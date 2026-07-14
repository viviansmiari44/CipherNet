import 'dotenv/config';
import { createPublicClient, http, parseAbiItem } from 'viem'; 
import { mainnet, bsc, polygon } from 'viem/chains';
import pg from 'pg';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';

const { Pool } = pg;

// --- MULTI‑CHAIN: get chain‑specific configs (with legacy fallback) ---
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;
const nativeSymbol = chainCfg?.nativeSymbol || 'ETH';
const chainId = chainCfg?.chainId || 1;

// Viem chain object for the current chain
let viemChain;
switch (chainName) {
  case 'bsc':
    viemChain = bsc;
    break;
  case 'polygon':
    viemChain = polygon;
    break;
  default:
    viemChain = mainnet;
}

// RPC URL: prefer chain‑specific RPC, otherwise use legacy NODE_RPC_URL
const chainRpc = chainCfg?.rpc || process.env.NODE_RPC_URL;

logger.info(`[Multi‑chain] Collector started on ${chainName} (${viemChain.name}), RPC: ${chainRpc}`);

// 1. Initialize Database Connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: String(process.env.DB_PASSWORD),
  port: process.env.DB_PORT,
});

// 2. Connect to the RPC node via HTTPS
const client = createPublicClient({
  chain: viemChain,
  transport: http(chainRpc), 
});

// The exact signature attackers spoof
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

// --- Build MONITORED_TOKENS from chain config (with fallback) ---
let MONITORED_TOKENS = {};

if (chainCfg && chainCfg.tokens) {
  // Build from chain config tokens
  for (const [symbol, address] of Object.entries(chainCfg.tokens)) {
    // Determine decimals: we can set defaults based on symbol
    let decimals = 18;
    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'BUSD') {
      decimals = 6;
    } else if (symbol === 'WBTC') {
      decimals = 8;
    }
    MONITORED_TOKENS[address.toLowerCase()] = { symbol, decimals };
  }
} else {
  // Fallback to hardcoded Ethereum mainnet tokens
  MONITORED_TOKENS = {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  };
}

// ─── Updated threshold: $5,000 USD equivalent ───
// For native tokens, we set a fixed wei value (~3 native tokens, adjust via env if needed)
// Override with CHAIN_NATIVE_THRESHOLD_WEI env var
const NATIVE_THRESHOLD_WEI = BigInt(
  process.env[`${chainName.toUpperCase()}_NATIVE_THRESHOLD_WEI`] || '3000000000000000000'
); // 3 native tokens (approx $5k at $1,666 per token)
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

// Keep track of the last block we saw in memory and execution state
let lastProcessedBlock = 0n; 
let isProcessing = false;

async function startCollector() {
  console.log(`[+] Starting real-time block ingestion on ${chainName}...`);
  console.log(`[+] Monitoring assets: ${Object.values(MONITORED_TOKENS).map(t => t.symbol).join(', ')} and Native ${nativeSymbol}`);
  console.log(`[+] Filtering dust: Only saving transfers >= $5,000 equivalent (${NATIVE_THRESHOLD_WEI} wei native)`);

  // Run this check exactly every 4 seconds (adjust for slower chains if needed)
  setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const currentBlock = await client.getBlockNumber();

      if (lastProcessedBlock === 0n) {
        console.log(`\n[i] Connected! Baseline block established at ${currentBlock}. Waiting for next...`);
        lastProcessedBlock = currentBlock;
        return;
      }

      if (currentBlock > lastProcessedBlock) {
        for (let i = lastProcessedBlock + 1n; i <= currentBlock; i++) {
          console.log(`\n[!] Block ${i} mined! Fetching transfer logs and block transactions...`);
          
          // Fetch ERC-20 logs
          const logs = await client.getLogs({
            event: transferEvent,
            address: Object.keys(MONITORED_TOKENS),
            fromBlock: i,
            toBlock: i,
          });

          // Fetch full block transactions to process native transfers
          const blockWithTx = await client.getBlock({
            blockNumber: i,
            includeTransactions: true,
          });

          const values = [];
          const queryPlaceholders = [];
          let counter = 1;
          let ingestedCount = 0;

          // Process ERC-20 Logs
          if (logs.length > 0) {
            logs.forEach((log) => {
              if (!log.args || !log.args.from || !log.args.to || !log.args.value) return; 

              const tokenAddress = log.address.toLowerCase();
              const tokenMeta = MONITORED_TOKENS[tokenAddress];
              if (!tokenMeta) return;

              // ─── $5,000 threshold ───
              const minTransferValue = 5000n * (10n ** BigInt(tokenMeta.decimals));
              if (log.args.value < minTransferValue) return;

              ingestedCount++;
              queryPlaceholders.push(`($${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++})`);
              values.push(
                log.transactionHash,
                Number(i),
                tokenAddress,       
                log.args.from.toLowerCase(),     
                log.args.to.toLowerCase(),       
                log.args.value.toString(),
                chainId
              );
            });
          }

          // Process Native transfers (ETH, BNB, MATIC, etc.)
          if (blockWithTx && blockWithTx.transactions) {
            for (const tx of blockWithTx.transactions) {
              if (tx.value && tx.value >= NATIVE_THRESHOLD_WEI && tx.to) {
                if (!tx.from || !tx.to) continue;

                ingestedCount++;
                queryPlaceholders.push(`($${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++}, $${counter++})`);
                values.push(
                  tx.hash,
                  Number(i),
                  NATIVE_ADDRESS,
                  tx.from.toLowerCase(),
                  tx.to.toLowerCase(),
                  tx.value.toString(),
                  chainId
                );
              }
            }
          }

          if (values.length > 0) {
            const query = `
              INSERT INTO token_transfers 
              (transaction_hash, block_number, token_address, sender, receiver, value, chain_id) 
              VALUES ${queryPlaceholders.join(', ')}
              ON CONFLICT (transaction_hash) DO NOTHING;
            `;
            
            await pool.query(query, values);
            console.log(`[+] Block ${i}: Successfully ingested ${ingestedCount} high-value transfers (ERC-20 + Native ${nativeSymbol}).`);
          } else {
            console.log(`[-] Block ${i}: No transfers met the $5,000 threshold criteria.`);
          }
        }
        
        lastProcessedBlock = currentBlock;
      }
    } catch (error) {
      console.error(`[-] Polling error on ${chainName}:`, error.message);
    } finally {
      isProcessing = false;
    }
  }, 4000);
}

startCollector();