import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

// 🛡️ PREVENT HARD CRASHES ON NETWORK/DNS HICCUPS
process.on('unhandledRejection', (reason, promise) => {
    console.warn(`\n⚠️  [Network Hiccup] Caught Unhandled Rejection. Continuing safely...`);
    console.warn(`   Reason: ${reason?.message || reason}`);
});

process.on('uncaughtException', (err) => {
    console.warn(`\n⚠️  [Network Hiccup] Caught Uncaught Exception. Continuing safely...`);
    console.warn(`   Error: ${err.message}`);
});

// ─── CLI Flags & Configuration ───
const isDryRun = process.argv.includes('--dry-run');
const TX_LIMIT_HEX = '0x64';
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 600;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

console.log('\n==================================================');
if (isDryRun) {
    console.log('[🔍 DRY-RUN MODE ACTIVE]');
    console.log('No database records will be modified.');
    console.log('Invalid targets WOULD be removed from pending_targets.');
} else {
    console.log('[⚠️  LIVE EXECUTION MODE]');
    console.log('Invalid targets (Freq<2 / Fake Dust) WILL be removed from pending_targets.');
    console.log('(Bot & Balance checks are DISABLED for this fast run)');
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
        'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-', 'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr', 'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A', 'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
        'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI', 'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
    ],
    polygon: [
        'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD', 'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5', 'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw', 'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
        'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE', 'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
    ],
    ethereum: [
        'https://eth-mainnet.g.alchemy.com/v2/alch_vHCE0WOUUK1Mk5G0tyA76', 'https://eth-mainnet.g.alchemy.com/v2/alch_YHosKAPg0sfm7jDhqvW74',
        'https://eth-mainnet.g.alchemy.com/v2/alch_lTX5t4XwroOB87Xk0AWbY', 'https://eth-mainnet.g.alchemy.com/v2/alch_9dpiCogyGyxtA4ptC-zIl',
        'https://eth-mainnet.g.alchemy.com/v2/alch_Y8rCHyOCRzZAW_2xLVM5r', 'https://eth-mainnet.g.alchemy.com/v2/alch_gx9srjXabB0OocIDNitUd',
        'https://eth-mainnet.g.alchemy.com/v2/alch_9P2EBVaMvYP0SPn4zjBUB', 'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
        'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA', 'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
        'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS', 'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
        'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o', 'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
        'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
    ],
};

// ─── Stage 2 Public Clients (Alchemy-Only) ───
const stage2Clients = {
    1: createPublicClient({ chain: mainnet, transport: fallback(ALCHEMY_RPCS.ethereum.map(url => http(url, { timeout: 15000 })), { retryCount: 3 }) }),
    56: createPublicClient({ chain: bsc, transport: fallback(ALCHEMY_RPCS.bsc.map(url => http(url, { timeout: 15000 })), { retryCount: 3 }) }),
    137: createPublicClient({ chain: polygon, transport: fallback(ALCHEMY_RPCS.polygon.map(url => http(url, { timeout: 15000 })), { retryCount: 3 }) }),
};

// ─── Chain & Stablecoin Configuration ───
const CHAIN_NAME_MAP = { 1: 'ethereum', 56: 'bsc', 137: 'polygon' };
const CHAIN_ID_MAP = { ethereum: 1, bsc: 56, polygon: 137 };

const ALCHEMY_CATEGORIES = {
    1: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
    56: ['external', 'erc20', 'erc721', 'erc1155'],
    137: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
};

const STABLECOIN_CONFIG = {
    1: {
        coingeckoId: 'ethereum', nativeSymbol: 'ETH',
        stablecoins: { USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7', USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F', USDP: '0x8E870D67F660D95d5be530380D0eC0bd388289E1', TUSD: '0x0000000000085d4780B73119b644AE5ecd22b376', FRAX: '0x853d955aCEf822Db058eb8505911ED77F175b99e' },
        decimals: { USDT: 6, USDC: 6, DAI: 18, USDP: 18, TUSD: 18, FRAX: 18, ETH: 18 },
    },
    56: {
        coingeckoId: 'binancecoin', nativeSymbol: 'BNB',
        stablecoins: { USDT: '0x55d398326f99059fF775485246999027B3197955', USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', DAI: '0x1AF3F329e8BE154074D8769D1FFa4f058117F6b8' },
        decimals: { USDT: 18, USDC: 18, BUSD: 18, DAI: 18, BNB: 18 },
    },
    137: {
        coingeckoId: 'matic-network', nativeSymbol: 'MATIC',
        stablecoins: { USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', USDCe: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', USDP: '0x2aBE941127B1C078d5e75E7C68A0e3ae3B0b8f1D' },
        decimals: { USDT: 6, USDC: 6, USDCe: 6, DAI: 18, USDP: 18, MATIC: 18 },
    },
};

// 🚀 Whitelist of major legitimate blue-chip tokens (WBTC, WETH, LINK, PEPE, etc.)
const MAJOR_TOKENS = {
    1: [ // Ethereum
        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
        '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
        '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
        '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
        '0x6982508145454Ce325dDbE47a25d4ec3d2311933', // PEPE
        '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', // AAVE
    ],
    56: [ // BSC
        '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB (Binance-Peg Bitcoin)
        '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // Binance-Peg ETH
        '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // CAKE
    ],
    137: [ // Polygon
        '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
        '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', // WBTC
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
        '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', // LINK
    ]
};

// 🚀 Build the master whitelist (Stablecoins + Major Blue-Chips)
const VALID_CONTRACTS = new Set();
for (const chainId of Object.keys(STABLECOIN_CONFIG)) {
    for (const addr of Object.values(STABLECOIN_CONFIG[chainId].stablecoins)) {
        VALID_CONTRACTS.add(addr.toLowerCase());
    }
}
for (const chainId of Object.keys(MAJOR_TOKENS)) {
    for (const addr of MAJOR_TOKENS[chainId]) {
        VALID_CONTRACTS.add(addr.toLowerCase());
    }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchAllRows(table, selectColumns) {
    const PAGE_SIZE = 1000; let offset = 0; let allRows = [];
    while (true) {
        const { data, error } = await supabase.from(table).select(selectColumns).range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error; if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < PAGE_SIZE) break; offset += PAGE_SIZE;
    }
    return allRows;
}

// ─── Fetch & Filter Transaction History ───
async function fetchTransactionHistory(address, chainId) {
    const client = stage2Clients[chainId]; if (!client) return null;
    try {
        const checksumAddr = getAddress(address); const category = ALCHEMY_CATEGORIES[chainId] || ALCHEMY_CATEGORIES[1];
        const [outRes] = await Promise.all([
            client.request({ method: 'alchemy_getAssetTransfers', params: [{ fromBlock: '0x0', toBlock: 'latest', fromAddress: checksumAddr, category, maxCount: TX_LIMIT_HEX, order: 'desc', withMetadata: true }] }).catch(() => null),
        ]);

        const transfers = [];

        // 🚀 FILTER OUTBOUND: Only keep Native or Real Stablecoins
        if (outRes?.transfers) {
            for (const t of outRes.transfers) {
                if (t.category === 'external' || t.category === 'internal') {
                    transfers.push({ ...t, direction: 'out' });
                } else if (t.category === 'erc20' && t.rawContract?.address && VALID_CONTRACTS.has(t.rawContract.address.toLowerCase())) {
                    transfers.push({ ...t, direction: 'out' });
                }
                // Ignore fake ERC20s, NFTs, and other attacker dust
            }
        }

        if (transfers.length === 0) return [];

        const unique = []; const seen = new Set();
        for (const t of transfers) { const id = t.uniqueId || `${t.hash}-${t.direction}`; if (!seen.has(id)) { seen.add(id); unique.push(t); } }
        unique.sort((a, b) => parseInt(b.blockNum, 16) - parseInt(a.blockNum, 16));
        return unique.slice(0, parseInt(TX_LIMIT_HEX, 16));
    } catch (err) { return null; }
}

async function purgePendingTargets(idsToDelete) {
    if (idsToDelete.size === 0) return;
    const idList = Array.from(idsToDelete);
    console.log(`\n[🧹 PURGING] Removing ${idList.length} invalid rows from pending_targets...`);
    if (isDryRun) { console.log(`  [DRY-RUN] Would remove.`); return; }
    for (let j = 0; j < idList.length; j += 100) {
        const chunk = idList.slice(j, j + 100);
        const { error } = await supabase.from('pending_targets').delete().in('id', chunk);
        if (error) console.error(`  [-] delete error:`, error.message);
    }
    console.log(`  [+] ${idList.length} rows removed.`);
}

async function runCleanup() {
    console.log('\n[+] Phase 1: Fetching ALL rows from pending_targets...\n');

    let targetsList = [];
    try { targetsList = await fetchAllRows('pending_targets', 'id, chain, counterparty, victim'); }
    catch (err) { console.error('[-] Error:', err.message); return; }

    if (targetsList.length === 0) { console.log('[✓] pending_targets is empty.'); return; }

    // Group rows by victim to save RPC calls (1 call per victim, check freq for all their rows)
    const victimRowsMap = new Map();
    for (const row of targetsList) {
        if (!row.victim || !row.chain || !row.id) continue;
        if (row.victim.toLowerCase() === ZERO_ADDR) continue;
        const cid = CHAIN_ID_MAP[row.chain.toLowerCase()]; if (!cid) continue;
        const key = `${row.victim.toLowerCase()}_${cid}`;
        if (!victimRowsMap.has(key)) victimRowsMap.set(key, []);
        victimRowsMap.get(key).push(row);
    }

    const uniqueVictims = Array.from(victimRowsMap.keys());
    console.log(`[+] Total rows: ${targetsList.length}`);
    console.log(`[+] Unique victims to analyze: ${uniqueVictims.length}\n`);

    const idsToDelete = new Set();
    let analyzed = 0, kept = 0, deletedLowFreq = 0, rpcFailCount = 0;

    for (let i = 0; i < uniqueVictims.length; i += BATCH_SIZE) {
        const batchKeys = uniqueVictims.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(batchKeys.map(async (key) => {
            const [address, chainIdStr] = key.split('_');
            const chainId = parseInt(chainIdStr);

            // Fetch filtered transaction history directly (No balance/bot checks!)
            const transfers = await fetchTransactionHistory(address, chainId);

            return { key, address, chainId, transfers };
        }));

        for (const res of results) {
            analyzed++;
            const rowsForVictim = victimRowsMap.get(res.key);

            if (res.transfers === null) {
                // RPC completely failed -> Keep rows (safe fallback)
                rpcFailCount += rowsForVictim.length;
                kept += rowsForVictim.length;
            } else {
                // Check Frequency for EACH row individually against REAL assets
                const outTransfers = res.transfers.filter(t => t.direction === 'out');

                for (const row of rowsForVictim) {
                    const cp = row.counterparty.toLowerCase();
                    // Count how many times victim sent to THIS specific counterparty
                    const freq = outTransfers.filter(t => t.to?.toLowerCase() === cp).length;

                    if (freq < 2) {
                        idsToDelete.add(row.id);
                        deletedLowFreq++;
                    } else {
                        kept++;
                    }
                }
            }
        }

        if ((i + BATCH_SIZE) % 80 === 0 || i + BATCH_SIZE >= uniqueVictims.length) {
            console.log(`  └─ Progress: ${Math.min(i + BATCH_SIZE, uniqueVictims.length)} / ${uniqueVictims.length} | Kept: ${kept} | Del(LowFreq/FakeDust): ${deletedLowFreq} | RPC Fail (Kept): ${rpcFailCount}`);
        }

        if (idsToDelete.size >= 1000) {
            await purgePendingTargets(idsToDelete);
            idsToDelete.clear();
        }

        if (i + BATCH_SIZE < uniqueVictims.length) await sleep(BATCH_DELAY_MS);
    }

    if (idsToDelete.size > 0) await purgePendingTargets(idsToDelete);

    console.log('\n==================================================');
    console.log(' FAST CLEANUP SUMMARY (Fake Dust Filter)');
    console.log('==================================================');
    console.log(`  ├─ Victims Analyzed:  ${analyzed}`);
    console.log(`  ├─ Rows KEPT:         ${kept} (Freq >= 2 on Real Assets)`);
    console.log(`  ├─ Rows DELETED:      ${deletedLowFreq}`);
    console.log(`  │  └─ Attacker Traps / Freq<2:  ${deletedLowFreq}`);
    console.log(`  └─ RPC Fails (Kept safely): ${rpcFailCount}`);
    console.log('==================================================\n');
}

runCleanup();