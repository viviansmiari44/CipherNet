// audit_pending_targets_cex.mjs

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
    console.log('Pending targets with CEX victims WILL BE DELETED in batches of 1000.');
} else {
    console.log('[🔍 DRY-RUN MODE ACTIVE]');
    console.log('No database records will be modified.');
}
console.log('==================================================\n');

// 🚀 HELPER: Delete a batch of CEX targets
async function deleteCexBatch(targetsToDelete) {
    const ids = targetsToDelete.map(t => t.id);
    let deletedCount = 0;

    for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { error } = await supabase.from('pending_targets').delete().in('id', batch);

        if (error) {
            console.error(`[❌ ERROR] Failed to delete batch: ${error.message}`);
        } else {
            deletedCount += batch.length;
        }
    }
    console.log(`\n[✅ AUTO-DELETE SUCCESS] Deleted ${deletedCount} CEX victim pending targets in this batch.\n`);
    return deletedCount;
}

async function auditPendingTargets() {
    await loadCexBlacklist();
    console.log('[+] Scanning ALL pending_targets for CEX victims (Static + Behavioral)...\n');

    const PAGE_SIZE = 1000;
    let offset = 0;
    let totalScanned = 0;
    let totalDeletedOverall = 0;
    const cexTargetsFound = [];

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 600;

    while (true) {
        const { data, error } = await supabase
            .from('pending_targets')
            .select('id, chain, victim, counterparty')
            // 🚀 REMOVED .eq('processed', false) to scan ALL targets
            .range(offset, offset + PAGE_SIZE - 1)
            .order('id', { ascending: false });

        if (error || !data || data.length === 0) break;

        for (let i = 0; i < data.length; i += BATCH_SIZE) {
            const batch = data.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(batch.map(async (target) => {
                const victimLower = target.victim?.toLowerCase();

                // CHECK 1: Static Blacklist (Instant, 0 RPC cost)
                if (victimLower && CEX_BLACKLIST.has(victimLower)) {
                    return { target, isCex: true, reason: 'Static Blacklist Match (Hot Wallet)' };
                }

                // CHECK 2: Behavioral Analysis (RPC Call)
                if (victimLower) {
                    // Determine chainId based on target.chain
                    let chainId = 1;
                    const chainLower = target.chain?.toLowerCase();
                    if (chainLower === 'bsc') chainId = 56;
                    else if (chainLower === 'polygon') chainId = 137;

                    const behaviorResult = await isCexDepositBehavior(target.victim, chainId);
                    if (behaviorResult.isCex) {
                        return { target, isCex: true, reason: behaviorResult.reason };
                    }
                }

                return { target, isCex: false, reason: '' };
            }));

            for (const res of results) {
                if (res.isCex) {
                    const targetWithReason = { ...res.target, reason: res.reason };
                    cexTargetsFound.push(targetWithReason);

                    // 🚀 SAFE PRINTING: Removed clearLine/cursorTo to prevent PM2 TTY errors
                    console.log(`\n🚫 [${cexTargetsFound.length}] VICTIM IS CEX: ${targetWithReason.victim}`);
                    console.log(`   ↳ Reason:       ${targetWithReason.reason}`);
                    console.log(`   ↳ Counterparty: ${targetWithReason.counterparty}`);
                    console.log(`   ↳ Chain:        ${targetWithReason.chain}`);

                    let explorer = 'https://etherscan.io/address/';
                    if (targetWithReason.chain?.toLowerCase() === 'bsc') explorer = 'https://bscscan.com/address/';
                    else if (targetWithReason.chain?.toLowerCase() === 'polygon') explorer = 'https://polygonscan.com/address/';

                    console.log(`   ↳ Explorer:     ${explorer}${targetWithReason.victim}`);
                    console.log('   ─────────────────────────────────────────────────');
                }
            }

            // 🚀 AUTO-DELETE EVERY 1000 FOUND (Only in Live Mode)
            if (isLiveMode && cexTargetsFound.length >= 1000) {
                console.log(`\n[🧹 AUTO-DELETE TRIGGERED] Reached 1000 CEX victims. Deleting batch...`);
                const deleted = await deleteCexBatch(cexTargetsFound);
                totalDeletedOverall += deleted;
                cexTargetsFound.length = 0; // Clear the array for the next batch
            }

            totalScanned += batch.length;
            console.log(`  [Progress] Scanned ${totalScanned} pending targets... Current batch has ${cexTargetsFound.length} CEX victims.`);

            if (i + BATCH_SIZE < data.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }

        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    // Delete any remaining found targets (less than 1000)
    if (isLiveMode && cexTargetsFound.length > 0) {
        console.log(`\n[🧹 FINAL AUTO-DELETE] Deleting remaining ${cexTargetsFound.length} CEX victims...`);
        const deleted = await deleteCexBatch(cexTargetsFound);
        totalDeletedOverall += deleted;
    }

    console.log(`\n\n[✅ SCAN COMPLETE] Scanned ${totalScanned} pending targets.`);
    console.log(`[🚨 TOTAL ALERT] Found and processed ${totalDeletedOverall > 0 ? totalDeletedOverall : cexTargetsFound.length} targets where the victim is a CEX.\n`);

    if (!isLiveMode && cexTargetsFound.length > 0) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('[🔍 DRY-RUN] No pending targets were deleted.');
        console.log('[💡 ACTION] Review the addresses printed above on the Block Explorer.');
        console.log('[💡 ACTION] If confirmed, run: pm2 start audit_pending_targets_cex.mjs --name "cex-audit-pt" --no-autorestart -- --live\n');
    } else if (isLiveMode) {
        console.log(`[✅ SUCCESS] Successfully deleted ${totalDeletedOverall} CEX victim pending targets in total.`);
    } else {
        console.log('[✅ CLEAN] No CEX victims found in pending targets.\n');
    }
}

auditPendingTargets().catch(err => {
    console.error('[❌ FATAL] Unhandled exception:', err);
    process.exit(1);
});