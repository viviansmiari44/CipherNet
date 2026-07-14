import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function getAuthUser() {
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
            // The義務 setAll can be ignored if called from a Server Component
          }
        },
      },
    }
  );

  // Raised timeout from 5s to 12s to accommodate local network variances
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Supabase Auth Timeout')), 12000)
  );

  try {
    // Race the network call against our new 12-second window
    const { data: { user }, error } = await Promise.race([
      supabase.auth.getUser(),
      timeoutPromise
    ]) as any;

    if (error) throw error;
    return user;
  } catch (err) {
    console.error('[auth] getAuthUser error or timeout:', err);
    return null;
  }
}