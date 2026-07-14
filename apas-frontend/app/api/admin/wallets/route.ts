import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';

// ── GET: Any authenticated user can view wallets ──
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabaseService
      .from('admin_wallets')
      .select('*')
      .order('token', { ascending: true });

    if (error) {
      console.error('[admin/wallets] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[admin/wallets] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PUT: Only admins can update wallets ──
export async function PUT(req: NextRequest) {
  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: currentUser } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();

    if (currentUser?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { updates } = await req.json(); // array of { id, address, is_active }

    if (!Array.isArray(updates)) {
      return NextResponse.json({ error: 'Invalid updates format' }, { status: 400 });
    }

    for (const item of updates) {
      if (!item.id) continue;
      await supabaseService
        .from('admin_wallets')
        .update({
          address: item.address,
          is_active: item.is_active !== undefined ? item.is_active : true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);
    }

    const { data, error } = await supabaseService
      .from('admin_wallets')
      .select('*')
      .order('token', { ascending: true });

    if (error) {
      console.error('[admin/wallets] Re-fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[admin/wallets] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}