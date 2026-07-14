import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';
import { getDepositAddress } from '@app-lib/hdWallet';

// ────────────────────────────────────────────────────────────────
// ALCHEMY REGISTRATION
// ────────────────────────────────────────────────────────────────
const ALCHEMY_NOTIFY_TOKEN = process.env.ALCHEMY_NOTIFY_TOKEN;
const ALCHEMY_WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID;

async function registerAddressWithAlchemy(address: string, userId: string): Promise<boolean> {
  console.log(`[deposit-address] Alchemy config: NOTIFY_TOKEN=${ALCHEMY_NOTIFY_TOKEN ? 'set' : 'missing'}, WEBHOOK_ID=${ALCHEMY_WEBHOOK_ID || 'missing'}`);

  if (!ALCHEMY_NOTIFY_TOKEN || !ALCHEMY_WEBHOOK_ID) {
    console.warn('[deposit-address] Alchemy Notify not configured – skipping registration');
    return true;
  }

  try {
    const url = 'https://dashboard.alchemy.com/api/update-webhook-addresses';
    console.log(`[deposit-address] Registering address ${address} for user ${userId}`);
    console.log(`[deposit-address] Alchemy URL: ${url}`);

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Alchemy-Token': ALCHEMY_NOTIFY_TOKEN,
      },
      body: JSON.stringify({
        webhook_id: ALCHEMY_WEBHOOK_ID,
        addresses_to_add: [address],
        addresses_to_remove: [],
      }),
    });

    const status = response.status;
    console.log(`[deposit-address] Alchemy response status: ${status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[deposit-address] Alchemy registration failed (${status}): ${errorText}`);
      try {
        const errorJson = JSON.parse(errorText);
        console.error('[deposit-address] Alchemy error details:', errorJson);
      } catch {
        // ignore
      }
      return false;
    }

    console.log(`[deposit-address] ✅ Address ${address} successfully added to Alchemy webhook ${ALCHEMY_WEBHOOK_ID}`);
    return true;
  } catch (err) {
    console.error('[deposit-address] Exception during Alchemy registration:', err);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// API ROUTE
// ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      console.warn('[deposit-address] Unauthorized request');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log(`[deposit-address] Fetching deposit address for user ${user.id}`);

    // ─── Check for force flag (admin only) ───
    const url = new URL(req.url);
    const forceRegister = url.searchParams.get('force') === 'true';
    if (forceRegister) {
      console.log('[deposit-address] ⚡ Force registration enabled');
    }

    // ─── Fetch user data (deposit_address + alchemy_registered) ───
    const { data: userData, error: fetchError } = await supabaseService
      .from('users')
      .select('deposit_address, alchemy_registered')
      .eq('id', user.id)
      .single();

    if (fetchError) {
      console.error('[deposit-address] Fetch error:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch user' }, { status: 500 });
    }

    let depositAddress = userData?.deposit_address;
    let alchemyRegistered = userData?.alchemy_registered || false;
    let isNewAddress = false;

    // ─── Generate address if missing ───
    if (!depositAddress) {
      console.log('[deposit-address] No existing deposit address – generating new one');
      try {
        depositAddress = getDepositAddress(user.id);
        console.log(`[deposit-address] Generated address: ${depositAddress}`);
      } catch (genErr) {
        console.error('[deposit-address] Generation error:', genErr);
        return NextResponse.json({ error: 'Failed to generate deposit address' }, { status: 500 });
      }

      // Save new address with alchemy_registered = false
      const { error: updateError } = await supabaseService
        .from('users')
        .update({
          deposit_address: depositAddress,
          alchemy_registered: false,
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('[deposit-address] Update error:', updateError);
        return NextResponse.json({ error: 'Failed to save deposit address' }, { status: 500 });
      }

      isNewAddress = true;
      console.log(`[deposit-address] ✅ Saved new deposit address ${depositAddress} for user ${user.id}`);
    } else {
      console.log(`[deposit-address] Existing deposit address found: ${depositAddress}`);
    }

    // ─── Determine if registration is needed ───
    const shouldRegister = isNewAddress || !alchemyRegistered || forceRegister;

    if (shouldRegister) {
      console.log('[deposit-address] 🔄 Attempting to register address with Alchemy...');
      try {
        const registered = await registerAddressWithAlchemy(depositAddress, user.id);
        if (registered) {
          // Update alchemy_registered to true
          await supabaseService
            .from('users')
            .update({ alchemy_registered: true })
            .eq('id', user.id);
          console.log(`[deposit-address] ✅ Address ${depositAddress} successfully registered with Alchemy.`);
        } else {
          console.warn(`[deposit-address] ⚠️ Address ${depositAddress} NOT registered with Alchemy.`);
          console.warn('[deposit-address] 🔧 Will retry on next request. Check your Alchemy Notify token and webhook ID.');
        }
      } catch (regErr) {
        console.error('[deposit-address] ❌ Registration error:', regErr);
      }
    } else {
      console.log('[deposit-address] Address already registered – skipping Alchemy registration.');
    }

    return NextResponse.json({ depositAddress });
  } catch (err) {
    console.error('[deposit-address] ❌ Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}