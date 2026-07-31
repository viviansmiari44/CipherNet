import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';

export async function POST(req: NextRequest) {
  try {
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

    const { campaignId, isMock } = await req.json();

    if (!campaignId) {
      return NextResponse.json({ error: 'Campaign ID required' }, { status: 400 });
    }

    if (typeof isMock !== 'boolean') {
      return NextResponse.json({ error: 'isMock must be a boolean' }, { status: 400 });
    }

    // Update the campaign
    const { data, error } = await supabaseService
      .from('campaigns')
      .update({ is_mock: isMock })
      .eq('id', campaignId)
      .select()
      .single();

    if (error) {
      console.error('[mock-toggle] Update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      campaign: data,
      message: `Campaign ${isMock ? 'marked as' : 'unmarked from'} mock`,
    });
  } catch (err) {
    console.error('[mock-toggle] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}