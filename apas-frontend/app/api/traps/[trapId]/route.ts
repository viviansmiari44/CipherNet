// app/api/traps/[trapId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { createClient } from '@supabase/supabase-js';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ trapId: string }> }
) {
  const { trapId } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch trap to verify ownership via campaign
  const { data: trap, error: trapError } = await supabaseAdmin
    .from('traps')
    .select('campaign_id')
    .eq('id', trapId)
    .single();

  if (trapError || !trap) {
    return NextResponse.json({ error: 'Trap not found' }, { status: 404 });
  }

  // Check campaign ownership
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('user_id')
    .eq('id', trap.campaign_id)
    .single();

  if (campaignError || !campaign || campaign.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Delete the trap using service role to bypass RLS policies
  const { error: deleteError } = await supabaseAdmin
    .from('traps')
    .delete()
    .eq('id', trapId);

  if (deleteError) {
    console.error('[DELETE trap] Error:', deleteError);
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}