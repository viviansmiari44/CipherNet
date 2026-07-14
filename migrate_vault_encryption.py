#!/usr/bin/env python3
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib.encryption import encrypt
from lib.logger import logger

VAULT_FILE = "vault.txt"
BACKUP_FILE = "vault.txt.backup"

def main():
    if not os.path.exists(VAULT_FILE):
        logger.error(f"{VAULT_FILE} not found.")
        sys.exit(1)
    # Backup
    os.rename(VAULT_FILE, BACKUP_FILE)
    logger.info(f"Backed up to {BACKUP_FILE}")
    with open(BACKUP_FILE, 'r') as f_in, open(VAULT_FILE, 'w') as f_out:
        for line in f_in:
            if line.strip():
                encrypted_line = encrypt(line)
                f_out.write(encrypted_line + "\n")
    logger.info(f"Encrypted {VAULT_FILE} created.")
    print("[+] Migration complete. Original saved as vault.txt.backup")

if __name__ == "__main__":
    main()