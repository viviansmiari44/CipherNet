#!/usr/bin/env node

import 'dotenv/config';
import fs from 'fs';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import pkg from 'pg';

const { Pool } = pkg;

// ─────────────────────────────────────────────────────────────
// CLI ARGS
// ─────────────────────────────────────────────────────────────

function getArg(name, defaultValue) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return defaultValue;
    return process.argv[idx + 1] ?? defaultValue;
}

const dryRun = process.argv.includes('--dry-run');
const unprocessedOnly = process.argv.includes('--unprocessed-only');

const limit = parseInt(getArg('--limit', '0'), 10); // 0 = all
const offset = parseInt(getArg('--offset', '0'), 10);
const chainFilter = getArg('--chain', '').toLowerCase();
const victimFilter = getArg('--victim', '').toLowerCase();

const outboundLimit = parseInt(getArg('--outbound-limit', '500'), 10);
const frequencyThreshold = parseInt(getArg('--freq', '2'), 10);
const insertBatch = Math.max(1, parseInt(getArg('--insert-batch', '100'), 10));
const scanBatch = Math.max(1, parseInt(getArg('--batch', '2'), 10));
const delayMs = parseInt(getArg('--delay', '1200'), 10);

const outCsv = getArg('--out', 'live_fill_single_cp_pending.csv');
const outJsonl = getArg('--jsonl', 'live_fill_single_cp_pending.jsonl');

// ─────────────────────────────────────────────────────────────
// DATABASE
// EXACT SAME STYLE AS cleanup_pending_low_balance_purge.js
// ─────────────────────────────────────────────────────────────

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'address_poisoning',
    password: process.env.DB_PASSWORD || 'password',
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const CHAIN_ID_MAP = {
    ethereum: 1,
    bsc: 56,
    polygon: 137,
};

const CHAIN_NAME_MAP = {
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
};

const NATIVE_SYMBOL_BY_CHAIN = {
    1: 'ETH',
    56: 'BNB',
    137: 'MATIC',
};

const ALCHEMY_CATEGORIES = {
    1: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
    56: ['external', 'erc20', 'erc721', 'erc1155'],
    137: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
};

// Same stablecoin config style as cleanup script
const STABLECOIN_CONFIG = {
    1: {
        nativeSymbol: 'ETH',
        stablecoins: {
            USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
            USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
            USDP: '0x8E870D67F660D95d5be530380D0eC0bd388289E1',
            TUSD: '0x0000000000085d4780B73119b644AE5ecd22b376',
            FRAX: '0x853d955aCEf822Db058eb8505911ED77F175b99e',
        },
    },
    56: {
        nativeSymbol: 'BNB',
        stablecoins: {
            USDT: '0x55d398326f99059fF775485246999027B3197955',
            USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
            DAI: '0x1AF3F329e8BE154074D8769D1FFa4f058117F6b8',
        },
    },
    137: {
        nativeSymbol: 'MATIC',
        stablecoins: {
            USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
            USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
            USDCe: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
            USDP: '0x2aBE941127B1C078d5e75E7C68A0e3ae3B0b8f1D',
        },
    },
};

// Same major-token whitelist idea as cleanup script
const MAJOR_TOKENS = {
    1: {
        WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
        UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
        PEPE: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
        AAVE: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    },
    56: {
        WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        BTCB: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
        ETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    },
    137: {
        WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
        WBTC: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
        WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        LINK: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    },
};

// Build global VALID_CONTRACTS exactly like cleanup script
const VALID_CONTRACTS = new Set();
const SYMBOL_BY_ADDR = new Map();

for (const chainId of Object.keys(STABLECOIN_CONFIG)) {
    for (const [symbol, addr] of Object.entries(STABLECOIN_CONFIG[chainId].stablecoins)) {
        const lower = addr.toLowerCase();
        VALID_CONTRACTS.add(lower);
        if (!SYMBOL_BY_ADDR.has(lower)) SYMBOL_BY_ADDR.set(lower, symbol);
    }
}

for (const chainId of Object.keys(MAJOR_TOKENS)) {
    for (const [symbol, addr] of Object.entries(MAJOR_TOKENS[chainId])) {
        const lower = addr.toLowerCase();
        VALID_CONTRACTS.add(lower);
        if (!SYMBOL_BY_ADDR.has(lower)) SYMBOL_BY_ADDR.set(lower, symbol);
    }
}

// ─────────────────────────────────────────────────────────────
// EXACT SAME ALCHEMY RPC ROTATION AS cleanup_pending_low_balance_purge.js
// ─────────────────────────────────────────────────────────────

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
        'https://eth-mainnet.g.alchemy.com/v2/alch_vHCE0WOUUK1Mk5G0tyA76',
        'https://eth-mainnet.g.alchemy.com/v2/alch_YHosKAPg0sfm7jDhqvW74',
        'https://eth-mainnet.g.alchemy.com/v2/alch_lTX5t4XwroOB87Xk0AWbY',
        'https://eth-mainnet.g.alchemy.com/v2/alch_9dpiCogyGyxtA4ptC-zIl',
        'https://eth-mainnet.g.alchemy.com/v2/alch_Y8rCHyOCRzZAW_2xLVM5r',
        'https://eth-mainnet.g.alchemy.com/v2/alch_gx9srjXabB0OocIDNitUd',
        'https://eth-mainnet.g.alchemy.com/v2/alch_9P2EBVaMvYP0SPn4zjBUB',
        'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
        'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
        'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
        'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
        'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
        'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LWtYU3_4Y103o',
        'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
        'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et',
    ],
};

const stage2Clients = {
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

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toHex(n) {
    return `0x${Number(n).toString(16)}`;
}

function csvField(value) {
    if (value === null || value === undefined) return '';
    const s = Array.isArray(value) ? value.join('|') : String(value);
    if (/[",\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function isZeroAmount(amount) {
    if (amount === null || amount === undefined) return true;

    const s = String(amount).trim();
    if (!s) return true;
    if (s === '0' || s === '0x0' || s === '0.0' || s === '0.00') return true;

    if (s.startsWith('0x') || s.startsWith('0X')) {
        try {
            return BigInt(s) === 0n;
        } catch {
            return false;
        }
    }

    if (s.includes('.')) {
        try {
            return Number(s) === 0;
        } catch {
            return false;
        }
    }

    try {
        return BigInt(s) === 0n;
    } catch {
        return false;
    }
}

function getAssetInfo(t, chainId) {
    if (t.category === 'external' || t.category === 'internal') {
        return {
            asset: NATIVE_SYMBOL_BY_CHAIN[chainId] || 'ETH',
            amount: t.value ?? '0',
        };
    }

    if (t.category === 'erc20') {
        const contract = t.rawContract?.address?.toLowerCase() || '';
        const symbol =
            t.rawContract?.symbol ||
            SYMBOL_BY_ADDR.get(contract) ||
            'ERC20';

        const amount = t.rawContract?.value || t.value || '0';

        return {
            asset: symbol,
            amount,
        };
    }

    return {
        asset: String(t.category || 'UNKNOWN').toUpperCase(),
        amount: '0',
    };
}

function bumpCounterparty(map, cp, t, chainId) {
    const blockNum = parseInt(t.blockNum, 16) || 0;
    const date = t.metadata?.blockTimestamp || null;
    const { asset, amount } = getAssetInfo(t, chainId);

    const current = map.get(cp);

    if (!current) {
        map.set(cp, {
            count: 1,
            latest: {
                blockNum,
                date,
                asset,
                amount,
            },
        });
        return;
    }

    current.count += 1;

    if (blockNum > current.latest.blockNum) {
        current.latest = {
            blockNum,
            date,
            asset,
            amount,
        };
    }
}

// ─────────────────────────────────────────────────────────────
// FETCH OUTBOUND HISTORY
// Uses same Alchemy request style as cleanup script, but outbound-only
// ─────────────────────────────────────────────────────────────

async function fetchOutboundTransfers(address, chainId, maxCount) {
    const client = stage2Clients[chainId];
    if (!client) {
        return { error: 'no_client', transfers: [], totalRaw: 0 };
    }

    try {
        const checksumAddr = getAddress(address);
        const category = ALCHEMY_CATEGORIES[chainId] || ALCHEMY_CATEGORIES[1];

        const res = await client
            .request({
                method: 'alchemy_getAssetTransfers',
                params: [
                    {
                        fromBlock: '0x0',
                        toBlock: 'latest',
                        fromAddress: checksumAddr,
                        category,
                        maxCount: toHex(maxCount),
                        order: 'desc',
                        withMetadata: true,
                    },
                ],
            })
            .catch(() => null);

        if (!res) {
            return { error: 'rpc_fail', transfers: [], totalRaw: 0 };
        }

        const rawTransfers = Array.isArray(res.transfers) ? res.transfers : [];

        const filtered = [];
        const seen = new Set();

        for (const t of rawTransfers) {
            if (!t.to) continue;

            const toLower = t.to.toLowerCase();
            if (!toLower || toLower === ZERO_ADDR) continue;

            const id =
                t.uniqueId ||
                `${t.hash}-${t.logIndex ?? ''}-${toLower}-${t.blockNum}-${t.value ?? ''}-${t.rawContract?.address ?? ''}-${t.rawContract?.value ?? ''}`;

            if (seen.has(id)) continue;
            seen.add(id);

            // Same trusted filtering idea as cleanup script:
            // native/internal always allowed, ERC20 only if whitelisted.
            if (t.category === 'external' || t.category === 'internal') {
                filtered.push(t);
            } else if (
                t.category === 'erc20' &&
                t.rawContract?.address &&
                VALID_CONTRACTS.has(t.rawContract.address.toLowerCase())
            ) {
                filtered.push(t);
            }
        }

        return {
            error: null,
            transfers: filtered,
            totalRaw: rawTransfers.length,
        };
    } catch (err) {
        return {
            error: err.message || 'unknown_error',
            transfers: [],
            totalRaw: 0,
        };
    }
}

// ─────────────────────────────────────────────────────────────
// INSERT QUEUE
// ─────────────────────────────────────────────────────────────

const insertQueue = [];

let totalQueued = 0;
let totalInserted = 0;
let totalSkipped = 0;
let totalWouldInsert = 0;

function queueInsert(row) {
    insertQueue.push(row);
    totalQueued += 1;
}

async function flushInserts(force = false) {
    if (insertQueue.length === 0) return;
    if (!force && insertQueue.length < insertBatch) return;

    const rows = insertQueue.splice(0, insertQueue.length);

    if (dryRun) {
        totalWouldInsert += rows.length;
        console.log(`[DRY-RUN] Would insert ${rows.length} rows. Total would insert: ${totalWouldInsert}`);
        return;
    }

    const db = await pool.connect();

    try {
        await db.query('BEGIN');

        let added = 0;

        for (let i = 0; i < rows.length; i += 100) {
            const chunk = rows.slice(i, i + 100);

            const values = [];
            const placeholders = [];
            let idx = 1;

            for (const r of chunk) {
                placeholders.push(
                    `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
                );

                values.push(
                    r.chain,
                    r.counterparty,
                    r.victim,
                    r.last_transfer_date,
                    r.last_transfer_amount,
                    r.last_transfer_asset,
                    r.last_transfer_block,
                    r.processed
                );
            }

            const sql = `
        INSERT INTO pending_targets (
          chain,
          counterparty,
          victim,
          last_transfer_date,
          last_transfer_amount,
          last_transfer_asset,
          last_transfer_block,
          processed
        )
        VALUES ${placeholders.join(',')}
        ON CONFLICT (chain, counterparty, victim) DO NOTHING
      `;

            const result = await db.query(sql, values);
            added += result.rowCount || 0;
        }

        await db.query('COMMIT');

        totalInserted += added;
        totalSkipped += rows.length - added;

        console.log(
            `[+] Inserted ${added} new counterparty rows. ` +
            `Duplicates skipped: ${rows.length - added}. ` +
            `Total inserted: ${totalInserted}`
        );
    } catch (err) {
        await db.query('ROLLBACK').catch(() => { });
        console.error(`[-] Insert batch failed: ${err.message}`);
    } finally {
        db.release();
    }
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
    console.log('\n==================================================');
    console.log(' LIVE FILL: pending_targets single-counterparty victims');
    console.log('==================================================');
    console.log(`Mode:                 ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
    console.log(`Limit:                ${limit === 0 ? 'ALL' : limit}`);
    console.log(`Offset:               ${offset}`);
    console.log(`Chain filter:         ${chainFilter || 'none'}`);
    console.log(`Victim filter:        ${victimFilter || 'none'}`);
    console.log(`Unprocessed only:     ${unprocessedOnly}`);
    console.log(`Outbound limit:       ${outboundLimit}`);
    console.log(`Frequency threshold:  ${frequencyThreshold}`);
    console.log(`Insert batch:         ${insertBatch}`);
    console.log(`Scan batch size:      ${scanBatch}`);
    console.log(`Delay ms:             ${delayMs}`);
    console.log(`CSV:                  ${outCsv}`);
    console.log(`JSONL:                ${outJsonl}`);
    console.log('==================================================\n');

    const conditions = [];
    const params = [];

    if (chainFilter) {
        params.push(chainFilter);
        conditions.push(`LOWER(chain) = $${params.length}`);
    }

    if (victimFilter) {
        params.push(victimFilter);
        conditions.push(`LOWER(victim) = $${params.length}`);
    }

    if (unprocessedOnly) {
        conditions.push(`processed = false`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitSql = limit > 0 ? `LIMIT ${limit}` : 'LIMIT ALL';

    const query = `
    SELECT
      chain,
      victim,
      MIN(counterparty) AS counterparty,
      COUNT(DISTINCT counterparty) AS cp_count
    FROM pending_targets
    ${where}
    GROUP BY chain, victim
    HAVING COUNT(DISTINCT counterparty) = 1
    ORDER BY chain, victim
    ${limitSql} OFFSET ${offset}
  `;

    console.log('[DEBUG] Querying pending_targets for single-counterparty victims...');

    const { rows } = await pool.query(query, params);

    console.log(`Found ${rows.length} single-counterparty victims.\n`);

    if (rows.length === 0) {
        await pool.end();
        return;
    }

    const header = [
        'chain',
        'victim',
        'pending_counterparty',
        'verdict',
        'outbound_transfers_seen',
        'pending_frequency',
        'missed_count',
        'missed_counterparties',
        'queued_inserts',
        'error',
    ];

    fs.writeFileSync(outCsv, header.join(',') + '\n');

    const jsonStream = outJsonl ? fs.createWriteStream(outJsonl) : null;

    const stats = {
        total: rows.length,
        okSingle: 0,
        missedVictims: 0,
        pendingNotConfirmed: 0,
        noOutbound: 0,
        rpcFail: 0,
        unknownChain: 0,
        errors: 0,
    };

    for (let i = 0; i < rows.length; i += scanBatch) {
        const batch = rows.slice(i, i + scanBatch);

        const results = await Promise.all(
            batch.map(async (row) => {
                const chain = String(row.chain || '').toLowerCase();
                const victim = String(row.victim || '').toLowerCase();
                const pendingCp = String(row.counterparty || '').toLowerCase();
                const chainId = CHAIN_ID_MAP[chain];

                const result = {
                    chain,
                    victim,
                    pendingCp,
                    verdict: 'UNKNOWN',
                    error: null,
                    outboundTransfersSeen: 0,
                    pendingFrequency: 0,
                    missed: [],
                    queuedInserts: 0,
                };

                if (!chainId) {
                    result.verdict = 'UNKNOWN_CHAIN';
                    result.error = 'unknown_chain';
                    stats.unknownChain++;
                    stats.errors++;
                    return result;
                }

                const fetched = await fetchOutboundTransfers(victim, chainId, outboundLimit);

                if (fetched.error) {
                    result.verdict = 'RPC_FAIL';
                    result.error = fetched.error;
                    stats.rpcFail++;
                    stats.errors++;
                    return result;
                }

                result.outboundTransfersSeen = fetched.transfers.length;

                if (fetched.transfers.length === 0) {
                    result.verdict = 'NO_OUTBOUND_HISTORY';
                    stats.noOutbound++;
                    return result;
                }

                const cpCounts = new Map();

                for (const t of fetched.transfers) {
                    const cp = t.to.toLowerCase();
                    bumpCounterparty(cpCounts, cp, t, chainId);
                }

                const pendingData = cpCounts.get(pendingCp);
                result.pendingFrequency = pendingData?.count || 0;

                const missed = [];

                for (const [cp, data] of cpCounts.entries()) {
                    if (cp === pendingCp) continue;
                    if (data.count < frequencyThreshold) continue;
                    if (!data.latest) continue;
                    if (isZeroAmount(data.latest.amount)) continue;

                    missed.push({
                        cp,
                        count: data.count,
                        latest: data.latest,
                    });
                }

                result.missed = missed;

                if (missed.length > 0) {
                    result.verdict = 'MISSED_COUNTERPARTY';
                    stats.missedVictims++;

                    for (const m of missed) {
                        queueInsert({
                            chain,
                            victim,
                            counterparty: m.cp,
                            last_transfer_date: m.latest.date || null,
                            last_transfer_amount: String(m.latest.amount),
                            last_transfer_asset: m.latest.asset || null,
                            last_transfer_block: m.latest.blockNum || null,
                            processed: false,
                        });

                        result.queuedInserts += 1;
                    }
                } else if (result.pendingFrequency < frequencyThreshold) {
                    result.verdict = 'PENDING_CP_NOT_CONFIRMED';
                    stats.pendingNotConfirmed++;
                } else {
                    result.verdict = 'OK_SINGLE';
                    stats.okSingle++;
                }

                return result;
            })
        );

        for (const r of results) {
            const missedCsv = r.missed.map(m => `${m.cp}:${m.count}`);

            const csvRow = [
                r.chain,
                r.victim,
                r.pendingCp,
                r.verdict,
                r.outboundTransfersSeen,
                r.pendingFrequency,
                r.missed.length,
                missedCsv,
                r.queuedInserts,
                r.error || '',
            ]
                .map(csvField)
                .join(',');

            fs.appendFileSync(outCsv, csvRow + '\n');

            if (jsonStream) {
                jsonStream.write(JSON.stringify(r) + '\n');
            }

            if (r.verdict === 'MISSED_COUNTERPARTY') {
                console.log(
                    `[MISS] ${r.chain} victim=${r.victim} pending=${r.pendingCp} ` +
                    `missed=${r.missed.length} queued=${r.queuedInserts}`
                );
            } else if (r.verdict === 'PENDING_CP_NOT_CONFIRMED') {
                console.log(
                    `[WARN] ${r.chain} victim=${r.victim} pending=${r.pendingCp} ` +
                    `pending_freq=${r.pendingFrequency}`
                );
            } else if (r.verdict === 'RPC_FAIL') {
                console.log(`[ERR ] ${r.chain} victim=${r.victim} RPC_FAIL: ${r.error}`);
            }
        }

        if (insertQueue.length >= insertBatch) {
            await flushInserts();
        }

        console.log(
            `Progress: ${Math.min(i + scanBatch, rows.length)} / ${rows.length} | ` +
            `Missed victims: ${stats.missedVictims} | ` +
            `Queued: ${totalQueued} | ` +
            `${dryRun ? 'Would insert' : 'Inserted'}: ${dryRun ? totalWouldInsert : totalInserted}`
        );

        if (i + scanBatch < rows.length) {
            await sleep(delayMs);
        }
    }

    await flushInserts(true);

    if (jsonStream) {
        jsonStream.end();
    }

    console.log('\n==================================================');
    console.log(' SUMMARY');
    console.log('==================================================');
    console.log(`Total victims audited:        ${stats.total}`);
    console.log(`OK single:                    ${stats.okSingle}`);
    console.log(`Victims with missed CP:       ${stats.missedVictims}`);
    console.log(`Pending CP not confirmed:     ${stats.pendingNotConfirmed}`);
    console.log(`No outbound history:          ${stats.noOutbound}`);
    console.log(`RPC fail:                     ${stats.rpcFail}`);
    console.log(`Unknown chain:                ${stats.unknownChain}`);
    console.log(`Errors:                       ${stats.errors}`);
    console.log('--------------------------------------------------');
    console.log(`Total queued for insertion:   ${totalQueued}`);

    if (dryRun) {
        console.log(`Dry-run would insert:        ${totalWouldInsert}`);
    } else {
        console.log(`Total inserted:              ${totalInserted}`);
        console.log(`Total duplicates skipped:    ${totalSkipped}`);
    }

    console.log(`CSV:                         ${outCsv}`);
    console.log(`JSONL:                       ${outJsonl}`);
    console.log('==================================================\n');

    await pool.end();
}

main().catch(async (err) => {
    console.error('Fatal error:', err);
    await flushInserts(true).catch(() => { });
    await pool.end().catch(() => { });
    process.exit(1);
});