import 'dotenv/config';
import { createPublicClient, http, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { createClient } from '@supabase/supabase-js';

// ─── CLI Flags & Configuration ───
const isDryRun = process.argv.includes('--dry-run');
const TX_LIMIT_HEX = '0x64';
const THRESHOLD_USD = 200; // Minimum required USD balance to pass Stage 1
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 600;
const MIN_TX_FOR_ANALYSIS = 10;
const BOT_SCORE_THRESHOLD = 0.6;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const MAX_NONCE_LIMIT = 1000;

console.log('\n==================================================');
if (isDryRun) {
  console.log('[🔍 DRY-RUN MODE ACTIVE]');
  console.log('No database records will be modified.');
  console.log('Valid targets WOULD be promoted to pending_targets.');
  console.log('Processed rows WOULD be removed from raw_targets.');
} else {
  console.log('[⚠️  LIVE EXECUTION MODE]');
  console.log('Valid targets WILL be inserted into pending_targets.');
  console.log('Processed rows WILL be removed from raw_targets.');
}
console.log(`[💰 BALANCE THRESHOLD]: $${THRESHOLD_USD} USD`);
console.log('==================================================\n');

// ─── Supabase Setup ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('[history] Missing Supabase credentials.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Generic Public RPC URLs (Stage 1) ───
const GENERIC_RPCS = {
  ethereum: [
    'https://white-sparkling-season.ethereum-mainnet.quiknode.pro/c96fe9f061e74418f432d2e2df614c83a3bbd239/',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
    'https://1rpc.io/eth',
    'https://ethereum-rpc.publicnode.com'
  ],
  bsc: [
    'https://binance.llamarpc.com',
    'https://rpc.ankr.com/bsc',
    'https://bsc-dataseed.binance.org',
    'https://1rpc.io/bnb',
    'https://bsc-rpc.publicnode.com'
  ],
  polygon: [
    'https://polygon.llamarpc.com',
    'https://rpc.ankr.com/polygon',
    'https://1rpc.io/matic',
    'https://polygon-bor-rpc.publicnode.com'
  ],
};

// ─── Alchemy-Only RPC URLs (Stage 2) ───
const ALCHEMY_RPCS = {
  bsc: [
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_z1J_ESjjLVZwSBLNoep84',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_-NvhHn24EgwhuMt38pZJr',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_8ToIPT9Z3R1iQ55nksx8b',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Qy6hQXdtdVlE7Z4uVxt_A',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_rniHI4MxzjBfNZ4bxmDu5',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
  ],
  polygon: [
    'https://polygon-mainnet.g.alchemy.com/v2/CByFU5cCGAYyh8EHLamXD',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UdSkrC6LFs2HGS0VUGg5O',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_tAPr1C9JUzQZYax5pslu5',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_Bq31mnvxmjdT70RCYLGLA',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_17XYrB1qagYO9Edwxj7Cw',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_UQzY-saHkZZrowH7kylTu',
    'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
  ],
  ethereum: [
    'https://eth-mainnet.g.alchemy.com/v2/alch_vHCE0WOUUK1Mk5G0tyA76',
    'https://eth-mainnet.g.alchemy.com/v2/alch_YHosKAPg0sfm7jDhqvW74',
    'https://eth-mainnet.g.alchemy.com/v2/alch_lTX5t4XwroOB87Xk0AWbY',
    'https://eth-mainnet.g.alchemy.com/v2/alch_9dpiCogyGyxtA4ptC-zIl',
    'https://eth-mainnet.g.alchemy.com/v2/alch_Y8rCHyOCRzZAW_2xLVM5r',
    'https://eth-mainnet.g.alchemy.com/v2/alch_gx9srjXabB0OocIDNitUd',
    'https://eth-mainnet.g.alchemy.com/v2/alch_9P2EBVaMvYP0SPn4zjBUB',
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
    'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
    'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
    'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
    'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
  ],
};

// ─── Stage 1 Public Clients (Generic RPCs) ───
const stage1Clients = {
  1: createPublicClient({
    chain: mainnet,
    transport: fallback(
      GENERIC_RPCS.ethereum.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
  56: createPublicClient({
    chain: bsc,
    transport: fallback(
      GENERIC_RPCS.bsc.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
  137: createPublicClient({
    chain: polygon,
    transport: fallback(
      GENERIC_RPCS.polygon.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
};

// ─── Stage 2 Public Clients (Alchemy-Only) ───
const stage2Clients = {
  1: createPublicClient({
    chain: mainnet,
    transport: fallback(
      ALCHEMY_RPCS.ethereum.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
  56: createPublicClient({
    chain: bsc,
    transport: fallback(
      ALCHEMY_RPCS.bsc.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
  137: createPublicClient({
    chain: polygon,
    transport: fallback(
      ALCHEMY_RPCS.polygon.map(url => http(url, { timeout: 15000 })),
      { retryCount: 3 }
    ),
  }),
};

// ─── Chain & Stablecoin Configuration ───
const CHAIN_NAME_MAP = { 1: 'ethereum', 56: 'bsc', 137: 'polygon' };
const CHAIN_ID_MAP = { ethereum: 1, bsc: 56, polygon: 137 };

const ALCHEMY_CATEGORIES = {
  1: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
  56: ['external', 'erc20', 'erc721', 'erc1155'],
  137: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
};

const STABLECOIN_CONFIG = {
  1: {
    coingeckoId: 'ethereum',
    nativeSymbol: 'ETH',
    stablecoins: {
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      USDP: '0x8E870D67F660D95d5be530380D0eC0bd388289E1',
      TUSD: '0x0000000000085d4780B73119b644AE5ecd22b376',
      FRAX: '0x853d955aCEf822Db058eb8505911ED77F175b99e',
    },
    decimals: { USDT: 6, USDC: 6, DAI: 18, USDP: 18, TUSD: 18, FRAX: 18, ETH: 18 },
  },
  56: {
    coingeckoId: 'binancecoin',
    nativeSymbol: 'BNB',
    stablecoins: {
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
      DAI: '0x1AF3F329e8BE154074D8769D1FFa4f058117F6b8',
    },
    decimals: { USDT: 18, USDC: 18, BUSD: 18, DAI: 18, BNB: 18 },
  },
  137: {
    coingeckoId: 'matic-network',
    nativeSymbol: 'MATIC',
    stablecoins: {
      USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      USDCe: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      USDP: '0x2aBE941127B1C078d5e75E7C68A0e3ae3B0b8f1D',
    },
    decimals: { USDT: 6, USDC: 6, USDCe: 6, DAI: 18, USDP: 18, MATIC: 18 },
  },
};

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
];

let prices = {};

// ─── Utilities ───
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getNativePrices() {
  const fallbackPrices = { ethereum: 1900, binancecoin: 610, 'matic-network': 0.08 };
  try {
    const ids = 'ethereum,binancecoin,matic-network';
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    return {
      ethereum: data.ethereum?.usd || fallbackPrices.ethereum,
      binancecoin: data.binancecoin?.usd || fallbackPrices.binancecoin,
      'matic-network': data['matic-network']?.usd || fallbackPrices['matic-network'],
      USDT: 1, USDC: 1, BUSD: 1, DAI: 1, USDP: 1, TUSD: 1, FRAX: 1, USDCe: 1,
    };
  } catch (err) {
    console.warn(`  ⚠️ Price fetch failed (${err.message}). Using default fallbacks.`);
    return {
      ethereum: 1900, binancecoin: 610, 'matic-network': 0.08,
      USDT: 1, USDC: 1, BUSD: 1, DAI: 1, USDP: 1, TUSD: 1, FRAX: 1, USDCe: 1,
    };
  }
}

async function fetchAllRows(table, selectColumns) {
  const PAGE_SIZE = 1000;
  let offset = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(selectColumns)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);

    if (allRows.length % 5000 === 0) {
      console.log(`  └─ Fetched ${allRows.length} rows from ${table}...`);
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return allRows;
}

// ─── USD Balance Evaluation Helper (Stage 1) ───
async function calculateAddressUsdBalance(checksumAddr, chainId) {
  const client = stage1Clients[chainId];
  const cfg = STABLECOIN_CONFIG[chainId];
  if (!client || !cfg) return 0;

  try {
    const nativeBalPromise = client.getBalance({ address: checksumAddr });

    let tokenBalancesMap = {};
    let tokenSuccess = false;

    // 1. Try Alchemy API token balance request (will fail gracefully on generic RPCs)
    try {
      const tokenAddrs = Object.values(cfg.stablecoins);
      const tokenResult = await client.request({
        method: 'alchemy_getTokenBalances',
        params: [checksumAddr, tokenAddrs],
      });

      if (tokenResult && Array.isArray(tokenResult.tokenBalances)) {
        const symbolByAddr = {};
        for (const [sym, addr] of Object.entries(cfg.stablecoins)) {
          symbolByAddr[addr.toLowerCase()] = sym;
        }
        for (const tb of tokenResult.tokenBalances) {
          if (!tb.tokenBalance || tb.tokenBalance === '0x0' || tb.error) continue;
          const sym = symbolByAddr[tb.contractAddress?.toLowerCase()];
          if (!sym) continue;
          try {
            tokenBalancesMap[sym] = BigInt(tb.tokenBalance);
          } catch { }
        }
        tokenSuccess = true;
      }
    } catch (e) {
      // Fall through to Multicall fallback
    }

    // 2. Multicall fallback on generic RPCs
    if (!tokenSuccess) {
      const tokenEntries = Object.entries(cfg.stablecoins);
      const multicallRes = await client.multicall({
        contracts: tokenEntries.map(([, tokenAddr]) => ({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [checksumAddr],
        })),
        allowFailure: true,
      });

      multicallRes.forEach((res, idx) => {
        if (res.status === 'success' && res.result) {
          const [sym] = tokenEntries[idx];
          tokenBalancesMap[sym] = BigInt(res.result);
        }
      });
    }

    const nativeBal = await nativeBalPromise;

    let totalUsd = 0;
    const nativeDecimal = cfg.decimals[cfg.nativeSymbol] || 18;
    const nativeAmount = Number(nativeBal) / (10 ** nativeDecimal);
    const nativePrice = prices[cfg.coingeckoId] || 0;
    totalUsd += nativeAmount * nativePrice;

    for (const [sym, rawBal] of Object.entries(tokenBalancesMap)) {
      const decimals = cfg.decimals[sym] || 18;
      const amount = Number(rawBal) / (10 ** decimals);
      totalUsd += amount * (prices[sym] || 1);
    }

    return totalUsd;
  } catch (err) {
    return 0;
  }
}

// ─── STAGE 1: On-chain State & USD Balance Checks ───
async function passesStageOne(address, chainId) {
  const client = stage1Clients[chainId];
  if (!client) return { pass: true, reason: 'no_client' };

  try {
    const checksumAddr = getAddress(address);
    const [code, nonce] = await Promise.all([
      client.getBytecode({ address: checksumAddr }),
      client.getTransactionCount({ address: checksumAddr }),
    ]);

    if (code && code !== '0x') return { pass: false, reason: 'is_contract' };
    if (nonce === 0) return { pass: false, reason: 'zero_nonce' };
    if (nonce >= MAX_NONCE_LIMIT) return { pass: false, reason: `high_nonce(${nonce})` };

    // Check Native + Stablecoin total USD valuation
    const totalUsd = await calculateAddressUsdBalance(checksumAddr, chainId);
    if (totalUsd < THRESHOLD_USD) {
      return { pass: false, reason: `low_usd_balance($${totalUsd.toFixed(2)})` };
    }

    return { pass: true, reason: 'eoa_ok' };
  } catch (err) {
    return { pass: true, reason: 'rpc_fail_stage1' };
  }
}

// ─── STAGE 2: Behavioral Analysis (Alchemy Dedicated) ───
async function fetchTransactionHistory(address, chainId) {
  const client = stage2Clients[chainId];
  if (!client) return null;

  try {
    const checksumAddr = getAddress(address);
    const category = ALCHEMY_CATEGORIES[chainId] || ALCHEMY_CATEGORIES[1];

    const [outRes, inRes] = await Promise.all([
      client.request({
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          fromAddress: checksumAddr,
          category,
          maxCount: TX_LIMIT_HEX,
          order: 'desc',
          withMetadata: true,
        }],
      }).catch(() => null),
      client.request({
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          toAddress: checksumAddr,
          category,
          maxCount: TX_LIMIT_HEX,
          order: 'desc',
          withMetadata: true,
        }],
      }).catch(() => null)
    ]);

    if (!outRes && !inRes) return null;

    const transfers = [];

    if (outRes?.transfers) {
      transfers.push(...outRes.transfers.map(t => ({ ...t, direction: 'out' })));
    }
    if (inRes?.transfers) {
      transfers.push(...inRes.transfers.map(t => ({ ...t, direction: 'in' })));
    }

    if (transfers.length === 0) return [];

    const unique = [];
    const seen = new Set();
    for (const t of transfers) {
      const id = t.uniqueId || `${t.hash}-${t.direction}`;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(t);
      }
    }

    unique.sort((a, b) => {
      const blockA = parseInt(a.blockNum, 16);
      const blockB = parseInt(b.blockNum, 16);
      return blockB - blockA;
    });

    return unique.slice(0, parseInt(TX_LIMIT_HEX, 16));
  } catch (err) {
    return null;
  }
}

function analyzeTransactionPatterns(transfers) {
  if (!transfers || transfers.length < MIN_TX_FOR_ANALYSIS) {
    return { score: 0, reason: 'insufficient_data', txCount: transfers ? transfers.length : 0 };
  }

  const chronological = [...transfers].reverse();
  const hours = new Set();
  const intervals = [];

  let prevTimestamp = null;
  let prevBlock = null;
  let prevDirection = null;
  const uniqueReceivers = new Set();

  const blockCounts = new Map();
  let zeroGapCount = 0;
  let currentBlockStreak = 0;
  let maxBlockStreak = 0;
  let totalIntervals = 0;

  let minTs = Infinity;
  let maxTs = -Infinity;
  let minInterval = Infinity;
  let minInOutInterval = Infinity;
  let microGapCount = 0;
  let sweepCount = 0;

  for (const tx of chronological) {
    const tsStr = tx.metadata?.blockTimestamp;
    if (!tsStr) continue;
    const timestamp = new Date(tsStr);
    if (isNaN(timestamp.getTime())) continue;
    const tsMs = timestamp.getTime();

    if (tsMs < minTs) minTs = tsMs;
    if (tsMs > maxTs) maxTs = tsMs;

    hours.add(timestamp.getUTCHours());
    if (tx.to && tx.direction === 'out') uniqueReceivers.add(tx.to.toLowerCase());

    if (tx.blockNum) {
      const currentBlock = BigInt(tx.blockNum);
      blockCounts.set(tx.blockNum, (blockCounts.get(tx.blockNum) || 0) + 1);

      if (prevBlock !== null) {
        const blockDiff = currentBlock - prevBlock;
        if (blockDiff >= 0n && blockDiff <= 2n) {
          currentBlockStreak++;
          if (currentBlockStreak > maxBlockStreak) maxBlockStreak = currentBlockStreak;
        } else {
          currentBlockStreak = 0;
        }
      }
      prevBlock = currentBlock;
    }

    if (prevTimestamp !== null) {
      const gapSeconds = (tsMs - prevTimestamp) / 1000;
      totalIntervals++;

      if (prevDirection === 'in' && tx.direction === 'out') {
        if (gapSeconds >= 0 && gapSeconds < 180) {
          sweepCount++;
        }
        if (gapSeconds >= 0 && gapSeconds < minInOutInterval) {
          minInOutInterval = gapSeconds;
        }
      }

      if (gapSeconds >= 0 && gapSeconds < minInterval) {
        minInterval = gapSeconds;
      }
      if (gapSeconds >= 0 && gapSeconds < 180) {
        microGapCount++;
      }

      if (gapSeconds > 0) {
        intervals.push(gapSeconds);
      } else {
        zeroGapCount++;
      }
    }
    prevTimestamp = tsMs;
    prevDirection = tx.direction;
  }

  if (intervals.length < 3 && zeroGapCount < 5) {
    return { score: 0, reason: 'too_few_intervals', txCount: transfers.length };
  }

  const spanDays = (minTs === Infinity || maxTs === -Infinity)
    ? Infinity
    : (maxTs - minTs) / (1000 * 60 * 60 * 24);

  const hourCoverage = hours.size / 24;
  const avgInterval = intervals.length > 0
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : 0;
  const variance = intervals.length > 0
    ? intervals.reduce((a, b) => a + (b - avgInterval) ** 2, 0) / intervals.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const cv = avgInterval === 0 ? 0 : stdDev / avgInterval;
  const receiverCount = uniqueReceivers.size;

  const blockCountsValues = [...blockCounts.values()];
  const maxBatchSize = blockCountsValues.length > 0 ? Math.max(...blockCountsValues) : 0;
  const batchBlockCount = blockCountsValues.filter(c => c >= 3).length;
  const zeroGapRatio = totalIntervals > 0 ? zeroGapCount / totalIntervals : 0;

  const transfersPerDay = (spanDays > 0 && spanDays !== Infinity)
    ? transfers.length / spanDays
    : 0;

  // ─── Scoring ───
  let score = 0;
  const signals = [];

  if (maxBatchSize >= 3) { score += 0.65; signals.push(`extreme_batch(max=${maxBatchSize})`); }
  else if (maxBatchSize === 2) { score += 0.35; signals.push(`batch(max=${maxBatchSize})`); }
  if (batchBlockCount >= 3) { score += 0.25; signals.push(`sustained_batch(${batchBlockCount}blocks)`); }
  if (maxBlockStreak >= 3) { score += 0.65; signals.push(`extreme_block_streak(${maxBlockStreak})`); }
  else if (maxBlockStreak >= 2) { score += 0.40; signals.push(`block_streak(${maxBlockStreak})`); }
  if (hourCoverage > 0.75 && spanDays < 30) { score += 0.30; signals.push(`24/7(${hours.size}h/${spanDays.toFixed(0)}d)`); }
  if (avgInterval < 300 && cv < 0.45 && intervals.length >= 5) { score += 0.35; signals.push(`robotic(avg=${avgInterval.toFixed(0)}s,cv=${cv.toFixed(2)})`); }

  if (receiverCount === 1) {
    const humanLike = spanDays > 90;
    if (humanLike) { score += 0.10; signals.push(`single_recv_humanlike(${spanDays.toFixed(0)}d)`); }
    else if (transfers.length >= 30) { score += 0.60; signals.push(`single_recv_sweeper(${transfers.length}tx)`); }
    else { score += 0.50; signals.push(`single_recv(${transfers.length}tx)`); }
  } else if (receiverCount <= 2) { score += 0.20; signals.push(`low_div(${receiverCount})`); }

  if (avgInterval < 60 && avgInterval > 0) { score += 0.25; signals.push(`rapid(${avgInterval.toFixed(0)}s)`); }
  if (zeroGapRatio > 0.40) { score += 0.20; signals.push(`zero_gap(${(zeroGapRatio * 100).toFixed(0)}%)`); }
  if (spanDays <= 4 && transfers.length >= 60) { score += 0.55; signals.push(`high_density(${transfers.length}tx/${spanDays.toFixed(1)}d)`); }
  else if (spanDays <= 7 && transfers.length >= 30) { score += 0.35; signals.push(`dense(${transfers.length}tx/${spanDays.toFixed(1)}d)`); }
  if (transfers.length >= 30 && transfersPerDay >= 15) { score += 0.60; signals.push(`high_daily_vol(${transfersPerDay.toFixed(0)}/day)`); }
  else if (transfers.length >= 20 && transfersPerDay >= 8) { score += 0.40; signals.push(`daily_vol(${transfersPerDay.toFixed(0)}/day)`); }

  const rapidRatio = totalIntervals > 0 ? (microGapCount / totalIntervals) : 0;

  if (totalIntervals > 10 && rapidRatio > 0.50) {
    score += 0.50;
    signals.push(`mostly_rapid(${(rapidRatio * 100).toFixed(0)}%)`);
  }

  if (sweepCount >= 3) {
    score += 0.80;
    signals.push(`confirmed_sweeper(${sweepCount}x)`);
  }

  if (receiverCount > 10 && spanDays > 30) {
    score -= 0.40;
    signals.push(`human_diversity(${receiverCount} contracts)`);
  }

  return {
    score: Math.min(score, 1.0),
    reason: signals.length > 0 ? signals.join('+') : 'clean',
    txCount: transfers.length,
    maxBatch: maxBatchSize,
    consecutiveBlocks: maxBlockStreak,
    batchBlocks: batchBlockCount,
    zeroGapPct: (zeroGapRatio * 100).toFixed(0),
    hours: `${hours.size}/24`,
    avgGap: avgInterval.toFixed(0),
    minGap: minInterval === Infinity ? '∞' : minInterval.toFixed(0),
    microGaps: microGapCount,
    cv: cv.toFixed(3),
    receivers: receiverCount,
    spanDays: spanDays === Infinity ? '∞' : spanDays.toFixed(1),
    perDay: transfersPerDay > 0 ? transfersPerDay.toFixed(1) : '0',
  };
}

// ─── Combined Analysis Pipeline ───
async function analyzeAddress(address, chainId) {
  const stage1 = await passesStageOne(address, chainId);
  if (!stage1.pass) {
    return { valid: false, stage: 'stage1', reason: stage1.reason, analysis: null };
  }

  const transfers = await fetchTransactionHistory(address, chainId);
  if (!transfers) {
    return { valid: true, stage: 'stage2', reason: 'rpc_fail_stage2', analysis: null };
  }

  const analysis = analyzeTransactionPatterns(transfers);
  if (analysis.score >= BOT_SCORE_THRESHOLD) {
    return { valid: false, stage: 'stage2', reason: analysis.reason, analysis };
  }

  return { valid: true, stage: 'pass', reason: 'human', analysis };
}

// ─── Batch Raw Targets Removal Helper ───
async function purgeRawTargets(idsToDelete) {
  if (idsToDelete.size === 0) return;

  const idList = Array.from(idsToDelete);
  console.log(`\n[🧹 PURGING BATCH] Removing ${idList.length} processed rows from raw_targets...`);

  if (isDryRun) {
    console.log(`  [🔍 DRY-RUN] Would remove ${idList.length} rows from raw_targets.`);
    idsToDelete.clear();
    return;
  }

  for (let j = 0; j < idList.length; j += 100) {
    const chunk = idList.slice(j, j + 100);
    const { error: delErr } = await supabase
      .from('raw_targets')
      .delete()
      .in('id', chunk);

    if (delErr && delErr.code !== '42P01') {
      console.error(`  [-] raw_targets delete error:`, delErr.message);
    }
  }
  console.log(`  [+] ${idList.length} rows removed from raw_targets.`);
  idsToDelete.clear();
}

// ─── Promote Valid Targets to pending_targets ───
async function promoteToPending(validTargets) {
  if (validTargets.length === 0) return 0;

  const rows = validTargets.map(t => ({
    chain: t.chain,
    counterparty: t.counterparty.toLowerCase(),
    victim: t.victim.toLowerCase(),
    last_transfer_date: t.last_transfer_date || null,
    last_transfer_amount: t.last_transfer_amount || null,
    last_transfer_asset: t.last_transfer_asset || null,
    last_transfer_block: t.last_transfer_block || null,
    processed: false,
  }));

  if (isDryRun) {
    console.log(`\n[🔍 DRY-RUN] Would promote ${rows.length} valid targets to pending_targets.`);
    return rows.length;
  }

  console.log(`\n[⬆️  PROMOTING] Inserting ${rows.length} validated human targets into pending_targets...`);

  let promoted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { data, error } = await supabase
      .from('pending_targets')
      .upsert(chunk, { onConflict: 'chain,counterparty,victim', ignoreDuplicates: true })
      .select('id');

    if (error) {
      if (error.code === '23505') {
        console.log(`  [!] Some duplicates skipped (already in pending_targets)`);
      } else {
        console.error(`  [-] pending_targets upsert error:`, error.message);
      }
    }
    promoted += data?.length || 0;
  }

  console.log(`  [+] ${promoted} targets promoted to pending_targets.`);
  return promoted;
}

// ─── Main Execution Pipeline ───
async function runCleanup() {
  console.log('[+] Fetching native asset prices...');
  prices = await getNativePrices();
  console.log('    Prices:', Object.entries(prices)
    .filter(([k]) => ['ethereum', 'binancecoin', 'matic-network'].includes(k))
    .map(([k, v]) => `${k}=$${v}`).join(', '));

  console.log('\n[+] Phase 1: Fetching ALL addresses from raw_targets...\n');

  let targetsList = [];

  try {
    targetsList = await fetchAllRows('raw_targets', 'id, chain, counterparty, victim, last_transfer_date, last_transfer_amount, last_transfer_asset, last_transfer_block');
  } catch (err) {
    if (err.code === '42P01') {
      console.error('[-] FATAL: Table raw_targets does not exist. Run the SQL migration first.');
      console.error('    CREATE TABLE raw_targets (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, chain TEXT, counterparty TEXT, victim TEXT, last_transfer_date TIMESTAMPTZ, last_transfer_amount TEXT, last_transfer_asset TEXT, last_transfer_block BIGINT, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(chain, counterparty, victim));');
    } else {
      console.error('[-] Error fetching raw_targets:', err.message);
    }
    return;
  }

  console.log(`\n[+] Total rows: ${targetsList.length} in raw_targets`);

  if (targetsList.length === 0) {
    console.log('\n[✓] raw_targets is empty. Nothing to process.\n');
    return;
  }

  const uniqueMap = new Map();

  for (const row of targetsList) {
    if (!row.victim || !row.chain || !row.id) continue;
    if (row.victim.toLowerCase() === ZERO_ADDR) continue;
    const cid = CHAIN_ID_MAP[row.chain.toLowerCase()];
    if (!cid) continue;
    const key = `${row.victim.toLowerCase()}_${cid}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, {
        rawId: row.id,
        address: row.victim.toLowerCase(),
        chainId: cid,
        chain: row.chain.toLowerCase(),
        counterparty: row.counterparty,
        victim: row.victim,
        last_transfer_date: row.last_transfer_date,
        last_transfer_amount: row.last_transfer_amount,
        last_transfer_asset: row.last_transfer_asset,
        last_transfer_block: row.last_transfer_block,
      });
    }
  }

  const uniqueAddresses = Array.from(uniqueMap.values());
  console.log(`[+] Unique addresses to analyze: ${uniqueAddresses.length}\n`);

  targetsList = null;

  console.log('[+] Phase 2: Running Stage 1 (on-chain state & $ threshold) + Stage 2 (behavioral) analysis...\n');

  const invalidByChain = new Map([
    [1, new Set()],
    [56, new Set()],
    [137, new Set()],
  ]);

  // 🆕 Track ALL raw_target IDs to delete (both valid and invalid, since all are processed)
  const pendingRawIdsToDelete = new Set();

  // 🆕 Track valid targets to promote to pending_targets
  const validTargetsToPromote = [];

  const analysisResults = new Map();
  const reasonCounts = new Map();

  let analyzedCount = 0;
  let invalidCount = 0;
  let humanCount = 0;
  let stage1Rejects = 0;
  let stage2Rejects = 0;
  let rpcFailCount = 0;
  let lastPurgeAt = 0;
  let totalPromoted = 0;

  for (let i = 0; i < uniqueAddresses.length; i += BATCH_SIZE) {
    const batch = uniqueAddresses.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (entry) => {
        const result = await analyzeAddress(entry.address, entry.chainId);
        return { ...entry, chainId: entry.chainId, ...result };
      })
    );

    for (const res of results) {
      analyzedCount++;
      const cacheKey = `${res.address}_${res.chainId}`;

      const reasonKey = res.valid ? 'human' : `${res.stage}:${res.reason.split('(')[0].split('+')[0]}`;
      reasonCounts.set(reasonKey, (reasonCounts.get(reasonKey) || 0) + 1);

      if (res.analysis) {
        analysisResults.set(cacheKey, res.analysis);
      }

      // 🆕 Track this raw_target ID for deletion (all processed rows get removed)
      if (res.rawId) {
        pendingRawIdsToDelete.add(res.rawId);
      }

      if (!res.valid) {
        invalidCount++;
        if (res.stage === 'stage1') stage1Rejects++;
        if (res.stage === 'stage2') stage2Rejects++;

        if (invalidByChain.has(res.chainId)) {
          invalidByChain.get(res.chainId).add(res.address);
        }
        // Invalid targets: just discard (do NOT promote to pending_targets)
      } else if (res.reason.includes('rpc_fail')) {
        rpcFailCount++;
        humanCount++;
        // 🆕 RPC failure = promote anyway (preserve original behavior)
        validTargetsToPromote.push(res);
      } else {
        humanCount++;
        // 🆕 Confirmed human = promote to pending_targets
        validTargetsToPromote.push(res);
      }
    }

    if ((i + BATCH_SIZE) % 80 === 0 || i + BATCH_SIZE >= uniqueAddresses.length) {
      console.log(
        `  └─ Progress: ${Math.min(i + BATCH_SIZE, uniqueAddresses.length)} / ${uniqueAddresses.length}` +
        ` | ✅ ${humanCount} | ❌ ${invalidCount} (S1:${stage1Rejects} S2:${stage2Rejects}) | ⚠️ ${rpcFailCount} RPC`
      );
    }

    if (analyzedCount - lastPurgeAt >= 1000) {
      // 🆕 Promote valid targets to pending_targets every 1000 analyzed
      if (validTargetsToPromote.length > 0) {
        const batchPromoted = await promoteToPending(validTargetsToPromote);
        totalPromoted += batchPromoted;
        validTargetsToPromote.length = 0; // Clear array for next batch
      }

      await purgeRawTargets(pendingRawIdsToDelete);
      lastPurgeAt = analyzedCount;
    }

    if (i + BATCH_SIZE < uniqueAddresses.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 2.5: DIAGNOSTIC — Score Distribution Sample
  // ═══════════════════════════════════════════════════════════

  console.log('\n==================================================');
  console.log(' [DIAGNOSTIC] Score Distribution Sample (30 addresses)');
  console.log('==================================================\n');

  const sampleSize = 30;
  const step = Math.max(1, Math.floor(uniqueAddresses.length / sampleSize));
  const sample = [];
  for (let i = 0; i < uniqueAddresses.length && sample.length < sampleSize; i += step) {
    sample.push(uniqueAddresses[i]);
  }

  let sampleInsufficient = 0;
  let sampleAnalyzed = 0;
  const scoreBuckets = { '0.00': 0, '0.01-0.29': 0, '0.30-0.59': 0, '0.60-1.00': 0 };

  console.log(`  ${'Address'.padEnd(44)} ${'Chain'.padEnd(8)} ${'TXs'.padEnd(4)} ${'Batch'.padEnd(6)} ${'Streak'.padEnd(7)} ${'MinGap'.padEnd(7)} ${'ZGap%'.padEnd(6)} ${'Hours'.padEnd(6)} ${'AvgGap'.padEnd(8)} ${'CV'.padEnd(6)} ${'Recv'.padEnd(5)} ${'SpanD'.padEnd(7)} ${'PerDay'.padEnd(7)} ${'Score'.padEnd(6)} Verdict`);
  console.log(`  ${'─'.repeat(44)} ${'─'.repeat(8)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(20)}`);

  for (const { address, chainId: cid } of sample) {
    const cacheKey = `${address}_${cid}`;
    const result = analysisResults.get(cacheKey);

    if (!result) {
      console.log(`  ${address.padEnd(44)} ${CHAIN_NAME_MAP[cid].padEnd(8)} ${'—'.padEnd(4)} ${'—'.padEnd(6)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(6)} ${'—'.padEnd(5)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} S1 REJECT / NO DATA`);
      continue;
    }

    if (result.reason === 'insufficient_data' || result.reason === 'too_few_intervals') {
      sampleInsufficient++;
      console.log(`  ${address.padEnd(44)} ${CHAIN_NAME_MAP[cid].padEnd(8)} ${String(result.txCount).padEnd(4)} ${'—'.padEnd(6)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} ${'—'.padEnd(6)} ${'—'.padEnd(8)} ${'—'.padEnd(6)} ${'—'.padEnd(5)} ${'—'.padEnd(7)} ${'—'.padEnd(7)} ${'—'.padEnd(6)} SKIP (${result.reason})`);
      continue;
    }

    sampleAnalyzed++;
    const verdict = result.score >= BOT_SCORE_THRESHOLD ? '🤖 BOT' : '👤 HUMAN';

    console.log(
      `  ${address.padEnd(44)} ${CHAIN_NAME_MAP[cid].padEnd(8)} ${String(result.txCount).padEnd(4)} ` +
      `${String(result.maxBatch).padEnd(6)} ${String(result.consecutiveBlocks).padEnd(7)} ${String(result.minGap).padEnd(7)} ${(result.zeroGapPct + '%').padEnd(6)} ${String(result.hours).padEnd(6)} ` +
      `${(result.avgGap + 's').padEnd(8)} ${String(result.cv).padEnd(6)} ${String(result.receivers).padEnd(5)} ` +
      `${String(result.spanDays).padEnd(7)} ${String(result.perDay).padEnd(7)} ` +
      `${result.score.toFixed(2).padEnd(6)} ${verdict} [${result.reason}]`
    );

    if (result.score === 0) scoreBuckets['0.00']++;
    else if (result.score < 0.30) scoreBuckets['0.01-0.29']++;
    else if (result.score < 0.60) scoreBuckets['0.30-0.59']++;
    else scoreBuckets['0.60-1.00']++;
  }

  console.log(`\n  ── Sample Summary ──`);
  console.log(`  ├─ Sampled:              ${sample.length}`);
  console.log(`  ├─ Insufficient data:    ${sampleInsufficient}`);
  console.log(`  ├─ Fully analyzed:       ${sampleAnalyzed}`);
  console.log(`  └─ Score distribution:`);
  console.log(`      ├─ 0.00 (clean):     ${scoreBuckets['0.00']}`);
  console.log(`      ├─ 0.01 – 0.29:      ${scoreBuckets['0.01-0.29']}`);
  console.log(`      ├─ 0.30 – 0.59:      ${scoreBuckets['0.30-0.59']}`);
  console.log(`      └─ 0.60 – 1.00 (BOT): ${scoreBuckets['0.60-1.00']}`);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3: Summary
  // ═══════════════════════════════════════════════════════════

  let totalInvalid = 0;
  for (const set of invalidByChain.values()) totalInvalid += set.size;

  console.log('\n==================================================');
  console.log(' STAGE 1 + STAGE 2 RAW TARGETS ANALYSIS RESULTS');
  console.log('==================================================');
  console.log(`  ├─ Total addresses analyzed:    ${analyzedCount}`);
  console.log(`  ├─ Confirmed humans:            ${humanCount} (will be promoted to pending_targets)`);
  console.log(`  ├─ Stage 1 rejects:             ${stage1Rejects} (contract/zero_nonce/low_balance)`);
  console.log(`  ├─ Stage 2 rejects:             ${stage2Rejects} (behavioral bots)`);
  console.log(`  ├─ RPC failures (promoted):     ${rpcFailCount}`);
  console.log(`  ├─ Invalid targets discarded:   ${totalInvalid}`);
  console.log(`  ├─ Valid targets in queue:      ${validTargetsToPromote.length}`);
  console.log(`  └─ Total promoted so far:       ${totalPromoted}`);

  if (reasonCounts.size > 0) {
    console.log('\n  📋 Outcome breakdown:');
    const sorted = [...reasonCounts.entries()]
      .filter(([r]) => r !== 'human')
      .sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      console.log(`     ├─ ${reason}: ${count}`);
    }
    const humanReasonCount = reasonCounts.get('human') || 0;
    console.log(`     └─ human (promoted): ${humanReasonCount}`);
  }

  for (const [cid, addrSet] of invalidByChain) {
    if (addrSet.size > 0) {
      console.log(`\n      ${CHAIN_NAME_MAP[cid].toUpperCase()} (Chain ${cid}): ${addrSet.size} invalid targets discarded`);
    }
  }

  if (isDryRun) {
    console.log('\n[🔍 DRY-RUN COMPLETE]');
    console.log(`  ├─ ${totalPromoted + validTargetsToPromote.length} total targets WOULD be promoted to pending_targets.`);
    console.log(`  ├─ ${totalInvalid} invalid targets WOULD be discarded (not promoted).`);
    console.log(`  └─ ${pendingRawIdsToDelete.size} rows WOULD be removed from raw_targets.`);
    console.log('\n[i] No database changes were executed. Run without --dry-run to apply.\n');
    return;
  }

  // ═══════════════════════════════════════════════════════════
  // PHASE 4: Final Flush (Promote remaining + Remove remaining)
  // ═══════════════════════════════════════════════════════════

  if (validTargetsToPromote.length > 0) {
    console.log(`\n[!] Phase 4a: Promoting remaining ${validTargetsToPromote.length} validated human targets to pending_targets...\n`);
    const finalPromoted = await promoteToPending(validTargetsToPromote);
    totalPromoted += finalPromoted;
    validTargetsToPromote.length = 0;
  }

  if (pendingRawIdsToDelete.size > 0) {
    console.log(`\n[!] Phase 4b: Removing remaining ${pendingRawIdsToDelete.size} processed rows from raw_targets...\n`);
    await purgeRawTargets(pendingRawIdsToDelete);
  }

  console.log(`\n[🎉] Pipeline complete! Total promoted to pending_targets: ${totalPromoted}\n`);
}

runCleanup();