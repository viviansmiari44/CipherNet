import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function POST(req: NextRequest) {
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

    const { userId, action } = await req.json(); // action: 'approve' or 'reject'

    if (!userId || !['approve', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const status = action === 'approve' ? 'active' : 'rejected';

    const { data, error } = await supabaseService
      .from('users')
      .update({ status })
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      console.error('[admin/approve] Update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, user: data });
  } catch (err) {
    console.error('[admin/approve] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}