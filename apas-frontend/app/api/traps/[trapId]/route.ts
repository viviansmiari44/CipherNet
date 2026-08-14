// app/api/traps/[trapId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ trapId: string }> }
) {
  const { trapId } = await params;

  // 🔧 FIX: Use the timeout-configured auth function
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 🔧 FIX: Use the pre-configured service client with timeout
  // (instead of creating a new client here)

  try {
    // Fetch trap to verify ownership via campaign
    const { data: trap, error: trapError } = await supabaseService
      .from('traps')
      .select('campaign_id')
      .eq('id', trapId)
      .single();

    if (trapError || !trap) {
      return NextResponse.json({ error: 'Trap not found' }, { status: 404 });
    }

    // Check campaign ownership using service role
    const { data: campaign, error: campaignError } = await supabaseService
      .from('campaigns')
      .select('user_id')
      .eq('id', trap.campaign_id)
      .single();

    if (campaignError || !campaign || campaign.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Delete the trap using service role to bypass RLS policies
    const { error: deleteError } = await supabaseService
      .from('traps')
      .delete()
      .eq('id', trapId);

    if (deleteError) {
      console.error('[DELETE trap] Error:', deleteError);
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    // 🔧 FIX: Handle timeout errors specifically
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      console.error('[DELETE trap] Timeout:', error.message);
      return NextResponse.json(
        { error: 'Request timeout - please try again' },
        { status: 504 }
      );
    }

    console.error('[DELETE trap] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}