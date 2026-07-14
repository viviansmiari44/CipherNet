#!/usr/bin/env python3
"""
Batch funding script.
Reads vault.txt, extracts all trap addresses (derived from private keys), and
sends ALL available balances (native + ERC‑20 tokens) equally distributed among
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
import argparse  # NEW
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

# --- Supabase client for job tracking (NEW) ---
try:
    from supabase import create_client
except ImportError:
    create_client = None

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

load_dotenv()

# --- Configuration ---
SOURCE_PRIVATE_KEY = config.FUNDING_SOURCE_PRIVATE_KEY or os.getenv("SOURCE_PRIVATE_KEY")
if not SOURCE_PRIVATE_KEY:
    logger.critical("SOURCE_PRIVATE_KEY not set in environment.")
    sys.exit(1)

VAULT_FILE = config.VAULT_FILE

# --- MULTI‑CHAIN: get chain‑specific configs (with legacy fallback) ---
CHAIN = getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None

# Token config: use chain‑specific if available, otherwise fallback to legacy
if chain_cfg and 'tokens' in chain_cfg:
    TOKEN_CONFIG = chain_cfg['tokens']
else:
    TOKEN_CONFIG = config.TOKEN_CONFIG

# Dust amounts (kept for reference, not used in new logic)
if chain_cfg and 'dust' in chain_cfg:
    DUST_AMOUNT = chain_cfg['dust']
else:
    DUST_AMOUNT = config.DUST_AMOUNT

# Native symbol for logging (e.g., ETH, BNB, MATIC)
NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'

# Chain ID for transactions
CHAIN_ID = chain_cfg['chain_id'] if chain_cfg and 'chain_id' in chain_cfg else 1

# RPC URL: prefer chain‑specific RPC, otherwise use legacy DUSTER_RPC_URL
RPC_URL = chain_cfg['rpc'] if chain_cfg and 'rpc' in chain_cfg else config.DUSTER_RPC_URL
# Also allow environment override
RPC_URL = os.getenv("DUSTER_RPC_URL") or RPC_URL or os.getenv("NODE_RPC_URL")

print(f'[DEBUG] Chain: {CHAIN}, Native symbol: {NATIVE_SYMBOL}, Chain ID: {CHAIN_ID}')
print('[DEBUG] DUST_AMOUNT:', DUST_AMOUNT)
print('[DEBUG] TOKEN_CONFIG:', TOKEN_CONFIG)

# --- Custom POA HTTPProvider (for BSC/Polygon) ---
class POAHTTPProvider(Web3.HTTPProvider):
    """Wraps HTTPProvider and trims extraData to 32 bytes on POA chains."""
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

# --- RPC setup with fallback (now uses POAHTTPProvider for bsc/polygon) ---
def get_web3():
    rpc_urls = [
        RPC_URL,
        config.DUSTER_RPC_URL,
        os.getenv("DUSTER_RPC_URL"),
        os.getenv("NODE_RPC_URL"),
    ] + config.FALLBACK_RPC_URLS
    rpc_urls = [url for url in rpc_urls if url]

    for url in rpc_urls:
        try:
            # Use custom POA provider for BSC/Polygon
            if CHAIN.lower() in ('bsc', 'polygon'):
                provider = POAHTTPProvider(url)
                print(f'[DEBUG] Using POAHTTPProvider for chain={CHAIN}')
            else:
                provider = Web3.HTTPProvider(url)

            w3 = Web3(provider)
            if w3.is_connected():
                logger.info(f"Connected to RPC: {url}")
                return w3
        except Exception:
            continue
    logger.critical("No RPC connection available.")
    sys.exit(1)

w3 = get_web3()

# Source wallet
source_account = w3.eth.account.from_key(SOURCE_PRIVATE_KEY)
source_address = source_account.address
logger.info(f"Source wallet: {source_address}")

# --- Check balances ---
native_balance = w3.eth.get_balance(source_address)
logger.info(f"{NATIVE_SYMBOL} balance: {w3.from_wei(native_balance, 'ether')} {NATIVE_SYMBOL}")

# Minimal ERC-20 ABI (balanceOf + transfer)
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

usdc_balance = get_token_balance(source_address, "USDC")
usdt_balance = get_token_balance(source_address, "USDT")

# --- Use token decimals from config for display ---
token_decimals = config.get_token_decimals()

# Log balances using correct decimals
usdc_decimals = token_decimals.get("USDC", 6)
usdt_decimals = token_decimals.get("USDT", 6)
logger.info(f"USDC balance: {usdc_balance / 10**usdc_decimals:.6f} USDC")
logger.info(f"USDT balance: {usdt_balance / 10**usdt_decimals:.6f} USDT")

# --- NEW: log native USDC balance ---
if "USDC_NATIVE" in TOKEN_CONFIG:
    native_usdc_balance = get_token_balance(source_address, "USDC_NATIVE")
    native_usdc_decimals = token_decimals.get("USDC_NATIVE", 6)
    logger.info(f"Native USDC balance: {native_usdc_balance / 10**native_usdc_decimals:.6f} USDC (native)")
else:
    native_usdc_balance = 0

# --- Retry wrapper for RPC calls ---
@retry(max_attempts=3, base_delay=1, exceptions=(Exception,))
def call_with_retry(func, *args, **kwargs):
    return func(*args, **kwargs)

def extract_addresses_from_vault(vault_path):
    """
    Extracts unique trap addresses from vault.txt.
    Returns a dictionary mapping trap addresses to their private keys to optimize test mode.
    """
    addresses = {}
    if not os.path.exists(vault_path):
        logger.error(f"{vault_path} not found.")
        return addresses
    with open(vault_path, 'r') as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            try:
                decrypted_line = decrypt(line)
            except Exception as e:
                logger.error(f"Failed to decrypt line: {e}")
                continue

            # Look for the private key in the vault entry
            key_match = re.search(r'Key:\s*(0x[a-fA-F0-9]{64})', decrypted_line)
            if not key_match:
                continue

            private_key_hex = key_match.group(1)
            try:
                account = w3.eth.account.from_key(private_key_hex)
                trap_address = account.address.lower()
                addresses[trap_address] = private_key_hex
            except Exception as e:
                logger.error(f"Invalid private key: {private_key_hex[:10]}... – {e}")
                continue

    return addresses

# --- NEW: Fetch trap addresses from database ---
def extract_addresses_from_db(campaign_id):
    """
    Fetches trap addresses and private keys from the traps table for a given campaign.
    Returns a dictionary {trap_address: private_key}.
    """
    addresses = {}
    if not supabase:
        logger.error("Supabase client not initialized.")
        return addresses
    try:
        result = supabase.table("traps")\
            .select("trap_address, trap_private_key_enc")\
            .eq("campaign_id", campaign_id)\
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
                # Validate key
                account = w3.eth.account.from_key(private_key)
                trap_address = account.address.lower()
                # Ensure the address matches the stored one (optional)
                if trap_address == row.get("trap_address", "").lower():
                    addresses[trap_address] = private_key
                else:
                    logger.warning(f"Mismatched trap address for stored private key")
            except Exception as e:
                logger.error(f"Failed to decrypt private key for trap {row.get('trap_address')}: {e}")
                continue
        logger.info(f"Loaded {len(addresses)} trap addresses from database for campaign {campaign_id}")
    except Exception as e:
        logger.error(f"Failed to fetch traps from database: {e}")
    return addresses

def compute_funding_plan(num_addresses, native_bal, usdc_bal, native_usdc_bal, usdt_bal):
    """
    Build a list of (asset_symbol, amount_per_address, decimals) by splitting each
    token balance equally among all trap addresses, strictly reserving gas first.
    """
    plan = []
    token_decimals = config.get_token_decimals()

    # Calculate how many assets we are sending in total to estimate gas burden
    assets_to_send = 0
    if usdc_bal > 0: assets_to_send += 1
    if "USDC_NATIVE" in TOKEN_CONFIG and native_usdc_bal > 0: assets_to_send += 1
    if usdt_bal > 0: assets_to_send += 1

    # Total expected transactions per address + across all addresses
    txs_per_address = (1 if native_bal > 0 else 0) + assets_to_send
    total_txs = txs_per_address * num_addresses

    # Gas Reserve Math: Estimate 80k average gas limit per TX, multiplied by the max fee cap
    max_fee_wei = w3.to_wei(config.GAS_MAX_FEE_CAP_GWEI, "gwei")
    total_gas_reserve = total_txs * 80000 * max_fee_wei 

    # Native currency (e.g., MATIC, BNB, ETH)
    if native_bal > total_gas_reserve:
        distributable_native = native_bal - total_gas_reserve
        per_addr = distributable_native // num_addresses
        if per_addr > 0:
            plan.append((NATIVE_SYMBOL, per_addr, 18))  # native always 18
    elif native_bal > 0:
        logger.warning("Native balance is too low to cover both distribution and gas fees.")

    # Bridged USDC
    if usdc_bal > 0:
        per_addr = usdc_bal // num_addresses
        if per_addr > 0:
            plan.append(("USDC", per_addr, token_decimals.get("USDC", 6)))

    # Native USDC (e.g., Polygon native USDC)
    if "USDC_NATIVE" in TOKEN_CONFIG:
        if native_usdc_bal > 0:
            per_addr = native_usdc_bal // num_addresses
            if per_addr > 0:
                plan.append(("USDC_NATIVE", per_addr, token_decimals.get("USDC_NATIVE", 6)))

    # USDT
    if usdt_bal > 0:
        per_addr = usdt_bal // num_addresses
        if per_addr > 0:
            plan.append(("USDT", per_addr, token_decimals.get("USDT", 6)))

    return plan

def send_funding(to_address, asset, amount_units, nonce):
    """
    Send a funding transaction of the chosen asset using EIP‑1559 fees.
    Returns (tx_hash, nonce_consumed_boolean).
    """
    try:
        # Ensure checksum address
        to_checksum = w3.to_checksum_address(to_address)

        # Dynamic fee calculation (same as duster.py)
        base_fee = call_with_retry(w3.eth.get_block, "latest")["baseFeePerGas"]
        max_priority = w3.to_wei(config.GAS_PRIORITY_FEE_GWEI, "gwei")
        max_fee = int((base_fee + max_priority) * config.GAS_FEE_BUFFER)
        max_fee = min(max_fee, w3.to_wei(config.GAS_MAX_FEE_CAP_GWEI, "gwei"))
        if max_priority > max_fee:
            max_priority = int(max_fee * 0.1)

        # For native asset (ETH, BNB, MATIC)
        if asset == NATIVE_SYMBOL:
            tx = {
                'from': source_address,
                'to': to_checksum,
                'value': amount_units,
                'gas': 21000,                       # fixed, no estimation needed
                'maxFeePerGas': max_fee,
                'maxPriorityFeePerGas': max_priority,
                'nonce': nonce,
                'chainId': CHAIN_ID,
            }
        else:
            # ERC‑20 transfer (USDC, USDT, USDC_NATIVE, etc.)
            token_addr = TOKEN_CONFIG.get(asset)
            if not token_addr:
                logger.error(f"Unknown token {asset}")
                return None, False
            
            token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
            
            # Dynamic Gas Estimation instead of fixed 100k
            try:
                est_gas = token.functions.transfer(to_checksum, amount_units).estimate_gas({'from': source_address})
                gas_limit = int(est_gas * 1.2) # 20% safety buffer
            except Exception as e:
                logger.warning(f"Gas estimation failed for {asset}, falling back to 100000 limit: {e}")
                gas_limit = 100000

            # Build transfer transaction
            tx = token.functions.transfer(to_checksum, amount_units).build_transaction({
                'from': source_address,
                'nonce': nonce,
                'chainId': CHAIN_ID,
                'gas': gas_limit,
                'maxFeePerGas': max_fee,
                'maxPriorityFeePerGas': max_priority,
            })

        # --- CHECK: ensure source wallet has enough native token for gas + value ---
        current_native_balance = w3.eth.get_balance(source_address)
        gas_cost = tx.get('gas', 21000) * tx.get('maxFeePerGas', max_fee)
        transfer_value = tx.get('value', 0)
        total_required = gas_cost + transfer_value
        
        if current_native_balance < total_required:
            logger.warning(f"⚠️ Insufficient {NATIVE_SYMBOL}: need {w3.from_wei(total_required, 'ether')}, have {w3.from_wei(current_native_balance, 'ether')}")
            return None, False

        signed = w3.eth.account.sign_transaction(tx, SOURCE_PRIVATE_KEY)
        
        # We catch exceptions here to ensure we don't skip nonces on failed broadcasts
        try:
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        except Exception as e:
            logger.error(f"Broadcast failed for {to_address}: {e}")
            return None, False  # Transaction never entered mempool, nonce is safe to reuse

        logger.info(f"TX sent: {tx_hash.hex()}")

        # Wait for receipt and check status
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt.status == 1:
            logger.info(f"✅ TX confirmed: {tx_hash.hex()}")
            return tx_hash.hex(), True
        else:
            logger.error(f"❌ TX reverted: {tx_hash.hex()}")
            return None, True # Reverted TX still burns gas and consumes the nonce

    except Exception as e:
        logger.error(f"Error preparing transaction for {to_address}: {e}")
        return None, False

def main():
    # Parse arguments
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', help='Job ID for tracking')
    parser.add_argument('--test', action='store_true', help='Test mode: fund only first trap')
    args = parser.parse_args()
    job_id = args.job_id
    test_mode = args.test

    campaign_id = None
    if job_id:
        update_job(job_id, status='running')
        campaign_id = get_campaign_id_from_job(job_id)

    setup_graceful_shutdown()

    # --- MODIFIED: Use database if campaign_id provided, else vault ---
    if campaign_id:
        logger.info(f"Using database for campaign {campaign_id}")
        address_dict = extract_addresses_from_db(campaign_id)
        if not address_dict:
            logger.error(f"No traps found for campaign {campaign_id}")
            sys.exit(1)
    else:
        logger.info("Using vault file for legacy mode")
        address_dict = extract_addresses_from_vault(VAULT_FILE)
        if not address_dict:
            logger.error("No addresses found in vault.txt")
            sys.exit(1)

    unique_addresses = list(address_dict.keys())
    total_traps = len(unique_addresses)
    logger.info(f"Found {total_traps} unique trap addresses")

    # Compute funding plan passing global balances to prevent scope shadowing
    plan = compute_funding_plan(
        total_traps, 
        native_balance, 
        usdc_balance, 
        native_usdc_balance, 
        usdt_balance
    )
    
    if not plan:
        logger.error("No assets available for funding (all balances are 0 or below gas limits).")
        send_telegram(f"❌ Funding failed: insufficient assets in source wallet.", campaign_id=campaign_id)
        if job_id:
            update_job(job_id, status='failed', message='No assets available')
        sys.exit(1)

    total_expected = len(plan) * len(unique_addresses)
    if job_id:
        update_job(job_id, total=total_expected)

    logger.info("Funding plan (per trap address, based on full vault):")
    for asset, amount, decimals in plan:
        if asset == NATIVE_SYMBOL:
            logger.info(f"   {asset}: {w3.from_wei(amount, 'ether')} {NATIVE_SYMBOL}")
        elif asset.endswith("USDC") or asset == "USDT":
            logger.info(f"   {asset}: {amount / 10**decimals:.6f} {asset}")
        else:
            logger.info(f"   {asset}: {amount / 10**decimals:.6f} {asset}")

    if test_mode:
        unique_addresses = unique_addresses[:1]
        first_addr = unique_addresses[0]
        logger.info("TEST MODE – only funding the first trap address:")
        logger.info(f"   {first_addr}")

        pk = address_dict.get(first_addr)
        if pk:
            print(f"\n[TEST] Private key for {first_addr}: {pk}\n")
            logger.info(f"[TEST] Private key for {first_addr}: {pk}")
        else:
            logger.warning(f"Could not retrieve private key for test address.")
    else:
        logger.info(f"Preparing to fund all {total_traps} trap addresses.")

    # Confirmation
    print("\n[!] Press Enter to continue or Ctrl+C to cancel...")
    input()

    # Track Nonce Locally to prevent Mempool Collisions
    current_nonce = w3.eth.get_transaction_count(source_address, 'pending')
    success_counts = {asset: 0 for asset, _, _ in plan}
    
    processed = 0
    for i, addr in enumerate(unique_addresses, 1):
        for asset, amount, _ in plan:
            logger.info(f"[{i}/{len(unique_addresses)}] Funding {addr} with {amount} units of {asset}...")
            
            tx_hash, nonce_consumed = send_funding(addr, asset, amount, current_nonce)
            
            if tx_hash:
                success_counts[asset] += 1
            else:
                logger.warning(f"Failed to fund {addr} with {asset}")
                
            if nonce_consumed:
                current_nonce += 1
            processed += 1
            if job_id and processed % 5 == 0:  # Update progress every 5 sends
                update_job(job_id, progress=processed)
                
            time.sleep(0.5)

    total_ok = sum(success_counts.values())
    logger.info(f"Funded {total_ok} of {total_expected} transfers.")
    send_telegram(f"🏁 Funding batch complete\nChain: {CHAIN}\nTransfers: {total_ok}/{total_expected}", campaign_id=campaign_id)

    if job_id:
        if total_ok == total_expected:
            update_job(job_id, status='completed', progress=total_expected, message='All done')
        else:
            update_job(job_id, status='failed', progress=total_ok, message=f'{total_ok}/{total_expected} succeeded')

if __name__ == "__main__":
    main()