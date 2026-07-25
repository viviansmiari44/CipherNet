import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ trapId: string }> }
) {
  const { trapId } = await params;

  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check admin role
    const { data: adminUser } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();
    if (adminUser?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Optional: verify the trap exists before deleting
    const { data: existing, error: fetchError } = await supabaseService
      .from('traps')
      .select('id')
      .eq('id', trapId)
      .single();

    if (fetchError || !existing) {
      return NextResponse.json({ error: 'Trap not found' }, { status: 404 });
    }

    const { error } = await supabaseService
      .from('traps')
      .delete()
      .eq('id', trapId);

    if (error) {
      console.error('[admin/traps] Delete error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[admin/traps] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}