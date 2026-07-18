import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
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
  polygon: { USDC: 6, USDC_NATIVE: 6, WBTC: 8 },
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
      .select('id, chain')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();

    if (error || !campaign) {
      console.error('[balances] Campaign error:', error);
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
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
      return NextResponse.json({ balances: [] });
    }

    // Dynamic environmental resolution logic
    const rpcVarName = rpcEnvMap[campaign.chain];
    const rpcUrl = rpcVarName ? process.env[rpcVarName] : process.env.NODE_RPC_URL;

    if (!rpcUrl) {
      console.error('[balances] No RPC URL configuration located for chain:', campaign.chain);
      return NextResponse.json({ error: 'RPC URL not configured' }, { status: 500 });
    }

    console.log(`[balances] Using RPC: ${rpcUrl} for chain ${campaign.chain}`);

    const chain = chainMap[campaign.chain as keyof typeof chainMap];
    if (!chain) {
      return NextResponse.json({ error: 'Unsupported chain' }, { status: 400 });
    }

    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 15000 }), // 15-second request threshold
    });

    const tokenAddresses = tokenMap[campaign.chain as keyof typeof tokenMap] || {};
    const decimalsForChain = tokenDecimalsMap[campaign.chain as keyof typeof tokenDecimalsMap] || {};
    const results = [];
    const errors: string[] = [];

    for (const trap of traps) {
      const address = trap.trap_address as `0x${string}`;
      const result: any = {
        trapAddress: address,
        victimAddress: trap.victim_address,
        counterpartyAddress: trap.counterparty_address,
        isCaught: trap.is_caught,
        native: '0',
        tokens: {},
      };

      // Native Asset Balance Collection
      try {
        const balance = await client.getBalance({ address });
        result.native = formatEther(balance);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(`[balances] Native balance failed for ${address}:`, errMsg);
        errors.push(`Native balance for ${address}: ${errMsg}`);
      }

      // Token Asset Balance Collection Loop
      for (const [symbol, tokenAddr] of Object.entries(tokenAddresses)) {
        try {
          const balance = await client.readContract({
            address: tokenAddr as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address],
          }) as bigint;

          // Process using exact token configurations, default back to 18 decimals
          const decimals = decimalsForChain[symbol] ?? 18;
          result.tokens[symbol] = formatUnits(balance, decimals);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.warn(`[balances] Token ${symbol} failed for ${address}:`, errMsg);
          errors.push(`Token ${symbol} for ${address}: ${errMsg}`);
          result.tokens[symbol] = '0';
        }
      }

      // ─── Polygon: merge USDC_NATIVE into USDC ───
      if (campaign.chain === 'polygon') {
        const nativeUsdc = parseFloat(result.tokens['USDC_NATIVE'] || '0');
        const bridgedUsdc = parseFloat(result.tokens['USDC'] || '0');
        result.tokens['USDC'] = (nativeUsdc + bridgedUsdc).toString();
      }

      results.push(result);
    }

    if (errors.length > 0) {
      console.warn('[balances] Encountered errors during execution pipeline:', errors.slice(0, 5));
    }

    return NextResponse.json({ balances: results });
  } catch (err) {
    console.error('[balances] Unexpected critical fallback error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}