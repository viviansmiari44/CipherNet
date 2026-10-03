import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';
import { sendAlert, formatAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) { console.error('[analyzer] Missing Supabase credentials.'); process.exit(1); }
const supabase = createClient(supabaseUrl, supabaseKey);

const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;
const CHAIN_IDS = { ethereum: 1, bsc: 56, polygon: 137 };
const chainId = chainCfg?.chainId || CHAIN_IDS[chainName] || 1;

logger.info(`[Stage 1 Funnel] Running for chain: ${chainName} (ID: ${chainId})`);
const QUALIFIED_POLL_INTERVAL_MS = parseInt(process.env.QUALIFIED_POLL_INTERVAL_MS || '600000', 10);

let isFetching = false;

async function safeSendAlert(message) {
  try { await sendAlert(message); } catch (err) { logger.warn(`[Notifier] Failed: ${err.message}`); }
}

async function withRetry(fn, context, maxAttempts = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) { await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1))); } else break;
    }
  }
  throw lastError;
}

async function fetchPendingTargets() {
  if (isFetching) return;
  isFetching = true;

  try {
    logger.info('Fetching unique senders from token_transfers...');

    // Fetch ALL rows using cursor pagination to avoid OFFSET timeouts
    const PAGE_SIZE = 1000;
    let allRows = [];
    let cursorBlock = null;
    let fetchPage = 0;

    while (true) {
      fetchPage++;
      const pageData = await withRetry(async () => {
        let query = supabase.from('token_transfers').select('sender, receiver, block_number').eq('chain_id', chainId).order('block_number', { ascending: false }).limit(PAGE_SIZE);
        if (cursorBlock !== null) query = query.lt('block_number', cursorBlock);
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      }, `FetchPage_${fetchPage}`);

      if (!pageData || pageData.length === 0) break;
      allRows = allRows.concat(pageData);
      if (allRows.length % 10000 === 0) logger.info(`  └─ Fetched ${allRows.length} rows...`);
      cursorBlock = pageData[pageData.length - 1].block_number;
      if (pageData.length < PAGE_SIZE) break;
    }

    if (allRows.length === 0) { logger.info('No transfers found.'); return; }
    logger.info(`Fetched ${allRows.length} total rows. Extracting unique senders...`);

    // Extract unique senders and keep ONE placeholder receiver for the DB schema
    const uniqueSendersMap = new Map();
    for (const row of allRows) {
      const sender = (row.sender || '').toLowerCase();
      if (!sender) continue;
      if (!uniqueSendersMap.has(sender)) {
        uniqueSendersMap.set(sender, {
          chain: chainName,
          victim: sender,
          counterparty: (row.receiver || '').toLowerCase(), // Placeholder
          last_transfer_block: row.block_number,
          processed: false
        });
      }
    }

    const insertData = Array.from(uniqueSendersMap.values());
    const allSenders = Array.from(uniqueSendersMap.keys());

    logger.info(`Found ${insertData.length} unique senders. Pushing to raw_targets...`);

    // ═══════════════════════════════════════════════════════════
    // 🚀 FIXED: Insert into raw_targets in chunks of 500
    // This prevents the massive "canceling statement due to statement timeout"
    // ═══════════════════════════════════════════════════════════
    if (insertData.length > 0) {
      logger.info(`Inserting ${insertData.length} unique senders into raw_targets in chunks...`);
      const INSERT_CHUNK_SIZE = 500;
      let totalInserted = 0;

      for (let i = 0; i < insertData.length; i += INSERT_CHUNK_SIZE) {
        const chunk = insertData.slice(i, i + INSERT_CHUNK_SIZE);
        try {
          const { data, error } = await supabase
            .from('raw_targets')
            .upsert(chunk, { onConflict: 'chain,counterparty,victim', ignoreDuplicates: true })
            .select();

          if (error) {
            logger.error(`[Insert] Chunk ${Math.floor(i / INSERT_CHUNK_SIZE) + 1} failed: ${error.message}`);
          } else {
            totalInserted += data ? data.length : 0;
            if ((Math.floor(i / INSERT_CHUNK_SIZE) + 1) % 10 === 0) {
              logger.info(`  └─ Insert progress: ${Math.min(i + INSERT_CHUNK_SIZE, insertData.length)} / ${insertData.length}`);
            }
          }
        } catch (e) {
          logger.error(`[Insert] Chunk ${Math.floor(i / INSERT_CHUNK_SIZE) + 1} threw error: ${e.message}`);
        }
      }
      logger.info(`Finished inserting. Total successful inserts: ${totalInserted}`);
    }

    // Delete ALL processed senders from token_transfers to advance the queue
    logger.info(`Deleting ${allSenders.length} senders from token_transfers...`);
    const DELETE_CHUNK_SIZE = 20;
    let successfulChunks = 0;
    for (let i = 0; i < allSenders.length; i += DELETE_CHUNK_SIZE) {
      const chunk = allSenders.slice(i, i + DELETE_CHUNK_SIZE);
      const { error } = await supabase.from('token_transfers').delete().eq('chain_id', chainId).in('sender', chunk);
      if (!error) successfulChunks++;

      // Progress logging every 500 delete chunks (10,000 senders)
      if (Math.floor(i / DELETE_CHUNK_SIZE) > 0 && Math.floor(i / DELETE_CHUNK_SIZE) % 500 === 0) {
        logger.info(`  └─ Delete progress: ${Math.min(i + DELETE_CHUNK_SIZE, allSenders.length)} / ${allSenders.length}`);
      }
    }
    logger.info(`Deleted ${successfulChunks} chunks from token_transfers.`);

    if (insertData.length > 0) {
      await safeSendAlert(`📊 [${chainName.toUpperCase()}] Stage 1: Pushed ${insertData.length} unique senders to raw_targets. Cleaned ${allSenders.length} senders from token_transfers.`);
    }

  } catch (error) {
    logger.error(`[Stage 1] Fatal error: ${error.message}`);
    await safeSendAlert(formatAlert('error', { source: 'Stage1', error: error.message }));
  } finally {
    isFetching = false;
  }
}

async function startObserver() {
  logger.info('Starting Stage 1 Fast Funnel');
  try { await fetchPendingTargets(); } catch (err) { }
  setInterval(async () => { try { await fetchPendingTargets(); } catch (err) { } }, QUALIFIED_POLL_INTERVAL_MS);
}

setupGracefulShutdown();
onShutdown(async () => { logger.info('[Stage 1] Shutting down.'); });
startObserver().catch(async (err) => { process.exit(1); });