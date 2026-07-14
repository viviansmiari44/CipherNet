import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  // If user doesn't have a deposit wallet, generate one (you'd use a wallet service)
  // For simplicity, we'll use a fixed wallet address and track deposits by user ID
  const { data, error } = await supabase
    .from('users')
    .select('deposit_wallet_address')
    .eq('id', user.id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If no wallet assigned, you could generate one here
  // (e.g., using HD wallet or a custodial wallet service)
  // For MVP, use a single wallet with memo/note field

  return NextResponse.json({
    walletAddress: data.deposit_wallet_address || '0x...', // Your platform wallet
    note: `User ID: ${user.id}`, // Important for identifying deposits
  });
}