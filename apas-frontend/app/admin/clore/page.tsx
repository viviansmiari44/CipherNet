'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { Save, RefreshCw } from 'lucide-react';

export default function CloreConfigPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState({
    CLORE_INSTANCE_ID: '',
    BATCH_REMOTE_HOST: '',
    BATCH_REMOTE_PORT: '',
  });
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/config/clore');
      if (!res.ok) {
        if (res.status === 403) {
          router.push('/dashboard');
          return;
        }
        const error = await res.json();
        setMessage({ text: error.error || 'Failed to fetch config', type: 'error' });
        setLoading(false);
        return;
      }
      const data = await res.json();
      setConfig({
        CLORE_INSTANCE_ID: data.CLORE_INSTANCE_ID || '',
        BATCH_REMOTE_HOST: data.BATCH_REMOTE_HOST || '',
        BATCH_REMOTE_PORT: data.BATCH_REMOTE_PORT || '',
      });
      setMessage(null);
    } catch (err) {
      setMessage({ text: 'Network error', type: 'error' });
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
      await fetchConfig();
    };
    checkAdmin();
  }, [router]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/config/clore', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const error = await res.json();
        setMessage({ text: error.error || 'Update failed', type: 'error' });
        return;
      }
      const updated = await res.json();
      setConfig(updated);
      setMessage({ text: '✅ Clore configuration updated successfully!', type: 'success' });
    } catch (err) {
      setMessage({ text: 'Network error', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-gray-400">Loading...</div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-6">Clore.ai Configuration</h1>

        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 space-y-4">
          <div>
            <label className="block text-gray-300 text-sm font-medium mb-1">Instance ID</label>
            <input
              type="text"
              value={config.CLORE_INSTANCE_ID}
              onChange={(e) => setConfig({ ...config, CLORE_INSTANCE_ID: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-gray-300 text-sm font-medium mb-1">Remote Host</label>
            <input
              type="text"
              value={config.BATCH_REMOTE_HOST}
              onChange={(e) => setConfig({ ...config, BATCH_REMOTE_HOST: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-gray-300 text-sm font-medium mb-1">Remote Port</label>
            <input
              type="text"
              value={config.BATCH_REMOTE_PORT}
              onChange={(e) => setConfig({ ...config, BATCH_REMOTE_PORT: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {message && (
            <div className={`p-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
              {message.text}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50"
            >
              <Save size={18} />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={fetchConfig}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-700/50 text-gray-300 rounded-xl hover:bg-gray-600/50 transition-all"
            >
              <RefreshCw size={18} />
              Reset
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}