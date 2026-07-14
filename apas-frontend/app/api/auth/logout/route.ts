import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@app-lib/supabaseClient';

export async function POST(req: NextRequest) {
  await supabase.auth.signOut();
  return NextResponse.json({ success: true });
}