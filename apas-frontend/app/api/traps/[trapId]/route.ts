// app/api/traps/[trapId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';

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

  // Fetch trap to verify ownership via campaign
  const { data: trap, error: trapError } = await supabase
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

  if (campaignError || campaign.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Delete the trap
  const { error: deleteError } = await supabase
    .from('traps')
    .delete()
    .eq('id', trapId);

  if (deleteError) {
    console.error('[DELETE trap] Error:', deleteError);
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}