#!/usr/bin/env python3
"""
Multi-RPC Mempool Cleaner for Polygon.
Iterates through the entire RPC rotation list to flush ghost transactions on every node.
"""
from web3 import Web3
import sys
import time

# 1. 🔴 PASTE YOUR FUNDING PRIVATE KEY HERE 🔴
PRIVATE_KEY = "acb92216291c7f30f7a1e91a757e5052dcca5a83dc8ff383168ea49a35dc7178"

# 2. The exact RPC rotation list used by your batch_fund.py
RPC_LIST = [
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
]

def main():
    if "PASTE_YOUR" in PRIVATE_KEY:
        print("❌ Please edit this file and paste your actual Private Key at the top.")
        sys.exit(1)

    account = Web3().eth.account.from_key(PRIVATE_KEY)
    address = account.address
    print(f"👛 Target Wallet: {address}\n")

    total_flushed = 0

    # 3. Iterate through EVERY RPC in the rotation
    for rpc_url in RPC_LIST:
        print(f"🔗 Connecting to: {rpc_url}")
        w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={'timeout': 10}))
        
        try:
            if not w3.is_connected():
                print("   ⚠️ Failed to connect. Skipping.\n")
                continue
        except Exception:
            print("   ⚠️ Connection error. Skipping.\n")
            continue

        # Check nonces for this specific RPC node
        latest_nonce = w3.eth.get_transaction_count(address, 'latest')
        pending_nonce = w3.eth.get_transaction_count(address, 'pending')

        if pending_nonce <= latest_nonce:
            print(f"   ✅ Clean! (Latest: {latest_nonce}, Pending: {pending_nonce})\n")
            continue

        stuck_count = pending_nonce - latest_nonce
        print(f"   ⚠️ Found {stuck_count} ghost transactions on this node!")
        print(f"   🧹 Flushing nonces {latest_nonce} to {pending_nonce - 1}...\n")

        # Flush the ghosts on THIS specific node
        for i in range(stuck_count):
            nonce_to_clear = latest_nonce + i
            
            tx = {
                'to': address,
                'value': 0,
                'gas': 21000,
                'gasPrice': w3.to_wei(1000, 'gwei'), # High gas to force replacement
                'nonce': nonce_to_clear,
                'chainId': 137
            }
            
            signed = w3.eth.account.sign_transaction(tx, PRIVATE_KEY)
            try:
                # 🚨 FIX: Use raw_transaction (with underscore) for Web3.py v6+ compatibility
                tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
                print(f"      -> Flushed nonce {nonce_to_clear}: {tx_hash.hex()}")
                total_flushed += 1
            except Exception as e:
                print(f"      -> Failed to flush nonce {nonce_to_clear}: {e}")
        
        # Small delay to prevent rate limiting the RPCs
        time.sleep(1) 

    print("\n" + "="*50)
    if total_flushed > 0:
        print(f"🎉 COMPLETE! Flushed {total_flushed} ghost transactions across the RPC rotation.")
    else:
        print("🎉 COMPLETE! All RPC nodes in your rotation are completely clean.")
    print("👉 You can now safely restart batch_fund.py on your server.")
    print("="*50)

if __name__ == "__main__":
    main()