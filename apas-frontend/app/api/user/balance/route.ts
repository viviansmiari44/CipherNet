import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { createServerSupabaseClient } from '@/lib/supabaseServer';

// Updated to accept any thenable/builder and safely convert it to a Promise
const fetchWithTimeout = async (promise: any, ms: number) => {
  const timeout = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('Request timed out')), ms)
  );
  return Promise.race([Promise.resolve(promise), timeout]);
};

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = await createServerSupabaseClient();

    const dbPromise = supabase
      .from('users')
      .select('credits, deposit_wallet_address')
      .eq('id', user.id)
      .single();

    const { data, error } = await fetchWithTimeout(dbPromise, 5000) as any;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      credits: data?.credits || 0,
      depositWallet: data?.deposit_wallet_address || null,
    });
  } catch (err) {
    console.error('[balance] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}