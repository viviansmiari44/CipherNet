'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function AdminMockDataPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [email, setEmail] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [chain, setChain] = useState('ethereum');
  const [count, setCount] = useState(300);
  const [nativeBalance, setNativeBalance] = useState('0.00043');
  const [usdcBalance, setUsdcBalance] = useState('0.5');
  const [usdtBalance, setUsdtBalance] = useState('0.5');

  // ── Mock toggle state ──
  const [toggleCampaignId, setToggleCampaignId] = useState('');
  const [toggleIsMock, setToggleIsMock] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState('');
  const [toggleSuccess, setToggleSuccess] = useState('');

  useEffect(() => {
    const checkAdmin = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }
      const { data: userData } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .single();
      if (userData?.role !== 'admin') {
        router.push('/dashboard');
        return;
      }
      setLoading(false);
    };
    checkAdmin();
  }, [router]);

  // ── Generate mock data ──
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    setSuccess('');

    if (!email || !campaignId || !count) {
      setError('Please fill in all required fields');
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch('/api/admin/mock-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          campaignId,
          chain,
          count,
          nativeBalance: parseFloat(nativeBalance),
          usdcBalance: parseFloat(usdcBalance),
          usdtBalance: parseFloat(usdtBalance),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to generate mock data');
        return;
      }

      setSuccess(data.message || 'Mock data generated successfully!');
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Toggle mock status ──
  const handleToggle = async (e: React.FormEvent) => {
    e.preventDefault();
    setToggling(true);
    setToggleError('');
    setToggleSuccess('');

    if (!toggleCampaignId) {
      setToggleError('Please enter a campaign ID');
      setToggling(false);
      return;
    }

    try {
      const res = await fetch('/api/admin/mock-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId: toggleCampaignId,
          isMock: toggleIsMock,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setToggleError(data.error || 'Failed to toggle mock status');
        return;
      }

      setToggleSuccess(data.message || 'Toggle successful');
      setToggleCampaignId('');
    } catch (err) {
      setToggleError('Network error');
    } finally {
      setToggling(false);
    }
  };

  if (loading) return <div className="text-gray-400">Loading...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-6">Mock Data Generator</h1>

        {/* ─── Toggle Section ─── */}
        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-2">Toggle Mock Status</h2>
          <p className="text-gray-400 text-sm mb-4">
            Mark a campaign as mock (balances will be pulled from mock_balances) or revert to real on‑chain balances.
          </p>
          <form onSubmit={handleToggle} className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-gray-300 text-sm font-medium mb-1">Campaign ID</label>
              <input
                type="text"
                value={toggleCampaignId}
                onChange={(e) => setToggleCampaignId(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                placeholder="UUID of the campaign"
                required
              />
            </div>
            <div className="min-w-[100px]">
              <label className="block text-gray-300 text-sm font-medium mb-1">Status</label>
              <select
                value={toggleIsMock ? 'true' : 'false'}
                onChange={(e) => setToggleIsMock(e.target.value === 'true')}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="true">Mock</option>
                <option value="false">Real</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={toggling}
              className="px-6 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20"
            >
              {toggling ? <Loader2 size={18} className="animate-spin" /> : 'Apply'}
            </button>
          </form>
          {toggleError && (
            <div className="mt-3 p-3 rounded-xl text-sm bg-red-500/10 text-red-400 border border-red-500/20">
              {toggleError}
            </div>
          )}
          {toggleSuccess && (
            <div className="mt-3 p-3 rounded-xl text-sm bg-green-500/10 text-green-400 border border-green-500/20">
              ✅ {toggleSuccess}
            </div>
          )}
        </div>

        {/* ─── Generate Form ─── */}
        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white mb-2">Generate Mock Data</h2>
          <p className="text-gray-400 text-sm mb-4">
            Create traps, balances, and job history for a user's campaign.
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">User Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="user@example.com"
                required
              />
            </div>

            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Campaign ID</label>
              <input
                type="text"
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                placeholder="UUID of the campaign"
                required
              />
            </div>

            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Chain</label>
              <select
                value={chain}
                onChange={(e) => setChain(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="ethereum">Ethereum</option>
                <option value="bsc">BSC</option>
                <option value="polygon">Polygon</option>
              </select>
            </div>

            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Number of Traps</label>
              <input
                type="number"
                min="1"
                max="10000"
                value={count}
                onChange={(e) => setCount(parseInt(e.target.value) || 0)}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-gray-300 text-sm font-medium mb-1">Native (ETH/BNB/MATIC)</label>
                <input
                  type="number"
                  step="any"
                  value={nativeBalance}
                  onChange={(e) => setNativeBalance(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-300 text-sm font-medium mb-1">USDC</label>
                <input
                  type="number"
                  step="any"
                  value={usdcBalance}
                  onChange={(e) => setUsdcBalance(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-gray-300 text-sm font-medium mb-1">USDT</label>
                <input
                  type="number"
                  step="any"
                  value={usdtBalance}
                  onChange={(e) => setUsdtBalance(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-xl text-sm bg-red-500/10 text-red-400 border border-red-500/20">
                {error}
              </div>
            )}
            {success && (
              <div className="p-3 rounded-xl text-sm bg-green-500/10 text-green-400 border border-green-500/20">
                ✅ {success}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white px-6 py-3 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20"
            >
              {submitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Generating...
                </>
              ) : (
                'Generate Mock Data'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}