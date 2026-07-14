import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { decrypt } from '@app-lib/encryption';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs';
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

  // ✅ Correct path: batch_fund.py (root)
  const scriptPath = path.resolve(process.cwd(), '../batch_fund.py');
  const projectRoot = path.resolve(process.cwd(), '..');

  if (!fs.existsSync(scriptPath)) {
    console.error('[fund] Script not found:', scriptPath);
    await sendAlert(`❌ Funding job failed: Script not found at ${scriptPath}`, 'error', id);
    return NextResponse.json({ error: 'Script not found' }, { status: 500 });
  }

  console.log(`[fund] Spawning: python3 ${scriptPath} --job-id ${job.id}`);

  const child = spawn('python3', [scriptPath, '--job-id', job.id], {
    env: {
      ...process.env,
      CHAIN: campaign.chain,
      SOURCE_PRIVATE_KEY: fundingKey,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    cwd: projectRoot,
    detached: true,
    stdio: 'pipe',
  });

  child.stdout.on('data', (data) => {
    console.log(`[fund stdout] ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    console.error(`[fund stderr] ${data.toString().trim()}`);
  });

  child.on('error', async (err) => {
    console.error('[fund] Spawn error:', err);
    await sendAlert(`❌ Funding job failed: Spawn error - ${err.message}`, 'error', id);
  });

  child.on('close', async (code) => {
    console.log(`[fund] Process exited with code ${code}`);
    if (code !== 0) {
      await sendAlert(`❌ Funding job failed: Process exited with code ${code} for campaign ${campaign.chain}`, 'error', id);
    } else {
      await sendAlert(`✅ Funding job completed successfully for campaign ${campaign.chain}`, 'info', id);
    }
  });

  child.unref();

  return NextResponse.json(
    { jobId: job.id, message: `Funding started for chain ${campaign.chain}` },
    { status: 202 }
  );
}