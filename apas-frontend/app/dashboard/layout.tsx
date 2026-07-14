'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { supabase } from '@app-lib/supabaseClient';
import Link from 'next/link';
import { Settings, Shield, LogOut, User } from 'lucide-react';
import CreditsCard from '@/components/CreditsCard';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');

  useEffect(() => {
    const checkUser = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }

      const { data: userData, error } = await supabase
        .from('users')
        .select('role, email, status') // ✅ added status
        .eq('id', session.user.id)
        .single();

      if (error || !userData) {
        // If user data missing, sign out and redirect
        await supabase.auth.signOut();
        router.replace('/login');
        return;
      }

      // ✅ Status check: if not active, sign out and redirect
      if (userData.status !== 'active') {
        await supabase.auth.signOut();
        router.replace('/login?pending=true');
        return;
      }

      if (userData) {
        setUserRole(userData.role || null);
        setUserEmail(userData.email || session.user.email || '');
      } else {
        setUserEmail(session.user.email || '');
      }
      setLoading(false);
    };
    checkUser();
  }, [router]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        Loading...
      </div>
    );
  }

  const isAdmin = userRole === 'admin';

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 text-gray-200">
      {/* Top Navigation */}
      <nav className="bg-gray-800/50 backdrop-blur-sm border-b border-gray-700 px-6 py-3 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              CipherNet
            </Link>
            <span className="text-gray-500 text-sm hidden md:inline">| Address Poisoning as a Service</span>
          </div>

          <div className="flex items-center gap-3">
            {/* Compact Credits Display */}
            <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 bg-gray-700/40 rounded-lg border border-gray-600">
              <CreditsCard compact />
            </div>

            {/* Admin Button */}
            {isAdmin && (
              <Link
                href="/admin"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition-colors text-sm font-medium"
              >
                <Shield size={16} />
                Admin
              </Link>
            )}

            {/* Settings Button */}
            <Link
              href="/dashboard/settings"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-sm ${
                pathname === '/dashboard/settings'
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'text-gray-300 hover:bg-gray-700/50'
              }`}
            >
              <Settings size={16} />
              Settings
            </Link>

            {/* User Avatar */}
            <div className="flex items-center gap-2 pl-2 border-l border-gray-700">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-sm font-semibold">
                {userEmail.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm text-gray-300 hidden sm:block">{userEmail}</span>
            </div>

            {/* Logout */}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors text-sm"
            >
              <LogOut size={16} />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}