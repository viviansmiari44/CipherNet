'use client';

import { useEffect, useState } from 'react';
import { DollarSign, PlusCircle } from 'lucide-react';
import Link from 'next/link';

interface CreditsCardProps {
  compact?: boolean; // ✅ new prop
}

export default function CreditsCard({ compact = false }: CreditsCardProps) {
  const [credits, setCredits] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCredits = async () => {
    try {
      const res = await fetch('/api/user/balance');
      const data = await res.json();
      setCredits(data.credits || 0);
    } catch {
      setCredits(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCredits();
    const interval = setInterval(fetchCredits, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return compact ? (
      <div className="text-gray-400 text-sm">Loading...</div>
    ) : (
      <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
        <div className="text-gray-400">Loading credits...</div>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-gray-300">
        <DollarSign size={14} className="text-green-400" />
        <span className="font-medium">${(credits ?? 0).toFixed(2)}</span>
      </div>
    );
  }

  // Full version (default)
  return (
    <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-green-500/20 rounded-xl">
            <DollarSign className="text-green-400" size={24} />
          </div>
          <div>
            <p className="text-gray-400 text-sm">Available Credits</p>
            <p className="text-white text-2xl font-bold">
              ${(credits ?? 0).toFixed(2)}
            </p>
          </div>
        </div>
       <Link
        href="/dashboard/deposit" // ✅ changed from /dashboard/deposit (no campaign ID)
        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-lg hover:from-blue-500 hover:to-purple-500 transition-all shadow-lg shadow-blue-500/20"
        >
        <PlusCircle size={18} />
        Add Funds
        </Link>
      </div>
    </div>
  );
}