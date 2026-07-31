import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';
import { encrypt } from '@/lib/encryption';
import { randomBytes } from 'node:crypto';

export async function POST(req: NextRequest) {
  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin role
    const { data: currentUser } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();

    if (currentUser?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { email, campaignId, chain, count, nativeBalance, usdcBalance, usdtBalance } = body;

    if (!email || !campaignId || !chain || !count || count <= 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Find user by email
    const { data: user, error: userError } = await supabaseService
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Verify campaign belongs to user
    const { data: campaign, error: campaignError } = await supabaseService
      .from('campaigns')
      .select('id, funding_private_key_enc, safe_wallet_address')
      .eq('id', campaignId)
      .eq('user_id', user.id)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json({ error: 'Campaign not found or does not belong to user' }, { status: 404 });
    }

    // Mark campaign as mock (if not already)
    await supabaseService
      .from('campaigns')
      .update({ is_mock: true })
      .eq('id', campaignId);

    const trapsData = [];
    const mockBalancesData = [];

    for (let i = 0; i < count; i++) {
      // Generate random private key
      const privateKey = `0x${randomBytes(32).toString('hex')}`;
      const encryptedKey = encrypt(privateKey);
      // Derive address (we'll just use a placeholder address – but for mock we can generate deterministic)
      // For simplicity, we can use a fake address: 0x + random 40 hex chars
      const trapAddress = `0x${randomBytes(20).toString('hex')}`;

      // We need a victim address and counterparty address – use random ones
      const victimAddress = `0x${randomBytes(20).toString('hex')}`;
      const counterpartyAddress = `0x${randomBytes(20).toString('hex')}`;

      trapsData.push({
        campaign_id: campaignId,
        victim_address: victimAddress,
        counterparty_address: counterpartyAddress,
        trap_private_key_enc: encryptedKey,
        trap_address: trapAddress,
        is_caught: false,
        funding_enabled: true,
      });

      mockBalancesData.push({
        campaign_id: campaignId,
        trap_address: trapAddress,
        native: nativeBalance || 0,
        usdc: usdcBalance || 0,
        usdt: usdtBalance || 0,
      });
    }

    // Insert traps in batch
    const { error: trapsInsertError } = await supabaseService
      .from('traps')
      .insert(trapsData);

    if (trapsInsertError) {
      console.error('[mock-data] Traps insert error:', trapsInsertError);
      return NextResponse.json({ error: trapsInsertError.message }, { status: 500 });
    }

    // Insert mock balances
    const { error: balancesInsertError } = await supabaseService
      .from('mock_balances')
      .insert(mockBalancesData);

    if (balancesInsertError) {
      console.error('[mock-data] Balances insert error:', balancesInsertError);
      return NextResponse.json({ error: balancesInsertError.message }, { status: 500 });
    }

    // Create mock jobs: generate, fund, dust
    const jobs = [
      {
        campaign_id: campaignId,
        type: 'generate',
        status: 'completed',
        progress: count,
        total: count,
        message: `Generated ${count} traps`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      {
        campaign_id: campaignId,
        type: 'fund',
        status: 'completed',
        progress: count,
        total: count,
        message: `Funded ${count} traps`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      {
        campaign_id: campaignId,
        type: 'dust',
        status: 'completed',
        progress: count,
        total: count,
        message: `Dusted ${count} traps`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
    ];

    const { error: jobsInsertError } = await supabaseService
      .from('jobs')
      .insert(jobs);

    if (jobsInsertError) {
      console.error('[mock-data] Jobs insert error:', jobsInsertError);
      // Non‑fatal – we can ignore
    }

    return NextResponse.json({
      success: true,
      message: `Generated ${count} mock traps for campaign ${campaignId}`,
    });
  } catch (err) {
    console.error('[mock-data] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}