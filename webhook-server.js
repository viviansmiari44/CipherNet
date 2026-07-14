#!/usr/bin/env node

/**
 * webhook-server.js
 * Receives job triggers from Vercel via HTTP POST, spawns the corresponding
 * Python/Node script, and runs it detached.
 *
 * Usage:
 *   node webhook-server.js
 *   or with PM2: pm2 start webhook-server.js --name webhook
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change-me';

// ─── Middleware ───
app.use(express.json({ limit: '1mb' }));

// ─── Health check ───
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Webhook handler ───
app.post('/webhook/job', (req, res) => {
  const { jobId, campaignId, chain, type, fundingPrivateKey } = req.body;

  // 1. Validate secret
  const authHeader = req.headers['x-webhook-secret'];
  if (authHeader !== WEBHOOK_SECRET) {
    console.error('[webhook] Unauthorized request');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  // 2. Validate required fields
  if (!jobId || !campaignId || !chain || !type) {
    console.error('[webhook] Missing required fields', { jobId, campaignId, chain, type });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log(`[webhook] Received ${type} job ${jobId} for campaign ${campaignId} on ${chain}`);

  // 3. Determine script path and arguments
  let scriptPath, args, interpreter = 'python3';
  const env = {
    ...process.env,
    CHAIN: chain,
    JOB_ID: jobId,
    CAMPAIGN_ID: campaignId,
  };

  const projectRoot = __dirname; // assumes webhook-server.js is at project root

  switch (type) {
    case 'generate':
      scriptPath = path.join(projectRoot, 'src', 'batch_generate.py');
      args = ['--job-id', jobId];
      break;

    case 'fund':
      scriptPath = path.join(projectRoot, 'batch_fund.py');
      args = ['--job-id', jobId];
      if (!fundingPrivateKey) {
        console.error('[webhook] fundingPrivateKey missing for fund job');
        return res.status(400).json({ error: 'fundingPrivateKey required for fund job' });
      }
      env.SOURCE_PRIVATE_KEY = fundingPrivateKey;
      break;

    case 'dust':
      scriptPath = path.join(projectRoot, 'tools', 'duster.py');
      args = ['--job-id', jobId];
      break;

    case 'sweep':
      scriptPath = path.join(projectRoot, 'src', 'sweeper.js');
      args = ['--job-id', jobId, '--campaign-id', campaignId];
      interpreter = 'node';
      env.CAMPAIGN_ID = campaignId;
      break;

    default:
      console.error('[webhook] Unknown job type:', type);
      return res.status(400).json({ error: 'Unknown job type' });
  }

  // 4. Check if script exists
  if (!fs.existsSync(scriptPath)) {
    console.error('[webhook] Script not found:', scriptPath);
    return res.status(500).json({ error: `Script not found: ${scriptPath}` });
  }

  console.log(`[webhook] Spawning: ${interpreter} ${scriptPath} ${args.join(' ')}`);

  // 5. Spawn the process detached
  const child = spawn(interpreter, [scriptPath, ...args], {
    env,
    detached: true,
    stdio: 'ignore', // discard stdout/stderr; logs go to PM2 logs or system logs
    cwd: projectRoot,
  });

  child.unref();

  // 6. Log process start
  console.log(`[webhook] ${type} job ${jobId} started (PID: ${child.pid})`);

  // 7. Respond immediately
  res.status(202).json({ message: `Job ${jobId} accepted for execution` });
});

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`[webhook] Server running on port ${PORT}`);
  console.log(`[webhook] Webhook endpoint: http://localhost:${PORT}/webhook/job`);
  console.log(`[webhook] Health: http://localhost:${PORT}/health`);
});