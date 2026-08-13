// lib/auth.ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function getAuthUser(retries = 2) {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The setAll can be ignored if called from a Server Component
          }
        },
      },
      // 🔧 FIX: Disable auto-refresh to reduce auth calls
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

  // 🔧 FIX: Implement retry logic with exponential backoff
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Use shorter timeout for auth (8 seconds)
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Supabase Auth Timeout')), 8000)
      );

      // Race the network call against timeout
      const { data: { user }, error } = await Promise.race([
        supabase.auth.getUser(),
        timeoutPromise
      ]) as any;

      if (error) {
        // Don't retry on auth errors (invalid token, etc.)
        if (error.message?.includes('Auth') || error.status === 401) {
          console.warn('[auth] Auth error (not retrying):', error.message);
          return null;
        }
        throw error;
      }

      return user;
    } catch (err: any) {
      const isTimeout = err.message?.includes('Timeout');
      const isLastAttempt = attempt === retries;

      if (isTimeout && !isLastAttempt) {
        // Wait before retry (exponential backoff: 1s, 2s)
        const waitTime = 1000 * attempt;
        console.warn(`[auth] Timeout on attempt ${attempt}/${retries}, retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Log and return null on final failure
      console.error(`[auth] getAuthUser failed after ${attempt} attempts:`, err.message);
      return null;
    }
  }

  return null;
}