'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface Job {
  id: string;
  type: 'generate' | 'fund' | 'dust' | 'sweep'; // added 'sweep'
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  total: number;
  message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export default function JobStatus({ campaignId }: { campaignId: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchJobs = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/jobs`);
      if (res.ok) {
        const data = await res.json();
        setJobs(data);
      }
    } catch (e) {
      console.error('Failed to fetch jobs:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchJobs(true);
    const interval = setInterval(() => fetchJobs(false), 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, [campaignId]);

  if (loading) return <div className="text-gray-400">Loading jobs...</div>;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      case 'running':
        return 'text-blue-400 bg-blue-500/20 border-blue-500/30';
      case 'completed':
        return 'text-green-400 bg-green-500/20 border-green-500/30';
      case 'failed':
        return 'text-red-400 bg-red-500/20 border-red-500/30';
      default:
        return 'text-gray-400 bg-gray-500/20 border-gray-500/30';
    }
  };

  const getLabel = (type: string) => {
    switch (type) {
      case 'generate':
        return 'Vanity Generation';
      case 'fund':
        return 'Funding';
      case 'dust':
        return 'Dusting';
      case 'sweep':
        return 'Sweeping';
      default:
        return type;
    }
  };

  return (
    <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-white font-semibold">Job Status</h3>
        <button
          onClick={() => fetchJobs(false)}
          disabled={refreshing}
          className="flex items-center gap-2 px-2 py-1 text-sm text-gray-400 hover:text-white transition-colors"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {['generate', 'fund', 'dust', 'sweep'].map((type) => {
          const job = jobs.find(j => j.type === type);
          return (
            <div key={type} className="bg-gray-900/50 rounded-xl p-3 border border-gray-700">
              <div className="flex justify-between items-start">
                <span className="text-gray-300 text-sm font-medium">{getLabel(type)}</span>
                {job ? (
                  <span className={`px-2 py-0.5 text-xs rounded-full border ${getStatusColor(job.status)}`}>
                    {job.status}
                  </span>
                ) : (
                  <span className="text-gray-500 text-xs">No job</span>
                )}
              </div>
              {job && (
                <>
                  <div className="mt-2">
                    <div className="w-full bg-gray-700 rounded-full h-1.5">
                      <div
                        className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
                        style={{
                          width: job.total > 0 ? `${Math.min(100, (job.progress / job.total) * 100)}%` : '0%',
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>{job.progress}/{job.total}</span>
                      <span>{job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0}%</span>
                    </div>
                  </div>
                  {job.message && (
                    <div className="text-xs text-gray-400 mt-1 truncate">{job.message}</div>
                  )}
                  {job.started_at && (
                    <div className="text-xs text-gray-500 mt-1">
                      Started: {new Date(job.started_at).toLocaleString()}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}