import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { supabaseService } from '@/lib/supabaseService';

export async function GET(req: NextRequest) {
  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: user } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();

    if (user?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data, error } = await supabaseService
      .from('app_config')
      .select('key, value')
      .in('key', ['CLORE_INSTANCE_ID', 'BATCH_REMOTE_HOST', 'BATCH_REMOTE_PORT']);

    if (error) {
      console.error('[admin/config] Fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const config = Object.fromEntries(data.map(row => [row.key, row.value]));
    return NextResponse.json(config);
  } catch (err) {
    console.error('[admin/config] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}



export async function PUT(req: NextRequest) {
  try {
    const admin = await getAuthUser();
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: user } = await supabaseService
      .from('users')
      .select('role')
      .eq('id', admin.id)
      .single();

    if (user?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const updates = await req.json();
    // Expect { CLORE_INSTANCE_ID: '...', BATCH_REMOTE_HOST: '...', BATCH_REMOTE_PORT: '...' }

    const operations = Object.entries(updates).map(([key, value]) =>
      supabaseService
        .from('app_config')
        .upsert({ key, value, updated_at: new Date().toISOString() })
    );

    await Promise.all(operations);

    // Fetch updated config
    const { data, error } = await supabaseService
      .from('app_config')
      .select('key, value')
      .in('key', ['CLORE_INSTANCE_ID', 'BATCH_REMOTE_HOST', 'BATCH_REMOTE_PORT']);

    if (error) {
      console.error('[admin/config] Re-fetch error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const config = Object.fromEntries(data.map(row => [row.key, row.value]));
    return NextResponse.json(config);
  } catch (err) {
    console.error('[admin/config] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}