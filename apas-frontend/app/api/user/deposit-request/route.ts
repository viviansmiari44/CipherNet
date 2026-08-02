import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import { sendAlert } from '@app-lib/notifier'; // ✅ import notifier

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { token, network, amount, walletAddress, tx_hash } = await req.json();

    if (!token || !network || !amount || !walletAddress || !tx_hash) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (amount <= 0) {
      return NextResponse.json({ error: 'Amount must be positive' }, { status: 400 });
    }

    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase
      .from('deposit_requests')
      .insert({
        user_id: user.id,
        token,
        network,
        amount,
        wallet_address: walletAddress,
        tx_hash: tx_hash,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      console.error('[deposit-request] Insert error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ─── Send admin notification ───
    try {
      const amountFormatted = parseFloat(amount).toFixed(2);
      const message =
`📩 New Deposit Request

User: ${user.email || user.id}
Amount: $${amountFormatted}
Token: ${token}
Network: ${network}
TX Hash: ${tx_hash}
Wallet: ${walletAddress}

Please review and approve in the admin panel.`;

      // Send without campaignId → falls back to global admin config
      await sendAlert(message, 'info');
      console.log(`[deposit-request] Admin notification sent for user ${user.id}`);
    } catch (notifErr) {
      // Log but do not fail the request
      console.error('[deposit-request] Failed to send admin notification:', notifErr);
    }

    return NextResponse.json({ success: true, request: data }, { status: 201 });
  } catch (err) {
    console.error('[deposit-request] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}