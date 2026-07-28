import 'dotenv/config';
import { createPublicClient, http, parseAbiItem, fallback, getAddress } from 'viem'; 
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

// ─── Public RPC Fallbacks ───
const PUBLIC_FALLBACKS = {
  bsc: [
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bsc-dataseed.binance.org',
    'https://rpc.ankr.com/bsc',
    'https://bsc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org'
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com',
    'https://polygon.publicnode.com',
    'https://1rpc.io/polygon'
  ],
  ethereum: [
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://eth.drpc.org'
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

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

// ─── BOUNDED LRU CONTRACT CACHE WITH FAIL-SAFE TTL ───
const MAX_CACHE_SIZE = 20000;
const addressCodeCache = new Map();

function setCacheEntry(key, value, ttlMs = null) {
  if (addressCodeCache.has(key)) {
    addressCodeCache.delete(key);
  } else if (addressCodeCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry (LRU)
    const oldestKey = addressCodeCache.keys().next().value;
    addressCodeCache.delete(oldestKey);
  }
  
  addressCodeCache.set(key, {
    isContract: value,
    expiresAt: ttlMs ? Date.now() + ttlMs : null
  });
}

/**
 * Checks if an address is a Smart Contract or EOA (User).
 * @param {string} address - Checksummed or lowercase Ethereum address
 * @returns {Promise<boolean>} - Returns true if Smart Contract, false if User (EOA)
 */
async function isContractAddress(address) {
  const lower = address.toLowerCase();
  const cached = addressCodeCache.get(lower);

  if (cached) {
    // Check if entry has expired (for temporary RPC failure caches)
    if (!cached.expiresAt || Date.now() < cached.expiresAt) {
      return cached.isContract;
    }
  }

  try {
    const code = await client.getBytecode({ address: getAddress(address) });
    const isContract = Boolean(code && code !== '0x');
    
    // Store permanently in LRU cache
    setCacheEntry(lower, isContract);
    return isContract;
  } catch (err) {
    // Prevent RPC storms by caching false for 5 minutes (TTL) instead of indefinitely
    setCacheEntry(lower, false, 5 * 60 * 1000);
    return false;
  }
}

// --- Build MONITORED_TOKENS from chain config ---
const TOKEN_DECIMALS_MAP = {
  56: {
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18,
    '0x55d398326f99059ff775485246999027b3197955': 18,
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': 18,
  },
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8,
  },
  137: {
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6,
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6,
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 8,
  }
};

function getTokenDecimals(address, symbol, currentChainId) {
  const addrLower = address.toLowerCase();
  if (TOKEN_DECIMALS_MAP[currentChainId] && TOKEN_DECIMALS_MAP[currentChainId][addrLower] !== undefined) {
    return TOKEN_DECIMALS_MAP[currentChainId][addrLower];
  }
  if (symbol === 'USDC' || symbol === 'USDT') return currentChainId === 56 ? 18 : 6;
  if (symbol === 'BUSD') return 18;
  if (symbol === 'WBTC') return 8;
  return 18;
}

let MONITORED_TOKENS = {};

if (chainCfg && chainCfg.tokens) {
  for (const [symbol, address] of Object.entries(chainCfg.tokens)) {
    const decimals = getTokenDecimals(address, symbol, chainId);
    MONITORED_TOKENS[address.toLowerCase()] = { symbol, decimals };
  }
} else {
  MONITORED_TOKENS = {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: getTokenDecimals('0xdac17f958d2ee523a2206206994597c13d831ec7', 'USDT', chainId) },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: getTokenDecimals('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', chainId) },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  };
}

// ─── USD Price Cache & Oracle ───
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

function getPrice(symbol) {
  const sym = symbol.toUpperCase();
  if (sym === 'WMATIC' || sym === 'POL') return PRICES['MATIC'] || PRICES['POL'] || 0.08;
  if (sym === 'WETH') return PRICES['ETH'] || 1880.0;
  if (sym === 'WBNB') return PRICES['BNB'] || 578.0;
  return PRICES[sym] || 1.0;
}

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
        // Silent catch
      }
    }
    updateNativeThreshold();
  } catch {
    // Fallback
  }
}

function getMinTransferValue(decimals, symbol, targetUsd = 3000) {
  const price = getPrice(symbol);
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

updateNativeThreshold();
updatePrices().catch(() => {});
setInterval(() => {
  updatePrices().catch(() => {});
}, 300000);

const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

let lastProcessedBlock = 0n; 
let isProcessing = false;

async function startCollector() {
  console.log(`[+] Starting real-time block ingestion on ${chainName}...`);
  console.log(`[+] Monitoring assets: ${Object.values(MONITORED_TOKENS).map(t => t.symbol).join(', ')} and Native ${nativeSymbol}`);

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

          // Execute both RPC calls simultaneously
          const [logs, blockWithTx] = await Promise.all([
            client.getLogs({
              event: transferEvent,
              address: Object.keys(MONITORED_TOKENS),
              fromBlock: i,
              toBlock: i,
            }),
            client.getBlock({
              blockNumber: i,
              includeTransactions: true,
            }),
          ]);

          const blockTimestampIso = new Date(Number(blockWithTx.timestamp) * 1000).toISOString();
          const insertData = [];
          let ingestedCount = 0;

          // ─── Process ERC-20 Logs ───
          if (logs.length > 0) {
            for (const log of logs) {
              if (!log.args || !log.args.from || !log.args.to || !log.args.value) continue; 

              const tokenAddress = log.address.toLowerCase();
              const tokenMeta = MONITORED_TOKENS[tokenAddress];
              if (!tokenMeta) continue;

              const minTransferValue = getMinTransferValue(tokenMeta.decimals, tokenMeta.symbol, 3000);
              if (log.args.value < minTransferValue) continue;

              const sender = log.args.from.toLowerCase();
              const receiver = log.args.to.toLowerCase();

              // 🔍 OPTIMIZED POISONING FILTER:
              const senderIsContract = await isContractAddress(sender);
              const receiverIsContract = await isContractAddress(receiver);

              // If BOTH are contracts, skip.
              if (senderIsContract && receiverIsContract) {
                continue;
              }

              ingestedCount++;
              insertData.push({
                transaction_hash: log.transactionHash,
                block_number: Number(i),
                token_address: tokenAddress,
                sender,
                receiver,
                value: log.args.value.toString(),
                chain_id: chainId,
                created_at: new Date().toISOString(),
                block_timestamp: blockTimestampIso,
                likely_victim: receiverIsContract ? sender : receiver,
              });
            }
          }

          // ─── Process Native transfers ───
          if (blockWithTx && blockWithTx.transactions) {
            for (const tx of blockWithTx.transactions) {
              // Explicit BigInt check for safety
              if (tx.value > 0n && tx.value >= NATIVE_THRESHOLD_WEI && tx.to) {
                if (!tx.from || !tx.to) continue;

                const sender = tx.from.toLowerCase();
                const receiver = tx.to.toLowerCase();

                // 🔍 OPTIMIZED POISONING FILTER:
                const senderIsContract = await isContractAddress(sender);
                const receiverIsContract = await isContractAddress(receiver);

                // If BOTH are contracts, skip.
                if (senderIsContract && receiverIsContract) {
                  continue;
                }

                ingestedCount++;
                insertData.push({
                  transaction_hash: tx.hash,
                  block_number: Number(i),
                  token_address: NATIVE_ADDRESS,
                  sender,
                  receiver,
                  value: tx.value.toString(),
                  chain_id: chainId,
                  created_at: new Date().toISOString(),
                  block_timestamp: blockTimestampIso,
                  likely_victim: receiverIsContract ? sender : receiver,
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
                if (error.code === '23505') {
                  console.log(`[-] Some transfers already exist in the database. Skipping duplicates.`);
                } else {
                  console.error('[collector] Insert error:', error);
                }
              } else {
                console.log(`[+] Block ${i}: Successfully ingested ${ingestedCount} high-value user transfers.`);
              }
            } catch (err) {
              console.error('[collector] Insert exception:', err);
            }
          } else {
            console.log(`[-] Block ${i}: No user transfers met criteria.`);
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