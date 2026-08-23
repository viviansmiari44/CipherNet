'use client';

import { useState } from 'react';
import { ShieldCheck, ShieldOff, Loader2 } from 'lucide-react';

export default function CounterPoisonToggle({
    campaignId,
    initialStatus
}: {
    campaignId: string;
    initialStatus: boolean;
}) {
    const [isEnabled, setIsEnabled] = useState(initialStatus ?? true);
    const [loading, setLoading] = useState(false);

    const handleToggle = async () => {
        setLoading(true);
        const newState = !isEnabled;
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/counter-poison-toggle`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ counter_poison_enabled: newState }),
            });
            if (res.ok) {
                setIsEnabled(newState);
            } else {
                console.error('Failed to toggle counter-poison');
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            onClick={handleToggle}
            disabled={loading}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all text-sm ${isEnabled
                    ? 'bg-purple-600/20 text-purple-300 border border-purple-500/50 hover:bg-purple-600/30'
                    : 'bg-gray-700/50 text-gray-400 border border-gray-600 hover:bg-gray-600/50'
                }`}
        >
            {loading ? (
                <Loader2 className="animate-spin" size={16} />
            ) : isEnabled ? (
                <ShieldCheck size={16} />
            ) : (
                <ShieldOff size={16} />
            )}
            {isEnabled ? 'Counter-Poison: ON' : 'Counter-Poison: OFF'}
        </button>
    );
}