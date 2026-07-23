// backfill_block_timestamps.mjs
// Usage: node backfill_block_timestamps.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, fallback } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CHAIN_CONFIGS = {
  1: {
    name: 'ethereum',
    chain: mainnet,
    fallbacks: [
      'https://ethereum.publicnode.com',
      'https://rpc.ankr.com/eth',
      'https://eth.llamarpc.com',
      'https://1rpc.io/eth',
      'https://eth.drpc.org',
      'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
      'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
    ]
  },
  56: {
    name: 'bsc',
    chain: bsc,
    fallbacks: [
      'https://bsc-dataseed.binance.org',
      'https://rpc.ankr.com/bsc',
      'https://bsc.publicnode.com',
      'https://1rpc.io/bnb',
      'https://bsc.drpc.org',
      'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
      'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
    ]
  },
  137: {
    name: 'polygon',
    chain: polygon,
    fallbacks: [
      'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon.llamarpc.com',
      'https://polygon.publicnode.com',
      'https://1rpc.io/polygon',
      'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
      'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
    ]
  }
};

// ─── Performance Settings ───
const PAGE_SIZE = 1500;           // Records fetched per page
const RPC_CONCURRENCY = 20;       // Parallel RPC block fetches
const DB_UPDATE_CONCURRENCY = 8;  // Lowered to prevent Supabase connection exhaustion

const blockTimestampCache = new Map();
const failedBlocks = new Set();

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function fetchBlockWithTimeout(client, blockNum, timeoutMs = 6000) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), timeoutMs)
  );
  const blockPromise = client.getBlock({ blockNumber: BigInt(blockNum) });
  return Promise.race([blockPromise, timeoutPromise]);
}

// Resilient DB update with retries
// Resilient DB update with exact row count tracking
async function updateBlockTimestampWithRetry(chainId, blockNum, timestampISO, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { error, count } = await supabaseAdmin
        .from('token_transfers')
        .update(
          { block_timestamp: timestampISO },
          { count: 'exact' } // 👈 Tells Supabase to return the actual count of updated rows
        )
        .eq('chain_id', chainId)
        .eq('block_number', blockNum)
        .is('block_timestamp', null);

      if (!error) return count || 0;
      
      console.warn(`[DB Retry ${attempt}/${retries}] Block ${blockNum}: ${error.message}`);
    } catch (e) {
      console.warn(`[DB Fetch Error ${attempt}/${retries}] Block ${blockNum}: ${e.message}`);
    }
    
    if (attempt < retries) {
      await new Promise(res => setTimeout(res, 500 * attempt));
    }
  }
  return 0;
}

async function main() {
  console.log('[Backfill] Starting resilient backfill process...');

  for (const [chainIdStr, config] of Object.entries(CHAIN_CONFIGS)) {
    const chainId = parseInt(chainIdStr);
    console.log(`\n==========================================`);
    console.log(`[Backfill] Processing chain ${config.name.toUpperCase()} (ID ${chainId})`);
    console.log(`==========================================`);

    const urls = Array.from(new Set(config.fallbacks));
    const client = createPublicClient({
      chain: config.chain,
      transport: fallback(
        urls.map(url => http(url, {
          timeout: 10000,
          batch: { batchSize: 30, wait: 20 }
        })),
        { rank: false }
      ),
    });

    let totalUpdated = 0;

    while (true) {
      const { data: blocks, error } = await supabaseAdmin
        .from('token_transfers')
        .select('block_number')
        .is('block_timestamp', null)
        .eq('chain_id', chainId)
        .order('block_number')
        .range(0, PAGE_SIZE - 1);

      if (error) {
        console.error(`[Backfill] Error fetching blocks for ${config.name}:`, error.message);
        break;
      }
      if (!blocks || blocks.length === 0) break;

      const blockNumbers = [...new Set(blocks.map(b => b.block_number))]
        .filter(b => !failedBlocks.has(`${chainId}-${b}`));

      if (blockNumbers.length === 0) {
        console.log(`[Backfill] No remaining processable blocks in this page for ${config.name}.`);
        break;
      }

      console.log(`\n[Page] Processing ${blockNumbers.length} distinct blocks (${blocks.length} DB rows total)...`);

      // ─── Step 1: Fetch block timestamps from RPC ───
      const rpcChunks = chunkArray(blockNumbers, RPC_CONCURRENCY);
      let fetchedInPage = 0;

      for (let i = 0; i < rpcChunks.length; i++) {
        const chunk = rpcChunks[i];
        
        await Promise.all(
          chunk.map(async (blockNum) => {
            const key = `${chainId}-${blockNum}`;
            if (blockTimestampCache.has(key)) return;

            try {
              const block = await fetchBlockWithTimeout(client, blockNum, 6000);
              if (block && block.timestamp) {
                blockTimestampCache.set(key, Number(block.timestamp));
                fetchedInPage++;
              }
            } catch (e) {
              failedBlocks.add(key);
            }
          })
        );

        process.stdout.write(`  RPC progress: ${Math.min((i + 1) * RPC_CONCURRENCY, blockNumbers.length)}/${blockNumbers.length} blocks...\r`);
      }
      console.log(`\n  ✅ Fetched timestamps for ${fetchedInPage} blocks.`);

      // ─── Step 2: Update Supabase DB in smaller, controlled waves ───
      const validBlockNumbers = blockNumbers.filter(b => blockTimestampCache.has(`${chainId}-${b}`));
      const updateChunks = chunkArray(validBlockNumbers, DB_UPDATE_CONCURRENCY);
      let pageUpdatedRows = 0;

      for (let i = 0; i < updateChunks.length; i++) {
        const chunk = updateChunks[i];
        const results = await Promise.all(
          chunk.map(async (blockNum) => {
            const key = `${chainId}-${blockNum}`;
            const timestamp = blockTimestampCache.get(key);
            if (timestamp === undefined) return 0;

            const timestampISO = new Date(timestamp * 1000).toISOString();
            return await updateBlockTimestampWithRetry(chainId, blockNum, timestampISO, 3);
          })
        );

        const chunkCount = results.reduce((acc, curr) => acc + curr, 0);
        pageUpdatedRows += chunkCount;
        totalUpdated += chunkCount;

        process.stdout.write(`  DB progress: ${Math.min((i + 1) * DB_UPDATE_CONCURRENCY, validBlockNumbers.length)}/${validBlockNumbers.length} blocks updated...\r`);
        
        // Pacing pause between update waves
        await new Promise(res => setTimeout(res, 50));
      }

      console.log(`\n  ✅ DB updated ${pageUpdatedRows} rows in this batch (Total: ${totalUpdated}).`);
    }

    console.log(`\n[Finished] Chain ${config.name}: Total rows updated = ${totalUpdated}`);
  }

  console.log('\n[Backfill] Complete!');
}

main().catch(console.error);