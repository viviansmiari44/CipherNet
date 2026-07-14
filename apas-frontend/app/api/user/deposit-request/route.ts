import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { token, network, amount, walletAddress, tx_hash } = await req.json();

    // ✅ Validate all required fields, including tx_hash
    if (!token || !network || !amount || !walletAddress || !tx_hash) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (amount <= 0) {
      return NextResponse.json({ error: 'Amount must be positive' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase
      .from('deposit_requests')
      .insert({
        user_id: user.id,
        token,
        network,
        amount,
        wallet_address: walletAddress,
        tx_hash: tx_hash, // ✅ Now storing the transaction hash
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      console.error('[deposit-request] Insert error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, request: data }, { status: 201 });
  } catch (err) {
    console.error('[deposit-request] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}