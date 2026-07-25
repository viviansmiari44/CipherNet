#!/usr/bin/env node

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from './lib/encryption.js';
import fs from 'fs';
import path from 'path';

// ─── Config ───
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase credentials. Check your .env file.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ─── Get chain from CLI argument ───
const chain = process.argv[2] || 'bsc';
console.log(`🔍 Exporting private keys for chain: ${chain}`);

async function exportKeys() {
  try {
    // 1. Get all campaign IDs for the chain
    const { data: campaigns, error: campError } = await supabase
      .from('campaigns')
      .select('id')
      .eq('chain', chain);

    if (campError) {
      console.error('❌ Failed to fetch campaigns:', campError);
      process.exit(1);
    }

    if (!campaigns || campaigns.length === 0) {
      console.log(`⚠️ No campaigns found for chain "${chain}".`);
      process.exit(0);
    }

    const campaignIds = campaigns.map(c => c.id);
    console.log(`📁 Found ${campaignIds.length} campaigns`);

    // 2. Fetch all traps belonging to those campaigns
    const { data: traps, error: trapError } = await supabase
      .from('traps')
      .select('trap_private_key_enc')
      .in('campaign_id', campaignIds);

    if (trapError) {
      console.error('❌ Failed to fetch traps:', trapError);
      process.exit(1);
    }

    console.log(`🎯 Found ${traps.length} traps`);

    // 3. Decrypt each private key
    const keys = [];
    let failed = 0;
    for (const trap of traps) {
      try {
        const decrypted = decrypt(trap.trap_private_key_enc);
        if (decrypted && decrypted.startsWith('0x')) {
          keys.push(decrypted);
        } else {
          console.warn(`⚠️ Skipping invalid key (does not start with 0x)`);
          failed++;
        }
      } catch (e) {
        console.warn(`⚠️ Failed to decrypt key: ${e.message}`);
        failed++;
      }
    }

    // 4. Write to file
    const filename = `${chain}_private_keys.txt`;
    const filepath = path.join(process.cwd(), filename);
    fs.writeFileSync(filepath, keys.join('\n') + '\n');

    console.log(`✅ Exported ${keys.length} private keys to ${filename}`);
    if (failed > 0) {
      console.log(`⚠️ ${failed} keys failed to decrypt.`);
    }

  } catch (err) {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  }
}

exportKeys();