'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@app-lib/supabaseClient';
import Link from 'next/link';
import { Plus, TrendingUp, Wallet, Layers } from 'lucide-react';
import CreditsCard from '@/components/CreditsCard'; // ✅ added import

interface Campaign {
  id: string;
  chain: string;
  safe_wallet_address: string;
  status: string;
  created_at: string;
}

export default function DashboardPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, active: 0, traps: 0 });

  useEffect(() => {
    const fetchData = async () => {
      // Fetch campaigns
      const { data, error } = await supabase
        .from('campaigns')
        .select('id, chain, safe_wallet_address, status, created_at')
        .order('created_at', { ascending: false });

      if (error) {
        console.error(error);
        setLoading(false);
        return;
      }

      setCampaigns(data || []);

      // Compute stats
      const total = data?.length || 0;
      const active = data?.filter(c => c.status === 'active').length || 0;

      // Fetch trap count (optional)
      const { count } = await supabase
        .from('traps')
        .select('*', { count: 'exact', head: true });

      setStats({
        total,
        active,
        traps: count || 0,
      });

      setLoading(false);
    };

    fetchData();
  }, []);

  if (loading) {
    return <div className="text-gray-400">Loading campaigns...</div>;
  }

  return (
    <div>
      {/* Credits Card */}
      <div className="mb-8">
        <CreditsCard />
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-400 text-sm">Total Campaigns</p>
              <p className="text-3xl font-bold text-white mt-1">{stats.total}</p>
            </div>
            <div className="p-3 bg-blue-500/20 rounded-xl">
              <Layers className="text-blue-400" size={24} />
            </div>
          </div>
        </div>
        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-400 text-sm">Active Campaigns</p>
              <p className="text-3xl font-bold text-white mt-1">{stats.active}</p>
            </div>
            <div className="p-3 bg-green-500/20 rounded-xl">
              <TrendingUp className="text-green-400" size={24} />
            </div>
          </div>
        </div>
        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-gray-400 text-sm">Total Traps</p>
              <p className="text-3xl font-bold text-white mt-1">{stats.traps}</p>
            </div>
            <div className="p-3 bg-purple-500/20 rounded-xl">
              <Wallet className="text-purple-400" size={24} />
            </div>
          </div>
        </div>
      </div>

      {/* Campaigns Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <h2 className="text-2xl font-bold text-white">Your Campaigns</h2>
        <Link
          href="/dashboard/new"
          className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white px-5 py-2.5 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/25"
        >
          <Plus size={18} />
          New Campaign
        </Link>
      </div>

      {campaigns.length === 0 ? (
        <div className="text-center py-16 bg-gray-800/30 rounded-2xl border border-gray-700">
          <p className="text-gray-400">No campaigns yet. Create your first campaign!</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {campaigns.map((campaign) => (
            <div
              key={campaign.id}
              className="group bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 hover:border-gray-600 transition-all hover:shadow-xl hover:shadow-blue-500/5"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <Link href={`/dashboard/${campaign.id}`} className="block">
                    <h3 className="text-lg font-semibold text-white group-hover:text-blue-400 transition-colors">
                      {campaign.chain.toUpperCase()}
                    </h3>
                  </Link>
                  <p className="text-sm text-gray-400 mt-1 truncate">
                    Safe: {campaign.safe_wallet_address.slice(0, 8)}…{campaign.safe_wallet_address.slice(-6)}
                  </p>
                  <span
                    className={`inline-block mt-3 px-3 py-1 text-xs font-medium rounded-full ${
                      campaign.status === 'active'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                        : 'bg-gray-600/30 text-gray-400 border border-gray-600'
                    }`}
                  >
                    {campaign.status}
                  </span>
                </div>
                <span className="text-xs text-gray-500 whitespace-nowrap ml-2">
                  {new Date(campaign.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}