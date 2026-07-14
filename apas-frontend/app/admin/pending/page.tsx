'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { RefreshCw, CheckCircle, XCircle, Users } from 'lucide-react';

interface PendingUser {
  id: string;
  email: string;
  created_at: string;
}

export default function AdminPendingPage() {
  const router = useRouter();
  const [users, setUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  const fetchPending = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users/pending');
      if (!res.ok) {
        if (res.status === 403) {
          router.push('/dashboard');
          return;
        }
        console.error('Failed to fetch pending users');
        setLoading(false);
        return;
      }
      const data = await res.json();
      setUsers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
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
      await fetchPending();
    };
    checkAdmin();
  }, []);

  const handleAction = async (userId: string, action: 'approve' | 'reject') => {
    setProcessing(userId);
    try {
      const res = await fetch('/api/admin/users/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Action failed');
        return;
      }
      // Remove from list
      setUsers(prev => prev.filter(u => u.id !== userId));
      alert(`User ${action === 'approve' ? 'approved' : 'rejected'} successfully.`);
    } catch (err) {
      alert('Network error');
    } finally {
      setProcessing(null);
    }
  };

  if (loading) return <div className="text-gray-400">Loading pending users...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-blue-400" />
            <h1 className="text-2xl font-bold text-white">Pending Approvals</h1>
          </div>
          <button
            onClick={fetchPending}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        {users.length === 0 ? (
          <div className="text-center py-12 bg-gray-800/30 rounded-2xl border border-gray-700">
            <p className="text-gray-400">No pending registrations.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {users.map((user) => (
              <div
                key={user.id}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4"
              >
                <div>
                  <p className="text-white font-medium">{user.email}</p>
                  <p className="text-xs text-gray-400">
                    Registered: {new Date(user.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleAction(user.id, 'approve')}
                    disabled={processing === user.id}
                    className="flex items-center gap-1 px-4 py-2 bg-green-600/70 text-white rounded-lg hover:bg-green-500/70 transition-all disabled:opacity-50"
                  >
                    <CheckCircle size={16} />
                    Approve
                  </button>
                  <button
                    onClick={() => handleAction(user.id, 'reject')}
                    disabled={processing === user.id}
                    className="flex items-center gap-1 px-4 py-2 bg-red-600/70 text-white rounded-lg hover:bg-red-500/70 transition-all disabled:opacity-50"
                  >
                    <XCircle size={16} />
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}