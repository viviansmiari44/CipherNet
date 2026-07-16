#!/usr/bin/env node

/**
 * webhook-server.js
 * Receives job triggers from Vercel via HTTP POST, spawns the corresponding
 * Python/Node script, and runs it detached.
 *
 * Usage:
 *    node webhook-server.js
 *    or with PM2: pm2 start webhook-server.js --name webhook
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ─── Supabase client for fetching Clore config ───
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('[webhook] Supabase client initialized for config fetching');
} else {
  console.warn('[webhook] Supabase credentials missing – Clore config will fall back to env vars');
}

// ─── Helper to fetch Clore config from Supabase ───
async function getCloreConfig() {
  if (!supabase) {
    console.warn('[webhook] Supabase client not available, using env vars for Clore config');
    return {};
  }
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('key, value')
      .in('key', ['CLORE_INSTANCE_ID', 'BATCH_REMOTE_HOST', 'BATCH_REMOTE_PORT']);

    if (error) {
      console.error('[webhook] Failed to fetch Clore config from Supabase:', error);
      return {};
    }

    const config = {};
    data.forEach(row => {
      config[row.key] = row.value;
    });
    console.log('[webhook] Clore config fetched from Supabase:', config);
    return config;
  } catch (err) {
    console.error('[webhook] Exception fetching Clore config:', err);
    return {};
  }
}

// ─── Startup Safety Checks ───
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (!WEBHOOK_SECRET || WEBHOOK_SECRET === 'change-me') {
  console.error('\x1b[31m[FATAL] WEBHOOK_SECRET is not set or is still set to the default "change-me".\x1b[0m');
  console.error('\x1b[31m[FATAL] Please set a secure WEBHOOK_SECRET in your .env file before running in production.\x1b[0m');
  process.exit(1);
}

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;
const LOG_LIMIT_MB = 10; // Auto-rotate logs when they exceed 10MB

// ─── Middleware ───
app.use(express.json({ limit: '1mb' }));

// Helper to safely handle native log rotation on Unix/macOS
function rotateLogsIfNeeded(logFile) {
  try {
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      const maxSizeBytes = LOG_LIMIT_MB * 1024 * 1024;

      if (stats.size > maxSizeBytes) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveFile = logFile.replace('.log', `-${timestamp}.log`);

        // Rename the old log. Active child processes will keep writing to the old file
        // descriptor safely, while new processes will write to the fresh log file.
        fs.renameSync(logFile, archiveFile);
        console.log(`[webhook] Rotated log file. Old log saved as: ${archiveFile}`);
      }
    }
  } catch (err) {
    console.error('[webhook] Log rotation failed:', err);
  }
}

// ─── Health check ───
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Webhook handler (now async) ───
app.post('/webhook/job', async (req, res) => {
  const { jobId, campaignId, chain, type, fundingPrivateKey } = req.body;

  // 1. Dual-Validation for Authentication
  const customHeader = req.headers['x-webhook-secret'];
  const authHeader = req.headers['authorization'];
  let token = customHeader;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token || token !== WEBHOOK_SECRET) {
    console.error('[webhook] Unauthorized request: Invalid or missing token/secret');
    return res.status(401).json({ error: 'Invalid authentication secret' });
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

  const projectRoot = __dirname;

  switch (type) {
    case 'generate':
      scriptPath = path.join(projectRoot, 'src', 'batch_generate.py');
      args = ['--job-id', jobId];

        // ─── Add max-keys if provided ───
      if (req.body.maxKeys) {
        args.push('--max-keys', String(req.body.maxKeys));
      }

      // ─── Fetch Clore config from Supabase and inject into env ───
      try {
        const cloreConfig = await getCloreConfig();
        env.CLORE_INSTANCE_ID = cloreConfig.CLORE_INSTANCE_ID || process.env.CLORE_INSTANCE_ID;
        env.BATCH_REMOTE_HOST = cloreConfig.BATCH_REMOTE_HOST || process.env.BATCH_REMOTE_HOST;
        env.BATCH_REMOTE_PORT = cloreConfig.BATCH_REMOTE_PORT || process.env.BATCH_REMOTE_PORT;
        console.log(`[webhook] Clore config applied: INSTANCE=${env.CLORE_INSTANCE_ID}, HOST=${env.BATCH_REMOTE_HOST}, PORT=${env.BATCH_REMOTE_PORT}`);
      } catch (err) {
        console.error('[webhook] Error applying Clore config:', err);
      }
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

  // 5. Setup Logging Directory, Log Rotation, and Files
  const logDir = path.join(projectRoot, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logFile = path.join(logDir, 'jobs.log');

  // Rotate log if it exceeds our size limit (10MB) before we write to it
  rotateLogsIfNeeded(logFile);

  const outStream = fs.openSync(logFile, 'a');

  console.log(`[webhook] Spawning: ${interpreter} ${scriptPath} ${args.join(' ')}`);

  // 6. Spawn the process detached
  const child = spawn(interpreter, [scriptPath, ...args], {
    env,
    detached: true,
    stdio: ['ignore', outStream, outStream], // Standard streams piped to outStream
    cwd: projectRoot,
  });

  // CRITICAL FIX: Close the parent process's file descriptor handle.
  // The OS passes a duplicated descriptor to the child, so closing it in the 
  // parent does NOT stop the child from logging, but it DOES prevent a system FD leak!
  fs.closeSync(outStream);

  // Disconnect the parent's IPC channel so the parent can respond immediately
  child.unref();

  // 7. Log process start
  console.log(`[webhook] ${type} job ${jobId} started (PID: ${child.pid}). Logs routed to logs/jobs.log`);

  // 8. Respond immediately
  res.status(202).json({ message: `Job ${jobId} accepted for execution` });
});

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`[webhook] Server running on port ${PORT}`);
  console.log(`[webhook] Webhook endpoint: http://localhost:${PORT}/webhook/job`);
  console.log(`[webhook] Health: http://localhost:${PORT}/health`);
});