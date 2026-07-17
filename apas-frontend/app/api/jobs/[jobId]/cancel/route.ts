import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { sendAlert } from '@app-lib/notifier';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  // Fetch job details (including type)
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('campaign_id, status, type')
    .eq('id', jobId)
    .single();

  if (jobError || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  // Check campaign ownership
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('user_id')
    .eq('id', job.campaign_id)
    .single();

  if (campaignError || campaign.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Only allow cancelling if status is 'pending' or 'running'
  if (job.status !== 'pending' && job.status !== 'running') {
    return NextResponse.json({ error: 'Job cannot be cancelled' }, { status: 400 });
  }

  // Update job status to 'cancelled'
  const { error: updateError } = await supabase
    .from('jobs')
    .update({ status: 'cancelled', message: 'Cancelled by user' })
    .eq('id', jobId);

  if (updateError) {
    console.error('[cancel] Update error:', updateError);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Send alert to user with the job type (with safe fallback string handling)
  const typeString = job.type || 'sweep';
  const typeLabel = typeString.charAt(0).toUpperCase() + typeString.slice(1);
  await sendAlert(`🛑 ${typeLabel} job ${jobId} has been cancelled.`, 'info', job.campaign_id);

  return NextResponse.json({ success: true });
}