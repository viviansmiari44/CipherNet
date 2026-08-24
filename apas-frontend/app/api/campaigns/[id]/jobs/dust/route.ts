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

  const supabase = await createServerSupabaseClient();

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, chain')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    console.error('[dust] Campaign error:', campaignError);
    await sendAlert(`❌ Dust job failed: Campaign not found for ID ${id}`, 'error', id);
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      campaign_id: id,
      type: 'dust',
      status: 'pending',
    })
    .select()
    .single();

  if (jobError) {
    console.error('[dust] Job error:', jobError);
    await sendAlert(`❌ Dust job failed: Could not create job record - ${jobError.message}`, 'error', id);
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  // ✅ Send "started" notification
  await sendAlert(`🚀 Dust job started for chain ${campaign.chain} (Job ID: ${job.id})`, 'info', id);

  // ─── Send webhook (with 5-second timeout to prevent UI blocking) ───
  const webhookUrl = `${process.env.WEBHOOK_BASE_URL}/webhook/job`;

  if (!process.env.WEBHOOK_BASE_URL) {
    console.warn('[dust] ⚠️ WEBHOOK_BASE_URL is not set in .env! Job saved to DB but webhook not sent.');
  } else {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

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
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      console.log(`[dust] ✅ Webhook successfully sent to ${webhookUrl}`);
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error(`[dust] ❌ Webhook timed out after 5s. Is webhook-server.cjs running at ${webhookUrl}?`);
      } else {
        console.error(`[dust] ❌ Webhook error:`, err.message);
      }
      await sendAlert(`⚠️ Dust job saved to DB, but webhook delivery failed. Check if webhook-server is running.`, 'warning', id);
    }
  }

  return NextResponse.json(
    { jobId: job.id, message: `Dusting started for chain ${campaign.chain}` },
    { status: 202 }
  );
}

