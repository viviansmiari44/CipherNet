import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs';
import { sendAlert } from '@/lib/notifier';

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

  // ✅ Send "started" notification immediately
  await sendAlert(`🚀 Generate job started for chain ${campaign.chain} (Job ID: ${job.id})`, 'info', id);

  const scriptPath = path.resolve(process.cwd(), '../src/batch_generate.py');
  const projectRoot = path.resolve(process.cwd(), '..');

  if (!fs.existsSync(scriptPath)) {
    console.error('[generate] Script not found:', scriptPath);
    await sendAlert(`❌ Generate job failed: Script not found at ${scriptPath}`, 'error', id);
    return NextResponse.json({ error: 'Script not found' }, { status: 500 });
  }

  console.log('[generate] NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL ? '✅ set' : '❌ missing');
  console.log('[generate] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ set' : '❌ missing');

  console.log(`[generate] Spawning: python3 ${scriptPath} --job-id ${job.id}`);

  const child = spawn('python3', [scriptPath, '--job-id', job.id], {
    env: {
      ...process.env,
      CHAIN: campaign.chain,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      VAULT_ENCRYPTION_PASSWORD: process.env.VAULT_ENCRYPTION_PASSWORD,
    },
    cwd: projectRoot,
    detached: true,
    stdio: 'pipe',
  });

  child.stdout.on('data', (data) => {
    console.log(`[generate stdout] ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    console.error(`[generate stderr] ${data.toString().trim()}`);
  });

  child.on('error', async (err) => {
    console.error('[generate] Spawn error:', err);
    await sendAlert(`❌ Generate job failed: Spawn error - ${err.message}`, 'error', id);
  });

  child.on('close', async (code) => {
    console.log(`[generate] Process exited with code ${code}`);
    if (code !== 0) {
      await sendAlert(`❌ Generate job failed: Process exited with code ${code} for campaign ${campaign.chain}`, 'error', id);
    } else {
      await sendAlert(`✅ Generate job completed successfully for campaign ${campaign.chain}`, 'info', id);
    }
  });

  child.unref();

  return NextResponse.json(
    { jobId: job.id, message: `Vanity generation started for chain ${campaign.chain}` },
    { status: 202 }
  );
}