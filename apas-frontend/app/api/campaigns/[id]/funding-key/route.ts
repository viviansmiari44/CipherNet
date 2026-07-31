import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import { decrypt, encrypt } from '@/lib/encryption';

// ─── GET: Fetch decrypted funding key ───
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('funding_private_key_enc')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  if (!campaign.funding_private_key_enc) {
    return NextResponse.json({ privateKey: null });
  }

  try {
    const privateKey = decrypt(campaign.funding_private_key_enc);
    return NextResponse.json({ privateKey });
  } catch (err) {
    console.error('[funding-key] Decryption error:', err);
    return NextResponse.json({ error: 'Failed to decrypt funding key' }, { status: 500 });
  }
}

// ─── PUT: Update funding key ───
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  const { data: campaign, error: checkError } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (checkError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const { privateKey } = await req.json();

  // ✅ Only check that the key is a non‑empty string
  if (!privateKey || typeof privateKey !== 'string' || privateKey.trim().length < 64) {
    return NextResponse.json({ error: 'Invalid private key (must be at least 64 hex characters)' }, { status: 400 });
  }

  // Encrypt the new key
  let encryptedKey: string;
  try {
    encryptedKey = encrypt(privateKey.trim());
  } catch (err) {
    console.error('[funding-key] Encryption error:', err);
    return NextResponse.json({ error: 'Failed to encrypt private key' }, { status: 500 });
  }

  const { error: updateError } = await supabase
    .from('campaigns')
    .update({ funding_private_key_enc: encryptedKey })
    .eq('id', id);

  if (updateError) {
    console.error('[funding-key] Update error:', updateError);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}