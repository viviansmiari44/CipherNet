import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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

    const { status, admin_notes, tx_hash } = await req.json();

    if (!status || !['approved', 'rejected', 'completed'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    // If approving, we could automatically add credits to user (optional)
    let updateData: any = { status, admin_notes, updated_at: new Date().toISOString() };
    if (tx_hash) updateData.tx_hash = tx_hash;

    const { data, error } = await supabaseService
      .from('deposit_requests')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[admin/deposit-request] Update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // If approved, optionally credit the user
    if (status === 'approved') {
      // Fetch the request to get user_id and amount
      const { data: requestData } = await supabaseService
        .from('deposit_requests')
        .select('user_id, amount')
        .eq('id', id)
        .single();

      if (requestData) {
        // Add credits to user
        const { data: userData } = await supabaseService
          .from('users')
          .select('credits')
          .eq('id', requestData.user_id)
          .single();

        const newCredits = (userData?.credits || 0) + parseFloat(requestData.amount);
        await supabaseService
          .from('users')
          .update({ credits: newCredits })
          .eq('id', requestData.user_id);
      }
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('[admin/deposit-request] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}