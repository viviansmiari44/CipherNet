'use client';

import { useState, useEffect } from 'react';
import { Zap, ChevronDown } from 'lucide-react';

interface Batch {
    generation_batch_id: string;
    total_traps: number;
    never_dusted: number;
    already_dusted: number;
    generated_at: string;
}

interface Stats {
    total: number;
    neverDusted: number;
    alreadyDusted: number;
}

interface DustFilterButtonProps {
    campaignId: string;
    disabled?: boolean;
}

export default function DustFilterButton({ campaignId, disabled }: DustFilterButtonProps) {
    const [filter, setFilter] = useState<'never_dusted' | 'batch' | 'all'>('never_dusted');
    const [selectedBatch, setSelectedBatch] = useState<string>('');
    const [batches, setBatches] = useState<Batch[]>([]);
    const [stats, setStats] = useState<Stats>({ total: 0, neverDusted: 0, alreadyDusted: 0 });
    const [isOpen, setIsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [quantity, setQuantity] = useState<number>(100);  // 🆕 Default to 100 traps

    useEffect(() => {
        fetchStats();
        fetchBatches();
    }, [campaignId]);

    async function fetchStats() {
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/dust-stats`);
            if (res.ok) {
                const data = await res.json();
                setStats(data);
            }
        } catch (err) {
            console.error('Failed to fetch stats:', err);
        }
    }

    async function fetchBatches() {
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/batches`);
            if (res.ok) {
                const data = await res.json();
                setBatches(data);
            }
        } catch (err) {
            console.error('Failed to fetch batches:', err);
        }
    }

    async function handleDust() {
        if (filter === 'batch' && !selectedBatch) {
            alert('Please select a batch');
            return;
        }

        if (quantity < 1 || quantity > 500) {
            alert('Quantity must be between 1 and 500');
            return;
        }

        setIsLoading(true);
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/dust`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filter,
                    batchId: filter === 'batch' ? selectedBatch : undefined,
                    quantity,  // 🆕 Pass quantity to API
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                alert(data.error || 'Failed to start dusting');
                return;
            }

            const originalCount = data.originalCount || data.trapCount;
            const message = data.trapCount < originalCount
                ? `Started dusting ${data.trapCount} of ${originalCount} traps. Job ID: ${data.jobId}`
                : `Started dusting ${data.trapCount} traps. Job ID: ${data.jobId}`;
            alert(message);
            setIsOpen(false);
        } catch (err) {
            console.error('Dust error:', err);
            alert('Failed to start dusting');
        } finally {
            setIsLoading(false);
        }
    }

    const getButtonText = () => {
        if (filter === 'never_dusted') return `🟢 Dust Never Dusted (${stats.neverDusted})`;
        if (filter === 'batch') return `📦 Dust Selected Batch`;
        return `🟡 Dust All (${stats.total})`;
    };

    return (
        <div className="relative inline-block">
            <button
                onClick={() => setIsOpen(!isOpen)}
                disabled={disabled || isLoading}
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
            >
                <Zap size={16} />
                {getButtonText()}
                <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute z-50 mt-2 w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 space-y-4">
                    <div className="text-sm text-gray-300">
                        <div className="flex justify-between mb-2">
                            <span>Total Traps:</span>
                            <span className="font-semibold text-white">{stats.total}</span>
                        </div>
                        <div className="flex justify-between mb-2">
                            <span>Never Dusted:</span>
                            <span className="font-semibold text-green-400">{stats.neverDusted}</span>
                        </div>
                        <div className="flex justify-between">
                            <span>Already Dusted:</span>
                            <span className="font-semibold text-yellow-400">{stats.alreadyDusted}</span>
                        </div>
                    </div>

                    <div className="border-t border-gray-700 pt-4 space-y-2">
                        <label className="block text-sm font-medium text-gray-300">Filter:</label>

                        <button
                            onClick={() => setFilter('never_dusted')}
                            className={`w-full px-3 py-2 rounded text-sm text-left ${filter === 'never_dusted'
                                ? 'bg-green-600 text-white'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                }`}
                        >
                            🟢 Never Dusted ({stats.neverDusted})
                        </button>

                        <button
                            onClick={() => setFilter('all')}
                            className={`w-full px-3 py-2 rounded text-sm text-left ${filter === 'all'
                                ? 'bg-yellow-600 text-white'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                }`}
                        >
                            🟡 All Traps ({stats.total})
                        </button>

                        <button
                            onClick={() => setFilter('batch')}
                            className={`w-full px-3 py-2 rounded text-sm text-left ${filter === 'batch'
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                }`}
                        >
                            📦 By Generation Batch
                        </button>
                    </div>

                    {filter === 'batch' && (
                        <div className="border-t border-gray-700 pt-4">
                            <select
                                value={selectedBatch}
                                onChange={(e) => setSelectedBatch(e.target.value)}
                                className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white"
                            >
                                <option value="">Select a batch...</option>
                                {batches.map((b) => (
                                    <option key={b.generation_batch_id} value={b.generation_batch_id}>
                                        {new Date(b.generated_at).toLocaleDateString()} — {b.total_traps} traps
                                        ({b.never_dusted} never dusted)
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* 🆕 Quantity Input */}
                    <div className="border-t border-gray-700 pt-4">
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Max Traps to Dust:
                        </label>
                        <input
                            type="number"
                            min="1"
                            max="500"
                            value={quantity}
                            onChange={(e) => setQuantity(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
                            className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm text-white"
                            placeholder="100"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                            Limit: 1-500 traps per batch (prevents errors with large datasets)
                        </p>
                    </div>

                    <button
                        onClick={handleDust}
                        disabled={isLoading || (filter === 'batch' && !selectedBatch)}
                        className="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                        {isLoading ? 'Starting...' : 'Start Dusting'}
                    </button>
                </div>
            )}
        </div>
    );
}