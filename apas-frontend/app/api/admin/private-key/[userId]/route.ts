import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';
import { getDepositPrivateKey } from '@/lib/hdWallet';

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
  const { data: currentUser, error: roleError } = await supabaseService
    .from('users')
    .select('role')
    .eq('id', admin.id)
    .single();

  if (roleError || currentUser?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const privateKey = getDepositPrivateKey(userId);
    // Also fetch the deposit address for verification
    const { data: userData } = await supabaseService
      .from('users')
      .select('deposit_address')
      .eq('id', userId)
      .single();

    return NextResponse.json({
      privateKey,
      depositAddress: userData?.deposit_address || null,
    });
  } catch (err: any) {
    console.error('[admin/private-key] Error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to retrieve private key' },
      { status: 500 }
    );
  }
}