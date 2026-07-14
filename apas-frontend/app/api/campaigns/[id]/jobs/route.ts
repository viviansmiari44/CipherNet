import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@app-lib/auth';
import { createServerSupabaseClient } from '@app-lib/supabaseServer';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;  // ✅ unwrap

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createServerSupabaseClient();

  // Verify campaign ownership
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Fetch jobs
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, type, status, progress, total, message, started_at, completed_at, created_at')
    .eq('campaign_id', id)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Group by type to get latest per type
  const latestByType: Record<string, any> = {};
  for (const job of jobs) {
    if (!latestByType[job.type]) {
      latestByType[job.type] = job;
    }
  }

  return NextResponse.json(Object.values(latestByType));
}