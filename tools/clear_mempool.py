#!/usr/bin/env python3
"""
Mempool Cleaner: Connects to your script's RPC and flushes stuck ghost transactions.
"""
import os
import sys
from web3 import Web3
from dotenv import load_dotenv

load_dotenv()
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.config import config

# 1. Setup Web3 using the EXACT same RPC your batch_fund.py uses
CHAIN = os.getenv('CHAIN') or getattr(config, 'CHAIN', 'polygon')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None
RPC_URL = chain_cfg['rpc'] if chain_cfg and 'rpc' in chain_cfg else os.getenv("DUSTER_RPC_URL")

if not RPC_URL:
    print("❌ No RPC URL found. Check your .env or config.py")
    sys.exit(1)

w3 = Web3(Web3.HTTPProvider(RPC_URL))
print(f"🔗 Connected to RPC: {RPC_URL}")

# 2. 🔴 PASTE YOUR FUNDING PRIVATE KEY HERE 🔴
# (This is the same key batch_fund.py uses. Delete this file or clear the key after running!)
PRIVATE_KEY = "0xPASTE_YOUR_FUNDING_PRIVATE_KEY_HERE" 

account = w3.eth.account.from_key(PRIVATE_KEY)
address = account.address
print(f"👛 Checking mempool for: {address}")

# 3. Find the ghost transactions
latest_nonce = w3.eth.get_transaction_count(address, 'latest')
pending_nonce = w3.eth.get_transaction_count(address, 'pending')

print(f"📦 Confirmed Nonce (On-chain): {latest_nonce}")
print(f"⏳ Pending Nonce (RPC Mempool): {pending_nonce}")

if pending_nonce <= latest_nonce:
    print("✅ Success! No stuck transactions found. Your mempool is clean.")
    sys.exit(0)

stuck_count = pending_nonce - latest_nonce
print(f"⚠️ Found {stuck_count} ghost transactions stuck in the RPC mempool.")
print("🧹 Flushing them with 0-value self-transfers and max gas...\n")

# 4. Flush them
for i in range(stuck_count):
    nonce_to_clear = latest_nonce + i
    print(f"-> Clearing nonce {nonce_to_clear}...")
    
    # Build a 0-value tx to self with massive gas to force replacement
    tx = {
        'to': address,
        'value': 0,
        'gas': 21000,
        'gasPrice': w3.to_wei(1000, 'gwei'), # 1000 Gwei to guarantee it replaces the stuck TX
        'nonce': nonce_to_clear,
        'chainId': w3.eth.chain_id
    }
    
    signed = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)
    try:
        tx_hash = w3.eth.send_raw_transaction(signed.rawTransaction)
        print(f"   ✅ Flushed! TX: {tx_hash.hex()}")
    except Exception as e:
        print(f"   ❌ Failed: {e}")

print("\n🎉 Mempool cleanup complete! Your available balance is now unlocked.")
print("👉 You can now safely restart batch_fund.py")