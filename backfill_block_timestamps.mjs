// backfill_block_timestamps.mjs
// Usage: node backfill_block_timestamps.mjs
// Backfills block_timestamp for all existing token_transfers rows (all chains)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, fallback } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

// ─── Supabase admin client ───
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Chain definitions (same as collector) ───
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

// ─── Block timestamp cache ───
const blockTimestampCache = new Map();

async function fetchBlockWithTimeout(client, blockNum, timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), timeoutMs)
  );
  const blockPromise = client.getBlock({ blockNumber: BigInt(blockNum) });
  return Promise.race([blockPromise, timeoutPromise]);
}

async function main() {
  console.log('[Backfill] Starting...');

  for (const [chainIdStr, config] of Object.entries(CHAIN_CONFIGS)) {
    const chainId = parseInt(chainIdStr);
    console.log(`\n[Backfill] Processing chain ${config.name} (ID ${chainId})`);

    const urls = Array.from(new Set(config.fallbacks));
    const client = createPublicClient({
      chain: config.chain,
      transport: fallback(
        urls.map(url => http(url, { timeout: 10000 })),
        { rank: false }
      ),
    });

    let offset = 0;
    const PAGE_SIZE = 1000;
    let totalUpdated = 0;

    while (true) {
      const { data: blocks, error } = await supabaseAdmin
        .from('token_transfers')
        .select('block_number')
        .is('block_timestamp', null)
        .eq('chain_id', chainId)
        .order('block_number')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error(`[Backfill] Error fetching blocks for ${config.name}:`, error.message);
        break;
      }
      if (!blocks || blocks.length === 0) break;

      const blockNumbers = [...new Set(blocks.map(b => b.block_number))];
      console.log(`[Backfill] Found ${blockNumbers.length} distinct blocks (rows ${offset + 1} - ${offset + blocks.length})`);

      // Fetch block timestamps
      for (let idx = 0; idx < blockNumbers.length; idx++) {
        const blockNum = blockNumbers[idx];
        const key = `${chainId}-${blockNum}`;

        if (blockTimestampCache.has(key)) {
          console.log(`  [${idx + 1}/${blockNumbers.length}] Block ${blockNum} (cached)`);
          continue;
        }

        let fetched = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`  [${idx + 1}/${blockNumbers.length}] Fetching block ${blockNum} (attempt ${attempt})`);
            const block = await fetchBlockWithTimeout(client, blockNum, 5000);
            if (block && block.timestamp) {
              blockTimestampCache.set(key, Number(block.timestamp));
              console.log(`    → timestamp ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
              fetched = true;
              break;
            }
          } catch (e) {
            console.warn(`    → attempt ${attempt} failed: ${e.message}`);
            if (attempt < 2) {
              // wait a bit before retry
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }

        if (!fetched) {
          console.warn(`  [${idx + 1}/${blockNumbers.length}] Block ${blockNum} could not be fetched – skipping`);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Update all rows for these blocks
      for (const blockNum of blockNumbers) {
        const key = `${chainId}-${blockNum}`;
        const timestamp = blockTimestampCache.get(key);
        if (timestamp === undefined) continue;

        const timestampISO = new Date(timestamp * 1000).toISOString();
        const { error: updateError, count } = await supabaseAdmin
          .from('token_transfers')
          .update({ block_timestamp: timestampISO })
          .eq('chain_id', chainId)
          .eq('block_number', blockNum)
          .is('block_timestamp', null);

        if (updateError) {
          console.error(`[Backfill] Update error block ${blockNum}:`, updateError.message);
        } else {
          totalUpdated += count || 0;
        }
      }

      offset += PAGE_SIZE;
    }

    console.log(`[Backfill] Chain ${config.name}: total rows updated = ${totalUpdated}`);
  }

  console.log('\n[Backfill] Completed.');
}

main().catch(console.error);