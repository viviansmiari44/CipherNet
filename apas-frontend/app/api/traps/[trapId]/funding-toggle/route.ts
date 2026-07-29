import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ trapId: string }> }
) {
  const { trapId } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  // Fetch trap with campaign info (campaigns is an array)
  const { data: trap, error: trapError } = await supabase
    .from('traps')
    .select('campaign_id, campaigns ( user_id )')
    .eq('id', trapId)
    .single();

  if (trapError || !trap) {
    return NextResponse.json({ error: 'Trap not found' }, { status: 404 });
  }

  // campaigns is an array; extract the first element's user_id
  const campaign = Array.isArray(trap.campaigns) ? trap.campaigns[0] : trap.campaigns;
  if (!campaign || campaign.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { funding_enabled } = await req.json();
  if (typeof funding_enabled !== 'boolean') {
    return NextResponse.json({ error: 'funding_enabled must be a boolean' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('traps')
    .update({ funding_enabled })
    .eq('id', trapId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}