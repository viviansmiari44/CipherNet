import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import { createPublicClient, http, fallback } from 'viem';
import { mainnet, bsc, polygon } from 'viem/chains';

const CONFIRMATIONS_REQUIRED = 6;

const chainMap = { ethereum: mainnet, bsc, polygon };
const CHAIN = (process.env.CHAIN || 'bsc').toLowerCase();
const primaryRpcUrl = process.env[`${CHAIN.toUpperCase()}_RPC_URL`] || process.env.NODE_RPC_URL;

const publicFallbacks: Record<string, string[]> = {
  bsc: [
    'https://bsc-dataseed.binance.org',
    'https://rpc.ankr.com/bsc',
    'https://binance.llamarpc.com'
  ],
  ethereum: [
    'https://cloudflare-eth.com',
    'https://rpc.ankr.com/eth',
    'https://eth.llamarpc.com'
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com'
  ]
};

const rpcUrls = [
  ...(primaryRpcUrl ? [primaryRpcUrl] : []),
  ...(publicFallbacks[CHAIN] || [])
];

let client: ReturnType<typeof createPublicClient> | null = null;

if (rpcUrls.length > 0) {
  try {
    client = createPublicClient({
      chain: chainMap[CHAIN as keyof typeof chainMap] || mainnet,
      transport: fallback(
        rpcUrls.map(url => http(url, { timeout: 3000 })), 
        { rank: false }
      ),
    });
  } catch (err) {
    console.warn('[deposit-status] Failed to initialize fallback RPC client:', err);
  }
}

const fetchWithTimeout = async (promise: any, ms: number) => {
  const timeout = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('Request timed out')), ms)
  );
  return Promise.race([Promise.resolve(promise), timeout]);
};

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ─── Pagination ───
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get('limit') || '10', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const supabase = await createServerSupabaseClient();

    const dbPromise = supabase
      .from('credit_transactions')
      .select('id, amount, tx_hash, block_number, status, created_at', { count: 'exact' })
      .eq('user_id', user.id)
      .eq('type', 'deposit')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data: deposits, error, count } = await fetchWithTimeout(dbPromise, 5000) as any;

    if (error) {
      console.error('[deposit-status] Fetch error:', error);
      return NextResponse.json({ error: 'Failed to fetch deposits' }, { status: 500 });
    }

    // Get current block number using fallback transport
    let currentBlock: bigint | null = null;
    if (client) {
      try {
        currentBlock = await fetchWithTimeout(client.getBlockNumber(), 3500) as bigint;
      } catch (err) {
        console.warn('[deposit-status] All RPC fallbacks timed out or failed. Skipping confirmation checking.');
      }
    }

    const processed = [];
    let totalCreditsToAward = 0;
    const txIdsToComplete: string[] = [];

    // 1. Calculate confirmations and filter transactions that need updating
    for (const dep of deposits || []) {
      let status = dep.status;
      let confirmations = 0;
      let isCompleted = dep.status === 'completed';

      if (dep.status === 'pending' && dep.block_number && currentBlock !== null) {
        try {
          const blockNum = BigInt(dep.block_number);
          confirmations = Number(currentBlock - blockNum);
          
          if (confirmations >= CONFIRMATIONS_REQUIRED) {
            status = 'completed';
            isCompleted = true;
            totalCreditsToAward += parseFloat(dep.amount);
            txIdsToComplete.push(dep.id);
          }
        } catch (calcErr) {
          console.warn('[deposit-status] Error calculating confirmations:', calcErr);
        }
      }

      processed.push({
        id: dep.id,
        amount: dep.amount,
        txHash: dep.tx_hash,
        status: status,
        confirmations: Math.max(0, confirmations),
        requiredConfirmations: CONFIRMATIONS_REQUIRED,
        createdAt: dep.created_at,
        isCompleted,
      });
    }

    // 2. Batch DB Operations Outside Loop
    if (txIdsToComplete.length > 0) {
      const userPromise = supabase.from('users').select('credits').eq('id', user.id).single();
      const { data: userData, error: userError } = await fetchWithTimeout(userPromise, 4000) as any;

      if (!userError && userData) {
        const finalBalance = (userData.credits || 0) + totalCreditsToAward;

        await Promise.all([
          fetchWithTimeout(
            supabase.from('users').update({ credits: finalBalance }).eq('id', user.id), 
            4000
          ),
          fetchWithTimeout(
            supabase.from('credit_transactions')
              .update({ status: 'completed', completed_at: new Date().toISOString() })
              .in('id', txIdsToComplete), 
            4000
          )
        ]);
        console.log(`[deposit-status] Successfully credited ${totalCreditsToAward} items to user ${user.id}`);
      }
    }

    return NextResponse.json({ deposits: processed, total: count, limit, offset });
  } catch (err) {
    console.error('[deposit-status] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}