import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';
import { config } from '../lib/config.js';

// ─── Supabase setup ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Chain setup ───
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;
const chainId = chainCfg?.chainId || 1;

let viemChain = mainnet;
if (chainName === 'bsc') viemChain = bsc;
if (chainName === 'polygon') viemChain = polygon;

const chainRpc = chainCfg?.rpc || process.env.NODE_RPC_URL;
const client = createPublicClient({
  chain: viemChain,
  transport: fallback([http(chainRpc, { timeout: 8000 })]),
});

async function main() {
  console.log(`[+] Scanning unique addresses on ${chainName} (Chain ID: ${chainId})...`);

  // 1. Fetch ONLY the unique, unchecked addresses directly from the database
  const { data: unchecked, error: fetchError } = await supabase
    .rpc('get_unchecked_addresses', { p_chain_id: chainId });

  if (fetchError) {
    console.error('[-] Failed to fetch unchecked addresses:', fetchError);
    return;
  }

  if (!unchecked || unchecked.length === 0) {
    console.log('[+] All addresses in the database are already indexed in known_contracts.');
    return;
  }

  console.log(`[+] Found ${unchecked.length} new addresses that need bytecode checks.`);

  // 2. Process bytecode in chunks with parallel concurrency (50 RPC calls at a time)
  const CONCURRENCY = 50;
  const newContracts = [];

  for (let i = 0; i < unchecked.length; i += CONCURRENCY) {
    const chunk = unchecked.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (row) => {
        const addr = row.address.toLowerCase();
        try {
          const code = await client.getBytecode({ address: getAddress(addr) });
          if (code && code !== '0x') {
            newContracts.push({ address: addr, chain_id: chainId });
          }
        } catch {
          // Ignore transient RPC errors; we can catch them on the next run
        }
      })
    );

    console.log(`[Progress] Checked ${Math.min(i + CONCURRENCY, unchecked.length)} / ${unchecked.length} addresses...`);
  }

  console.log(`\n[+] Identified ${newContracts.length} new smart contract addresses.`);

  // 3. Save contracts into known_contracts table
  if (newContracts.length > 0) {
    const { error } = await supabase.from('known_contracts').upsert(newContracts, {
      onConflict: 'address',
      ignoreDuplicates: true,
    });

    if (error) {
      console.error('[-] Error inserting known contracts:', error.message);
    } else {
      console.log(`[+] Successfully inserted ${newContracts.length} contract addresses into the database.`);
    }
  } else {
    console.log('[+] No new contracts found.');
  }
}

main().catch(console.error);