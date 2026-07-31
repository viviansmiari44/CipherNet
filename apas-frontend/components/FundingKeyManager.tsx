'use client';

import { useState, useEffect } from 'react';
import { Eye, EyeOff, Copy, Check, Save, RefreshCw } from 'lucide-react';

export default function FundingKeyManager({ campaignId }: { campaignId: string }) {
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchKey = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/funding-key`);
      if (!res.ok) {
        const err = await res.json();
        setMessage({ text: err.error || 'Failed to fetch funding key', type: 'error' });
        return;
      }
      const data = await res.json();
      setPrivateKey(data.privateKey);
      setNewKey(data.privateKey || '');
    } catch {
      setMessage({ text: 'Network error', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKey();
  }, [campaignId]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const handleSave = async () => {
    if (!newKey || !newKey.startsWith('0x')) {
      setMessage({ text: 'Private key must start with 0x', type: 'error' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/funding-key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateKey: newKey }),
      });
      if (!res.ok) {
        const err = await res.json();
        setMessage({ text: err.error || 'Update failed', type: 'error' });
        return;
      }
      setPrivateKey(newKey);
      setEditing(false);
      setMessage({ text: 'Funding key updated successfully!', type: 'success' });
    } catch {
      setMessage({ text: 'Network error', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setNewKey(privateKey || '');
    setEditing(false);
    setMessage(null);
  };

  if (loading) return <div className="text-gray-400">Loading funding key...</div>;

  const displayKey = showKey ? privateKey : (privateKey ? '0x' + '•'.repeat(64) : 'Not set');

  return (
    <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 mb-6">
      <h3 className="text-white font-semibold text-lg mb-3">Funding Wallet Private Key</h3>
      <p className="text-gray-400 text-sm mb-4">
        This private key is used to fund traps. Keep it secure.
      </p>

      {!editing ? (
        // ─── View Mode ───
        <div>
          <div className="flex items-center gap-2 bg-gray-900/50 border border-gray-700 rounded-xl p-3">
            <code className="text-white text-sm font-mono break-all flex-1">
              {displayKey}
            </code>
            <button
              onClick={() => setShowKey(!showKey)}
              className="p-1.5 hover:bg-gray-700/50 rounded transition-colors text-gray-400 hover:text-white"
              title={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
            {privateKey && (
              <button
                onClick={() => copyToClipboard(privateKey)}
                className="p-1.5 hover:bg-gray-700/50 rounded transition-colors text-gray-400 hover:text-white"
                title="Copy key"
              >
                {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
              </button>
            )}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-1.5 bg-blue-600/70 text-white text-sm rounded-lg hover:bg-blue-500/70 transition-all"
            >
              Edit Key
            </button>
            <button
              onClick={fetchKey}
              className="px-4 py-1.5 bg-gray-600/50 text-gray-300 text-sm rounded-lg hover:bg-gray-500/50 transition-all flex items-center gap-1"
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </div>
      ) : (
        // ─── Edit Mode ───
        <div>
          <div className="bg-gray-900/50 border border-gray-700 rounded-xl p-3">
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="0x..."
              className="w-full bg-transparent border-none text-white text-sm font-mono focus:outline-none"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 bg-green-600/70 text-white text-sm rounded-lg hover:bg-green-500/70 transition-all disabled:opacity-50 flex items-center gap-1"
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 bg-gray-600/50 text-gray-300 text-sm rounded-lg hover:bg-gray-500/50 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && (
        <div className={`mt-3 text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}