'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@app-lib/supabaseClient';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, Wallet, DollarSign } from 'lucide-react';

interface ProfitShare {
  user_amount: string;
  service_amount: string;
  user_share_tx_hash: string | null;
  service_share_tx_hash: string | null;
  settled_at: string | null;
}

interface Transaction {
  id: string;
  trap_address: string;
  token_symbol: string;
  amount: string;
  usd_value: string;
  tx_hash: string;
  type: string;
  status: string;
  created_at: string;
  profit_shares: ProfitShare[];
}

export default function ProfitHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [totals, setTotals] = useState({ user: 0, service: 0, count: 0 });

  // Unwrap params (even though this is a client component, we can use React.use)
  // Or we can use a useEffect with the id from the URL
  // Since this is a client component, we'll get the id from the URL using usePathname or similar
  // But simpler: we'll use the id from the route via a prop

  // Actually, since this is a client component with 'use client', we can't use async params directly.
  // We'll use a different approach: get the id from the URL pathname.

  // Let's rewrite this as a client component that extracts the id from the URL.

  useEffect(() => {
    const fetchProfitHistory = async () => {
      // Get the campaign ID from the URL path
      const pathSegments = window.location.pathname.split('/');
      const campaignId = pathSegments[pathSegments.length - 2]; // /dashboard/[id]/profits

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }

      try {
        const res = await fetch(`/api/campaigns/${campaignId}/profits`);
        if (!res.ok) {
          const json = await res.json();
          setError(json.error || 'Failed to fetch profits');
          setLoading(false);
          return;
        }
        const data = await res.json();
        setTransactions(data.transactions || []);

        let userTotal = 0;
        let serviceTotal = 0;
        for (const tx of data.transactions) {
          if (tx.profit_shares && tx.profit_shares.length > 0) {
            const share = tx.profit_shares[0];
            userTotal += parseFloat(share.user_amount || '0');
            serviceTotal += parseFloat(share.service_amount || '0');
          }
        }
        setTotals({
          user: userTotal,
          service: serviceTotal,
          count: data.transactions.length,
        });
      } catch (err) {
        setError('Network error');
      } finally {
        setLoading(false);
      }
    };

    fetchProfitHistory();
  }, [router]);

  if (loading) return <div className="text-gray-400">Loading profit history...</div>;
  if (error) return <div className="text-red-400">{error}</div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Navigation */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            href={`/dashboard/${window.location.pathname.split('/')[2]}`}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-2xl font-bold text-white">Profit History</h1>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/20 rounded-lg">
                <TrendingUp className="text-blue-400" size={20} />
              </div>
              <div>
                <p className="text-gray-400 text-sm">Total Transactions</p>
                <p className="text-white text-xl font-bold">{totals.count}</p>
              </div>
            </div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-500/20 rounded-lg">
                <Wallet className="text-green-400" size={20} />
              </div>
              <div>
                <p className="text-gray-400 text-sm">Your Total Share</p>
                <p className="text-green-400 text-xl font-bold">{totals.user.toFixed(6)}</p>
              </div>
            </div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/20 rounded-lg">
                <DollarSign className="text-purple-400" size={20} />
              </div>
              <div>
                <p className="text-gray-400 text-sm">Service Total Share</p>
                <p className="text-purple-400 text-xl font-bold">{totals.service.toFixed(6)}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Table */}
        {transactions.length === 0 ? (
          <div className="text-center py-12 bg-gray-800/30 rounded-2xl border border-gray-700">
            <p className="text-gray-400">No transactions yet.</p>
          </div>
        ) : (
          <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-900/50 border-b border-gray-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Trap</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Asset</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Amount</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">USD Value</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Your Share</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Service Share</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Settled</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {transactions.map((tx) => {
                    const share = tx.profit_shares?.[0] || null;
                    return (
                      <tr key={tx.id} className="hover:bg-gray-700/20 transition-colors">
                        <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                          {new Date(tx.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                          {tx.trap_address.slice(0, 8)}…{tx.trap_address.slice(-6)}
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          {tx.token_symbol}
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          {parseFloat(tx.amount).toFixed(6)}
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          ${parseFloat(tx.usd_value || '0').toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-green-400">
                          {share ? parseFloat(share.user_amount).toFixed(6) : '—'}
                        </td>
                        <td className="px-4 py-3 text-purple-400">
                          {share ? parseFloat(share.service_amount).toFixed(6) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {share?.settled_at ? (
                            <span className="text-green-400 text-xs">✅ Settled</span>
                          ) : (
                            <span className="text-yellow-400 text-xs">⏳ Pending</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}