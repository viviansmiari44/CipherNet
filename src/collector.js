import 'dotenv/config';
import { createPublicClient, http, parseAbiItem, fallback, getAddress } from 'viem'; 
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';

// ─── CLI Flags ───
const isBackfill = process.argv.includes('--backfill');

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
if (isBackfill) {
  logger.info('[BACKFILL MODE] Will process last 40 days of historical data');
} else {
  logger.info('[REAL-TIME MODE] Listening for new blocks only');
}

// ─── Public RPC Fallbacks (removed drpc.org - doesn't support eth_getLogs) ───
const PUBLIC_FALLBACKS = {
  bsc: [
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bsc-dataseed.binance.org',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
    'https://rpc.ankr.com/bsc',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
    'https://bsc.publicnode.com',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
    'https://1rpc.io/bnb',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
  ],
  polygon: [
    'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
    'https://polygon-rpc.com',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5',
    'https://rpc.ankr.com/polygon',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
    'https://polygon.llamarpc.com',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw',
    'https://polygon.publicnode.com',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
    'https://1rpc.io/polygon',
    'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
  ],
  ethereum: [
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://ethereum.publicnode.com',
    'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
    'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
    'https://rpc.ankr.com/eth',
    'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
    'https://eth.llamarpc.com',
    'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
    'https://1rpc.io/eth',
    'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
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
    fallbackUrls.map(url => http(url, { timeout: 15000 })),
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
    const oldestKey = addressCodeCache.keys().next().value;
    addressCodeCache.delete(oldestKey);
  }
  
  addressCodeCache.set(key, {
    isContract: value,
    expiresAt: ttlMs ? Date.now() + ttlMs : null
  });
}

async function isContractAddress(address) {
  const lower = address.toLowerCase();
  const cached = addressCodeCache.get(lower);

  if (cached && (!cached.expiresAt || Date.now() < cached.expiresAt)) {
    return cached.isContract;
  }

  try {
    const code = await client.getBytecode({ address: getAddress(address) });
    const isContract = Boolean(code && code !== '0x');
    setCacheEntry(lower, isContract);
    return isContract;
  } catch (err) {
    setCacheEntry(lower, false, 5 * 60 * 1000);
    return false;
  }
}

// ─── STAGE 1 HEURISTICS CACHE & FUNCTION ───
const MIN_GAS_RESERVE_WEI = 2000000000000000n; // 0.002 Native Token in Wei
const MAX_STAGE_ONE_CACHE = 50000;
const STAGE_ONE_CACHE = new Map();

function setStageOneCacheEntry(key, passes, ttlMs) {
  if (STAGE_ONE_CACHE.has(key)) {
    STAGE_ONE_CACHE.delete(key);
  } else if (STAGE_ONE_CACHE.size >= MAX_STAGE_ONE_CACHE) {
    const oldestKey = STAGE_ONE_CACHE.keys().next().value;
    STAGE_ONE_CACHE.delete(oldestKey);
  }
  
  STAGE_ONE_CACHE.set(key, {
    passes,
    expiresAt: Date.now() + ttlMs
  });
}

async function passesStageOneHeuristics(address) {
  const lower = address.toLowerCase();
  const cached = STAGE_ONE_CACHE.get(lower);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.passes;
  }

  try {
    const checksumAddr = getAddress(address);

    const [code, nonce, balance] = await Promise.all([
      client.getBytecode({ address: checksumAddr }),
      client.getTransactionCount({ address: checksumAddr }),
      client.getBalance({ address: checksumAddr })
    ]);

    const isContract = Boolean(code && code !== '0x');
    if (isContract) {
      setStageOneCacheEntry(lower, false, 3600000); // 1hr
      return false;
    }

    if (nonce >= 1000) {
      setStageOneCacheEntry(lower, false, 600000); // 10m
      return false;
    }

    if (balance < MIN_GAS_RESERVE_WEI) {
      setStageOneCacheEntry(lower, false, 300000); // 5m
      return false;
    }

    setStageOneCacheEntry(lower, true, 1800000); // 30m
    return true;
  } catch (err) {
    setStageOneCacheEntry(lower, false, 60000); // 1m fallback
    return false;
  }
}

// ─── CONCURRENCY-LIMITED PARALLEL EXECUTION ───
async function promiseAllLimit(tasks, limit = 10) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const batch = tasks.slice(i, i + limit);
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }
  return results;
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

// ─── 40-DAY BLOCK CALCULATION ───
const BLOCKS_40_DAYS_MAP = {
  ethereum: 288000n,   // ~12s blocks
  bsc: 1152000n,       // ~3s blocks
  polygon: 1728000n,   // ~2s blocks
};
const BLOCKS_40_DAYS = BLOCKS_40_DAYS_MAP[chainName] || 288000n;

// ─── STATE PERSISTENCE (STRICTLY FOR BACKFILL) ───
async function saveCollectorState(blockNumber) {
  try {
    await supabase
      .from('collector_state')
      .upsert({
        chain: chainName,
        last_processed_block: Number(blockNumber),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'chain'
      });
  } catch (err) {
    console.error('[collector] Failed to save state:', err.message);
  }
}

async function loadCollectorState() {
  try {
    const { data, error } = await supabase
      .from('collector_state')
      .select('last_processed_block')
      .eq('chain', chainName)
      .single();
    
    if (error || !data) return null;
    return BigInt(data.last_processed_block);
  } catch (err) {
    return null;
  }
}

let lastProcessedBlock = 0n; 
let isProcessing = false;
let blocksSinceLastSave = 0;
const SAVE_STATE_INTERVAL = 100; // Save state every 100 blocks

// ─── BLOCK-LEVEL RETRY LOGIC ───
async function fetchBlockWithRetry(blockNumber, maxRetries = 3) {
  let retries = 0;
  let lastError = null;
  
  while (retries < maxRetries) {
    try {
      const [logs, blockWithTx] = await Promise.all([
        client.getLogs({
          event: transferEvent,
          address: Object.keys(MONITORED_TOKENS),
          fromBlock: blockNumber,
          toBlock: blockNumber,
        }),
        client.getBlock({
          blockNumber: blockNumber,
          includeTransactions: true,
        }),
      ]);
      
      return { logs, blockWithTx };
    } catch (err) {
      retries++;
      lastError = err;
      
      if (retries < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, retries), 10000);
        console.warn(`[!] Block ${blockNumber}: Retry ${retries}/${maxRetries} in ${backoffMs}ms - ${err.message.split('\n')[0]}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  console.error(`[!] Block ${blockNumber}: Failed after ${maxRetries} retries, skipping...`);
  return { logs: [], blockWithTx: { timestamp: BigInt(Math.floor(Date.now() / 1000)), transactions: [] } };
}

// ─── SUPABASE INSERT WITH RETRY ───
async function insertWithRetry(insertData, blockNum, maxRetries = 3) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const { error } = await supabase
        .from('token_transfers')
        .upsert(insertData, { 
          onConflict: 'transaction_hash, log_index',
          ignoreDuplicates: true 
        });

      if (error) {
        if (error.code === '23505') {
          return { success: true, duplicates: true };
        }
        throw error;
      }
      
      return { success: true, duplicates: false };
    } catch (err) {
      retries++;
      
      if (retries < maxRetries) {
        const backoffMs = Math.min(2000 * Math.pow(2, retries), 15000);
        console.warn(`[!] Block ${blockNum} DB retry ${retries}/${maxRetries} in ${backoffMs}ms - ${err.message.split('\n')[0]}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } else {
        return { success: false, error: err };
      }
    }
  }
}

// ─── GRACEFUL SHUTDOWN (Only saves state if in backfill mode) ───
process.on('SIGINT', async () => {
  console.log('\n[!] Received SIGINT, shutting down...');
  if (isBackfill && lastProcessedBlock > 0n) {
    await saveCollectorState(lastProcessedBlock);
    console.log(`[!] Saved backfill state at block ${lastProcessedBlock}`);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[!] Received SIGTERM, shutting down...');
  if (isBackfill && lastProcessedBlock > 0n) {
    await saveCollectorState(lastProcessedBlock);
    console.log(`[!] Saved backfill state at block ${lastProcessedBlock}`);
  }
  process.exit(0);
});

async function startCollector() {
  console.log(`[+] Starting block ingestion on ${chainName}...`);
  console.log(`[+] Monitoring assets: ${Object.values(MONITORED_TOKENS).map(t => t.symbol).join(', ')} and Native ${nativeSymbol}`);

  // 🛑 FIX: ONLY load saved state if we are in backfill mode.
  // Real-time mode MUST ignore the DB state and always start at the current block.
  if (isBackfill) {
    const savedState = await loadCollectorState();
    if (savedState && savedState > 0n) {
      console.log(`[RESUME] Found saved backfill state, resuming from block ${savedState}`);
      lastProcessedBlock = savedState;
    }
  }

  setInterval(async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
      const currentBlock = await client.getBlockNumber();

      if (lastProcessedBlock === 0n) {
        if (isBackfill) {
          // Backfill mode: start from 40 days ago
          const startBlock = currentBlock > BLOCKS_40_DAYS ? currentBlock - BLOCKS_40_DAYS : 0n;
          console.log(`\n[BACKFILL] Starting historical ingestion from block ${startBlock} (40 days ago)`);
          console.log(`[BACKFILL] Current block: ${currentBlock}, blocks to process: ${currentBlock - startBlock}`);
          lastProcessedBlock = startBlock;
        } else {
          // Real-time mode: ALWAYS start from current block
          console.log(`\n[REAL-TIME] Connected! Baseline block established at ${currentBlock}. Waiting for next...`);
          lastProcessedBlock = currentBlock;
          return;
        }
      }

      if (currentBlock > lastProcessedBlock) {
        // Process in chunks to avoid overwhelming the RPC
        const chunkSize = isBackfill ? 50n : 1n;
        const endBlock = lastProcessedBlock + chunkSize > currentBlock ? currentBlock : lastProcessedBlock + chunkSize;
        
        for (let i = lastProcessedBlock + 1n; i <= endBlock; i++) {
          if (isBackfill) {
            const progress = Number(i - (currentBlock - BLOCKS_40_DAYS));
            const total = Number(BLOCKS_40_DAYS);
            const percent = ((progress / total) * 100).toFixed(2);
            if (progress % 100 === 0) {
              console.log(`[BACKFILL] Block ${i}/${currentBlock} (${percent}%) - Processing...`);
            }
          } else {
            console.log(`\n[!] Block ${i} mined! Fetching transfer logs and block transactions...`);
          }

          // Use retry logic for block fetching
          const { logs, blockWithTx } = await fetchBlockWithRetry(i);

          const blockTimestampIso = new Date(Number(blockWithTx.timestamp) * 1000).toISOString();
          
          // Accumulate raw transfers first for consistent batch filtering
          const rawTransfers = [];

          // ─── Extract ERC-20 Logs ───
          if (logs.length > 0) {
            for (const log of logs) {
              if (!log.args || !log.args.from || !log.args.to || !log.args.value) continue; 
              
              const tokenAddress = log.address.toLowerCase();
              const tokenMeta = MONITORED_TOKENS[tokenAddress];
              if (!tokenMeta) continue;

              const minTransferValue = getMinTransferValue(tokenMeta.decimals, tokenMeta.symbol, 3000);
              if (log.args.value < minTransferValue) continue;

              // Skip mint events (from = 0x0) and burn events (to = 0x0)
              const sender = log.args.from.toLowerCase();
              const receiver = log.args.to.toLowerCase();
              if (sender === NATIVE_ADDRESS || receiver === NATIVE_ADDRESS) continue;

              rawTransfers.push({
                transaction_hash: log.transactionHash,
                log_index: typeof log.logIndex !== 'undefined' ? Number(log.logIndex) : 0,
                token_address: tokenAddress,
                sender,
                receiver,
                value: log.args.value.toString()
              });
            }
          }

          // ─── Extract Native transfers ───
          if (blockWithTx && blockWithTx.transactions) {
            for (const tx of blockWithTx.transactions) {
              if (tx.value > 0n && tx.value >= NATIVE_THRESHOLD_WEI && tx.to && tx.from) {
                const sender = tx.from.toLowerCase();
                const receiver = tx.to.toLowerCase();

                // Skip zero-address sends (contract creation / burns)
                if (sender === NATIVE_ADDRESS || receiver === NATIVE_ADDRESS) continue;

                rawTransfers.push({
                  transaction_hash: tx.hash,
                  log_index: -1,
                  token_address: NATIVE_ADDRESS,
                  sender,
                  receiver,
                  value: tx.value.toString()
                });
              }
            }
          }

          // ─── Sync Filtering: In-Block Batch Detection ───
          const blockSenderCounts = new Map();
          const preFilteredTransfers = [];

          for (const t of rawTransfers) {
            const senderCount = (blockSenderCounts.get(t.sender) || 0) + 1;
            blockSenderCounts.set(t.sender, senderCount);
            if (senderCount < 3) {
              preFilteredTransfers.push(t);
            }
          }

          // ─── Async Filtering & Evaluation (concurrency-limited) ───
          const evaluationResults = await promiseAllLimit(
            preFilteredTransfers.map(async (t) => {
              // Stage 1: sender must be human EOA, nonce < 1000, balance >= 0.002
              const senderIsHuman = await passesStageOneHeuristics(t.sender);
              if (!senderIsHuman) return null;

              return {
                transaction_hash: t.transaction_hash,
                log_index: t.log_index,
                block_number: Number(i),
                token_address: t.token_address,
                sender: t.sender,
                receiver: t.receiver,
                value: t.value,
                chain_id: chainId,
                created_at: new Date().toISOString(),
                block_timestamp: blockTimestampIso,
                likely_victim: t.sender,
              };
            }),
            10
          );

          // Clean out filtered null results
          const insertData = evaluationResults.filter(r => r !== null);

          // ─── Insert into Supabase with retry ───
          if (insertData.length > 0) {
            const result = await insertWithRetry(insertData, i);
            
            if (result.success) {
              if (result.duplicates) {
                console.log(`[-] Block ${i}: Some transfers already exist, skipping duplicates.`);
              } else {
                console.log(`[+] Block ${i}: Successfully ingested ${insertData.length} high-value user transfers.`);
              }
            } else {
              console.error(`[collector] Block ${i}: Insert failed after retries:`, result.error.message);
            }
          } else if (!isBackfill) {
            console.log(`[-] Block ${i}: No user transfers met criteria.`);
          }

          // 🛑 FIX: Periodically save state ONLY in backfill mode
          if (isBackfill) {
            blocksSinceLastSave++;
            if (blocksSinceLastSave >= SAVE_STATE_INTERVAL) {
              await saveCollectorState(i);
              blocksSinceLastSave = 0;
              console.log(`[STATE] Saved backfill progress at block ${i}`);
            }
          }
        }
        
        lastProcessedBlock = endBlock;
      }
    } catch (error) {
      console.error(`[-] Polling error on ${chainName}:`, error.message);
    } finally {
      isProcessing = false;
    }
  }, 4000);
}

startCollector();