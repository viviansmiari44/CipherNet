import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet } from 'viem/chains';

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER ADDRESS & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const ROUTER = '0xD67A3a5F8673c3972eEd8691F4cBa9F323C492B2';
// const ROUTER = '0x77EB52E44dB06777bCE478159f25c0d55a295314';
const TRANSFER_EVENT_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC RPCs (NO MONTHLY LIMITS - FAST & RELIABLE)
// ═══════════════════════════════════════════════════════════════════════════════
const FAST_RPCS = [
    'https://ethereum.publicnode.com',
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth',
    'https://eth.drpc.org',
    'https://eth.merkle.io',
    'https://cloudflare-eth.com',
    'https://rpc.flashbots.net',
    'https://eth-pokt.nodies.app',
    'https://eth.meowrpc.com',
    'https://eth-mainnet.public.blastapi.io',
    'https://virginia.rpc.blxrbdn.com',
    'https://singapore.rpc.blxrbdn.com',
    'https://uk.rpc.blxrbdn.com',
];

console.log(`[DEBUG] Loaded ${FAST_RPCS.length} fast public RPC endpoints.\n`);

const client = createPublicClient({
    chain: mainnet,
    transport: fallback(
        FAST_RPCS.map(url => http(url, { timeout: 15000 })),
        { rank: false, retryCount: 5, retryDelay: 500 }
    ),
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: SCAN RECENT BLOCKS FOR ROUTER CALLS
// ═══════════════════════════════════════════════════════════════════════════════

async function findRouterCalls() {
    console.log('🔍 STEP 1: SCANNING RECENT BLOCKS FOR ROUTER CALLS...');
    console.log(`   Router: ${ROUTER}\n`);

    const routerLower = ROUTER.toLowerCase();
    const currentBlock = await client.getBlockNumber();
    console.log(`   Current block: ${currentBlock}\n`);

    // Scan last 5000 blocks (~17 hours) - fast and likely to have recent activity
    const BLOCKS_TO_SCAN = 5000n;
    const startBlock = currentBlock - BLOCKS_TO_SCAN;

    console.log(`   Scanning ${BLOCKS_TO_SCAN} blocks from ${startBlock} to ${currentBlock}...\n`);

    const routerTxHashes = new Set();
    const txBlockMap = new Map();
    let scannedBlocks = 0;
    let blockNum = currentBlock;

    // Scan blocks one at a time (fast, no log limits)
    while (blockNum >= startBlock) {
        try {
            const block = await client.getBlock({
                blockNumber: blockNum,
                includeTransactions: true,
            });

            if (block && block.transactions) {
                for (const tx of block.transactions) {
                    if (tx.to && tx.to.toLowerCase() === routerLower) {
                        routerTxHashes.add(tx.hash);
                        txBlockMap.set(tx.hash, {
                            blockNumber: blockNum,
                            timestamp: Number(block.timestamp) * 1000,
                            from: tx.from,
                            gasUsed: tx.gas,
                        });
                    }
                }
            }

            scannedBlocks++;
            if (scannedBlocks % 500 === 0) {
                console.log(`      Scanned ${scannedBlocks} blocks, found ${routerTxHashes.size} router calls...`);
            }

            blockNum--;
            await new Promise(r => setTimeout(r, 30)); // Gentle rate limiting

        } catch (err) {
            console.log(`      ⚠️  Block ${blockNum} error: ${err.message?.slice(0, 60)}`);
            blockNum--;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log(`\n   ✅ Found ${routerTxHashes.size} router calls in last ${BLOCKS_TO_SCAN} blocks!\n`);

    return {
        txHashes: [...routerTxHashes],
        txBlockMap,
        blocksScanned: scannedBlocks,
        blockRange: { start: startBlock, end: currentBlock },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: ANALYZE EACH ROUTER CALL
// ═══════════════════════════════════════════════════════════════════════════════

async function analyzeRouterCalls(scanData) {
    console.log('🔍 STEP 2: ANALYZING ROUTER TRANSACTIONS...\n');

    const { txHashes, txBlockMap } = scanData;
    const totalTxs = txHashes.length;

    if (totalTxs === 0) {
        console.log('   ❌ No router calls found in the scanned block range.');
        return null;
    }

    console.log(`   Analyzing ${totalTxs} router transactions...\n`);

    const batchSizes = [];
    const allVictims = new Set();
    const allTraps = new Set();
    const allMirrorContracts = new Set();
    const timestamps = [];
    let totalTransfers = 0;
    let analyzedCount = 0;

    for (let i = 0; i < totalTxs; i++) {
        const hash = txHashes[i];
        const meta = txBlockMap.get(hash);

        try {
            const receipt = await client.getTransactionReceipt({ hash });
            if (!receipt) continue;

            // Count Transfer events
            const transferLogs = receipt.logs.filter(log =>
                log.topics[0] === TRANSFER_EVENT_SIGNATURE
            );

            const batchSize = transferLogs.length;
            batchSizes.push(batchSize);
            totalTransfers += batchSize;

            if (meta?.timestamp) timestamps.push(meta.timestamp);

            // Extract victims, traps, and mirror contracts
            for (const log of transferLogs) {
                const mirrorContract = log.address?.toLowerCase();
                if (mirrorContract) allMirrorContracts.add(mirrorContract);

                const victim = log.topics[1] ? '0x' + log.topics[1].slice(26) : null;
                const trap = log.topics[2] ? '0x' + log.topics[2].slice(26) : null;

                if (victim) allVictims.add(victim);
                if (trap) allTraps.add(trap);
            }

            analyzedCount++;

            if ((i + 1) % 10 === 0) {
                console.log(`      Analyzed ${i + 1}/${totalTxs} (total transfers: ${totalTransfers})...`);
            }

            await new Promise(r => setTimeout(r, 50));

        } catch (err) {
            console.log(`      ⚠️  Error analyzing ${hash}: ${err.message?.slice(0, 60)}`);
        }
    }

    // Calculate statistics
    const avgBatchSize = batchSizes.length > 0
        ? (batchSizes.reduce((a, b) => a + b, 0) / batchSizes.length).toFixed(1)
        : 0;

    const maxBatchSize = batchSizes.length > 0 ? Math.max(...batchSizes) : 0;
    const minBatchSize = batchSizes.length > 0 ? Math.min(...batchSizes) : 0;

    // Activity span
    let spanHours = 0;
    if (timestamps.length >= 2) {
        const sorted = timestamps.sort((a, b) => a - b);
        spanHours = (sorted[sorted.length - 1] - sorted[0]) / (1000 * 60 * 60);
    }

    console.log('\n   📈 ROUTER USAGE STATISTICS:');
    console.log(`   ├─ Blocks scanned: ${scanData.blocksScanned}`);
    console.log(`   ├─ Total router calls found: ${totalTxs}`);
    console.log(`   ├─ Transactions analyzed: ${analyzedCount}`);
    console.log(`   ├─ Total Transfer events: ${totalTransfers}`);
    console.log(`   ├─ Avg batch size: ${avgBatchSize} transfers per tx`);
    console.log(`   ├─ Min batch size: ${minBatchSize}`);
    console.log(`   ├─ Max batch size: ${maxBatchSize}`);
    console.log(`   ├─ Scan window: ${spanHours.toFixed(1)} hours`);
    console.log(`   ├─ Unique victims: ${allVictims.size}`);
    console.log(`   ├─ Unique traps: ${allTraps.size}`);
    console.log(`   └─ Mirror contracts used: ${allMirrorContracts.size}`);

    // Extrapolate to daily volume
    const routerCallsPerDay = spanHours > 0
        ? (totalTxs / spanHours) * 24
        : 0;
    const transfersPerDay = routerCallsPerDay * parseFloat(avgBatchSize);

    console.log('\n   📊 EXTRAPOLATED DAILY VOLUME:');
    console.log(`   ├─ Estimated router calls/day: ${routerCallsPerDay.toFixed(0)}`);
    console.log(`   └─ Estimated fake transfers/day: ${transfersPerDay.toFixed(0)}`);

    // Batch size distribution
    console.log('\n   📊 BATCH SIZE DISTRIBUTION:');
    const distribution = {};
    batchSizes.forEach(size => {
        const bucket = size < 10 ? '<10' : size < 50 ? '10-50' : size < 100 ? '50-100' : size < 200 ? '100-200' : '200+';
        distribution[bucket] = (distribution[bucket] || 0) + 1;
    });
    Object.entries(distribution).sort().forEach(([bucket, count]) => {
        console.log(`      ${bucket}: ${count} transactions (${((count / batchSizes.length) * 100).toFixed(1)}%)`);
    });

    return {
        totalRouterCalls: totalTxs,
        analyzedCount,
        totalTransfers,
        avgBatchSize,
        minBatchSize,
        maxBatchSize,
        spanHours,
        uniqueVictims: allVictims.size,
        uniqueTraps: allTraps.size,
        mirrorContracts: allMirrorContracts.size,
        routerCallsPerDay: routerCallsPerDay.toFixed(0),
        transfersPerDay: transfersPerDay.toFixed(0),
        batchDistribution: distribution,
        sampleVictims: [...allVictims].slice(0, 10),
        sampleTraps: [...allTraps].slice(0, 10),
        sampleMirrorContracts: [...allMirrorContracts].slice(0, 10),
        sampleTxHashes: txHashes.slice(0, 10),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n' + '='.repeat(80));
    console.log('ATTACKER ROUTER FORENSIC ANALYSIS (FAST EDITION)');
    console.log('='.repeat(80) + '\n');

    // Step 1: Scan blocks for router calls
    const scanData = await findRouterCalls();

    // Step 2: Analyze the calls
    const routerData = await analyzeRouterCalls(scanData);

    if (!routerData) {
        console.log('\n❌ No router activity found in the scanned range.');
        console.log('   Try increasing BLOCKS_TO_SCAN or checking a different time window.');
        return;
    }

    // ─── FINAL SUMMARY ───
    console.log('\n' + '='.repeat(80));
    console.log('FINAL FORENSIC SUMMARY');
    console.log('='.repeat(80));

    console.log('\n📊 ROUTER OPERATION SCALE:');
    console.log(`   ├─ Router Calls in Window: ${routerData.totalRouterCalls}`);
    console.log(`   ├─ Total Fake Transfers: ${routerData.totalTransfers}`);
    console.log(`   ├─ Scan Window: ${routerData.spanHours} hours`);
    console.log(`   ├─ Est. Router Calls/Day: ${routerData.routerCallsPerDay}`);
    console.log(`   └─ Est. Fake Transfers/Day: ${routerData.transfersPerDay}`);

    console.log('\n🎯 BATCHING EFFICIENCY:');
    console.log(`   ├─ Average Batch Size: ${routerData.avgBatchSize} transfers per tx`);
    console.log(`   ├─ Min Batch: ${routerData.minBatchSize}`);
    console.log(`   └─ Max Batch: ${routerData.maxBatchSize}`);

    console.log('\n🎯 VICTIM TARGETING:');
    console.log(`   ├─ Unique Victims (in window): ${routerData.uniqueVictims}`);
    console.log(`   ├─ Unique Traps (in window): ${routerData.uniqueTraps}`);
    console.log(`   └─ Mirror Contracts Used: ${routerData.mirrorContracts}`);

    console.log('\n💡 KEY INSIGHTS:');
    const successPerDay = Math.round(parseInt(routerData.transfersPerDay) * 0.0016);
    console.log(`   1. The attacker batches ${routerData.avgBatchSize} fake transfers per transaction`);
    console.log(`   2. They emit ~${routerData.transfersPerDay} fake transfer events per day`);
    console.log(`   3. At 0.16% success rate → ~${successPerDay} successful steals/day`);
    console.log(`   4. They use ${routerData.mirrorContracts} different mirror contracts`);

    console.log('\n🔗 SAMPLE TRANSACTION HASHES (verify on Etherscan):');
    routerData.sampleTxHashes.slice(0, 5).forEach((hash, i) => {
        console.log(`   ${i + 1}. https://etherscan.io/tx/${hash}`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('DETAILED DATA');
    console.log('='.repeat(80));
    console.log('<<<JSON_START>>>');
    console.log(JSON.stringify({ router: routerData }, null, 2));
    console.log('<<<JSON_END>>>');

    console.log('\n✅ Analysis complete!\n');
}

main().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});