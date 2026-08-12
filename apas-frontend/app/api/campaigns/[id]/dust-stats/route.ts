import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = await createServerSupabaseClient();

    // Verify ownership
    const { data: campaign } = await supabase
        .from('campaigns')
        .select('id')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

    if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Get total count
    const { count: total } = await supabase
        .from('traps')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', id);

    // Get never dusted count (dust_count = 0 OR NULL)
    const { count: neverDusted } = await supabase
        .from('traps')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', id)
        .or('dust_count.eq.0,dust_count.is.null');

    const alreadyDusted = (total || 0) - (neverDusted || 0);

    return NextResponse.json({
        total: total || 0,
        neverDusted: neverDusted || 0,
        alreadyDusted,
    });
}