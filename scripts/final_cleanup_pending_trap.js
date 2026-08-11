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
    console.log('Invalid pending targets WILL be permanently purged from Supabase.');
}
console.log('==================================================\n');

// ─── Supabase Setup ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('[cleanup] Missing Supabase credentials.');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Multi-Chain Viem Clients (Alchemy-only) ───
const clients = {
    1: createPublicClient({
        chain: mainnet,
        transport: fallback([
            http('https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1', { timeout: 15000 }),
            http('https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et', { timeout: 15000 }),
        ], { retryCount: 3 }),
    }),
    56: createPublicClient({
        chain: bsc,
        transport: fallback([
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI', { timeout: 15000 }),
            http('https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh', { timeout: 15000 }),
        ], { retryCount: 3 }),
    }),
    137: createPublicClient({
        chain: polygon,
        transport: fallback([
            http('https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE', { timeout: 15000 }),
            http('https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11', { timeout: 15000 }),
        ], { retryCount: 3 }),
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

const CHAIN_ID_MAP = { ethereum: 1, bsc: 56, polygon: 137 };
const CHAIN_NAME_MAP = { 1: 'ethereum', 56: 'bsc', 137: 'polygon' };

const ALCHEMY_CATEGORIES = {
    1: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
    56: ['external', 'erc20', 'erc721', 'erc1155'],
    137: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
};

// ─── Utilities ─
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllRows(table, select, filters = {}) {
    const limit = 1000;
    let offset = 0;
    let allRows = [];
    let hasMore = true;

    while (hasMore) {
        let query = supabase.from(table).select(select);
        for (const [key, value] of Object.entries(filters)) {
            query = query.eq(key, value);
        }
        query = query.range(offset, offset + limit - 1);

        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) {
            hasMore = false;
        } else {
            allRows = allRows.concat(data);
            offset += limit;
            if (allRows.length % 5000 === 0) {
                console.log(`  └─ Fetched ${allRows.length} rows from ${table}...`);
            }
        }
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
 *
 *   +0.65  extreme_batch         (>= 3 transfers in a single block)
 *   +0.35  batch                 (exactly 2 in a block)
 *   +0.25  sustained_batch       (>= 3 different blocks each with a batch)
 *   +0.65  extreme_block_streak  (4+ transfers across consecutive/adjacent blocks)
 *   +0.40  block_streak          (3 transfers across consecutive/adjacent blocks)
 *   +0.30  24/7                  (> 75% hours, compressed into < 30 days)
 *   +0.35  robotic               (avg interval < 5min AND CV < 0.45)
 *   +0.60  single_recv_sweeper   (1 receiver, >= 30 txs, NOT a long-span human)
 *   +0.50  single_recv           (1 receiver, 10-29 txs, NOT a long-span human)
 *   +0.10  single_recv_humanlike (1 receiver but history spans > 90 days)
 *   +0.20  low_div               (2 receivers)
 *   +0.25  rapid                 (avg interval < 60s)
 *   +0.20  zero_gap              (> 40% of intervals are 0s)
 *   +0.55  high_density          (>= 60 txs inside <= 4 days)
 *   +0.35  dense                 (>= 30 txs inside <= 7 days)
 *   +0.60  high_daily_vol        (>= 30 txs at >= 15 outgoing/day — sustained automation)
 *   +0.40  daily_vol             (>= 20 txs at >= 8 outgoing/day)
 *   +0.70  micro_gap             (ANY gap < 360s — no human can confirm 2 txs in 6 min)
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

    // 🆕 11. Micro-gap detection (ROBUST MODE) - REDUCED TO 3 MINUTES (180s)
    // Check explicit IN -> OUT sweeps first (+0.80) because that is a 100% confirmed sweeper bot.
    // 1. Calculate the percentage of rapid transactions
    const rapidRatio = totalIntervals > 0 ? (microGapCount / totalIntervals) : 0;

    // 2. Only penalize if RAPID transactions are the user's NORMAL behavior (> 50% of the time)
    if (totalIntervals > 10 && rapidRatio > 0.50) {
        score += 0.50;
        signals.push(`mostly_rapid(${(rapidRatio * 100).toFixed(0)}%)`);
    }

    // 3. Specifically target Sweepers (In -> Out in under 30 seconds)
    // But only if they do it repeatedly, not just once.
    let sweepCount = 0;
    // (You would need to track this inside your chronological loop: 
    // if (prevDirection === 'in' && tx.direction === 'out' && gapSeconds < 30) sweepCount++; )

    if (sweepCount >= 3) {
        score += 0.80;
        signals.push(`confirmed_sweeper(${sweepCount}x)`);
    }

    // 4. ADD A HUMAN WHITELIST (Rescue organic users)
    // If they have interacted with many different addresses and have a long lifespan, reduce their bot score.
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

function isBot(transfers) {
    const { score } = analyzeTransactionPatterns(transfers);
    return score >= BOT_SCORE_THRESHOLD;
}

// ─── Combined analysis: Stage 1 + Stage 2 ───
async function analyzeVictim(address, chainId) {
    const stage1 = await passesStageOne(address, chainId);
    if (!stage1.pass) {
        return { valid: false, reason: `stage1:${stage1.reason}`, analysis: null };
    }

    const transfers = await fetchTransactionHistory(address, chainId);
    if (!transfers) {
        return { valid: true, reason: 'stage1_pass_stage2_rpc_fail', analysis: null };
    }

    const analysis = analyzeTransactionPatterns(transfers);
    if (analysis.score >= BOT_SCORE_THRESHOLD) {
        return { valid: false, reason: `stage2:${analysis.reason}`, analysis };
    }

    return { valid: true, reason: 'human', analysis };
}

// ─── Main ───
async function runCleanup() {
    console.log('[+] Fetching all traps with campaign and user info...\n');

    let traps = [];
    try {
        traps = await fetchAllRows('pending_targets', 'id, victim, chain');
    } catch (err) {
        console.error('[-] Error fetching pending_targets:', err);
        return;
    }
    console.log(`\n[+] Total pending_targets fetched: ${traps.length}`);

    const uniqueMap = new Map();

    for (const row of traps) {
        if (!row.victim) continue;
        if (row.victim.toLowerCase() === ZERO_ADDR) continue;

        const chainId = CHAIN_ID_MAP[row.chain];
        if (!chainId) continue;
        const key = `${row.victim.toLowerCase()}_${chainId}`;
        if (!uniqueMap.has(key)) {
            uniqueMap.set(key, { address: row.victim.toLowerCase(), chainId, pendingIds: [] });
        }
        uniqueMap.get(key).pendingIds.push(row.id);
    }

    const uniqueAddresses = Array.from(uniqueMap.values());
    console.log(`[+] Unique victim addresses to analyze: ${uniqueAddresses.length}\n`);

    traps = null;

    // ─── Analyze ───
    const reasonCounts = new Map();

    let analyzed = 0;
    let invalid = 0;
    let valid = 0;
    let rpcFails = 0;
    const invalidIds = new Set();

    const detailedResults = [];

    for (let i = 0; i < uniqueAddresses.length; i += BATCH_SIZE) {
        const batch = uniqueAddresses.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
            batch.map(async ({ address, chainId, pendingIds }) => {
                const result = await analyzeVictim(address, chainId);
                return { address, chainId, pendingIds, ...result };
            })
        );

        for (const res of results) {
            analyzed++;

            const reasonKey = res.reason.split('+')[0].split('(')[0];
            reasonCounts.set(reasonKey, (reasonCounts.get(reasonKey) || 0) + 1);

            detailedResults.push(res);

            if (!res.valid) {
                invalid++;
                for (const pendingId of res.pendingIds) {
                    invalidIds.add(pendingId);
                }
            } else if (res.reason.includes('rpc_fail')) {
                rpcFails++;
                valid++;
            } else {
                valid++;
            }
        }

        if ((i + BATCH_SIZE) % 50 === 0 || i + BATCH_SIZE >= uniqueAddresses.length) {
            console.log(
                `  └─ Progress: ${Math.min(i + BATCH_SIZE, uniqueAddresses.length)} / ${uniqueAddresses.length}` +
                ` | ✅ ${valid} | ❌ ${invalid} | ⚠️ ${rpcFails} RPC fails`
            );
        }

        if (i + BATCH_SIZE < uniqueAddresses.length) {
            await sleep(BATCH_DELAY_MS);
        }
    }

    // ─── Diagnostic: rejected sample ───
    const rejected = detailedResults.filter(r => !r.valid && r.analysis);
    if (rejected.length > 0) {
        console.log('\n──────────────────────────────────────────────────────────────────────────────────────────────────────────');
        console.log(' [DIAGNOSTIC] Stage 2 Behavioral Rejections (sample)');
        console.log('──────────────────────────────────────────────────────────────────────────────────────────────────────────');
        console.log(`  ${'Address'.padEnd(44)} ${'Chain'.padEnd(8)} ${'TXs'.padEnd(4)} ${'Batch'.padEnd(6)} ${'Streak'.padEnd(7)} ${'MinGap'.padEnd(7)} ${'ZGap%'.padEnd(6)} ${'Hours'.padEnd(6)} ${'AvgGap'.padEnd(8)} ${'CV'.padEnd(6)} ${'SpanD'.padEnd(7)} ${'PerDay'.padEnd(7)} ${'Score'.padEnd(6)} Signals`);
        console.log(`  ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(20)}`);

        for (const r of rejected.slice(0, 20)) {
            const a = r.analysis;
            console.log(
                `  ${r.address.padEnd(44)} ${CHAIN_NAME_MAP[r.chainId].padEnd(8)} ${String(a.txCount).padEnd(4)} ` +
                `${String(a.maxBatch).padEnd(6)} ${String(a.consecutiveBlocks).padEnd(7)} ${String(a.minGap).padEnd(7)} ${(a.zeroGapPct + '%').padEnd(6)} ${String(a.hours).padEnd(6)} ` +
                `${(a.avgGap + 's').padEnd(8)} ${String(a.cv).padEnd(6)} ${String(a.spanDays).padEnd(7)} ${String(a.perDay).padEnd(7)} ` +
                `${a.score.toFixed(2).padEnd(6)} [${a.reason}]`
            );
        }
    }

    // ─── Diagnostic: SURVIVORS (anything that PASSED) ───
    const survivors = detailedResults.filter(r => r.valid);
    if (survivors.length > 0) {
        console.log('\n──────────────────────────────────────────────────────────────────────────────────────────────────────────');
        console.log(` [SURVIVORS] Addresses that PASSED (showing ${Math.min(survivors.length, 30)} of ${survivors.length})`);
        console.log(' ── a real human: MinGap > 360s, PerDay < 5, high CV, large SpanD ──');
        console.log('──────────────────────────────────────────────────────────────────────────────────────────────────────────');
        console.log(`  ${'Address'.padEnd(44)} ${'Chain'.padEnd(8)} ${'TXs'.padEnd(4)} ${'Batch'.padEnd(6)} ${'Streak'.padEnd(7)} ${'MinGap'.padEnd(7)} ${'ZGap%'.padEnd(6)} ${'Hours'.padEnd(6)} ${'AvgGap'.padEnd(8)} ${'CV'.padEnd(6)} ${'SpanD'.padEnd(8)} ${'PerDay'.padEnd(7)} ${'Score'.padEnd(6)} Note`);
        console.log(`  ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(16)}`);

        for (const r of survivors.slice(0, 30)) {
            const a = r.analysis;
            if (!a) {
                console.log(`  ${r.address.padEnd(44)} ${CHAIN_NAME_MAP[r.chainId].padEnd(8)} ${'—'.padEnd(4)} ${'—'.padEnd(6)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} RPC FAIL (preserved)`);
                continue;
            }
            if (a.reason === 'insufficient_data' || a.reason === 'too_few_intervals') {
                console.log(`  ${r.address.padEnd(44)} ${CHAIN_NAME_MAP[r.chainId].padEnd(8)} ${String(a.txCount).padEnd(4)} ${'—'.padEnd(6)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(7)} ${'0.00'.padEnd(6)} ⚠️ <${MIN_TX_FOR_ANALYSIS} outgoing (RESIDUAL)`);
                continue;
            }
            console.log(
                `  ${r.address.padEnd(44)} ${CHAIN_NAME_MAP[r.chainId].padEnd(8)} ${String(a.txCount).padEnd(4)} ` +
                `${String(a.maxBatch).padEnd(6)} ${String(a.consecutiveBlocks).padEnd(7)} ${String(a.minGap).padEnd(7)} ${(a.zeroGapPct + '%').padEnd(6)} ${String(a.hours).padEnd(6)} ` +
                `${(a.avgGap + 's').padEnd(8)} ${String(a.cv).padEnd(6)} ${String(a.spanDays).padEnd(8)} ${String(a.perDay).padEnd(7)} ` +
                `${a.score.toFixed(2).padEnd(6)} 👤 [${a.reason}]`
            );
        }
    }

    // ─── Summary ─
    const totalInvalidTargets = invalidIds.size;

    console.log('\n==================================================');
    console.log(' STAGE 1 + STAGE 2 PENDING_TARGETS ANALYSIS RESULTS');
    console.log('==================================================');
    console.log(`  ├─ Unique victims analyzed:  ${analyzed}`);
    console.log(`  ├─ Valid humans:             ${valid}`);
    console.log(`  ├─ Invalid (total):          ${invalid}`);
    console.log(`  ├─ RPC failures (preserved): ${rpcFails}`);

}
runCleanup();