import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@app-lib/supabaseService';
import crypto from 'node:crypto'; // Safer as a top-level import

const WEBHOOK_SECRET = process.env.CRYPTO_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-alchemy-signature') || req.headers.get('X-Alchemy-Signature');
    
    if (WEBHOOK_SECRET) {
      if (!signature) {
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
      }
      
      const expected = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');
      
      if (signature !== expected) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }

    const body = JSON.parse(rawBody);
    const activities = body.event?.activity || [];

    if (activities.length === 0) {
      return NextResponse.json({ error: 'No activity' }, { status: 400 });
    }

    for (const activity of activities) {
      const toAddress = activity.toAddress?.toLowerCase();
      const fromAddress = activity.fromAddress?.toLowerCase();
      
      // 1. Bypass Alchemy's test payload cleanly without throwing DB warnings
      if (toAddress === '0x000000000000000000000000000000000000dead') {
        console.log('[webhook] Ignored Alchemy test notification.');
        continue; 
      }

      const hash = activity.hash;
      const asset = activity.asset;
      const tokenAddress = activity.log?.address?.toLowerCase();
      
      // 2. Parse Hex BlockNumber to Integer for safe DB insertion
      const blockNumber = activity.blockNum ? parseInt(activity.blockNum, 16) : null;

      // 3. Fix the double-division bug
      // activity.value is already formatted (e.g., 1.5). activity.rawValue is in Wei hex.
      let amountInUnits: number;
      if (activity.value !== undefined && activity.value !== null) {
        amountInUnits = activity.value; 
      } else if (activity.rawValue) {
        const isNative = !tokenAddress;
        const decimals = isNative ? 18 : getTokenDecimals(tokenAddress, 1);
        amountInUnits = parseInt(activity.rawValue, 16) / Math.pow(10, decimals);
      } else {
        console.warn(`[webhook] No valid amount found for tx ${hash}`);
        continue;
      }

      const { data: user, error } = await supabaseService
        .from('users')
        .select('id, credits')
        .eq('deposit_address', toAddress)
        .single();

      if (error || !user) {
        console.warn(`[webhook] No user found for address ${toAddress}. Is this address tracked in Alchemy?`);
        continue;
      }

      await supabaseService.from('credit_transactions').insert({
        user_id: user.id,
        amount: amountInUnits,
        type: 'deposit',
        status: 'pending', 
        tx_hash: hash,
        block_number: blockNumber,
        description: `Deposit from ${fromAddress} (${asset || 'Unknown'})`,
      });

      console.log(`[webhook] Recorded pending deposit ${amountInUnits} for user ${user.id}`);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[webhook] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function getTokenDecimals(tokenAddress: string, chainId: number): number {
  const tokenMap: Record<string, number> = {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 18,
    '0x55d398326f99059ff775485246999027b3197955': 18,
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 6,
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6,
  };
  const addr = tokenAddress?.toLowerCase();
  return addr && tokenMap[addr] ? tokenMap[addr] : 18;
}