import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> }
) {
  const { campaignId } = await params;

  const admin = await getAuthUser();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: currentUser } = await supabaseService
    .from('users')
    .select('role')
    .eq('id', admin.id)
    .single();

  if (currentUser?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { safeWalletAddress } = await req.json();

  if (!safeWalletAddress) {
    return NextResponse.json({ error: 'Missing safe wallet address' }, { status: 400 });
  }

  const { data, error } = await supabaseService
    .from('campaigns')
    .update({ safe_wallet_address: safeWalletAddress })
    .eq('id', campaignId)
    .select()
    .single();

  if (error) {
    console.error('[admin/campaigns/update] Update error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}