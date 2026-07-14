import 'dotenv/config';
import { createPublicClient, http, formatEther } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const PLATFORM_WALLET = process.env.PLATFORM_WALLET_ADDRESS;
const CHAIN_NAME = process.env.CHAIN || 'bsc';

const chainMap = { ethereum: mainnet, bsc, polygon };
const chain = chainMap[CHAIN_NAME];

const client = createPublicClient({
  chain,
  transport: http(process.env[`${CHAIN_NAME.toUpperCase()}_RPC_URL`]),
});

let lastProcessedBlock = 0n;

async function checkDeposits() {
  console.log('[Payment Monitor] Checking deposits...');

  try {
    const currentBlock = await client.getBlockNumber();
    if (lastProcessedBlock === 0n) {
      lastProcessedBlock = currentBlock - 100n; // Check last 100 blocks on startup
    }

    // Get transactions to the platform wallet
    const logs = await client.getLogs({
      address: PLATFORM_WALLET,
      fromBlock: lastProcessedBlock + 1n,
      toBlock: currentBlock,
    });

    // Also check native transfers (ETH/BNB/MATIC)
    // For simplicity, we'll use a block scanner approach

    for (let block = lastProcessedBlock + 1n; block <= currentBlock; block++) {
      const blockWithTx = await client.getBlock({
        blockNumber: block,
        includeTransactions: true,
      });

      for (const tx of blockWithTx.transactions) {
        if (tx.to?.toLowerCase() === PLATFORM_WALLET?.toLowerCase() && tx.value > 0n) {
          // Found a deposit! Look up the user by a memo/note
          // For MVP, we'll use a note field – in production, use unique deposit addresses
          // For now, we'll have users include their user ID in the transaction data (via memo)
          // Or we can assign unique deposit addresses per user

          // This is a placeholder – you'd need a proper mapping
          // For now, we'll log and manually credit
          console.log('[Payment Monitor] Deposit detected:', {
            from: tx.from,
            amount: formatEther(tx.value),
            txHash: tx.hash,
          });

          // Auto-credit user (you'd need user mapping)
          await processDeposit(tx);
        }
      }
    }

    lastProcessedBlock = currentBlock;
  } catch (err) {
    console.error('[Payment Monitor] Error:', err.message);
  }
}

async function processDeposit(tx) {
  // This would:
  // 1. Find user by deposit address mapping (you need to implement this)
  // 2. Credit the user's balance
  // 3. Create transaction record

  // For now, this is a placeholder. In production:
  // - Use unique deposit addresses per user (HD wallet)
  // - Or use transaction data/memo field

  console.log('[Payment Monitor] Processing deposit:', tx.hash);
}

setInterval(checkDeposits, 60000); // Check every minute