'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@app-lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { 
  ArrowLeft, Copy, Check, Clock, AlertCircle, CheckCircle, Loader2, 
  PlusCircle, Wallet, Send, Hash 
} from 'lucide-react';
import Link from 'next/link';

interface Deposit {
  id: string;
  amount: number;
  txHash: string;
  status: 'pending' | 'completed' | 'failed';
  confirmations: number;
  requiredConfirmations: number;
  createdAt: string;
  isCompleted: boolean;
}

type Token = 'USDT' | 'ETH' | 'BTC';
type Network = 'ERC20' | 'BSC' | 'TRX' | 'Ethereum' | 'Bitcoin';

interface WalletInfo {
  id: string;
  token: Token;
  network: Network;
  address: string;
  is_active: boolean;
}

export default function DepositPage() {
  const router = useRouter();

  // ─── Automatic Deposit State ───
  const [loading, setLoading] = useState(true);
  const [depositAddress, setDepositAddress] = useState('');
  const [copied, setCopied] = useState(false);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [countdown, setCountdown] = useState(3600);
  const [timerActive, setTimerActive] = useState(false);

  // ─── Manual Deposit State ───
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [selectedToken, setSelectedToken] = useState<Token>('USDT');
  const [selectedNetwork, setSelectedNetwork] = useState<Network>('ERC20');
  const [amount, setAmount] = useState('');
  const [txHash, setTxHash] = useState(''); // ✅ added
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [manualCopied, setManualCopied] = useState(false);

  // ─── Fetch automatic deposit address ───
  useEffect(() => {
    const fetchDepositAddress = async () => {
      console.log('[DepositPage] 🔍 Fetching deposit address...');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.log('[DepositPage] ❌ No session found, redirecting to login');
        router.push('/login');
        return;
      }

      try {
        const res = await fetch('/api/user/deposit-address');
        if (!res.ok) {
          const error = await res.json();
          console.error('[DepositPage] ❌ Failed to fetch deposit address:', error);
          setLoading(false);
          return;
        }
        const data = await res.json();
        setDepositAddress(data.depositAddress);
        setTimerActive(true);
      } catch (err) {
        console.error('[DepositPage] ❌ Error fetching deposit address:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchDepositAddress();
  }, [router]);

  // ─── Fetch admin wallets for manual deposit ───
  useEffect(() => {
    const fetchWallets = async () => {
      try {
        const res = await fetch('/api/admin/wallets');
        if (res.ok) {
          const data = await res.json();
          setWallets(data.filter((w: WalletInfo) => w.is_active));
        }
      } catch (err) {
        console.error('Failed to fetch wallets:', err);
      }
    };
    fetchWallets();
  }, []);

  // ─── Fetch deposit status (automatic) ───
  const fetchDepositStatus = async () => {
    try {
      const res = await fetch('/api/user/deposit-status');
      if (!res.ok) {
        if (res.status !== 401) {
          const errorText = await res.text();
          console.error(`[DepositPage] ❌ Status API error: ${res.status} - ${errorText}`);
        }
        return;
      }
      const data = await res.json();
      setDeposits(data.deposits || []);
    } catch (err: any) {
      console.error('[DepositPage] ❌ Error fetching deposit status:', err);
    }
  };

  useEffect(() => {
    if (loading) return;
    let isMounted = true;
    let timeoutId: NodeJS.Timeout;

    const poll = async () => {
      if (!isMounted) return;
      await fetchDepositStatus();
      if (isMounted) {
        timeoutId = setTimeout(poll, 10000);
      }
    };

    poll();
    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [loading]);

  // ─── Countdown timer ───
  useEffect(() => {
    if (!timerActive) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 3600;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [timerActive]);

  // ─── Helpers ───
  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const copyManualAddress = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setManualCopied(true);
    setTimeout(() => setManualCopied(false), 3000);
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // ─── Manual Deposit Helpers ───
  const getAvailableNetworks = (token: Token): Network[] => {
    const map: Record<Token, Network[]> = {
      USDT: ['ERC20', 'BSC', 'TRX'],
      ETH: ['Ethereum'],
      BTC: ['Bitcoin'],
    };
    return map[token] || [];
  };

  const getWalletAddress = (token: Token, network: Network): string => {
    const wallet = wallets.find(w => w.token === token && w.network === network);
    return wallet?.address || '';
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!amount || parseFloat(amount) <= 0) {
      setMessage({ text: 'Please enter a valid amount.', type: 'error' });
      return;
    }
    if (!txHash || txHash.trim().length < 10) {
      setMessage({ text: 'Please enter a valid transaction hash (at least 10 characters).', type: 'error' });
      return;
    }
    const walletAddress = getWalletAddress(selectedToken, selectedNetwork);
    if (!walletAddress) {
      setMessage({ text: 'No wallet address configured for this token/network. Please contact support.', type: 'error' });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      const res = await fetch('/api/user/deposit-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: selectedToken,
          network: selectedNetwork,
          amount: parseFloat(amount),
          walletAddress,
          tx_hash: txHash.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ text: '✅ Deposit request submitted! Admin will verify your transaction.', type: 'success' });
        setAmount('');
        setTxHash('');
      } else {
        setMessage({ text: `❌ Error: ${data.error || 'Failed to submit request'}`, type: 'error' });
      }
    } catch {
      setMessage({ text: '❌ Network error. Please try again.', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="text-gray-400 p-6">Loading deposit info...</div>;
  }

  const manualWalletAddress = getWalletAddress(selectedToken, selectedNetwork);

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link href="/dashboard" className="text-gray-400 hover:text-white transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-2xl font-bold text-white">Add Funds</h1>
      </div>

      {/* ─── AUTOMATIC DEPOSIT SECTION ─── */}
      <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 space-y-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-gray-300 text-sm">Your Personal Deposit Address</p>
            <div className="flex items-center gap-2 mt-2">
              <code className="text-white text-sm font-mono bg-gray-900/50 px-3 py-2 rounded-lg border border-gray-700 break-all">
                {depositAddress}
              </code>
              <button
                onClick={() => copyToClipboard(depositAddress)}
                className="flex items-center gap-1 px-3 py-2 bg-gray-700/50 hover:bg-gray-600/50 rounded-lg transition-colors text-sm text-gray-300 shadow-sm"
              >
                {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock size={16} className="text-yellow-400" />
            <span className="text-gray-300 font-mono">{formatTime(countdown)}</span>
          </div>
        </div>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-sm text-blue-400">
          <span className="font-medium">ℹ️ Address is permanent</span> – the timer is a visual guide; you can deposit at any time.
        </div>
      </div>

      {/* Deposit History */}
      <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-6 space-y-4 mb-6">
        <h2 className="text-lg font-semibold text-white">Deposit History</h2>
        {deposits.length === 0 ? (
          <p className="text-gray-400 text-sm">No deposits detected yet.</p>
        ) : (
          <div className="space-y-3">
            {deposits.map((dep) => (
              <div
                key={dep.id}
                className="bg-gray-900/50 rounded-xl p-4 border border-gray-700 flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    {dep.status === 'completed' ? (
                      <CheckCircle size={16} className="text-green-400" />
                    ) : dep.status === 'pending' ? (
                      <Loader2 size={16} className="text-yellow-400 animate-spin" />
                    ) : (
                      <AlertCircle size={16} className="text-red-400" />
                    )}
                    <span className="text-gray-200 font-medium">${dep.amount.toFixed(2)}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 font-mono">
                    {dep.txHash.slice(0, 10)}…{dep.txHash.slice(-8)}
                  </div>
                </div>
                <div className="text-right">
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${
                      dep.status === 'completed'
                        ? 'bg-green-500/20 text-green-400'
                        : dep.status === 'pending'
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'bg-red-500/20 text-red-400'
                    }`}
                  >
                    {dep.status}
                  </span>
                  {dep.status === 'pending' && (
                    <div className="mt-1 text-xs text-gray-400">
                      {dep.confirmations}/{dep.requiredConfirmations} confirmations
                    </div>
                  )}
                  {dep.status === 'pending' && dep.confirmations < dep.requiredConfirmations && (
                    <div className="mt-1 w-24 h-1.5 bg-gray-700 rounded-full overflow-hidden ml-auto">
                      <div
                        className="h-full bg-yellow-400 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(100, (dep.confirmations / dep.requiredConfirmations) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── MANUAL DEPOSIT SECTION (Recommended) ─── */}
      <div className="bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur-sm border border-blue-500/30 rounded-2xl p-6 space-y-6 shadow-lg shadow-blue-500/5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/20 rounded-lg">
            <Wallet size={20} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Manual Deposit <span className="text-xs text-blue-400 font-medium ml-2 bg-blue-500/20 px-2 py-0.5 rounded-full">Recommended</span></h2>
            <p className="text-gray-400 text-sm">Request a deposit via USDT, ETH, or BTC. Admin will approve after confirmation.</p>
          </div>
        </div>

        <form onSubmit={handleManualSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Token</label>
              <select
                value={selectedToken}
                onChange={(e) => {
                  const token = e.target.value as Token;
                  setSelectedToken(token);
                  const networks = getAvailableNetworks(token);
                  setSelectedNetwork(networks[0] || 'ERC20');
                }}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="USDT">USDT</option>
                <option value="ETH">Ethereum (ETH)</option>
                <option value="BTC">Bitcoin (BTC)</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Network</label>
              <select
                value={selectedNetwork}
                onChange={(e) => setSelectedNetwork(e.target.value as Network)}
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {getAvailableNetworks(selectedToken).map((net) => (
                  <option key={net} value={net}>{net}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-gray-300 text-sm font-medium mb-1">Amount (USD)</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g., 100"
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          {/* ✅ Transaction Hash input */}
          <div>
            <label className="block text-gray-300 text-sm font-medium mb-1 flex items-center gap-1">
              <Hash size={16} className="text-gray-400" />
              Transaction Hash (TXID) <span className="text-red-400 text-xs">*</span>
            </label>
            <input
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="e.g., 0x1234... or BTC txid"
              className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
              required
            />
            <p className="text-gray-500 text-xs mt-1">Paste the transaction hash from your wallet after sending the funds.</p>
          </div>

          {manualWalletAddress && (
            <div className="bg-gray-900/50 rounded-xl p-4 border border-gray-700">
              <p className="text-gray-400 text-xs mb-1">Send funds to this address:</p>
              <div className="flex items-center justify-between gap-2">
                <code className="text-white text-sm font-mono break-all">{manualWalletAddress}</code>
                <button
                  type="button"
                  onClick={() => copyManualAddress(manualWalletAddress)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700/50 hover:bg-gray-600/50 rounded-lg transition-colors text-sm text-gray-300"
                >
                  {manualCopied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                  {manualCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {message && (
            <div className={`p-3 rounded-xl text-sm ${message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
              {message.text}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !manualWalletAddress}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 text-white px-6 py-3 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20"
          >
            {submitting ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Send size={18} />
                Submit Deposit Request
              </>
            )}
          </button>
        </form>
      </div>

      {/* Info */}
      <div className="mt-6 bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-4 text-xs text-gray-400 space-y-1">
        <p>• Automatic deposits: credited after <span className="text-white font-medium">6 confirmations</span> (~1-2 minutes).</p>
        <p>• Manual deposit requests: reviewed by admin, usually within 20 minutes.</p>
          <p>
            • Minimum deposit: <span className="text-white font-medium">$50</span> equivalent – 
            <span className="text-blue-400"> enough to power RTX 5090 GPU renting. Can generate upto 50 Traps</span>
          </p>
        <p>• Supported networks: BSC, Ethereum, Polygon, TRX, Bitcoin.</p>
      </div>
    </div>
  );
}