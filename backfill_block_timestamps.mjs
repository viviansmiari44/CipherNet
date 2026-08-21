// backfill_last_transfers.mjs
// Usage: node backfill_last_transfers.mjs
// Backfills last_transfer_date, last_transfer_amount, last_transfer_asset for pending_targets and traps

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CHAIN_CONFIGS = {
  1: {
    name: 'ethereum',
    urls: [
      'https://eth-mainnet.g.alchemy.com/v2/alch_0hEit_izstW7cL9Gyz_T_',
      'https://eth-mainnet.g.alchemy.com/v2/alch_A0-PobPGMyEAZ31xva35A',
      'https://eth-mainnet.g.alchemy.com/v2/alch_D_FWof7AulPvkFHZnDlFn',
      'https://eth-mainnet.g.alchemy.com/v2/alch_3smRQUoTzfj_NPiK6451s',
      'https://eth-mainnet.g.alchemy.com/v2/alch_xp0ppatuXONHI2pClS7_M',
      'https://eth-mainnet.g.alchemy.com/v2/alch_hmts-IFXko93muF8BaX5Q',
      'https://eth-mainnet.g.alchemy.com/v2/alch_8fJp6NiVdGxCOljdKCDZi',
      'https://eth-mainnet.g.alchemy.com/v2/alch_4euFfPOpJDglYNRQYKWhO',
      'https://eth-mainnet.g.alchemy.com/v2/alch_bjwK80RPIzP774OVkp-vE',
      'https://eth-mainnet.g.alchemy.com/v2/alch_LcoDsDwyyl7fbYUvffKYC',
      'https://eth-mainnet.g.alchemy.com/v2/alch_btTtYZmxG7VfNjY_jZIJr',
      'https://eth-mainnet.g.alchemy.com/v2/alch_IP1SsCj0wqzZqrvhH_Rv5',
      'https://eth-mainnet.g.alchemy.com/v2/alch_1O0yoHMsrXCOe3lOHu7dc',
      'https://eth-mainnet.g.alchemy.com/v2/alch_w2NDE7Pilr5cpIPb51Wsx',
      'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
      'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
      'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
      'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
      'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
      'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
      'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
      'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
    ]
  },
  56: {
    name: 'bsc',
    urls: [
      'https://bnb-mainnet.g.alchemy.com/v2/alch_DMA2jJjcrOWJ9R10_Fx5k',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_bBpETSAAmA8VjshNMBkLn',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_VJ0_4LOGnzlbo7NPkqhg-',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_3_Bpj7ORVica5UbSitOXm',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_AMGRdQ1DjpCspfYgaJWk8',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_n0iXFk0U2atdbZFyJw3Vd',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_uG-HMTi_h9uFfpZ0IPtUC',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_Of_5h7lrnjaNskMMN1m_O',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_JXJn_G0u41v-ORLH-PLvm',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_6DY1YYDbhjfaDTRvVlb8E',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_FY7h0VVmtvSHzWHULlBYD',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_e2hNo6urdy-p9K3iCKBRz',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_wT_5s_3jEKZRUHS6-9qlB',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_xo7rkNtpCG3XTTte_34Oe',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
      'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
    ]
  },
  137: {
    name: 'polygon',
    urls: [
      'https://polygon-mainnet.g.alchemy.com/v2/alch_qfGoxus-szPvLI44z9YWw',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_fcNea90VExKd5DNvSguRa',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_sr3YXfVMNVZJ5qSCU0kyD',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_6bgVHMAQFQbOqC7cHZ5tU',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_e1PIp-UVXQ1jZWINkbmDm',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_n9bFKwbW1lFSXd-CTjFA8',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_VXeIGTUmcC8G4X4a4Lx8e',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_adXxpjamb8lNBSSnH-dZF',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_vUHRCAI2B5z-NVbge5MjR',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_YXuYd2T6nO-_ASx3VyYd8',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_o4lfkzzsAyG0uEFq9cfx0',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_6vT8KHKebKLX2IzQCgHpo',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_C7D8h3Jq99k3QweZHq1Ip',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_1t_00WgSdtEqIYYRY8LdA',
      'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
      'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
    ]
  }
};

// ─── Performance Settings ───
const PAGE_SIZE = 100;              // Records fetched per page
const RPC_CONCURRENCY = 5;          // Parallel Alchemy queries
const RATE_LIMIT_DELAY = 3000;      // Delay between batches (ms)

let rateLimitCount = 0;
let lastRateLimitTime = 0;

// ─── Custom Round-Robin RPC Rotator ───
class RPCRotator {
  constructor(urls) {
    this.urls = urls;
    this.currentIndex = 0;
  }

  async fetchAlchemyTransfers(params) {
    let attempts = 0;
    let lastError = null;

    while (attempts < this.urls.length) {
      // Grab current URL and immediately cycle to the next to naturally balance load
      const url = this.urls[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.urls.length;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "alchemy_getAssetTransfers",
            params: params
          })
        });

        if (!response.ok) {
          throw new Error(`HTTP Error: ${response.status}`);
        }

        const data = await response.json();

        if (data.error) {
          throw new Error(data.error.message);
        }

        return data.result;
      } catch (error) {
        lastError = error;
        attempts++;
        // Caught an error (rate limit or network), loop restarts and hits the next URL instantly.
      }
    }

    // Only throw to the main script if we've exhausted all URLs in the pool without success
    throw new Error(`All ${this.urls.length} RPCs rate-limited or failed. Last error: ${lastError?.message}`);
  }
}

// ─── Pre-flight Summary Function ───
async function showPreFlightSummary() {
  console.log('\n📊 [Pre-flight] Analyzing database state before starting...\n');

  const { count: totalActive } = await supabaseAdmin
    .from('traps')
    .select('*', { count: 'exact', head: true })
    .eq('is_caught', false);

  const { count: pendingCount } = await supabaseAdmin
    .from('traps')
    .select('*', { count: 'exact', head: true })
    .eq('is_caught', false)
    .is('last_transfer_date', null);

  const { count: processedCount } = await supabaseAdmin
    .from('traps')
    .select('*', { count: 'exact', head: true })
    .eq('is_caught', false)
    .not('last_transfer_date', 'is', null);

  const { count: noTransferCount } = await supabaseAdmin
    .from('traps')
    .select('*', { count: 'exact', head: true })
    .eq('is_caught', false)
    .eq('last_transfer_date', '1970-01-01T00:00:00.000Z');

  const realCompletedCount = Math.max(0, (processedCount || 0) - (noTransferCount || 0));

  console.log(`🌍 [GLOBAL] Active Traps Overview:`);
  console.log(`   ⏳ Pending backfill (never processed):  ${pendingCount || 0}`);
  console.log(`   ✅ Have REAL transfer data:             ${realCompletedCount}`);
  console.log(`   ⚠️  Processed but NO transfer found:     ${noTransferCount || 0}`);
  console.log(`   📊 Total active traps:                  ${totalActive || 0}`);
  console.log('');

  console.log('🚀 Starting backfill process...\n');
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ─── Fetch Transfer Data Using the RPC Rotator ───
async function fetchLastTransfer(rotator, fromAddress, toAddress, chainName) {
  try {
    const categories = chainName === 'bsc'
      ? ['external', 'erc20']
      : ['external', 'internal', 'erc20'];

    const result = await rotator.fetchAlchemyTransfers([{
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: fromAddress,
      toAddress: toAddress,
      category: categories,
      order: 'desc',
      maxCount: '0x1',
      withMetadata: true
    }]);

    if (result?.transfers?.length > 0) {
      const transfer = result.transfers[0];
      const blockNum = parseInt(transfer.blockNum, 16);
      const timestamp = new Date(transfer.metadata?.blockTimestamp).toISOString();

      let amount = '0';
      let asset = chainName === 'ethereum' ? 'ETH' : chainName === 'bsc' ? 'BNB' : 'MATIC';

      if (transfer.category === 'external') {
        amount = transfer.value?.toString() || '0';
      } else if (transfer.category === 'erc20') {
        amount = transfer.rawContract?.value || '0';
        asset = transfer.asset || 'UNKNOWN';
      }

      return {
        success: true,
        last_transfer_date: timestamp,
        last_transfer_amount: amount,
        last_transfer_asset: asset,
        last_transfer_block: blockNum
      };
    }

    return { success: true, no_transfer: true };
  } catch (error) {
    // This catch block only triggers if the RPCRotator has failed across EVERY URL.
    const errMsg = (error.message || String(error)).toLowerCase();
    const errShort = error.shortMessage?.toLowerCase() || '';
    const errDetails = error.details?.toLowerCase() || '';
    const combined = errMsg + ' ' + errShort + ' ' + errDetails;

    const isRateLimit = combined.includes('429') ||
      combined.includes('rate limit') ||
      combined.includes('too many requests') ||
      combined.includes('rate-limit') ||
      combined.includes('fipt');

    if (isRateLimit) {
      rateLimitCount++;
      lastRateLimitTime = Date.now();

      if (rateLimitCount >= 5) {
        console.warn(`\n[Rate Limit] Pool exhausted 5 times, pausing 60s...`);
        await new Promise(res => setTimeout(res, 60000));
        rateLimitCount = 0;
      } else {
        const waitTime = Math.min(2 ** rateLimitCount, 30) * 1000;
        console.warn(`\n[Rate Limit] Pool exhausted #${rateLimitCount}, waiting ${waitTime / 1000}s...`);
        await new Promise(res => setTimeout(res, waitTime));
      }
    }

    return { success: false, error: errMsg.slice(0, 150) };
  }
}

// ─── Database Updates ───
async function updatePendingTarget(id, transferData) {
  try {
    const { error } = await supabaseAdmin
      .from('pending_targets')
      .update(transferData)
      .eq('id', id);

    if (error) {
      console.warn(`[DB Error] Failed to update pending_target ${id}: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[DB Error] Exception updating pending_target ${id}: ${e.message}`);
    return false;
  }
}

async function updateTrap(id, transferData) {
  try {
    const { error } = await supabaseAdmin
      .from('traps')
      .update(transferData)
      .eq('id', id);

    if (error) {
      console.warn(`[DB Error] Failed to update trap ${id}: ${error.message}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[DB Error] Exception updating trap ${id}: ${e.message}`);
    return false;
  }
}

// ─── Table Processing logic ───
async function processTable(tableName, chainId, chainName, rotator) {
  console.log(`\n[Process] Starting ${tableName} for ${chainName}...`);

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalNoTransfer = 0;
  let totalErrors = 0;

  const fromCol = tableName === 'pending_targets' ? 'victim' : 'victim_address';
  const toCol = tableName === 'pending_targets' ? 'counterparty' : 'counterparty_address';

  let campaignIds = null;
  if (tableName === 'traps') {
    const { data: campaigns, error: campError } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('chain', chainName);

    if (campError || !campaigns || campaigns.length === 0) {
      console.log(`[Done] No campaigns found for chain ${chainName}, skipping traps.`);
      return;
    }
    campaignIds = campaigns.map(c => c.id);
    console.log(`[Info] Found ${campaignIds.length} campaigns for ${chainName}`);
  }

  while (true) {
    let query = supabaseAdmin
      .from(tableName)
      .select(`id, ${fromCol}, ${toCol}`)
      .is('last_transfer_date', null)
      .limit(PAGE_SIZE);

    if (tableName === 'pending_targets') {
      query = query.eq('chain', chainName);
    } else {
      query = query.in('campaign_id', campaignIds).eq('is_caught', false);
    }

    const { data: records, error } = await query;

    if (error) {
      console.error(`[Error] Failed to fetch ${tableName}: ${error.message}`);
      break;
    }

    if (!records || records.length === 0) {
      console.log(`[Done] No more ${tableName} records to process for ${chainName}`);
      break;
    }

    console.log(`\n[Page] Processing ${records.length} ${tableName} records...`);

    const chunks = chunkArray(records, RPC_CONCURRENCY);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const results = await Promise.all(
        chunk.map(async (record) => {
          const fromAddr = record[fromCol];
          const toAddr = record[toCol];

          if (!fromAddr || !toAddr) {
            return { record, result: { success: false, error: 'Missing addresses' } };
          }

          const result = await fetchLastTransfer(rotator, fromAddr, toAddr, chainName);
          return { record, result };
        })
      );

      for (const { record, result } of results) {
        totalProcessed++;

        if (result.success) {
          if (result.no_transfer) {
            totalNoTransfer++;
            await (tableName === 'pending_targets'
              ? updatePendingTarget(record.id, { last_transfer_date: '1970-01-01T00:00:00.000Z' })
              : updateTrap(record.id, { last_transfer_date: '1970-01-01T00:00:00.000Z' }));
          } else {
            totalUpdated++;
            const updateData = {
              last_transfer_date: result.last_transfer_date,
              last_transfer_amount: result.last_transfer_amount,
              last_transfer_asset: result.last_transfer_asset,
              last_transfer_block: result.last_transfer_block
            };

            const success = tableName === 'pending_targets'
              ? await updatePendingTarget(record.id, updateData)
              : await updateTrap(record.id, updateData);

            if (!success) totalErrors++;
          }
        } else {
          totalErrors++;
          if (totalErrors <= 5) {
            console.warn(`[Error] Failed for ${record.id}: ${result.error}`);
          }
        }
      }

      process.stdout.write(`  Progress: ${Math.min((i + 1) * RPC_CONCURRENCY, records.length)}/${records.length} | Updated: ${totalUpdated} | No Transfer: ${totalNoTransfer} | Errors: ${totalErrors}\r`);

      if (i < chunks.length - 1) {
        await new Promise(res => setTimeout(res, RATE_LIMIT_DELAY));
      }
    }

    console.log(`\n  ✅ Page complete: Updated=${totalUpdated}, No Transfer=${totalNoTransfer}, Errors=${totalErrors}`);
  }

  console.log(`\n[Finished] ${tableName} for ${chainName}:`);
  console.log(`  Total Processed: ${totalProcessed}`);
  console.log(`  Updated: ${totalUpdated}`);
  console.log(`  No Transfer Found: ${totalNoTransfer}`);
  console.log(`  Errors: ${totalErrors}`);
}

// ─── Main Execution ───
async function main() {
  console.log('[Backfill] Starting last transfer backfill for NEW TRAPS ONLY...');

  await showPreFlightSummary();

  for (const [chainIdStr, config] of Object.entries(CHAIN_CONFIGS)) {
    const chainId = parseInt(chainIdStr);

    console.log(`\n==========================================`);
    console.log(`[Backfill] Processing chain ${config.name.toUpperCase()} (ID ${chainId})`);
    console.log(`==========================================`);

    // Instantiate the custom rotator instead of the viem client
    const rotator = new RPCRotator(config.urls);

    await processTable('traps', chainId, config.name, rotator);
  }

  console.log('\n[Backfill] Complete!');
}

main().catch(console.error);