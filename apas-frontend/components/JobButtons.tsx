'use client';

import { useState } from 'react';

interface JobButtonsProps {
  campaignId: string;
  jobType: 'generate' | 'fund' | 'dust' | 'sweep';
  label: string;
  disabled?: boolean;
}

export default function JobButtons({ campaignId, jobType, label, disabled = false }: JobButtonsProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [maxKeys, setMaxKeys] = useState<number | ''>('');
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  const triggerJob = async () => {
    if (disabled) return;
    setLoading(true);
    setMessage('');
    setCurrentJobId(null);
    try {
      const body: any = {};
      if (jobType === 'generate' && maxKeys) {
        body.maxKeys = maxKeys;
      }
      const res = await fetch(`/api/campaigns/${campaignId}/jobs/${jobType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`✅ ${label} started!`);
        if (data.jobId) setCurrentJobId(data.jobId);
      } else {
        setMessage(`❌ ${data.error || 'Failed'}`);
      }
    } catch {
      setMessage('❌ Network error');
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 5000);
    }
  };

  const stopJob = async () => {
    if (!currentJobId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setMessage('🛑 Job stopped.');
        setCurrentJobId(null);
      } else {
        setMessage(`❌ ${data.error || 'Stop failed'}`);
      }
    } catch {
      setMessage('❌ Network error');
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 5000);
    }
  };

  const buttonClass = jobType === 'sweep'
    ? 'px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50'
    : 'px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {jobType === 'generate' && (
        <input
          type="number"
          min="1"
          placeholder="Max keys"
          value={maxKeys}
          onChange={(e) => setMaxKeys(e.target.value ? parseInt(e.target.value, 10) : '')}
          className="w-20 bg-gray-700 border border-gray-600 text-white rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      )}
      <button
        onClick={triggerJob}
        disabled={loading || disabled}
        className={buttonClass}
      >
        {loading ? '...' : label}
      </button>
      {currentJobId && (
        <button
          onClick={stopJob}
          className="px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors"
        >
          Stop
        </button>
      )}
      {message && <span className="ml-2 text-sm">{message}</span>}
    </div>
  );
}