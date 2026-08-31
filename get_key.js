import { createClient } from '@supabase/supabase-js';
import { decrypt } from './lib/encryption.js';
import 'dotenv/config';

const campaignId = process.argv[2];

if (!campaignId) {
  console.log('❌ Usage: node get_key.js <campaign_id>');
  console.log('💡 Example: node get_key.js dc2843c8-3864-4bae-a5f3-1f61c6512999');
  process.exit(1);
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getKey() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, chain, funding_private_key_enc') // Removed 'name'
    .eq('id', campaignId)
    .maybeSingle();

  if (error) {
    console.error('❌ Supabase Error:', error.message);
    return;
  }

  if (!data) {
    console.log('❌ Campaign not found in database.');
    return;
  }

  if (!data.funding_private_key_enc) {
    console.log('⚠️ Campaign found, but no funding key is configured for it.');
    return;
  }

  try {
    const decryptedKey = decrypt(data.funding_private_key_enc);
    console.log(`\n✅ Campaign ID: ${data.id}`);
    console.log(`⛓️ Chain: ${data.chain}`);
    console.log(`🔓 Decrypted Funding Private Key:\n${decryptedKey}\n`);
  } catch (e) {
    console.error('❌ Failed to decrypt. Is your ENCRYPTION_KEY in the .env file correct?');
  }
}

getKey();