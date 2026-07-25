import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from './apas-frontend/lib/encryption.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const trapAddress = process.argv[2]; // pass trap address as argument

if (!trapAddress) {
  console.error('Usage: node get_private_key.js <trap_address>');
  process.exit(1);
}

const { data, error } = await supabase
  .from('traps')
  .select('trap_private_key_enc, trap_address')
  .eq('trap_address', trapAddress)
  .single();

if (error) {
  console.error('Error fetching trap:', error.message);
  process.exit(1);
}

try {
  const privateKey = decrypt(data.trap_private_key_enc);
  console.log(`✅ Private key for ${data.trap_address}:`);
  console.log(privateKey);
} catch (err) {
  console.error('Decryption failed:', err.message);
}