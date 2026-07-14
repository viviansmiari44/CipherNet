// lib/supabaseClient.ts
import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// Client-side client (for components and client-side API calls)
export const supabase = createBrowserClient(supabaseUrl, supabaseKey);