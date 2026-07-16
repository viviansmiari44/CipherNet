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

  // ─── Parse request body for maxKeys ───
  const body = await req.json().catch(() => ({}));
  const maxKeys = body.maxKeys ? parseInt(body.maxKeys, 10) : undefined;

  const supabase = await createServerSupabaseClient();

  // ─── Check user credits ───
  const { data: userData, error: userCreditError } = await supabase
    .from('users')
    .select('credits')
    .eq('id', user.id)
    .single();

  if (userCreditError || !userData || (userData.credits ?? 0) <= 0) {
    console.error('[generate] Insufficient credits:', userData?.credits);
    await sendAlert(`❌ Generate job failed: Insufficient credits. Please add funds to continue.`, 'error', id);
    return NextResponse.json({ error: 'Insufficient credits' }, { status: 403 });
  }

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, chain')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    console.error('[generate] Campaign error:', campaignError);
    await sendAlert(`❌ Generate job failed: Campaign not found for ID ${id}`, 'error', id);
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      campaign_id: id,
      type: 'generate',
      status: 'pending',
    })
    .select()
    .single();

  if (jobError) {
    console.error('[generate] Job error:', jobError);
    await sendAlert(`❌ Generate job failed: Could not create job record - ${jobError.message}`, 'error', id);
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  // ✅ Send "started" notification
  await sendAlert(`🚀 Generate job started for chain ${campaign.chain} (Job ID: ${job.id})`, 'info', id);

  // ─── Send webhook to backend ───
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
        type: 'generate',
        maxKeys, // ✅ pass the user‑specified limit
      }),
    });
    console.log(`[generate] Webhook sent to ${webhookUrl}`);
  } catch (err) {
    console.error('[generate] Webhook error:', err);
    await sendAlert(`⚠️ Generate job scheduled but webhook delivery failed. The job may not run.`, 'error', id);
  }

  return NextResponse.json(
    { jobId: job.id, message: `Vanity generation started for chain ${campaign.chain}` },
    { status: 202 }
  );
}