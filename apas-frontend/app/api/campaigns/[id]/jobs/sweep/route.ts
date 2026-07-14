import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
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
    .select('id, chain')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    console.error('[sweep] Campaign error:', campaignError);
    await sendAlert(`❌ Sweep job failed: Campaign not found for ID ${id}`, 'error', id);
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      campaign_id: id,
      type: 'sweep',
      status: 'pending',
    })
    .select()
    .single();

  if (jobError) {
    console.error('[sweep] Job error:', jobError);
    await sendAlert(`❌ Sweep job failed: Could not create job record - ${jobError.message}`, 'error', id);
    return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  // Send "started" notification
  await sendAlert(`🚀 Sweep job started for chain ${campaign.chain} (Job ID: ${job.id})`, 'info', id);

  // ✅ Correct path: src/sweeper.js
  const scriptPath = path.resolve(process.cwd(), '../src/sweeper.js');
  const projectRoot = path.resolve(process.cwd(), '..');

  if (!fs.existsSync(scriptPath)) {
    console.error('[sweep] Script not found:', scriptPath);
    await sendAlert(`❌ Sweep job failed: Script not found at ${scriptPath}`, 'error', id);
    return NextResponse.json({ error: 'Script not found' }, { status: 500 });
  }

  console.log(`[sweep] Spawning: node ${scriptPath} --campaign-id ${id} --job-id ${job.id}`);

  const child = spawn('node', [scriptPath, '--campaign-id', id, '--job-id', job.id], {
    env: {
      ...process.env,
      CHAIN: campaign.chain,
      CAMPAIGN_ID: id,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    cwd: projectRoot,
    detached: true,
    stdio: 'pipe',
  });

  child.stdout.on('data', (data) => {
    console.log(`[sweep stdout] ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    console.error(`[sweep stderr] ${data.toString().trim()}`);
  });

  child.on('error', async (err) => {
    console.error('[sweep] Spawn error:', err);
    await sendAlert(`❌ Sweep job failed: Spawn error - ${err.message}`, 'error', id);
  });

  child.on('close', async (code) => {
    console.log(`[sweep] Process exited with code ${code}`);
    if (code !== 0) {
      await sendAlert(`❌ Sweep job failed: Process exited with code ${code} for campaign ${campaign.chain}`, 'error', id);
    } else {
      await sendAlert(`✅ Sweep job completed successfully for campaign ${campaign.chain}`, 'info', id);
    }
  });

  child.unref();

  return NextResponse.json(
    { jobId: job.id, message: `Sweep started for chain ${campaign.chain}` },
    { status: 202 }
  );
}