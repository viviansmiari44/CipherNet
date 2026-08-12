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

    // Fetch all traps grouped by batch_id using raw SQL via PostgREST
    const { data: traps } = await supabase
        .from('traps')
        .select('generation_batch_id, dust_count, created_at')
        .eq('campaign_id', id)
        .not('generation_batch_id', 'is', null);

    if (!traps) return NextResponse.json([]);

    // Group by batch in JS (Supabase doesn't support GROUP BY directly)
    const batchMap = new Map();
    for (const t of traps) {
        const bid = t.generation_batch_id;
        if (!batchMap.has(bid)) {
            batchMap.set(bid, {
                generation_batch_id: bid,
                total_traps: 0,
                never_dusted: 0,
                already_dusted: 0,
                generated_at: t.created_at,
            });
        }
        const b = batchMap.get(bid);
        b.total_traps++;
        if (!t.dust_count || t.dust_count === 0) b.never_dusted++;
        else b.already_dusted++;
    }

    const batches = Array.from(batchMap.values()).sort(
        (a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime()
    );

    return NextResponse.json(batches);
}