import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;

  const admin = await getAuthUser();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role
  const { data: currentUser } = await supabaseService
    .from('users')
    .select('role')
    .eq('id', admin.id)
    .single();

  if (currentUser?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data: campaigns, error } = await supabaseService
    .from('campaigns')
    .select('id, chain, safe_wallet_address')
    .eq('user_id', userId);

  if (error) {
    console.error('[admin/campaigns] Fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(campaigns);
}