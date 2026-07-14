import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { supabaseService } from '@app-lib/supabaseService';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  const user = await getAuthUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check admin role
  const { data: currentUser, error: adminError } = await supabaseService
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  if (adminError || currentUser?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { amount, description, type = 'add' } = await req.json();

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
  }

  // Fetch current credits
  const { data: userData, error: fetchError } = await supabaseService
    .from('users')
    .select('credits')
    .eq('id', userId)
    .single();

  if (fetchError || !userData) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const currentCredits = parseFloat(userData.credits || '0');
  let newCredits: number;

  if (type === 'withdraw') {
    if (currentCredits < amount) {
      return NextResponse.json(
        { error: `Insufficient credits: ${currentCredits.toFixed(2)} available, ${amount} requested` },
        { status: 400 }
      );
    }
    newCredits = currentCredits - amount;
  } else {
    // type === 'add' (default)
    newCredits = currentCredits + amount;
  }

  // Update credits
  const { data: updatedUser, error: updateError } = await supabaseService
    .from('users')
    .update({ credits: newCredits })
    .eq('id', userId)
    .select()
    .single();

  if (updateError) {
    console.error('[admin balance] Update error:', updateError);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Log transaction
  const transactionType = type === 'withdraw' ? 'admin_withdrawal' : 'admin_add';
  const { error: txError } = await supabaseService.from('credit_transactions').insert({
    user_id: userId,
    amount: type === 'withdraw' ? -amount : amount,
    type: transactionType,
    status: 'completed',
    description: description || (type === 'withdraw' ? 'Admin manual withdrawal' : 'Admin manual funding'),
    completed_at: new Date().toISOString(),
  });

  if (txError) {
    console.error('[admin balance] Transaction log error:', txError);
    // Don't fail the request, just log
  }

  return NextResponse.json(updatedUser);
}