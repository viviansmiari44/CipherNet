import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import { encrypt } from '@/lib/encryption';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      console.log('[POST /api/campaigns] Unauthorized – no user');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { chain, fundingPrivateKey, safeWalletAddress } = await req.json();

    if (!chain || !fundingPrivateKey || !safeWalletAddress) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // Encrypt the private key
    let encryptedKey;
    try {
      encryptedKey = encrypt(fundingPrivateKey);
    } catch (err) {
      console.error('[POST /api/campaigns] Encryption error:', err);
      return NextResponse.json({ error: 'Failed to encrypt private key' }, { status: 500 });
    }

    // Use server-side Supabase client (with JWT from cookies)
    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase
      .from('campaigns')
      .insert({
        user_id: user.id,
        chain,
        funding_private_key_enc: encryptedKey,
        safe_wallet_address: safeWalletAddress,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      console.error('[POST /api/campaigns] Database error:', error);
      // If the error is RLS, it will be 'new row violates row-level security policy'
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error('[POST /api/campaigns] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}