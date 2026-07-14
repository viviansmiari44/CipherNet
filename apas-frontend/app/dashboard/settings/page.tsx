'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { Save, ArrowLeft, CheckCircle, AlertCircle } from 'lucide-react';
import Link from 'next/link';

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');

  const fetchSettings = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.push('/login');
      return;
    }

    const res = await fetch('/api/user/settings');
    if (!res.ok) {
      const error = await res.json();
      console.error('Failed to fetch settings:', error);
      setLoading(false);
      return;
    }
    const data = await res.json();
    setTelegramToken(data.telegram_bot_token || '');
    setTelegramChatId(data.telegram_chat_id || '');
    setLoading(false);
  };

  useEffect(() => {
    fetchSettings();
  }, [router]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    const res = await fetch('/api/user/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_bot_token: telegramToken.trim() || null,
        telegram_chat_id: telegramChatId.trim() || null,
      }),
    });

    if (!res.ok) {
      const error = await res.json();
      setMessage({ text: 'Failed to save: ' + error.error, type: 'error' });
    } else {
      const data = await res.json();
      setMessage({ text: 'Settings saved successfully!', type: 'success' });
      // Update local state with returned values
      setTelegramToken(data.telegram_bot_token || '');
      setTelegramChatId(data.telegram_chat_id || '');
    }
    setSaving(false);
  };

  if (loading) return <div className="text-gray-400">Loading settings...</div>;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <Link
          href="/dashboard"
          className="text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Telegram Bot Token
          </label>
          <input
            type="text"
            value={telegramToken}
            onChange={(e) => setTelegramToken(e.target.value)}
            placeholder="e.g., 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Get one from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">@BotFather</a> on Telegram.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Telegram Chat ID
          </label>
          <input
            type="text"
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
            placeholder="e.g., 123456789"
            className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Your personal chat ID (send a message to your bot and check updates).
          </p>
        </div>

        {message && (
          <div className={`flex items-center gap-2 text-sm p-3 rounded-xl ${
            message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
          }`}>
            {message.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
            {message.text}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white px-6 py-3 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20"
        >
          <Save size={18} />
          {saving ? 'Saving...' : 'Save Settings'}
        </button>

        <div className="text-xs text-gray-500 text-center">
          Your current token: {telegramToken ? '✅ Set' : '❌ Not set'} &nbsp;|&nbsp; Chat ID: {telegramChatId || 'Not set'}
        </div>
      </div>
    </div>
  );
}