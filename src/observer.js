import pg from 'pg';
import { appendFile, readFile } from 'fs/promises';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';
import { sendAlert, formatAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';

const { Pool } = pg;

// --- Configuration from central config ---
const {
  db,
  files,
} = config;

// --- MULTI‑CHAIN: get chain‑specific configs ---
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;
const chainId = chainCfg?.chainId || 1;

logger.info(`[Multi‑chain] Observer running for chain: ${chainName} (ID: ${chainId})`);

// --- Database pool ---
const pool = new Pool({
  user: db.user,
  host: db.host,
  database: db.database,
  password: db.password,
  port: db.port,
});

// --- Qualified pairs polling interval (default 10 minutes) ---
const QUALIFIED_POLL_INTERVAL_MS = parseInt(
  process.env.QUALIFIED_POLL_INTERVAL_MS || '600000',
  10
);

// --- Chain‑specific block count for 30 days (approximate) ---
const BLOCKS_30_DAYS_MAP = {
  ethereum: 216000n,   // ~13s blocks
  bsc:      864000n,   // ~3s blocks
  polygon:  1296000n,  // ~2s blocks
};
const BLOCKS_30_DAYS = BLOCKS_30_DAYS_MAP[chainName] || 216000n;

// FIX 2: Mutex lock to prevent overlapping database queries
let isFetching = false;

// --- Helper: retry wrapper for DB queries ---
async function withRetry(fn, context, maxAttempts = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`[${context}] Attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        break;
      }
    }
  }
  throw lastError;
}

// --- fetchPendingTargets (formerly fetchQualifiedTargets) ---
async function fetchPendingTargets() {
  if (isFetching) {
    logger.warn('Database query is still running from the previous interval. Skipping to prevent DB locks.');
    return;
  }
  
  isFetching = true;

  try {
    logger.info('Fetching qualified pairs (frequency >= 7, last tx within 30 days, min $1000)...');

    // 1. Load existing pairs from the file
    let existingPairs = new Set();
    try {
      const content = await readFile(files.pending, 'utf8');   
      const lines = content.split('\n').filter(line => line.trim() !== '');
      lines.forEach(line => {
        const match = line.match(/Counterparty:\s*(0x[a-fA-F0-9]{40})\s*\|\s*Victim:\s*(0x[a-fA-F0-9]{40})/i);
        if (match) {
          const cp = match[1].toLowerCase();
          const v = match[2].toLowerCase();
          existingPairs.add(`${cp}|${v}`);
        }
      });
      logger.info(`Loaded ${existingPairs.size} existing pairs from ${files.pending}`);
    } catch (err) {
      logger.info('No existing pending file found, starting fresh.');
    }

    // 2. Get the max block number for this chain from the database
    const maxBlockQuery = `
      SELECT MAX(block_number) AS max_block
      FROM token_transfers
      WHERE chain_id = $1
    `;
    const maxBlockResult = await pool.query(maxBlockQuery, [chainId]);
    const maxBlock = maxBlockResult.rows[0]?.max_block;
    
    if (!maxBlock) {
      logger.info('No transfers found in database for this chain yet.');
      return;
    }
    
    const maxBlockBigInt = BigInt(maxBlock);
    
    // FIX 3: Safe threshold calculation preventing negative block numbers
    const blockDiff = Number(maxBlockBigInt - BLOCKS_30_DAYS);
    const thresholdBlock = Math.max(0, blockDiff);

    const query = `
      SELECT sender, receiver, COUNT(*) as freq, MAX(block_number) as last_block
      FROM token_transfers
      WHERE chain_id = $1
        AND value::NUMERIC > 0
      GROUP BY sender, receiver
      HAVING COUNT(*) >= 7 AND MAX(block_number) >= $2
      ORDER BY freq DESC, last_block DESC;
    `;
    const result = await pool.query(query, [chainId, thresholdBlock]);

    if (result.rows.length === 0) {
      logger.info('No qualified pairs found in this run.');
      return;
    }

    const newLines = [];
    for (const row of result.rows) {
      const cp = row.receiver.toLowerCase();
      const v = row.sender.toLowerCase();
      const key = `${cp}|${v}`;
      if (!existingPairs.has(key)) {
        newLines.push(`Counterparty: ${cp} | Victim: ${v}`);
        existingPairs.add(key);
      }
    }

    if (newLines.length === 0) {
      logger.info('No new qualified pairs to add.');
      return;
    }

    const contentToAppend = newLines.join('\n') + '\n';
    await appendFile(files.pending, contentToAppend, 'utf8');   

    logger.info(`Added ${newLines.length} new qualified pairs to ${files.pending}`);
    logger.info(`Total pairs in file now: ${existingPairs.size}`);

    if (newLines.length > 50) {
      await sendAlert(`📊 Found ${newLines.length} new qualified pairs.`);
    }

  } catch (error) {
    logger.error(`Error fetching qualified pairs: ${error.message}`);
    await sendAlert(formatAlert('error', { source: 'fetchPendingTargets', error: error.message }));
  } finally {
    isFetching = false; // Mutex released securely
  }
}

// --- Start the periodic poller ---
async function startObserver() {
  logger.info('Starting qualified‑targets poller (continuous mode)');
  logger.info(`Polling interval: ${QUALIFIED_POLL_INTERVAL_MS / 1000} seconds`);
  logger.info(`30‑day block window for ${chainName}: ${BLOCKS_30_DAYS} blocks`);

  // Run immediately on start
  await fetchPendingTargets();

  // Then schedule periodic runs
  setInterval(async () => {
    try {
      await fetchPendingTargets();
    } catch (err) {
      logger.error(`Polling error: ${err.message}`);
    }
  }, QUALIFIED_POLL_INTERVAL_MS);
}

// --- Graceful shutdown ---
setupGracefulShutdown();

onShutdown(async () => {
  logger.info('Closing database connections...');
  await pool.end();
  logger.info('Database closed.');
});

// --- Start ---
startObserver().catch(async (err) => {
  logger.error(`Fatal error: ${err.message}`);
  await sendAlert(formatAlert('error', { source: 'startObserver', error: err.message }));
  process.exit(1);
});