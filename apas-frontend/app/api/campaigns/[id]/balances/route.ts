import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { createPublicClient, http, formatEther, formatUnits, fallback, getAddress } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

const chainMap = { ethereum: mainnet, bsc, polygon };

// Explicit environment mapping to align with backend config definitions
const rpcEnvMap: Record<string, string> = {
  ethereum: 'ETH_RPC_URL',
  bsc: 'BSC_RPC_URL',
  polygon: 'POLYGON_RPC_URL',
};

// Fully synchronized token asset list derived from your backend dependencies
const tokenMap: Record<string, Record<string, string>> = {
  ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  bsc: {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    DAI: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  },
  polygon: {
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    WBTC: '0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6',
  },
};

// Custom decimal overrides matching token specifications per chain
const tokenDecimalsMap: Record<string, Record<string, number>> = {
  ethereum: { USDC: 6, USDT: 6, WBTC: 8 },
  bsc: { USDC: 18, USDT: 18 }, // Explicitly overrides BSC variations to 18 decimals
  polygon: { USDC: 6, USDC_NATIVE: 6, USDT: 6, WBTC: 8 },
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

// ─── In‑Memory Cache ───
const balancesCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = parseInt(process.env.BALANCES_CACHE_TTL_MS || '60000', 10); // default 1 min

function getCachedBalances(campaignId: string) {
  const cached = balancesCache.get(campaignId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function setCachedBalances(campaignId: string, data: any) {
  balancesCache.set(campaignId, { data, timestamp: Date.now() });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = await createServerSupabaseClient();

    // Verify campaign execution access
    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('id, chain, is_mock')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (error || !campaign) {
      console.error('[balances] Campaign error:', error);
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    // ─── Handle mock campaigns ───
    if (campaign.is_mock) {
      console.log(`[balances] Campaign ${id} is a mock campaign – returning mock balances`);

      const { data: mockBalances, error: mockError } = await supabase
        .from('mock_balances')
        .select('trap_address, native, usdc, usdt')
        .eq('campaign_id', id);

      if (mockError) {
        console.error('[balances] Mock balances error:', mockError);
        return NextResponse.json({ error: 'Failed to fetch mock balances' }, { status: 500 });
      }

      // ✅ Format as simple strings (matching BalanceCard interface)
      const mockResults = (mockBalances || []).map((row) => ({
        trapAddress: row.trap_address,
        native: row.native.toString(),
        tokens: {
          USDC: row.usdc.toString(),
          USDT: row.usdt.toString(),
        },
      }));

      const response = { balances: mockResults };
      setCachedBalances(id, response);
      return NextResponse.json(response);
    }

    // ─── Check cache (Only AFTER ownership is verified) ───
    const cached = getCachedBalances(id);
    if (cached) {
      console.log(`[balances] Returning cached balances for campaign ${id}`);
      return NextResponse.json(cached);
    }

    // Fetch operational records
    const { data: traps, error: trapsError } = await supabase
      .from('traps')
      .select('trap_address, victim_address, counterparty_address, is_caught')
      .eq('campaign_id', id);

    if (trapsError) {
      console.error('[balances] Traps query error:', trapsError);
      return NextResponse.json({ error: 'Failed to fetch traps' }, { status: 500 });
    }

    if (!traps || traps.length === 0) {
      const emptyResponse = { balances: [] };
      setCachedBalances(id, emptyResponse);
      return NextResponse.json(emptyResponse);
    }

    const normalizedChain = campaign.chain?.toLowerCase() || '';

    // Dynamic environmental resolution logic
    const rpcVarName = rpcEnvMap[normalizedChain];
    const rpcUrl = rpcVarName ? process.env[rpcVarName] : process.env.NODE_RPC_URL;

    if (!rpcUrl) {
      console.error('[balances] No RPC URL configuration located for chain:', campaign.chain);
      return NextResponse.json({ error: 'RPC URL not configured' }, { status: 500 });
    }

    console.log(`[balances] Using RPC: ${rpcUrl} for chain ${campaign.chain}`);

    const chain = chainMap[normalizedChain as keyof typeof chainMap];
    if (!chain) {
      return NextResponse.json({ error: 'Unsupported chain' }, { status: 400 });
    }

    // ─── Public RPC Fallbacks ───
    const PUBLIC_FALLBACKS: Record<string, string[]> = {
      bsc: [
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

    const rawUrls = [rpcUrl, ...(PUBLIC_FALLBACKS[normalizedChain] || [])];
    const fallbackUrls = Array.from(new Set(rawUrls.filter(Boolean)));

    const client = createPublicClient({
      chain,
      transport: fallback(
        fallbackUrls.map((url) => http(url, { timeout: 15000 })),
        { rank: false }
      ),
    });

    const tokenAddresses = tokenMap[normalizedChain] || {};
    const decimalsForChain = tokenDecimalsMap[normalizedChain] || {};
    const errors: string[] = [];

    // Process traps concurrently to prevent waterfall timeouts
    const results = await Promise.all(
      traps.map(async (trap) => {
        const address = trap.trap_address as `0x${string}`;
        let checksummedAddress: `0x${string}`;

        try {
          checksummedAddress = getAddress(address);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.warn(`[balances] Invalid address ${address}:`, errMsg);
          errors.push(`Invalid address ${address}: ${errMsg}`);
          return {
            trapAddress: address,
            victimAddress: trap.victim_address,
            counterpartyAddress: trap.counterparty_address,
            isCaught: trap.is_caught,
            native: '0',
            tokens: {},
          };
        }

        const result: any = {
          trapAddress: address,
          victimAddress: trap.victim_address,
          counterpartyAddress: trap.counterparty_address,
          isCaught: trap.is_caught,
          native: '0',
          tokens: {},
        };

        // Native Balance Request
        const nativePromise = client
          .getBalance({ address: checksummedAddress })
          .then((balance) => {
            result.native = formatEther(balance);
          })
          .catch((e) => {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.warn(`[balances] Native balance failed for ${address}:`, errMsg);
            errors.push(`Native balance for ${address}: ${errMsg}`);
          });

        // Track raw token BigInts for exact precision calculations
        const tokenRawBalances: Record<string, bigint> = {};

        // Token Balance Requests (Parallel)
        const tokenPromises = Object.entries(tokenAddresses).map(async ([symbol, rawTokenAddr]) => {
          try {
            const tokenAddr = getAddress(rawTokenAddr);
            const balance = (await client.readContract({
              address: tokenAddr,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [checksummedAddress],
            })) as bigint;

            tokenRawBalances[symbol] = balance;
            const decimals = decimalsForChain[symbol] ?? 18;
            result.tokens[symbol] = formatUnits(balance, decimals);
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            console.warn(`[balances] Token ${symbol} failed for ${address}:`, errMsg);
            errors.push(`Token ${symbol} for ${address}: ${errMsg}`);
            tokenRawBalances[symbol] = BigInt(0);
            result.tokens[symbol] = '0';
          }
        });

        await Promise.all([nativePromise, ...tokenPromises]);

        // ─── Polygon: merge USDC_NATIVE into USDC using BigInt precision ───
        if (normalizedChain === 'polygon') {
          const nativeUsdcBigInt = tokenRawBalances['USDC_NATIVE'] || BigInt(0);
          const bridgedUsdcBigInt = tokenRawBalances['USDC'] || BigInt(0);
          const totalUsdc = nativeUsdcBigInt + bridgedUsdcBigInt;
          result.tokens['USDC'] = formatUnits(totalUsdc, 6);
        }

        console.log(`[balances] Tokens for ${address}:`, result.tokens);
        return result;
      })
    );

    if (errors.length > 0) {
      console.warn('[balances] Encountered errors during execution pipeline:', errors.slice(0, 5));
    }

    const response = { balances: results };

    // ─── Store in cache ───
    setCachedBalances(id, response);

    return NextResponse.json(response);
  } catch (err) {
    console.error('[balances] Unexpected critical fallback error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}