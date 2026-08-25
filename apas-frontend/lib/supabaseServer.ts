// lib/supabaseServer.ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  return createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: any) {
          cookieStore.set({ name, value: '', ...options });
        },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      // 🚀 FIX: Increased timeout to 60s + Auth/Realtime exclusions
      global: {
        fetch: (url, options = {}) => {
          // NEVER apply timeouts to Auth or Realtime endpoints.
          // Otherwise, it kills WebSocket/Long-polling connections!
          if (typeof url === 'string' && (url.includes('/auth/v1') || url.includes('/realtime/v1'))) {
            return fetch(url, options);
          }

          return fetch(url, {
            ...options,
            signal: AbortSignal.timeout(60000), // 🚀 60 seconds for heavy DB queries
          });
        },
      },
    }
  );
}