import 'dotenv/config';
import pg from 'pg';
import { config } from '../lib/config.js';

const { Pool } = pg;

// --- MULTI‑CHAIN: get current chain config ---
const chainName = config.chain || 'ethereum';
const chainCfg = config.getChainConfig ? config.getChainConfig() : null;

// --- Build TOKEN_DECIMALS from chain config (with fallback) ---
let TOKEN_DECIMALS = {};

if (chainCfg && chainCfg.tokens) {
  // Build from chain config tokens
  for (const [symbol, address] of Object.entries(chainCfg.tokens)) {
    let decimals = 18;
    if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'BUSD') {
      decimals = 6;
    } else if (symbol === 'WBTC') {
      decimals = 8;
    }
    // For native token, we use address '0x000...0000' with native decimals 18
    TOKEN_DECIMALS[address.toLowerCase()] = { symbol, decimals };
  }
} else {
  // Fallback to hardcoded Ethereum mainnet tokens
  TOKEN_DECIMALS = {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
    '0x0000000000000000000000000000000000000000': { symbol: chainCfg?.nativeSymbol || 'ETH', decimals: 18 }
  };
}

// Also add native token if not already present
const nativeSymbol = chainCfg?.nativeSymbol || 'ETH';
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
if (!TOKEN_DECIMALS[NATIVE_ADDRESS]) {
  TOKEN_DECIMALS[NATIVE_ADDRESS] = { symbol: nativeSymbol, decimals: 18 };
}

// --- Database connection ---
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: String(process.env.DB_PASSWORD),
  port: process.env.DB_PORT,
});

// --- Multi‑chain filter ---
const chainId = config.getChainId ? config.getChainId() : 1;

async function runClusterer() {
  console.log('\n[+] Booting Threat Intel Clustering Engine...');
  console.log(`[+] Scanning chain: ${chainName} (ID: ${chainId})`);
  console.log('[+] Scanning database for highly vulnerable "Stable Pairs"...\n');

  const query = `
    SELECT 
      sender AS "Victim_Wallet", 
      receiver AS "Trusted_Counterparty", 
      token_address AS "Token_Contract",
      COUNT(*) AS interaction_frequency,
      MAX(value::NUMERIC) AS raw_max_value
    FROM token_transfers
    WHERE chain_id = $1
    GROUP BY sender, receiver, token_address
    HAVING COUNT(*) > 1 
    ORDER BY interaction_frequency DESC
    LIMIT 15;
  `;

  try {
    const result = await pool.query(query, [chainId]);
    
    if (result.rows.length === 0) {
      console.log('[-] Insufficient data. Let the Collector run for a few more minutes to build the map.');
    } else {
      console.log(`[!] CRITICAL TARGETS IDENTIFIED: Found ${result.rows.length} high-risk clusters.`);
      
      // Format rows with token metadata from the dynamic map
      const readableRows = result.rows.map(row => {
        const tokenMeta = TOKEN_DECIMALS[row.Token_Contract.toLowerCase()];
        let readableValue = row.raw_max_value;
        let tokenLabel = 'UNKNOWN';

        if (tokenMeta) {
          const rawNum = parseFloat(row.raw_max_value);
          const divisor = Math.pow(10, tokenMeta.decimals);
          readableValue = (rawNum / divisor).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4
          });
          tokenLabel = tokenMeta.symbol;
        }

        return {
          'Victim Wallet': row.Victim_Wallet,
          'Trusted Counterparty': row.Trusted_Counterparty,
          'Asset': tokenLabel,
          'Frequency': parseInt(row.interaction_frequency),
          'Max Transfer Value': `${readableValue} ${tokenLabel}`
        };
      });

      console.table(readableRows);
    }
  } catch (error) {
    console.error('[-] Clustering Engine Error:', error.message);
  } finally {
    await pool.end();
  }
}

runClusterer();