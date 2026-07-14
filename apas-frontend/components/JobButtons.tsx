'use client';

import { useState } from 'react';

interface JobButtonsProps {
  campaignId: string;
  jobType: 'generate' | 'fund' | 'dust' | 'sweep';
  label: string;
  disabled?: boolean; // ✅ added
}

export default function JobButtons({ campaignId, jobType, label, disabled = false }: JobButtonsProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const triggerJob = async () => {
    if (disabled) return;
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/jobs/${jobType}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`✅ ${label} started!`);
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

  // Different color for sweep button
  const buttonClass = jobType === 'sweep'
    ? 'px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50'
    : 'px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50';

  return (
    <div>
      <button
        onClick={triggerJob}
        disabled={loading || disabled}
        className={buttonClass}
      >
        {loading ? '...' : label}
      </button>
      {message && <span className="ml-2 text-sm">{message}</span>}
    </div>
  );
}