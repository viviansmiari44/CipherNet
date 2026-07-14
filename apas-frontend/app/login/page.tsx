'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { Shield } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    const userId = data.user?.id;
    if (!userId) {
      setError('Invalid login response');
      setLoading(false);
      return;
    }

    // ─── Fetch user status from users table ───
    const { data: userData, error: statusError } = await supabase
      .from('users')
      .select('status')
      .eq('id', userId)
      .single();

    if (statusError || !userData) {
      // If user row doesn't exist, sign out and show error.
      await supabase.auth.signOut();
      setError('Account not found. Please contact support.');
      setLoading(false);
      return;
    }

    const status = userData.status;

    if (status === 'rejected') {
      await supabase.auth.signOut();
      setError('Your account has been rejected. Please contact support.');
      setLoading(false);
      return;
    }

    if (status !== 'active') {
      // status is 'pending' or any other non‑active state
      await supabase.auth.signOut();
      setError('Your account is pending admin approval. You will receive an email when activated.');
      setLoading(false);
      return;
    }

    // ─── Status is 'active' – proceed ───
    window.location.href = '/dashboard';
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2">
            <Shield className="w-8 h-8 text-blue-400" />
            <span className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              CipherNet
            </span>
          </div>
          <h2 className="text-white text-2xl font-semibold mt-4">Welcome back</h2>
          <p className="text-gray-400 text-sm mt-1">Log in to your account</p>
        </div>

        <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label className="block text-gray-300 text-sm font-medium mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full bg-gray-700 border border-gray-600 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                placeholder="••••••••"
              />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white py-2.5 rounded-xl hover:from-blue-500 hover:to-purple-500 transition-all disabled:opacity-50 shadow-lg shadow-blue-500/25"
            >
              {loading ? 'Logging in...' : 'Log In'}
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-gray-400">
            Don't have an account?{' '}
            <Link href="/register" className="text-blue-400 hover:text-blue-300 transition-colors">
              Register
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}