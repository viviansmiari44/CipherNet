import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

// ─── CLI Flags ───
const isDryRun = process.argv.includes('--dry-run');
const TX_LIMIT_HEX = '0x64';

console.log('\n==================================================');
if (isDryRun) {
  console.log('[🔍 DRY-RUN MODE ACTIVE]');
  console.log('No database records will be modified or deleted.');
} else {
  console.log('[⚠️  LIVE EXECUTION MODE]');
  console.log('Failing records WILL be permanently purged from pending_targets.');
}
console.log('==================================================\n');

// ─── Supabase Setup ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('[history] Missing Supabase credentials.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Alchemy-Only RPC URLs ───
const ALCHEMY_RPCS = {
  bsc: [
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh',
  ],
  polygon: [
    'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
    'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11',
  ],
  ethereum: [
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
    'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
    'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
    'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
    'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et',
  ],
};

// ─── Alchemy-Only Viem Clients ───
const clients = {
  1: createPublicClient({
    chain: mainnet,
    transport: fallback(
      ALCHEMY_RPCS.ethereum.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
  56: createPublicClient({
    chain: bsc,
    transport: fallback(
      ALCHEMY_RPCS.bsc.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
  137: createPublicClient({
    chain: polygon,
    transport: fallback(
      ALCHEMY_RPCS.polygon.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
};

// ─── Constants ───
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 250;
const MIN_TX_FOR_ANALYSIS = 10;
const BOT_SCORE_THRESHOLD = 0.6;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const MIN_GAS_RESERVE_WEI = 2000000000000000n;
const MAX_NONCE_LIMIT = 1000;

const CHAIN_NAME_MAP = { 1: 'ethereum', 56: 'bsc', 137: 'polygon' };
const CHAIN_ID_MAP = { ethereum: 1, bsc: 56, polygon: 137 };

const ALCHEMY_CATEGORIES = {
  1: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
  56: ['external', 'erc20', 'erc721', 'erc1155'],
  137: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
};

// ─── Utilities ───
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllRows(table, selectColumns) {
  const PAGE_SIZE = 1000;
  let offset = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(selectColumns)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);

    if (allRows.length % 5000 === 0) {
      console.log(`  └─ Fetched ${allRows.length} rows from ${table}...`);
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allRows;
}

// ─── STAGE 1: On-chain state checks (HUMAN-ONLY GATE — unchanged) ───
async function passesStageOne(address, chainId) {
  const client = clients[chainId];
  if (!client) return { pass: true, reason: 'no_client' };

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

// ─── STAGE 2: Behavioral analysis ───
async function fetchTransactionHistory(address, chainId) {
  const client = clients[chainId];
  if (!client) return null;

  try {
    const checksumAddr = getAddress(address);
    const category = ALCHEMY_CATEGORIES[chainId] || ALCHEMY_CATEGORIES[1];

    // Fetch OUTGOING and INCOMING concurrently
    const [outRes, inRes] = await Promise.all([
      client.request({
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          fromAddress: checksumAddr,
          category,
          maxCount: TX_LIMIT_HEX,
          order: 'desc',
          withMetadata: true,
        }],
      }).catch(() => null),
      client.request({
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          toAddress: checksumAddr,
          category,
          maxCount: TX_LIMIT_HEX,
          order: 'desc',
          withMetadata: true,
        }],
      }).catch(() => null)
    ]);

    const transfers = [];

    // Tag the directions so the analyzer knows what kind of gap it is
    if (outRes?.transfers) {
      transfers.push(...outRes.transfers.map(t => ({ ...t, direction: 'out' })));
    }
    if (inRes?.transfers) {
      transfers.push(...inRes.transfers.map(t => ({ ...t, direction: 'in' })));
    }

    if (transfers.length === 0) return [];

    // Deduplicate (in case of self-transfers appearing in both)
    const unique = [];
    const seen = new Set();
    for (const t of transfers) {
      const id = t.uniqueId || `${t.hash}-${t.direction}`;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(t);
      }
    }

    // Sort descending by block number (newest first, mimicking original Alchemy response)
    unique.sort((a, b) => {
      const blockA = parseInt(a.blockNum, 16);
      const blockB = parseInt(b.blockNum, 16);
      return blockB - blockA;
    });

    // Enforce the max count
    return unique.slice(0, parseInt(TX_LIMIT_HEX, 16));
  } catch (err) {
    return null;
  }
}

/**
 * Behavioral analysis — bot probability score (capped at 1.0, threshold >= 0.6).
 */
function analyzeTransactionPatterns(transfers) {
  if (!transfers || transfers.length < MIN_TX_FOR_ANALYSIS) {
    return { score: 0, reason: 'insufficient_data', txCount: transfers ? transfers.length : 0 };
  }

  const chronological = [...transfers].reverse();
  const hours = new Set();
  const intervals = [];

  let prevTimestamp = null;
  let prevBlock = null;
  let prevDirection = null;
  const uniqueReceivers = new Set();

  const blockCounts = new Map();
  let zeroGapCount = 0;
  let currentBlockStreak = 0;
  let maxBlockStreak = 0;
  let totalIntervals = 0;

  let minTs = Infinity;
  let maxTs = -Infinity;
  let minInterval = Infinity;
  let minInOutInterval = Infinity;
  let microGapCount = 0;

  for (const tx of chronological) {
    const tsStr = tx.metadata?.blockTimestamp;
    if (!tsStr) continue;
    const timestamp = new Date(tsStr);
    if (isNaN(timestamp.getTime())) continue;
    const tsMs = timestamp.getTime();

    if (tsMs < minTs) minTs = tsMs;
    if (tsMs > maxTs) maxTs = tsMs;

    hours.add(timestamp.getUTCHours());
    if (tx.to && tx.direction === 'out') uniqueReceivers.add(tx.to.toLowerCase());

    if (tx.blockNum) {
      const currentBlock = BigInt(tx.blockNum);
      blockCounts.set(tx.blockNum, (blockCounts.get(tx.blockNum) || 0) + 1);

      if (prevBlock !== null) {
        const blockDiff = currentBlock - prevBlock;
        if (blockDiff >= 0n && blockDiff <= 2n) {
          currentBlockStreak++;
          if (currentBlockStreak > maxBlockStreak) maxBlockStreak = currentBlockStreak;
        } else {
          currentBlockStreak = 0;
        }
      }
      prevBlock = currentBlock;
    }

    if (prevTimestamp !== null) {
      const gapSeconds = (tsMs - prevTimestamp) / 1000;
      totalIntervals++;

      // Catch an IN immediately followed by an OUT
      if (prevDirection === 'in' && tx.direction === 'out') {
        if (gapSeconds >= 0 && gapSeconds < minInOutInterval) {
          minInOutInterval = gapSeconds;
        }
      }

      // Check >= 0 so same-block transactions don't bypass the 3-min rule
      if (gapSeconds >= 0 && gapSeconds < minInterval) {
        minInterval = gapSeconds;
      }
      // REDUCED TO 180 SECONDS (3 MINUTES)
      if (gapSeconds >= 0 && gapSeconds < 180) {
        microGapCount++;
      }

      // Keep intervals > 0 for standard deviation math so it doesn't skew
      if (gapSeconds > 0) {
        intervals.push(gapSeconds);
      } else {
        zeroGapCount++;
      }
    }
    prevTimestamp = tsMs;
    prevDirection = tx.direction;
  }

  if (intervals.length < 3 && zeroGapCount < 5) {
    return { score: 0, reason: 'too_few_intervals', txCount: transfers.length };
  }

  const spanDays = (minTs === Infinity || maxTs === -Infinity)
    ? Infinity
    : (maxTs - minTs) / (1000 * 60 * 60 * 24);

  const hourCoverage = hours.size / 24;
  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : 0;
  const variance = intervals.length > 0
    ? intervals.reduce((a, b) => a + (b - avgInterval) ** 2, 0) / intervals.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const cv = avgInterval === 0 ? 0 : stdDev / avgInterval;
  const receiverCount = uniqueReceivers.size;

  const blockCountsValues = [...blockCounts.values()];
  const maxBatchSize = blockCountsValues.length > 0 ? Math.max(...blockCountsValues) : 0;
  const batchBlockCount = blockCountsValues.filter(c => c >= 3).length;
  const zeroGapRatio = totalIntervals > 0 ? zeroGapCount / totalIntervals : 0;

  const transfersPerDay = (spanDays > 0 && spanDays !== Infinity)
    ? transfers.length / spanDays
    : 0;

  // ─── Scoring ───
  let score = 0;
  const signals = [];

  if (maxBatchSize >= 3) { score += 0.65; signals.push(`extreme_batch(max=${maxBatchSize})`); }
  else if (maxBatchSize === 2) { score += 0.35; signals.push(`batch(max=${maxBatchSize})`); }
  if (batchBlockCount >= 3) { score += 0.25; signals.push(`sustained_batch(${batchBlockCount}blocks)`); }
  if (maxBlockStreak >= 3) { score += 0.65; signals.push(`extreme_block_streak(${maxBlockStreak})`); }
  else if (maxBlockStreak >= 2) { score += 0.40; signals.push(`block_streak(${maxBlockStreak})`); }
  if (hourCoverage > 0.75 && spanDays < 30) { score += 0.30; signals.push(`24/7(${hours.size}h/${spanDays.toFixed(0)}d)`); }
  if (avgInterval < 300 && cv < 0.45 && intervals.length >= 5) { score += 0.35; signals.push(`robotic(avg=${avgInterval.toFixed(0)}s,cv=${cv.toFixed(2)})`); }

  if (receiverCount === 1) {
    const humanLike = spanDays > 90;
    if (humanLike) { score += 0.10; signals.push(`single_recv_humanlike(${spanDays.toFixed(0)}d)`); }
    else if (transfers.length >= 30) { score += 0.60; signals.push(`single_recv_sweeper(${transfers.length}tx)`); }
    else { score += 0.50; signals.push(`single_recv(${transfers.length}tx)`); }
  } else if (receiverCount <= 2) { score += 0.20; signals.push(`low_div(${receiverCount})`); }

  if (avgInterval < 60 && avgInterval > 0) { score += 0.25; signals.push(`rapid(${avgInterval.toFixed(0)}s)`); }
  if (zeroGapRatio > 0.40) { score += 0.20; signals.push(`zero_gap(${(zeroGapRatio * 100).toFixed(0)}%)`); }
  if (spanDays <= 4 && transfers.length >= 60) { score += 0.55; signals.push(`high_density(${transfers.length}tx/${spanDays.toFixed(1)}d)`); }
  else if (spanDays <= 7 && transfers.length >= 30) { score += 0.35; signals.push(`dense(${transfers.length}tx/${spanDays.toFixed(1)}d)`); }
  if (transfers.length >= 30 && transfersPerDay >= 15) { score += 0.60; signals.push(`high_daily_vol(${transfersPerDay.toFixed(0)}/day)`); }
  else if (transfers.length >= 20 && transfersPerDay >= 8) { score += 0.40; signals.push(`daily_vol(${transfersPerDay.toFixed(0)}/day)`); }

  const rapidRatio = totalIntervals > 0 ? (microGapCount / totalIntervals) : 0;

  if (totalIntervals > 10 && rapidRatio > 0.50) {
    score += 0.50;
    signals.push(`mostly_rapid(${(rapidRatio * 100).toFixed(0)}%)`);
  }

  let sweepCount = 0;

  if (sweepCount >= 3) {
    score += 0.80;
    signals.push(`confirmed_sweeper(${sweepCount}x)`);
  }

  if (receiverCount > 10 && spanDays > 30) {
    score -= 0.40;
    signals.push(`human_diversity(${receiverCount} contracts)`);
  }

  return {
    score: Math.min(score, 1.0),
    reason: signals.length > 0 ? signals.join('+') : 'clean',
    txCount: transfers.length,
    maxBatch: maxBatchSize,
    consecutiveBlocks: maxBlockStreak,
    batchBlocks: batchBlockCount,
    zeroGapPct: (zeroGapRatio * 100).toFixed(0),
    hours: `${hours.size}/24`,
    avgGap: avgInterval.toFixed(0),
    minGap: minInterval === Infinity ? '∞' : minInterval.toFixed(0),
    microGaps: microGapCount,
    cv: cv.toFixed(3),
    receivers: receiverCount,
    spanDays: spanDays === Infinity ? '∞' : spanDays.toFixed(1),
    perDay: transfersPerDay > 0 ? transfersPerDay.toFixed(1) : '0',
  };
}

// ─── Combined analysis: Stage 1 + Stage 2 ───
async function analyzeAddress(address, chainId) {
  const stage1 = await passesStageOne(address, chainId);
  if (!stage1.pass) {
    return { valid: false, stage: 'stage1', reason: stage1.reason, analysis: null };
  }

  const transfers = await fetchTransactionHistory(address, chainId);
  if (!transfers) {
    return { valid: true, stage: 'stage2', reason: 'rpc_fail_stage2', analysis: null };
  }

  const analysis = analyzeTransactionPatterns(transfers);
  if (analysis.score >= BOT_SCORE_THRESHOLD) {
    return { valid: false, stage: 'stage2', reason: analysis.reason, analysis };
  }

  return { valid: true, stage: 'pass', reason: 'human', analysis };
}

// ─── Helper for purges ───
async function purgePendingTargets(purgeMap) {
  let countToPurge = 0;
  for (const set of purgeMap.values()) countToPurge += set.size;
  if (countToPurge === 0) return;

  console.log(`\n[🧹 PURGING BATCH] Purging ${countToPurge} invalid/bot addresses from pending_targets...`);

  for (const [cid, addrSet] of purgeMap) {
    if (addrSet.size === 0) continue;

    const chainNameStr = CHAIN_NAME_MAP[cid];
    const invalidList = Array.from(addrSet);

    if (isDryRun) {
      console.log(`  [🔍 DRY-RUN] Would purge ${invalidList.length} addresses for ${chainNameStr.toUpperCase()}...`);
    } else {
      console.log(`  [${chainNameStr.toUpperCase()}] Purging ${invalidList.length} addresses from pending_targets...`);

      for (let j = 0; j < invalidList.length; j += 100) {
        const chunk = invalidList.slice(j, j + 100);
        const { error: delErr } = await supabase
          .from('pending_targets')
          .delete()
          .eq('chain', chainNameStr)
          .in('victim', chunk);

        if (delErr && delErr.code !== '42P01') {
          console.error(`  [-] pending_targets delete error (${chainNameStr}):`, delErr.message);
        }
      }
      console.log(`  [+] ${chainNameStr.toUpperCase()} batch purge complete.`);
    }
    addrSet.clear();
  }
  console.log('[+] Batch purge complete. Resuming filtering...\n');
}

// ─── Main Cleanup ───
async function runCleanup() {
  console.log('[+] Phase 1: Fetching ALL addresses from pending_targets...\n');

  let targetsList = [];

  try {
    targetsList = await fetchAllRows('pending_targets', 'victim, chain');
  } catch (err) {
    console.error('[-] Error fetching pending_targets:', err.message);
    return;
  }

  console.log(`\n[+] Total rows: ${targetsList.length} in pending_targets`);

  const uniqueMap = new Map();

  for (const row of targetsList) {
    if (!row.victim || !row.chain) continue;
    if (row.victim.toLowerCase() === ZERO_ADDR) continue;
    const cid = CHAIN_ID_MAP[row.chain.toLowerCase()];
    if (!cid) continue;
    const key = `${row.victim.toLowerCase()}_${cid}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, { address: row.victim.toLowerCase(), chainId: cid });
    }
  }

  const uniqueAddresses = Array.from(uniqueMap.values());
  console.log(`[+] Unique addresses to analyze: ${uniqueAddresses.length}\n`);

  targetsList = null;

  console.log('[+] Phase 2: Running Stage 1 (on-chain) + Stage 2 (behavioral) analysis...\n');

  // Accumulates ALL invalid addresses for final summary reporting
  const invalidByChain = new Map([
    [1, new Set()],
    [56, new Set()],
    [137, new Set()],
  ]);

  // Holds invalid addresses waiting to be purged during active execution
  const pendingPurgeByChain = new Map([
    [1, new Set()],
    [56, new Set()],
    [137, new Set()],
  ]);

  const analysisResults = new Map();
  const reasonCounts = new Map();

  let analyzedCount = 0;
  let invalidCount = 0;
  let humanCount = 0;
  let stage1Rejects = 0;
  let stage2Rejects = 0;
  let rpcFailCount = 0;
  let lastPurgeAt = 0;

  for (let i = 0; i < uniqueAddresses.length; i += BATCH_SIZE) {
    const batch = uniqueAddresses.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async ({ address, chainId: cid }) => {
        const result = await analyzeAddress(address, cid);
        return { address, chainId: cid, ...result };
      })
    );

    for (const res of results) {
      analyzedCount++;
      const cacheKey = `${res.address}_${res.chainId}`;

      const reasonKey = res.valid ? 'human' : `${res.stage}:${res.reason.split('(')[0].split('+')[0]}`;
      reasonCounts.set(reasonKey, (reasonCounts.get(reasonKey) || 0) + 1);

      if (res.analysis) {
        analysisResults.set(cacheKey, res.analysis);
      }

      if (!res.valid) {
        invalidCount++;
        if (res.stage === 'stage1') stage1Rejects++;
        if (res.stage === 'stage2') stage2Rejects++;

        if (invalidByChain.has(res.chainId)) {
          invalidByChain.get(res.chainId).add(res.address);
        }
        if (pendingPurgeByChain.has(res.chainId)) {
          pendingPurgeByChain.get(res.chainId).add(res.address);
        }
      } else if (res.reason.includes('rpc_fail')) {
        rpcFailCount++;
        humanCount++;
      } else {
        humanCount++;
      }
    }

    if ((i + BATCH_SIZE) % 50 === 0 || i + BATCH_SIZE >= uniqueAddresses.length) {
      console.log(
        `  └─ Progress: ${Math.min(i + BATCH_SIZE, uniqueAddresses.length)} / ${uniqueAddresses.length}` +
        ` | ✅ ${humanCount} | ❌ ${invalidCount} (S1:${stage1Rejects} S2:${stage2Rejects}) | ⚠️ ${rpcFailCount} RPC`
      );
    }

    // Purge every 4,000 address filters
    if (analyzedCount - lastPurgeAt >= 4000) {
      await purgePendingTargets(pendingPurgeByChain);
      lastPurgeAt = analyzedCount;
    }

    if (i + BATCH_SIZE < uniqueAddresses.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 2.5: DIAGNOSTIC — Score Distribution Sample
  // ═══════════════════════════════════════════════════════════

  console.log('\n==================================================');
  console.log(' [DIAGNOSTIC] Score Distribution Sample (30 addresses)');
  console.log('==================================================\n');

  const sampleSize = 30;
  const step = Math.max(1, Math.floor(uniqueAddresses.length / sampleSize));
  const sample = [];
  for (let i = 0; i < uniqueAddresses.length && sample.length < sampleSize; i += step) {
    sample.push(uniqueAddresses[i]);
  }

  let sampleInsufficient = 0;
  let sampleAnalyzed = 0;
  const scoreBuckets = { '0.00': 0, '0.01-0.29': 0, '0.30-0.59': 0, '0.60-1.00': 0 };

  console.log(`  ${'Address'.padEnd(44)} ${'Chain'.padEnd(8)} ${'TXs'.padEnd(4)} ${'Batch'.padEnd(6)} ${'Streak'.padEnd(7)} ${'MinGap'.padEnd(7)} ${'ZGap%'.padEnd(6)} ${'Hours'.padEnd(6)} ${'AvgGap'.padEnd(8)} ${'CV'.padEnd(6)} ${'Recv'.padEnd(5)} ${'SpanD'.padEnd(7)} ${'PerDay'.padEnd(7)} ${'Score'.padEnd(6)} Verdict`);
  console.log(`  ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(20)}`);

  for (const { address, chainId: cid } of sample) {
    const cacheKey = `${address}_${cid}`;
    const result = analysisResults.get(cacheKey);

    if (!result) {
      console.log(`  ${address.padEnd(44)} ${CHAIN_NAME_MAP[cid].padEnd(8)} ${'—'.padEnd(4)} ${'—'.padEnd(6)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(6)} ${'—'.padEnd(5)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} S1 REJECT / NO DATA`);
      continue;
    }

    if (result.reason === 'insufficient_data' || result.reason === 'too_few_intervals') {
      sampleInsufficient++;
      console.log(`  ${address.padEnd(44)} ${CHAIN_NAME_MAP[cid].padEnd(8)} ${String(result.txCount).padEnd(4)} ${'—'.padEnd(6)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(6)} ${'—'.padEnd(5)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} SKIP (${result.reason})`);
      continue;
    }

    sampleAnalyzed++;
    const verdict = result.score >= BOT_SCORE_THRESHOLD ? '🤖 BOT' : '👤 HUMAN';

    console.log(
      `  ${address.padEnd(44)} ${CHAIN_NAME_MAP[cid].padEnd(8)} ${String(result.txCount).padEnd(4)} ` +
      `${String(result.maxBatch).padEnd(6)} ${String(result.consecutiveBlocks).padEnd(7)} ${String(result.minGap).padEnd(7)} ${(result.zeroGapPct + '%').padEnd(6)} ${String(result.hours).padEnd(6)} ` +
      `${(result.avgGap + 's').padEnd(8)} ${String(result.cv).padEnd(6)} ${String(result.receivers).padEnd(5)} ` +
      `${String(result.spanDays).padEnd(7)} ${String(result.perDay).padEnd(7)} ` +
      `${result.score.toFixed(2).padEnd(6)} ${verdict} [${result.reason}]`
    );

    if (result.score === 0) scoreBuckets['0.00']++;
    else if (result.score < 0.30) scoreBuckets['0.01-0.29']++;
    else if (result.score < 0.60) scoreBuckets['0.30-0.59']++;
    else scoreBuckets['0.60-1.00']++;
  }

  console.log(`\n  ── Sample Summary ──`);
  console.log(`  ├─ Sampled:              ${sample.length}`);
  console.log(`  ├─ Insufficient data:    ${sampleInsufficient}`);
  console.log(`  ├─ Fully analyzed:       ${sampleAnalyzed}`);
  console.log(`  └─ Score distribution:`);
  console.log(`      ├─ 0.00 (clean):     ${scoreBuckets['0.00']}`);
  console.log(`      ├─ 0.01 – 0.29:      ${scoreBuckets['0.01-0.29']}`);
  console.log(`      ├─ 0.30 – 0.59:      ${scoreBuckets['0.30-0.59']}`);
  console.log(`      └─ 0.60 – 1.00 (BOT): ${scoreBuckets['0.60-1.00']}`);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Summary
  // ═══════════════════════════════════════════════════════════

  let totalInvalid = 0;
  for (const set of invalidByChain.values()) totalInvalid += set.size;

  console.log('\n==================================================');
  console.log(' STAGE 1 + STAGE 2 PENDING TARGETS ANALYSIS RESULTS');
  console.log('==================================================');
  console.log(`  ├─ Total addresses analyzed:    ${analyzedCount}`);
  console.log(`  ├─ Confirmed humans:            ${humanCount}`);
  console.log(`  ├─ Stage 1 rejects:             ${stage1Rejects} (contract/nonce/balance)`);
  console.log(`  ├─ Stage 2 rejects:             ${stage2Rejects} (behavioral)`);
  console.log(`  ├─ RPC failures (preserved):    ${rpcFailCount}`);
  console.log(`  └─ Unique addresses purged:     ${totalInvalid}`);

  if (reasonCounts.size > 0) {
    console.log('\n  📋 Rejection reasons:');
    const sorted = [...reasonCounts.entries()]
      .filter(([r]) => r !== 'human')
      .sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      console.log(`     ├─ ${reason}: ${count}`);
    }
  }

  for (const [cid, addrSet] of invalidByChain) {
    if (addrSet.size > 0) {
      console.log(`\n      ${CHAIN_NAME_MAP[cid].toUpperCase()} (Chain ${cid}): ${addrSet.size} total addresses purged`);
    }
  }

  // ─── DRY-RUN EXIT ───
  if (isDryRun) {
    console.log('\n[🔍 DRY-RUN COMPLETE]');
    console.log(`  ├─ ${totalInvalid} addresses WOULD be purged from pending_targets.`);
    console.log('\n[i] No database changes were executed. Run without --dry-run to delete.\n');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Final Purge (purges remaining addresses < 4000)
  // ═══════════════════════════════════════════════════════════

  let remainingCount = 0;
  for (const set of pendingPurgeByChain.values()) remainingCount += set.size;

  if (remainingCount > 0) {
    console.log('\n[!] Phase 4: Executing final database purge for remaining targets...\n');
    await purgePendingTargets(pendingPurgeByChain);
  } else {
    console.log('\n[+] Database is up to date. All invalid addresses have already been purged in batches.\n');
  }

  console.log('\n[🎉] Stage 1 + Stage 2 pending_targets cleanup complete across all chains!\n');
}

runCleanup();