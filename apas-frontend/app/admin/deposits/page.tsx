'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { RefreshCw, CheckCircle, XCircle, Clock, Copy, Check } from 'lucide-react'; // ✅ added Copy, Check

interface DepositRequest {
  id: string;
  user_id: string;
  token: string;
  network: string;
  amount: number;
  wallet_address: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  tx_hash: string | null;
  admin_notes: string | null;
  created_at: string;
  users: { email: string };
}

export default function AdminDepositsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<DepositRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected' | 'completed'>('pending');
  const [refreshing, setRefreshing] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [txHash, setTxHash] = useState('');
  const [copiedTx, setCopiedTx] = useState<string | null>(null); // ✅ track copied tx

  const fetchRequests = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch(`/api/admin/deposit-requests?status=${filter}`);
      if (!res.ok) {
        if (res.status === 403) {
          router.push('/dashboard');
          return;
        }
        console.error('Failed to fetch requests');
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const data = await res.json();
      setRequests(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      await fetchRequests(true);
    };
    checkAdmin();
  }, [filter]);

  const updateRequest = async (id: string, status: string, notes?: string, txHashVal?: string) => {
    setProcessingId(id);
    try {
      const res = await fetch(`/api/admin/deposit-requests/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, admin_notes: notes || null, tx_hash: txHashVal || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Update failed');
        return;
      }
      await fetchRequests(false);
      setNote('');
      setTxHash('');
    } catch (err) {
      alert('Network error');
    } finally {
      setProcessingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    const map = {
      pending: <span className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-2 py-0.5 rounded-full text-xs">Pending</span>,
      approved: <span className="bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full text-xs">Approved</span>,
      rejected: <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-full text-xs">Rejected</span>,
      completed: <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full text-xs">Completed</span>,
    };
    return map[status as keyof typeof map] || status;
  };

  // ── Copy helper ──
  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedTx(id);
    setTimeout(() => setCopiedTx(null), 3000);
  };

  if (loading) return <div className="text-gray-400">Loading deposit requests...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h1 className="text-2xl font-bold text-white">Deposit Requests</h1>
          <div className="flex items-center gap-4">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
              className="bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-1.5 text-sm"
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="completed">Completed</option>
            </select>
            <button
              onClick={() => fetchRequests(false)}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        <div className="grid gap-4">
          {requests.length === 0 ? (
            <div className="text-center py-12 bg-gray-800/30 rounded-2xl border border-gray-700">
              <p className="text-gray-400">No deposit requests found.</p>
            </div>
          ) : (
            requests.map((req) => (
              <div
                key={req.id}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-5 hover:border-gray-600 transition-all"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-medium">{req.users?.email || 'Unknown'}</span>
                      <span className="text-gray-400 text-sm">·</span>
                      <span className="text-white font-mono text-sm">{req.token}</span>
                      <span className="text-gray-400 text-sm">({req.network})</span>
                      <span className="text-white font-mono text-sm">${req.amount.toFixed(2)}</span>
                      {getStatusBadge(req.status)}
                    </div>
                    <div className="mt-1 text-xs text-gray-400">
                      <span>Requested: {new Date(req.created_at).toLocaleString()}</span>
                      {req.tx_hash && (
                        <span className="ml-4 flex items-center gap-1">
                          Tx: <code className="text-blue-400">{req.tx_hash.slice(0, 12)}…</code>
                          <button
                            onClick={() => copyToClipboard(req.tx_hash!, req.id)}
                            className="p-0.5 hover:bg-gray-600/50 rounded transition-colors"
                            title="Copy transaction hash"
                          >
                            {copiedTx === req.id ? (
                              <Check size={14} className="text-green-400" />
                            ) : (
                              <Copy size={14} className="text-gray-400 hover:text-white" />
                            )}
                          </button>
                        </span>
                      )}
                    </div>
                    {req.admin_notes && (
                      <div className="mt-1 text-xs text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded">
                        Admin note: {req.admin_notes}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {req.status === 'pending' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        placeholder="Tx hash (optional)"
                        value={txHash}
                        onChange={(e) => setTxHash(e.target.value)}
                        className="bg-gray-700 border border-gray-600 text-white text-xs rounded-lg px-2 py-1 w-32 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <button
                        onClick={() => updateRequest(req.id, 'approved', note, txHash)}
                        disabled={processingId === req.id}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600/70 text-white text-sm rounded-lg hover:bg-green-500/70 transition-all"
                      >
                        <CheckCircle size={14} />
                        Approve
                      </button>
                      <button
                        onClick={() => updateRequest(req.id, 'rejected', note)}
                        disabled={processingId === req.id}
                        className="flex items-center gap-1 px-3 py-1.5 bg-red-600/70 text-white text-sm rounded-lg hover:bg-red-500/70 transition-all"
                      >
                        <XCircle size={14} />
                        Reject
                      </button>
                    </div>
                  )}
                  {req.status === 'approved' && (
                    <button
                      onClick={() => updateRequest(req.id, 'completed', req.admin_notes || undefined, req.tx_hash || undefined)}
                      disabled={processingId === req.id}
                      className="px-3 py-1.5 bg-blue-600/70 text-white text-sm rounded-lg hover:bg-blue-500/70 transition-all"
                    >
                      Mark Completed
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}