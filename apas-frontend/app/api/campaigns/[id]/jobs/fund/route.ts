import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { decrypt } from '@app-lib/encryption';
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
    .select('id, chain, funding_private_key_enc')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    console.error('[fund] Campaign error:', campaignError);
    await sendAlert(`❌ Funding job failed: Campaign not found for ID ${id}`, 'error', id);
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  let fundingKey: string;
  try {
    fundingKey = decrypt(campaign.funding_private_key_enc);
  } catch (decryptError) {
    console.error('[fund] Decryption error:', decryptError);
    await sendAlert(`❌ Funding job failed: Could not decrypt funding private key for campaign ${id}`, 'error', id);
    return NextResponse.json(
      { error: 'Failed to decrypt funding private key' },
      { status: 500 }
    );
  }

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      campaign_id: id,
      type: 'fund',
      status: 'pending',
    })
    .select()
    .single();

  if (jobError) {
    console.error('[fund] Job error:', jobError);
    await sendAlert(`❌ Funding job failed: Could not create job record - ${jobError.message}`, 'error', id);
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  // Send "started" notification
  await sendAlert(`🚀 Funding job started for chain ${campaign.chain} (Job ID: ${job.id})`, 'info', id);

  // ─── Send webhook ───
  const webhookUrl = `${process.env.WEBHOOK_BASE_URL}/webhook/job`;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        campaignId: campaign.id,
        chain: campaign.chain,
        type: 'fund',
        fundingPrivateKey: fundingKey, // encrypted or plain? The backend expects it; we send it here.
      }),
    });
    console.log(`[fund] Webhook sent to ${webhookUrl}`);
  } catch (err) {
    console.error('[fund] Webhook error:', err);
    await sendAlert(`⚠️ Funding job scheduled but webhook delivery failed. The job may not run.`, 'error', id);
  }

  return NextResponse.json(
    { jobId: job.id, message: `Funding started for chain ${campaign.chain}` },
    { status: 202 }
  );
}