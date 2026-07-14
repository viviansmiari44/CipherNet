import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@app-lib/supabaseClient';
import { supabaseService } from '@app-lib/supabaseService';
import { sendAlert } from '@app-lib/notifier';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();

  if (!email || !password) {
    return NextResponse.json(
      { error: 'Email and password required' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // Create a user record in `users` with status 'pending'
  const { error: insertError } = await supabaseService
    .from('users')
    .insert([{ id: data.user?.id, email, role: 'user', status: 'pending' }]);

  if (insertError) {
    console.error('[register] Insert error:', insertError);
    return NextResponse.json(
      { error: 'Failed to create user profile' },
      { status: 500 }
    );
  }

  // Send Telegram alert to admins
  await sendAlert(
    `📝 New user registration\n` +
    `Email: ${email}\n` +
    `ID: ${data.user?.id}\n` +
    `Pending approval. Go to Admin → Pending Users to activate.`,
    'info'
    // no campaignId – uses global Telegram config
  );

  return NextResponse.json({ user: data.user });
}