'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@app-lib/supabaseClient';

export default function NewCampaignPage() {
  const router = useRouter();
  const [chain, setChain] = useState('bsc');
  const [fundingKey, setFundingKey] = useState('');
  const [safeWallet, setSafeWallet] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain,
        fundingPrivateKey: fundingKey,
        safeWalletAddress: safeWallet,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || 'Failed to create campaign');
      setLoading(false);
      return;
    }

    router.push('/dashboard');
  };

  return (
    <div className="max-w-md mx-auto">
      <h2 className="text-2xl font-semibold mb-6">Create a New Campaign</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Chain</label>
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            className="mt-1 block w-full border border-gray-300 rounded-md p-2"
          >
            <option value="ethereum">Ethereum</option>
            <option value="bsc">Binance Smart Chain</option>
            <option value="polygon">Polygon</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Funding Private Key</label>
          <input
            type="text"
            value={fundingKey}
            onChange={(e) => setFundingKey(e.target.value)}
            required
            className="mt-1 block w-full border border-gray-300 rounded-md p-2"
            placeholder="0x..."
          />
          <p className="text-xs text-gray-500 mt-1">This key will be encrypted and stored securely.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Safe Wallet Address</label>
          <input
            type="text"
            value={safeWallet}
            onChange={(e) => setSafeWallet(e.target.value)}
            required
            className="mt-1 block w-full border border-gray-300 rounded-md p-2"
            placeholder="0x..."
          />
          <p className="text-xs text-gray-500 mt-1">Funds swept will be sent here (your 75% share).</p>
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'Creating...' : 'Create Campaign'}
        </button>
      </form>
    </div>
  );
}