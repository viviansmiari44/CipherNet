import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;  // ✅ Unwrap the Promise

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  // Verify campaign belongs to user
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Fetch transactions with profit shares
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select(`
      id,
      trap_address,
      token_symbol,
      amount,
      usd_value,
      tx_hash,
      type,
      status,
      created_at,
      profit_shares (
        user_amount,
        service_amount,
        user_share_tx_hash,
        service_share_tx_hash,
        settled_at
      )
    `)
    .eq('campaign_id', id)
    .order('created_at', { ascending: false });

  if (txError) {
    return NextResponse.json({ error: txError.message }, { status: 500 });
  }

  return NextResponse.json({ transactions });
}