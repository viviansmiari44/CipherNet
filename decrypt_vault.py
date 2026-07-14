#!/usr/bin/env python3
"""
Decrypt vault.txt and print all entries in plain text.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
from lib.encryption import decrypt
from lib.config import config

load_dotenv()

VAULT_FILE = config.VAULT_FILE  # defaults to "vault.txt"

if not os.path.exists(VAULT_FILE):
    print(f"[!] {VAULT_FILE} not found.")
    sys.exit(1)

with open(VAULT_FILE, 'r') as f:
    lines = f.readlines()

print(f"Decrypting {len(lines)} lines from {VAULT_FILE}...\n")
for i, raw_line in enumerate(lines, 1):
    line = raw_line.strip()
    if not line:
        continue
    try:
        plain = decrypt(line)
        print(f"[{i}] {plain}")
    except Exception as e:
        print(f"[{i}] ERROR decrypting: {e}")

print("\nDone.")