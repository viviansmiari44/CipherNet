import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function GET(req: NextRequest) {
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

    const { data, error } = await supabaseService
      .from('users')
      .select('id, email, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[admin/pending] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[admin/pending] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}