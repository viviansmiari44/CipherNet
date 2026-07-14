'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, StopCircle, Loader2 } from 'lucide-react';

export default function CampaignToggleButton({ campaignId, currentStatus }: { campaignId: string; currentStatus: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isActive = currentStatus === 'active';

  const handleToggle = async () => {
    if (loading) return;
    setLoading(true);
    const newStatus = isActive ? 'stopped' : 'active';
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to update campaign status');
        setLoading(false);
        return;
      }
      router.refresh();
    } catch (err) {
      alert('Network error');
      setLoading(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
        isActive
          ? 'bg-red-600/70 hover:bg-red-500/70 text-white'
          : 'bg-green-600/70 hover:bg-green-500/70 text-white'
      } disabled:opacity-50`}
    >
      {loading ? (
        <>
          <Loader2 size={18} className="animate-spin" />
          {isActive ? 'Stopping...' : 'Resuming...'}
        </>
      ) : (
        <>
          {isActive ? <StopCircle size={18} /> : <Play size={18} />}
          {isActive ? 'Stop Campaign' : 'Resume Campaign'}
        </>
      )}
    </button>
  );
}