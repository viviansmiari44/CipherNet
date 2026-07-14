import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';

export async function GET(req: NextRequest) {
  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin role
    const { data: currentUser, error: roleError } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();

    if (roleError || currentUser?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || 'all';

    let query = supabaseService
      .from('deposit_requests')
      .select(`
        *,
        users:user_id (email)
      `)
      .order('created_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[admin/deposit-requests] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[admin/deposit-requests] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}