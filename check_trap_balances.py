#!/usr/bin/env python3
"""
Quick trap balance checker.
Reads vault.txt, derives all unique trap addresses, and prints their balances.
If an address has any balance, also prints its private key.
"""

import sys
import os
import re
from web3 import Web3
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.config import config
from lib.logger import logger
from lib.encryption import decrypt

load_dotenv()

# --- Chain setup (same as batch_fund) ---
CHAIN = getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None

TOKEN_CONFIG = chain_cfg['tokens'] if chain_cfg and 'tokens' in chain_cfg else config.TOKEN_CONFIG
NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'

RPC_URL = chain_cfg['rpc'] if chain_cfg and 'rpc' in chain_cfg else config.DUSTER_RPC_URL
RPC_URL = os.getenv("DUSTER_RPC_URL") or RPC_URL or os.getenv("NODE_RPC_URL")

VAULT_FILE = config.VAULT_FILE

# Get token decimals from config
token_decimals = config.get_token_decimals() if hasattr(config, 'get_token_decimals') else {}

# POA provider
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
    rpc_urls = [RPC_URL] + config.FALLBACK_RPC_URLS
    rpc_urls = [url for url in rpc_urls if url]
    for url in rpc_urls:
        try:
            if CHAIN.lower() in ('bsc', 'polygon'):
                provider = POAHTTPProvider(url)
            else:
                provider = Web3.HTTPProvider(url)
            w3 = Web3(provider)
            if w3.is_connected():
                logger.info(f"Connected to {url}")
                return w3
        except Exception:
            continue
    logger.error("No RPC connection")
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
]

def get_token_balance(address, token_addr):
    if not token_addr:
        return 0
    token = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
    try:
        return token.functions.balanceOf(w3.to_checksum_address(address)).call()
    except Exception as e:
        logger.warning(f"Failed to get balance for {address} token {token_addr}: {e}")
        return 0

def main():
    # Extract unique trap addresses and their private keys
    address_to_privkey = {}
    if not os.path.exists(VAULT_FILE):
        print(f"Vault file {VAULT_FILE} not found.")
        sys.exit(1)

    with open(VAULT_FILE, 'r') as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            try:
                decrypted = decrypt(line)
            except Exception:
                continue
            key_match = re.search(r'Key:\s*(0x[a-fA-F0-9]{64})', decrypted)
            if not key_match:
                continue
            priv = key_match.group(1)
            try:
                acct = w3.eth.account.from_key(priv)
                addr = acct.address.lower()
                address_to_privkey[addr] = priv
            except Exception:
                continue

    if not address_to_privkey:
        print("No valid addresses found in vault.")
        sys.exit(1)

    addresses = sorted(address_to_privkey.keys())
    print(f"Checking balances for {len(addresses)} unique trap addresses on {CHAIN}...\n")

    totals = {NATIVE_SYMBOL: 0, "USDC": 0, "USDC_NATIVE": 0, "USDT": 0}
    token_addrs = {
        "USDC": TOKEN_CONFIG.get("USDC"),
        "USDC_NATIVE": TOKEN_CONFIG.get("USDC_NATIVE"),
        "USDT": TOKEN_CONFIG.get("USDT"),
    }

    # Determine decimals for display
    usdc_decimals = token_decimals.get("USDC", 6)
    usdc_native_decimals = token_decimals.get("USDC_NATIVE", 6)
    usdt_decimals = token_decimals.get("USDT", 6)

    for i, addr in enumerate(addresses, 1):
        checksum = w3.to_checksum_address(addr)
        native = w3.eth.get_balance(checksum)
        usdc = get_token_balance(checksum, token_addrs["USDC"])
        usdc_native = get_token_balance(checksum, token_addrs["USDC_NATIVE"])
        usdt = get_token_balance(checksum, token_addrs["USDT"])

        totals[NATIVE_SYMBOL] += native
        totals["USDC"] += usdc
        totals["USDC_NATIVE"] += usdc_native
        totals["USDT"] += usdt

        # Check if any balance > 0
        has_balance = (native > 0 or usdc > 0 or usdc_native > 0 or usdt > 0)

        if has_balance:
            # Print address with private key
            print(f"[{i}/{len(addresses)}] {addr}")
            print(f"   Private Key: {address_to_privkey[addr]}")
            print(f"   {NATIVE_SYMBOL}: {w3.from_wei(native, 'ether')} {NATIVE_SYMBOL}")
            print(f"   USDC:        {usdc / 10**usdc_decimals:.6f}")
            print(f"   USDC_NATIVE: {usdc_native / 10**usdc_native_decimals:.6f}")
            print(f"   USDT:        {usdt / 10**usdt_decimals:.6f}\n")

    print("=" * 50)
    print("TOTAL BALANCES (all traps):")
    print(f"{NATIVE_SYMBOL}: {w3.from_wei(totals[NATIVE_SYMBOL], 'ether')} {NATIVE_SYMBOL}")
    print(f"USDC:        {totals['USDC'] / 10**usdc_decimals:.6f}")
    print(f"USDC_NATIVE: {totals['USDC_NATIVE'] / 10**usdc_native_decimals:.6f}")
    print(f"USDT:        {totals['USDT'] / 10**usdt_decimals:.6f}")

if __name__ == "__main__":
    main()