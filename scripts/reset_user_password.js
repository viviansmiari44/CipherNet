#!/usr/bin/env node
/**
 * Admin script to reset a user's password
 * Usage: node scripts/reset_user_password.js <email> <new_password>
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const email = process.argv[2];
const newPassword = process.argv[3];

if (!email || !newPassword) {
    console.error('Usage: node scripts/reset_user_password.js <email> <new_password>');
    console.error('Example: node scripts/reset_user_password.js bjighuioni@gmail.com NewPass123!');
    process.exit(1);
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function resetPassword() {
    console.log(`\n🔄 Resetting password for: ${email}`);

    // Find the user
    const { data: users, error: listError } = await supabase.auth.admin.listUsers();

    if (listError) {
        console.error('❌ Failed to list users:', listError.message);
        process.exit(1);
    }

    const user = users.users.find(u => u.email.toLowerCase() === email.toLowerCase());

    if (!user) {
        console.error(`❌ User not found: ${email}`);
        process.exit(1);
    }

    console.log(`✅ Found user: ${user.id}`);

    // Update the password
    const { data, error } = await supabase.auth.admin.updateUserById(
        user.id,
        { password: newPassword }
    );

    if (error) {
        console.error('❌ Failed to reset password:', error.message);
        process.exit(1);
    }

    console.log(`\n✅ Password reset successfully!`);
    console.log(`   User: ${email}`);
    console.log(`   New password: ${newPassword}`);
    console.log(`\n⚠️  Share this password securely with the user and ask them to change it immediately.\n`);
}

resetPassword();