import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import { decrypt } from '@/lib/encryption';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ trapId: string }> }
) {
  const { trapId } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  const { data: trap, error: trapError } = await supabase
    .from('traps')
    .select('trap_private_key_enc, campaign_id')
    .eq('id', trapId)
    .single();

  if (trapError || !trap) {
    return NextResponse.json({ error: 'Trap not found' }, { status: 404 });
  }

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('user_id')
    .eq('id', trap.campaign_id)
    .single();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  if (campaign.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 🔍 Log the full encrypted string
  console.log('[key] Encrypted string (raw):', trap.trap_private_key_enc);
  console.log('[key] Length:', trap.trap_private_key_enc.length);

  let privateKey: string;
  try {
    privateKey = decrypt(trap.trap_private_key_enc);
  } catch (err) {
    console.error('[key] Decryption error:', err);
    return NextResponse.json({ error: 'Failed to decrypt private key: ' + (err as Error).message }, { status: 500 });
  }

  return NextResponse.json({ privateKey });
}