#!/usr/bin/env python3
"""
Batch funding script.
Reads vault.txt (local fallback) or fetches from Supabase DB, extracts trap addresses, 
and sends ALL available balances (native + ERC‑20 tokens) equally distributed among
all unique trap addresses.

Supports multi‑chain: Ethereum, BSC, Polygon (via CHAIN env var).

Usage:
  python3 batch_fund.py         # full run
  python3 batch_fund.py --test  # test with first trap address only
  python3 batch_fund.py --job-id <id>   # with job tracking
"""

import sys
import os
import re
import time
import argparse
from web3 import Web3
from dotenv import load_dotenv

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.config import config
from lib.logger import logger
from lib.retry import retry
from lib.notifier import send_telegram
from lib.shutdown import setup_graceful_shutdown
from lib.encryption import decrypt

# --- Supabase client for job tracking ---
try:
    from supabase import create_client
except ImportError:
    create_client = None

load_dotenv()

SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = None
if SUPABASE_URL and SUPABASE_KEY and create_client:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def update_job(job_id, status=None, progress=None, total=None, message=None):
    """Update job status in Supabase."""
    if not supabase:
        return
    data = {}
    if status is not None:
        data["status"] = status
    if progress is not None:
        data["progress"] = progress
    if total is not None:
        data["total"] = total
    if message is not None:
        data["message"] = message
    if status == "running" and "started_at" not in data:
        data["started_at"] = "now()"
    if status in ("completed", "failed"):
        data["completed_at"] = "now()"
    try:
        supabase.table("jobs").update(data).eq("id", job_id).execute()
    except Exception as e:
        logger.error(f"Failed to update job {job_id}: {e}")

def get_campaign_id_from_job(job_id):
    """Retrieve campaign_id from job record."""
    if not supabase:
        return None
    try:
        result = supabase.table("jobs").select("campaign_id").eq("id", job_id).execute()
        if result.data:
            return result.data[0]["campaign_id"]
    except Exception as e:
        logger.error(f"Failed to get campaign_id for job {job_id}: {e}")
    return None

def get_funding_key_for_campaign(campaign_id):
    """Fetch and decrypt the funding private key for a campaign."""
    if not supabase:
        logger.error("Supabase client not initialized.")
        return None
    try:
        result = supabase.table("campaigns").select("funding_private_key_enc").eq("id", campaign_id).execute()
        if not result.data:
            logger.error(f"Campaign {campaign_id} not found.")
            send_telegram(f"❌ Funding failed: Campaign {campaign_id} not found.", campaign_id)
            return None
        enc_key = result.data[0].get("funding_private_key_enc")
        if not enc_key:
            logger.error(f"No funding key stored for campaign {campaign_id}.")
            send_telegram(f"❌ Funding failed: No funding key stored for campaign.", campaign_id)
            return None

        logger.info(f"Encrypted key loaded successfully (first 50 chars): {enc_key[:50]}...")

        try:
            private_key = decrypt(enc_key)
            return private_key
        except Exception as e:
            logger.error(f"Decryption failed: {e}")
            send_telegram(f"❌ Funding failed: Could not decrypt funding key - {str(e)}", campaign_id)
            return None
    except Exception as e:
        logger.error(f"Failed to get funding key for campaign {campaign_id}: {e}")
        send_telegram(f"❌ Funding failed: {str(e)}", campaign_id)
        return None

# --- MULTI‑CHAIN Config setup ---
CHAIN = getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None

if chain_cfg and 'tokens' in chain_cfg:
    TOKEN_CONFIG = chain_cfg['tokens']
else:
    TOKEN_CONFIG = getattr(config, 'TOKEN_CONFIG', {})

NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'
CHAIN_ID = chain_cfg['chain_id'] if chain_cfg and 'chain_id' in chain_cfg else 1

RPC_URL = chain_cfg['rpc'] if chain_cfg and 'rpc' in chain_cfg else getattr(config, 'DUSTER_RPC_URL', None)
RPC_URL = os.getenv("DUSTER_RPC_URL") or RPC_URL or os.getenv("NODE_RPC_URL")

print(f'[DEBUG] Chain: {CHAIN}, Native symbol: {NATIVE_SYMBOL}, Chain ID: {CHAIN_ID}')
print('[DEBUG] TOKEN_CONFIG:', TOKEN_CONFIG)

# --- Custom POA HTTPProvider ---
class POAHTTPProvider(Web3.HTTPProvider):
    def make_request(self, method, params):
        response = super().make_request(method, params)
        if method in ('eth_getBlockByNumber', 'eth_getBlockByHash'):
            if 'result' in response and 'extraData' in response['result']:
                extra = response['result']['extraData']
                if isinstance(extra, str):
                    extra_bytes = bytes.fromhex(extra[2:] if extra.startswith('0x') else extra)
                else:
                    extra_bytes = extra
                if len(extra_bytes) > 32:
                    response['result']['extraData'] = '0x' + extra_bytes[:32].hex()
        return response

def get_web3():
    rpc_urls = [
        RPC_URL,
        getattr(config, 'DUSTER_RPC_URL', None),
        os.getenv("DUSTER_RPC_URL"),
        os.getenv("NODE_RPC_URL"),
    ] + getattr(config, 'FALLBACK_RPC_URLS', [])
    rpc_urls = [url for url in rpc_urls if url]

    for url in rpc_urls:
        try:
            if CHAIN.lower() in ('bsc', 'polygon'):
                provider = POAHTTPProvider(url)
                print(f'[DEBUG] Using POAHTTPProvider for chain={CHAIN}')
            else:
                provider = Web3.HTTPProvider(url)

            w3 = Web3(provider)
            if w3.is_connected():
                logger.info(f"Connected to RPC: {url}")
                return w3
        except Exception as e:
            continue
    logger.critical("No RPC connection available.")
    sys.exit(1)

w3 = get_web3()

# Minimal ERC-20 ABI
ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "type": "function",
    },
    {
        "constant": False,
        "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function",
    },
]

def get_token_balance(address, token_symbol):
    token_addr = TOKEN_CONFIG.get(token_symbol)
    if not token_addr:
        return 0
    token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
    try:
        return token.functions.balanceOf(address).call()
    except Exception as e:
        logger.warning(f"Failed to get token balance for {address}: {e}")
        return 0

@retry(max_attempts=3, base_delay=1, exceptions=(Exception,))
def call_with_retry(func, *args, **kwargs):
    return func(*args, **kwargs)

# --- Fetch trap addresses from Database ---
def extract_addresses_from_db(campaign_id):
    addresses = {}
    if not supabase:
        logger.error("Supabase client not initialized.")
        return addresses
    try:
        # Note: Supplying standard page limit handling for larger arrays
        result = supabase.table("traps")\
            .select("trap_address, trap_private_key_enc")\
            .eq("campaign_id", campaign_id)\
            .limit(2000)\
            .execute()
            
        if not result.data:
            logger.info(f"No traps found for campaign {campaign_id}")
            return addresses
        for row in result.data:
            enc_key = row.get("trap_private_key_enc")
            if not enc_key:
                continue
            try:
                private_key = decrypt(enc_key)
                account = w3.eth.account.from_key(private_key)
                trap_address = account.address.lower()
                if trap_address == row.get("trap_address", "").lower():
                    addresses[trap_address] = private_key
                else:
                    logger.warning("Mismatched trap address found for stored private key.")
            except Exception as e:
                logger.error(f"Failed to decrypt private key for trap {row.get('trap_address')}: {e}")
                continue
        logger.info(f"Loaded {len(addresses)} trap addresses from database for campaign {campaign_id}")
    except Exception as e:
        logger.error(f"Failed to fetch traps from database: {e}")
    return addresses

# --- Fallback: Fetch trap addresses from local file ---
def extract_addresses_from_file(filepath="vault.txt"):
    addresses = {}
    if not os.path.exists(filepath):
        logger.warning(f"Local file {filepath} not found.")
        return addresses
    try:
        with open(filepath, "r") as f:
            content = f.read()
        
        # Pulls valid 64-char hex strings (optionally containing 0x)
        keys = re.findall(r'(?:0x)?([a-fA-F0-9]{64})', content)
        for raw_key in keys:
            try:
                private_key = "0x" + raw_key
                account = w3.eth.account.from_key(private_key)
                trap_address = account.address.lower()
                addresses[trap_address] = private_key
            except Exception:
                continue
        logger.info(f"Loaded {len(addresses)} unique trap addresses from local file '{filepath}'")
    except Exception as e:
        logger.error(f"Error reading/parsing local {filepath}: {e}")
    return addresses

def compute_funding_plan(num_addresses, native_bal, usdc_bal, native_usdc_bal, usdt_bal, total_txs):
    """Build asset list, dynamically calculating gas requirements first."""
    plan = []
    
    # Decimals dynamic fetch
    token_decimals = getattr(config, 'get_token_decimals', lambda: {"USDC": 6, "USDT": 6, "USDC_NATIVE": 6})()

    # Dynamic gas price estimator logic
    try:
        current_gas_price = w3.eth.gas_price
    except Exception:
        current_gas_price = w3.to_wei(30, "gwei")  # Safe fallback default

    max_fee_cap = w3.to_wei(getattr(config, 'GAS_MAX_FEE_CAP_GWEI', 100), "gwei")
    safe_reserve_gas_price = min(int(current_gas_price * 1.5), max_fee_cap)
    
    # 80k is standard high-buffer gas limit for ERC20/Base interactions
    total_gas_reserve = total_txs * 80000 * safe_reserve_gas_price

    if native_bal > total_gas_reserve:
        distributable_native = native_bal - total_gas_reserve
        per_addr = distributable_native // num_addresses
        if per_addr > 0:
            plan.append((NATIVE_SYMBOL, per_addr, 18))
    else:
        logger.warning(
            f"Native balance too low to distribute native asset. "
            f"Available: {w3.from_wei(native_bal, 'ether')} {NATIVE_SYMBOL}. "
            f"Required safe Gas Reserve: {w3.from_wei(total_gas_reserve, 'ether')} {NATIVE_SYMBOL}."
        )

    if usdc_bal > 0:
        per_addr = usdc_bal // num_addresses
        if per_addr > 0:
            plan.append(("USDC", per_addr, token_decimals.get("USDC", 6)))

    if "USDC_NATIVE" in TOKEN_CONFIG and native_usdc_bal > 0:
        per_addr = native_usdc_bal // num_addresses
        if per_addr > 0:
            plan.append(("USDC_NATIVE", per_addr, token_decimals.get("USDC_NATIVE", 6)))

    if usdt_bal > 0:
        per_addr = usdt_bal // num_addresses
        if per_addr > 0:
            plan.append(("USDT", per_addr, token_decimals.get("USDT", 6)))

    return plan

def send_funding(source_address, private_key, to_address, asset, amount_units, nonce):
    """
    Send a funding transaction with isolated broadcast/wait logic 
    and dynamic EIP-1559/Legacy gas fallbacks.
    """
    try:
        to_checksum = w3.to_checksum_address(to_address)
        latest_block = call_with_retry(w3.eth.get_block, "latest")
        
        # Check if chain supports EIP-1559, and enforce legacy transactions on BSC
        use_eip1559 = (
            "baseFeePerGas" in latest_block 
            and latest_block["baseFeePerGas"] is not None 
            and CHAIN.lower() != "bsc"
        )

        gas_params = {}
        max_fee_cap = w3.to_wei(getattr(config, 'GAS_MAX_FEE_CAP_GWEI', 100), "gwei")

        if use_eip1559:
            base_fee = latest_block["baseFeePerGas"]
            max_priority = w3.to_wei(getattr(config, 'GAS_PRIORITY_FEE_GWEI', 1), "gwei")
            buffer = getattr(config, 'GAS_FEE_BUFFER', 1.2)
            max_fee = int((base_fee + max_priority) * buffer)
            max_fee = min(max_fee, max_fee_cap)
            if max_priority > max_fee:
                max_priority = int(max_fee * 0.1)

            gas_params['maxFeePerGas'] = max_fee
            gas_params['maxPriorityFeePerGas'] = max_priority
        else:
            gas_price = w3.eth.gas_price
            legacy_buffer = getattr(config, 'GAS_FEE_BUFFER', 1.15)
            capped_gas_price = min(int(gas_price * legacy_buffer), max_fee_cap)
            gas_params['gasPrice'] = capped_gas_price

        # Build payloads
        if asset == NATIVE_SYMBOL:
            tx = {
                'from': source_address,
                'to': to_checksum,
                'value': amount_units,
                'gas': 21000,
                'nonce': nonce,
                'chainId': CHAIN_ID,
                **gas_params
            }
        else:
            token_addr = TOKEN_CONFIG.get(asset)
            if not token_addr:
                logger.error(f"Unknown token {asset}")
                return None, False

            token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
            try:
                est_gas = token.functions.transfer(to_checksum, amount_units).estimate_gas({'from': source_address})
                gas_limit = int(est_gas * 1.2)
            except Exception as e:
                logger.warning(f"Gas estimation failed for {asset}, falling back to 100000 limit: {e}")
                gas_limit = 100000

            tx = token.functions.transfer(to_checksum, amount_units).build_transaction({
                'from': source_address,
                'nonce': nonce,
                'chainId': CHAIN_ID,
                'gas': gas_limit,
                **gas_params
            })

        # Final wallet check before broadcast
        current_native_balance = w3.eth.get_balance(source_address)
        active_gas_price = gas_params.get('gasPrice', gas_params.get('maxFeePerGas', 0))
        gas_cost = tx.get('gas', 21000) * active_gas_price
        transfer_value = tx.get('value', 0)
        total_required = gas_cost + transfer_value

        if current_native_balance < total_required:
            logger.error(f"Insufficient gas balance to cover transaction. Needed: {total_required}, Have: {current_native_balance}")
            return None, False

        # Sign & Broadcast (The absolute point of no return for nonce consumption!)
        signed = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        logger.info(f"Broadcasted TX: {tx_hash.hex()} (Nonce: {nonce})")

    except Exception as e:
        logger.error(f"Failed to prepare or broadcast transaction for {to_address}: {e}")
        # Transaction NEVER hit the network, so nonce remains unconsumed.
        return None, False

    # Confirmation Phase (Timeout or errors here do NOT free the nonce, it is in the mempool!)
    try:
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status == 1:
            logger.info(f"✅ TX confirmed: {tx_hash.hex()}")
            return tx_hash.hex(), True
        else:
            logger.error(f"❌ TX reverted in block: {tx_hash.hex()}")
            return None, True
    except Exception as e:
        logger.warning(f"⚠️ Receipt check timed out/failed for {tx_hash.hex()}. Nonce marked as spent: {e}")
        return tx_hash.hex(), True


def main():
    parser = argparse.ArgumentParser(description="Batch funding script")
    parser.add_argument("--test", action="store_true", help="Test with first trap address only")
    parser.add_argument("--job-id", type=str, help="Job ID for status tracking")
    args = parser.parse_args()

    test_mode = args.test
    job_id = args.job_id

    campaign_id = None
    try:
        if job_id:
            logger.info(f"Running with job tracking for job_id: {job_id}")
            update_job(job_id, status="running", message="Initializing batch funding job...")
            campaign_id = get_campaign_id_from_job(job_id)

        # 1. Fetch & decrypt source funding key
        funding_key = None
        if campaign_id:
            funding_key = get_funding_key_for_campaign(campaign_id)
            if not funding_key:
                if job_id:
                    update_job(job_id, status="failed", message="Could not retrieve or decrypt funding key.")
                sys.exit(1)
        else:
            funding_key = os.getenv("FUNDING_PRIVATE_KEY")
            if not funding_key:
                logger.error("No funding private key found in environment or database.")
                send_telegram("❌ Funding failed: No funding private key found in environment.", campaign_id)
                sys.exit(1)

        source_account = w3.eth.account.from_key(funding_key)
        source_address = source_account.address
        logger.info(f"Funding source address: {source_address}")

        # 2. Extract targets (DB or local fallback)
        traps = {}
        if campaign_id:
            traps = extract_addresses_from_db(campaign_id)
        else:
            traps = extract_addresses_from_file("vault.txt")

        if not traps:
            logger.critical("No trap addresses loaded. Exiting.")
            if job_id:
                update_job(job_id, status="failed", message="No trap addresses loaded.")
            send_telegram("❌ Funding failed: No trap addresses loaded.", campaign_id)
            sys.exit(1)

        unique_addresses = list(traps.keys())

        # Handle test mode early so tracking counts are accurate
        if test_mode:
            logger.info("[TEST MODE] Slicing execution down to first trap address only.")
            unique_addresses = unique_addresses[:1]

        num_targets = len(unique_addresses)
        logger.info(f"Targeting {num_targets} unique trap addresses")

        # 3. Pull balances
        native_bal = w3.eth.get_balance(source_address)
        usdc_bal = get_token_balance(source_address, "USDC")
        native_usdc_bal = get_token_balance(source_address, "USDC_NATIVE")
        usdt_bal = get_token_balance(source_address, "USDT")

        logger.info(f"Source Native Balance: {w3.from_wei(native_bal, 'ether')} {NATIVE_SYMBOL}")
        logger.info(f"Source USDC Balance: {usdc_bal / 1e6} USDC")
        if "USDC_NATIVE" in TOKEN_CONFIG:
            logger.info(f"Source USDC_NATIVE Balance: {native_usdc_bal / 1e6} USDC_NATIVE")
        logger.info(f"Source USDT Balance: {usdt_bal / 1e6} USDT")

        # 4. Generate plan
        assets_to_send = 0
        if usdc_bal > 0: assets_to_send += 1
        if "USDC_NATIVE" in TOKEN_CONFIG and native_usdc_bal > 0: assets_to_send += 1
        if usdt_bal > 0: assets_to_send += 1
        
        txs_per_address = (1 if native_bal > 0 else 0) + assets_to_send
        total_txs = txs_per_address * num_targets

        plan = compute_funding_plan(num_targets, native_bal, usdc_bal, native_usdc_bal, usdt_bal, total_txs)
        if not plan:
            logger.critical("No assets to distribute or gas balance too low.")
            if job_id:
                update_job(job_id, status="failed", message="No assets to distribute or native balance is too low for gas.")
            send_telegram("❌ Funding failed: No assets to distribute or native balance is too low for gas.", campaign_id)
            sys.exit(1)

        logger.info(f"Funding Plan computed: {plan}")

        # Correct tracking count representation after test-mode slicing
        total_expected = len(plan) * num_targets
        if job_id:
            update_job(job_id, total=total_expected, progress=0)

        # 5. Non-interactive input bypass check
        is_interactive = sys.stdin.isatty() and not job_id
        if is_interactive:
            print(f"\n[!] Ready to broadcast {total_expected} transactions to {num_targets} addresses.")
            print("Press Enter to continue or Ctrl+C to cancel...")
            try:
                input()
            except KeyboardInterrupt:
                logger.info("Operation cancelled by user.")
                sys.exit(0)
        else:
            logger.info("Non-interactive run detected. Skipping confirmation prompt.")

        setup_graceful_shutdown()

        # 6. Execute transactions sequentially
        current_nonce = w3.eth.get_transaction_count(source_address, "pending")
        total_ok = 0
        tx_count = 0

        for addr in unique_addresses:
            for asset, amount, decimals in plan:
                logger.info(f"Sending {amount / (10**decimals)} {asset} to {addr} (Nonce: {current_nonce})")
                
                tx_hash, nonce_consumed = send_funding(
                    source_address=source_address,
                    private_key=funding_key,
                    to_address=addr,
                    asset=asset,
                    amount_units=amount,
                    nonce=current_nonce
                )

                if nonce_consumed:
                    current_nonce += 1

                if tx_hash:
                    total_ok += 1
                
                tx_count += 1
                if job_id:
                    update_job(job_id, progress=tx_count, message=f"Processed {tx_count}/{total_expected} transfers")
                
                # Anti-spam cool-down
                time.sleep(0.5)

        # 7. Complete job status mapping
        if total_ok == total_expected:
            if job_id:
                update_job(job_id, status="completed", progress=total_expected, message="Batch funding completed successfully.")
            send_telegram(f"✅ Batch funding completed successfully. Sent {total_ok}/{total_expected} transactions.", campaign_id)
        elif total_ok > 0:
            if job_id:
                update_job(job_id, status="completed", progress=total_ok, message=f"Partial completion: {total_ok}/{total_expected} succeeded.")
            send_telegram(f"⚠️ Batch funding partially completed. {total_ok}/{total_expected} transactions succeeded.", campaign_id)
        else:
            if job_id:
                update_job(job_id, status="failed", message="All batch transactions failed.")
            send_telegram(f"❌ Batch funding failed. All {total_expected} transactions failed.", campaign_id)

    except Exception as e:
        logger.critical(f"Unhandled exception in batch funding: {e}", exc_info=True)
        if job_id:
            update_job(job_id, status="failed", message=f"Unhandled error: {str(e)}")
        send_telegram(f"❌ Batch funding failed with unexpected error: {str(e)}", campaign_id)
        sys.exit(1)

if __name__ == "__main__":
    main()