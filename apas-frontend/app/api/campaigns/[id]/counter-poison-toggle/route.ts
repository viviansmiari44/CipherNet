import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const user = await getAuthUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = await createServerSupabaseClient();

    // Verify ownership
    const { data: campaign, error: campError } = await supabase
        .from('campaigns')
        .select('user_id')
        .eq('id', id)
        .single();

    if (campError || !campaign || campaign.user_id !== user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { counter_poison_enabled } = await req.json();
    if (typeof counter_poison_enabled !== 'boolean') {
        return NextResponse.json({ error: 'counter_poison_enabled must be a boolean' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('campaigns')
        .update({ counter_poison_enabled })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
}