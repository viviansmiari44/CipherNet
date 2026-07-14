import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabase } from '@/lib/supabaseClient';
import { supabaseService } from '@/lib/supabaseService'; // ✅ import service role

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params; // ✅ unwrap Promise if needed

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role (using regular client)
  const { data: currentUser, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  if (userError || currentUser?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { profitSplitPercent } = await req.json();

  if (typeof profitSplitPercent !== 'number' || profitSplitPercent < 0 || profitSplitPercent > 100) {
    return NextResponse.json({ error: 'Invalid profit split percent' }, { status: 400 });
  }

  // ✅ Use service role to update ANY user (bypass RLS)
  const { data, error } = await supabaseService
    .from('users')
    .update({ profit_split_percent: profitSplitPercent })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    console.error('[profit-split] Update error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}