// app/api/campaigns/[id]/dust/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { sendAlert } from '@app-lib/notifier';

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    const user = await getAuthUser();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { filter, batchId } = await req.json();
    const supabase = await createServerSupabaseClient();

    // Verify campaign ownership
    const { data: campaign, error: campError } = await supabase
        .from('campaigns')
        .select('id, chain')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

    if (campError || !campaign) {
        console.error('[dust-filter] Campaign error:', campError);
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    // Build query based on filter
    console.log(`[dust-filter] Building query for campaign ${id}, filter: ${filter}, batchId: ${batchId}`);

    let query = supabase
        .from('traps')
        .select('id')
        .eq('campaign_id', id);

    if (filter === 'never_dusted') {
        query = query.or('dust_count.eq.0,dust_count.is.null');
    } else if (filter === 'batch' && batchId) {
        query = query.eq('generation_batch_id', batchId);
    }
    // 'all' = no additional filter

    const { data: traps, error: trapsError } = await query;

    if (trapsError) {
        console.error('[dust-filter] Traps query error:', trapsError);
        return NextResponse.json({ error: trapsError.message }, { status: 500 });
    }

    console.log(`[dust-filter] Found ${traps?.length || 0} traps matching filter`);

    if (!traps || traps.length === 0) {
        return NextResponse.json(
            { error: 'No traps match this filter' },
            { status: 400 }
        );
    }

    // Create job record
    const { data: job, error: jobError } = await supabase
        .from('jobs')
        .insert({
            campaign_id: id,
            type: 'dust',
            status: 'pending',
        })
        .select()
        .single();

    if (jobError || !job) {
        console.error('[dust-filter] Job creation error:', jobError);
        await sendAlert(`❌ Filtered dust failed: Could not create job - ${jobError?.message}`, 'error', id);
        return NextResponse.json({ error: 'Failed to create job' }, { status: 500 });
    }

    // 🆕 Extract quantity from request body
    const { quantity } = await req.json();

    // Apply quantity limit if provided
    let filteredTraps = traps;
    if (quantity && quantity > 0 && traps.length > quantity) {
        filteredTraps = traps.slice(0, quantity);
        console.log(`[dust-filter] Limited to ${quantity} traps (from ${traps.length})`);
    }

    // Extract trap IDs as comma-separated string
    const trapIds = filteredTraps.map((t) => t.id).join(',');

    // ✅ Send "started" notification
    const filterLabel = filter === 'never_dusted' ? 'Never Dusted' : filter === 'batch' ? `Batch ${batchId.slice(0, 8)}` : 'All Traps';
    await sendAlert(
        `🚀 Filtered Dust started\nFilter: ${filterLabel}\nTraps: ${filteredTraps.length}${quantity ? ` (limited from ${traps.length})` : ''}\nJob ID: ${job.id}`,
        'info',
        id
    );

    // ─── Send webhook to backend (matching your existing pattern) ───
    const webhookUrl = `${process.env.WEBHOOK_BASE_URL}/webhook/job`;
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-webhook-secret': process.env.WEBHOOK_SECRET || '',
            },
            body: JSON.stringify({
                jobId: job.id,
                campaignId: campaign.id,
                chain: campaign.chain,
                type: 'dust',
                trapIds: trapIds,
                quantity: quantity,  // 🆕 Pass quantity to webhook
            }),
        });
        console.log(`[dust-filter] Webhook sent to ${webhookUrl} with ${traps.length} trap IDs`);
    } catch (err) {
        console.error('[dust-filter] Webhook error:', err);
        await sendAlert(`⚠️ Filtered dust scheduled but webhook delivery failed.`, 'error', id);
    }

    return NextResponse.json({
        jobId: job.id,
        trapCount: filteredTraps.length,  // 🆕 Use filteredTraps.length
        filter,
        quantity,  // 🆕 Include quantity in response
        message: `Dusting ${filteredTraps.length} traps (${filterLabel})`,
    });
}