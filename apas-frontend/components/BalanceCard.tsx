'use client';

import { useEffect, useState } from 'react';
import { Coins, DollarSign, Wallet, TrendingUp } from 'lucide-react';

interface Balance {
  trapAddress: string;
  native: string; // ✅ string, not an object
  tokens: Record<string, string>; // ✅ string values
}

export default function BalanceCard({ campaignId }: { campaignId: string }) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBalances = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/balances`);
      const data = await res.json();
      if (data.balances && Array.isArray(data.balances)) {
        setBalances(data.balances);
      } else {
        setBalances([]);
      }
    } catch {
      setBalances([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBalances();
    const interval = setInterval(fetchBalances, 30000);
    return () => clearInterval(interval);
  }, [campaignId]);

  if (loading) return <div className="text-gray-400">Loading balances...</div>;
  if (!balances || balances.length === 0) return <p className="text-gray-400">No traps found.</p>;

  // Totals
  let totalNative = 0;
  const totalTokens: Record<string, number> = {};

  for (const b of balances) {
    totalNative += parseFloat(b.native || '0');
    for (const [symbol, value] of Object.entries(b.tokens || {})) {
      totalTokens[symbol] = (totalTokens[symbol] || 0) + parseFloat(value || '0');
    }
  }

  // Map token symbols to icons
  const getIcon = (symbol: string) => {
    const iconMap: Record<string, any> = {
      ETH: <Coins className="text-blue-400" size={20} />,
      BNB: <Coins className="text-yellow-400" size={20} />,
      MATIC: <Coins className="text-purple-400" size={20} />,
      USDC: <DollarSign className="text-green-400" size={20} />,
      USDT: <DollarSign className="text-green-400" size={20} />,
      DAI: <DollarSign className="text-blue-400" size={20} />,
    };
    return iconMap[symbol] || <Wallet className="text-gray-400" size={20} />;
  };

  // Build asset list (Native + tokens)
  const assetList = [
    { symbol: 'Native', amount: totalNative, icon: <TrendingUp className="text-blue-400" size={20} /> },
  ];
  for (const [symbol, amount] of Object.entries(totalTokens)) {
    assetList.push({ symbol, amount, icon: getIcon(symbol) });
  }

  // Filter out assets with zero balance (optional, but cleans up the UI)
  const filteredAssets = assetList.filter(item => item.amount > 0);

  return (
    <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 mb-6">
      <h3 className="text-white font-semibold text-lg mb-4">Balance Overview</h3>
      {filteredAssets.length === 0 ? (
        <p className="text-gray-400 text-sm">No positive balances found.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filteredAssets.map((item) => (
            <div
              key={item.symbol}
              className="bg-gray-900/50 rounded-xl p-4 border border-gray-700 flex flex-col items-start"
            >
              <div className="flex items-center gap-2 mb-1">
                {item.icon}
                <span className="text-gray-400 text-sm">{item.symbol}</span>
              </div>
              <p className="text-white text-xl font-bold">
                {item.amount.toFixed(6)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}