// lib/supabaseService.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabaseService = createClient(
    supabaseUrl,
    supabaseServiceKey,
    {
        // 🔧 FIX: Add auth configuration for service role
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
        // 🔧 FIX: Add timeout to all service role requests
        global: {
            fetch: (url, options = {}) => {
                return fetch(url, {
                    ...options,
                    signal: AbortSignal.timeout(20000), // 20 second timeout for admin operations
                });
            },
        },
    }
);