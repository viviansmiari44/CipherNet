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

  // ✅ Fetch users with credits
  const { data: users, error } = await supabaseService
    .from('users')
    .select('id, email, profit_split_percent, telegram_bot_token, telegram_chat_id, created_at, credits')
    .order('created_at', { ascending: false });

  if (error) {
    console.log('[admin] Error fetching users:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ─── Compute per‑chain trap counts per user ───
  // 1. Fetch all campaigns (with user_id and chain)
  const { data: campaigns } = await supabaseService
    .from('campaigns')
    .select('id, user_id, chain');

  // 2. Fetch all traps (only campaign_id needed)
  const { data: traps } = await supabaseService
    .from('traps')
    .select('campaign_id');

  // Build campaign_id → { user_id, chain }
  const campaignInfo: Record<string, { user_id: string; chain: string }> = {};
  for (const camp of campaigns || []) {
    campaignInfo[camp.id] = { user_id: camp.user_id, chain: camp.chain };
  }

  // Count traps per user, per chain
  const userChainCounts: Record<string, Record<string, number>> = {};
  for (const trap of traps || []) {
    const info = campaignInfo[trap.campaign_id];
    if (info) {
      if (!userChainCounts[info.user_id]) {
        userChainCounts[info.user_id] = {};
      }
      userChainCounts[info.user_id][info.chain] =
        (userChainCounts[info.user_id][info.chain] || 0) + 1;
    }
  }

  // Attach to each user
  for (const u of users || []) {
    const counts = userChainCounts[u.id] || {};
    (u as any).trap_counts = counts;
    (u as any).total_traps = Object.values(counts).reduce((a, b) => a + b, 0);
  }

  console.log(`[admin] Fetched ${users?.length || 0} users with chain‑specific trap counts`);
  return NextResponse.json(users);
}