import 'dotenv/config';
import { createPublicClient, http, parseAbiItem, fallback } from 'viem'; 
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';

// ─── Supabase client ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('[collector] Missing Supabase credentials. Exiting.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

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

// 2. Connect to the RPC node via HTTPS
// ─── Public RPC Fallbacks ───
const PUBLIC_FALLBACKS = {
  bsc: [
    'https://bsc-dataseed.binance.org',
    'https://rpc.ankr.com/bsc',
    'https://bsc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com',
    'https://polygon.publicnode.com',
    'https://1rpc.io/polygon',
    'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
  ],
  ethereum: [
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://eth.drpc.org',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
  ],
};

const normalizedChain = chainName?.toLowerCase() || '';
const rawUrls = [chainRpc, ...(PUBLIC_FALLBACKS[normalizedChain] || [])];
const fallbackUrls = Array.from(new Set(rawUrls.filter(Boolean)));

const client = createPublicClient({
  chain: viemChain,
  transport: fallback(
    fallbackUrls.map(url => http(url, { timeout: 8000 })),
    { rank: false }
  ),
});

// The exact signature attackers spoof
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

// --- Build MONITORED_TOKENS from chain config (with fallback) ---
let MONITORED_TOKENS = {};

if (chainCfg && chainCfg.tokens) {
  for (const [symbol, address] of Object.entries(chainCfg.tokens)) {
    let decimals = 18;
    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'BUSD') {
      decimals = 6;
    } else if (symbol === 'WBTC') {
      decimals = 8;
    }
    MONITORED_TOKENS[address.toLowerCase()] = { symbol, decimals };
  }
} else {
  MONITORED_TOKENS = {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  };
}

// ─── USD Price Cache & Oracle (Production-ready $3,000 dynamic filtering) ───
const PRICES = {
  USDT: 1.0,
  USDC: 1.0,
  DAI: 1.0,
  BUSD: 1.0,
  ETH: 1880.0,
  WETH: 1880.0,
  BNB: 578.0,
  MATIC: 0.08,
  POL: 0.08,
  WBTC: 64000.0,
};

// Simple, production-ready price updater (Will not block execution if API fails)
async function updatePrices() {
  if (typeof fetch === 'undefined') return;
  try {
    const pairs = {
      ETH: 'ETHUSDT',
      WETH: 'ETHUSDT',
      BNB: 'BNBUSDT',
      WBTC: 'BTCUSDT',
      MATIC: 'MATICUSDT',
      POL: 'POLUSDT'
    };

    for (const [key, pair] of Object.entries(pairs)) {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
        if (res.ok) {
          const data = await res.json();
          const price = parseFloat(data.price);
          if (price > 0) PRICES[key] = price;
        }
      } catch {
        // Silent catch for individual network hiccups
      }
    }
    updateNativeThreshold();
  } catch {
    // Graceful fallback to static defaults
  }
}

// Calculates exact minimum BigInt value for $3,000 securely
function getMinTransferValue(decimals, symbol, targetUsd = 3000) {
  const price = PRICES[symbol.toUpperCase()] || 1.0;
  const targetUsdBig = BigInt(Math.round(targetUsd));
  const priceScaled = BigInt(Math.round(price * 1000000));
  return (targetUsdBig * (10n ** BigInt(decimals)) * 1000000n) / priceScaled;
}

let NATIVE_THRESHOLD_WEI = 0n;
function updateNativeThreshold() {
  const envVal = process.env[`${chainName.toUpperCase()}_NATIVE_THRESHOLD_WEI`];
  if (envVal) {
    NATIVE_THRESHOLD_WEI = BigInt(envVal);
  } else {
    NATIVE_THRESHOLD_WEI = getMinTransferValue(18, nativeSymbol, 3000);
  }
}

// Initialize native threshold on boot with static fallbacks
updateNativeThreshold();

// Run dynamic updates in the background
updatePrices().catch(() => {});
setInterval(() => {
  updatePrices().catch(() => {});
}, 300000); // Check every 5 minutes

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

let lastProcessedBlock = 0n; 
let isProcessing = false;

async function startCollector() {
  console.log(`[+] Starting real-time block ingestion on ${chainName}...`);
  console.log(`[+] Monitoring assets: ${Object.values(MONITORED_TOKENS).map(t => t.symbol).join(', ')} and Native ${nativeSymbol}`);
  console.log(`[+] Filtering dust: Only saving transfers >= $3,000 equivalent (${NATIVE_THRESHOLD_WEI} wei native)`);

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
          
          const logs = await client.getLogs({
            event: transferEvent,
            address: Object.keys(MONITORED_TOKENS),
            fromBlock: i,
            toBlock: i,
          });

          const blockWithTx = await client.getBlock({
            blockNumber: i,
            includeTransactions: true,
          });

          const insertData = [];
          let ingestedCount = 0;

          // ─── Process ERC-20 Logs ───
          if (logs.length > 0) {
            logs.forEach((log) => {
              if (!log.args || !log.args.from || !log.args.to || !log.args.value) return; 

              const tokenAddress = log.address.toLowerCase();
              const tokenMeta = MONITORED_TOKENS[tokenAddress];
              if (!tokenMeta) return;

              const minTransferValue = getMinTransferValue(tokenMeta.decimals, tokenMeta.symbol, 3000);
              if (log.args.value < minTransferValue) return;

              ingestedCount++;
              insertData.push({
                transaction_hash: log.transactionHash,
                block_number: Number(i),
                token_address: tokenAddress,
                sender: log.args.from.toLowerCase(),
                receiver: log.args.to.toLowerCase(),
                value: log.args.value.toString(),
                chain_id: chainId,
              });
            });
          }

          // ─── Process Native transfers ───
          if (blockWithTx && blockWithTx.transactions) {
            for (const tx of blockWithTx.transactions) {
              if (tx.value && tx.value >= NATIVE_THRESHOLD_WEI && tx.to) {
                if (!tx.from || !tx.to) continue;

                ingestedCount++;
                insertData.push({
                  transaction_hash: tx.hash,
                  block_number: Number(i),
                  token_address: NATIVE_ADDRESS,
                  sender: tx.from.toLowerCase(),
                  receiver: tx.to.toLowerCase(),
                  value: tx.value.toString(),
                  chain_id: chainId,
                });
              }
            }
          }

          // ─── Insert into Supabase ───
          if (insertData.length > 0) {
            try {
              const { error } = await supabase
                .from('token_transfers')
                .insert(insertData);

              if (error) {
                // 23505 = unique violation (duplicate transaction_hash)
                if (error.code === '23505') {
                  console.log(`[-] Some transfers already exist in the database. Skipping duplicates.`);
                } else {
                  console.error('[collector] Insert error:', error);
                }
              } else {
                console.log(`[+] Block ${i}: Successfully ingested ${ingestedCount} high-value transfers (ERC-20 + Native ${nativeSymbol}).`);
              }
            } catch (err) {
              console.error('[collector] Insert exception:', err);
            }
          } else {
            console.log(`[-] Block ${i}: No transfers met the $3,000 threshold criteria.`);
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