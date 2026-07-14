import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { supabaseService } from '@app-lib/supabaseService';

export async function GET(req: NextRequest) {
  console.log('[admin] Route /api/admin/users called');

  const user = await getAuthUser();
  if (!user) {
    console.log('[admin] No authenticated user found');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  console.log('[admin] Authenticated user:', user.id);

  const supabase = await createServerSupabaseClient();

  const { data: currentUser, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  console.log('[admin] Role from DB:', currentUser?.role);

  if (userError || currentUser?.role !== 'admin') {
    console.log('[admin] Access denied for user:', user.id);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  console.log('[admin] Access granted for user:', user.id);

  // ✅ Include credits column
  const { data: users, error } = await supabaseService
    .from('users')
    .select('id, email, profit_split_percent, telegram_bot_token, telegram_chat_id, created_at, credits')
    .order('created_at', { ascending: false });

  if (error) {
    console.log('[admin] Error fetching users:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  console.log(`[admin] Fetched ${users?.length || 0} users`);
  return NextResponse.json(users);
}