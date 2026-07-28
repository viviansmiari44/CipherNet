import 'dotenv/config';
import { createPublicClient, http, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';
import { config } from './lib/config.js';

// ─── CONFIGURATION ───
const DRY_RUN = true; // Set to false to actually delete the records
const BATCH_SIZE = 500; // Process 500 records at a time to avoid memory/RPC limits

// ─── SUPABASE SETUP ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── VIEM CLIENT SETUP ───
const chainName = config.chain || 'ethereum';
let viemChain;
switch (chainName) {
  case 'bsc': viemChain = bsc; break;
  case 'polygon': viemChain = polygon; break;
  default: viemChain = mainnet;
}

const chainRpc = config.getChainConfig?.()?.rpc || process.env.NODE_RPC_URL;

const client = createPublicClient({
  chain: viemChain,
  transport: http(chainRpc, { timeout: 10000 }),
});

// ─── CONTRACT CHECKER WITH CACHE ───
// The cache is CRITICAL here. It prevents checking the same USDT/Binance address thousands of times.
const addressCodeCache = new Map();

async function isContractAddress(address) {
  const lower = address.toLowerCase();
  if (addressCodeCache.has(lower)) {
    return addressCodeCache.get(lower);
  }

  try {
    const code = await client.getBytecode({ address: getAddress(address) });
    const isContract = Boolean(code && code !== '0x');
    addressCodeCache.set(lower, isContract);
    return isContract;
  } catch (err) {
    return false; // On RPC error, assume EOA to be safe
  }
}

// ─── MAIN CLEANUP LOGIC ───
async function runCleanup() {
  console.log(`[+] Starting database cleanup on ${chainName}...`);
  console.log(`[+] Mode: ${DRY_RUN ? '🛡️ DRY RUN (No data will be deleted)' : '⚠️ LIVE DELETE'}`);

  let offset = 0;
  let totalChecked = 0;
  let totalToDelete = 0;
  let isFinished = false;

  while (!isFinished) {
    // 1. Fetch a batch of records
    const { data: records, error: fetchError } = await supabase
      .from('token_transfers')
      .select('id, sender, receiver, transaction_hash')
      .order('created_at', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (fetchError) {
      console.error('[-] Error fetching records:', fetchError);
      break;
    }

    if (!records || records.length === 0) {
      isFinished = true;
      break;
    }

    const idsToDelete = [];

    // 2. Check each record
    for (const record of records) {
      totalChecked++;
      
      const senderIsContract = await isContractAddress(record.sender);
      const receiverIsContract = await isContractAddress(record.receiver);

      // If BOTH are contracts, there is no human to poison. Mark for deletion.
      if (senderIsContract && receiverIsContract) {
        idsToDelete.push(record.id);
      }
    }

    // 3. Delete the batch (if not in dry run)
    if (idsToDelete.length > 0) {
      totalToDelete += idsToDelete.length;
      console.log(`[!] Found ${idsToDelete.length} contract-to-contract transfers in this batch.`);

      if (!DRY_RUN) {
        const { error: deleteError } = await supabase
          .from('token_transfers')
          .delete()
          .in('id', idsToDelete);

        if (deleteError) {
          console.error('[-] Error deleting records:', deleteError);
        } else {
          console.log(`[+] Successfully deleted ${idsToDelete.length} records.`);
        }
      }
    } else {
      console.log(`[+] Batch clean. No contract-to-contract transfers found.`);
    }

    console.log(`[i] Progress: Checked ${totalChecked} records. Total flagged: ${totalToDelete}\n`);
    
    // Move to next batch
    offset += BATCH_SIZE;
    
    // Small delay to be kind to the RPC and Supabase
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n========================================');
  console.log(`[✅] Cleanup Complete!`);
  console.log(`[📊] Total records checked: ${totalChecked}`);
  console.log(`[🗑️] Total records flagged for deletion: ${totalToDelete}`);
  if (DRY_RUN) {
    console.log(`[⚠️] This was a DRY RUN. No data was deleted.`);
    console.log(`[💡] To actually delete them, change DRY_RUN = false in the script and run it again.`);
  }
  console.log('========================================');
}

runCleanup().catch(console.error);