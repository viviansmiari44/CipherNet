'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { RefreshCw, Save, X } from 'lucide-react';

interface Wallet {
  id: string;
  token: string;
  network: string;
  address: string;
  is_active: boolean;
}

export default function AdminWalletsPage() {
  const router = useRouter();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

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
      await fetchWallets();
    };
    checkAdmin();
  }, [router]);

  const fetchWallets = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/wallets');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setWallets(data);
      // Init edits with current addresses
      const newEdits: Record<string, string> = {};
      data.forEach((w: Wallet) => { newEdits[w.id] = w.address; });
      setEdits(newEdits);
    } catch (err) {
      console.error(err);
      alert('Failed to load wallets');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = wallets.map(w => ({
        id: w.id,
        address: edits[w.id] || w.address,
        is_active: w.is_active,
      }));
      const res = await fetch('/api/admin/wallets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Update failed');
        return;
      }
      const data = await res.json();
      setWallets(data);
      const newEdits: Record<string, string> = {};
      data.forEach((w: Wallet) => { newEdits[w.id] = w.address; });
      setEdits(newEdits);
      alert('✅ Wallet addresses updated successfully');
    } catch (err) {
      alert('Network error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = (id: string) => {
    setWallets(wallets.map(w => w.id === id ? { ...w, is_active: !w.is_active } : w));
  };

  if (loading) return <div className="text-gray-400">Loading wallets...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">Admin Wallets</h1>
          <button
            onClick={fetchWallets}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/50 border-b border-gray-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Token</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Network</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Address</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {wallets.map((wallet) => (
                <tr key={wallet.id} className="hover:bg-gray-700/20 transition-colors">
                  <td className="px-6 py-4 text-gray-300">{wallet.token}</td>
                  <td className="px-6 py-4 text-gray-400">{wallet.network}</td>
                  <td className="px-6 py-4">
                    <input
                      type="text"
                      value={edits[wallet.id] || ''}
                      onChange={(e) => setEdits(prev => ({ ...prev, [wallet.id]: e.target.value }))}
                      className="w-full bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => toggleActive(wallet.id)}
                      className={`px-3 py-1 text-xs rounded-full transition-colors ${wallet.is_active ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-gray-600/30 text-gray-400 border border-gray-600'}`}
                    >
                      {wallet.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50"
          >
            <Save size={18} />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}