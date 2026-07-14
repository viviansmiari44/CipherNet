import { createServerSupabaseClient } from '@app-lib/supabaseServer';
import TrapsList from '@/components/TrapsList';
import JobButtons from '@/components/JobButtons';
import BalanceCard from '@/components/BalanceCard';
import CreditsCard from '@/components/CreditsCard';
import JobStatus from '@/components/JobStatus';
import CampaignToggleButton from '@/components/CampaignToggleButton'; // ✅ new import
import Link from 'next/link';
import { TrendingUp } from 'lucide-react';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createServerSupabaseClient();

  // 🔍 Debug 1: Check if the user is authenticated
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  console.log('[CampaignPage] User:', user?.id, user?.email);
  console.log('[CampaignPage] User error:', userError);

  // 🔍 Debug 2: Query the campaign with the current user ID
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .single();

  console.log('[CampaignPage] Campaign query error:', error);
  console.log('[CampaignPage] Campaign data:', campaign);

  if (error || !campaign) {
    return (
      <div className="text-red-400">
        Campaign not found
        <pre className="text-xs mt-2">
          Error: {error?.message || 'No data returned'}
          <br />
          User ID: {user?.id || 'Not authenticated'}
          <br />
          Campaign ID: {id}
        </pre>
      </div>
    );
  }

  const { data: traps } = await supabase
    .from('traps')
    .select('*')
    .eq('campaign_id', id);

  const isActive = campaign.status === 'active';

  return (
    <div>
      {/* ─── Header with status and toggle button ─── */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">{campaign.chain.toUpperCase()} Campaign</h2>
          <p className="text-gray-400 text-sm">Safe wallet: {campaign.safe_wallet_address}</p>
          <p className="text-gray-400 text-sm">
            Status: <span className={`capitalize ${isActive ? 'text-green-400' : 'text-red-400'}`}>
              {campaign.status}
            </span>
          </p>
        </div>
        <CampaignToggleButton campaignId={id} currentStatus={campaign.status} />
      </div>

      {/* ─── Job Buttons ─── */}
      <div className="flex flex-wrap gap-4 mb-6">
        <JobButtons campaignId={id} jobType="generate" label="Generate Vanity" disabled={!isActive} />
        <JobButtons campaignId={id} jobType="fund" label="Fund Traps" disabled={!isActive} />
        <JobButtons campaignId={id} jobType="dust" label="Send Dust" disabled={!isActive} />
        <JobButtons campaignId={id} jobType="sweep" label="Sweep Traps" disabled={!isActive} />
        <Link
          href={`/dashboard/${id}/profits`}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors"
        >
          <TrendingUp size={16} />
          Profit History
        </Link>
      </div>

      <JobStatus campaignId={id} />

      {/* Credits Card */}
      <div className="mb-6">
        <CreditsCard />
      </div>

      <BalanceCard campaignId={id} />
      <div className="mt-8">
       <TrapsList campaignId={id} />
      </div>
    </div>
  );
}