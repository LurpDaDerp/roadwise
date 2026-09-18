// utils/supabase.js
//
// Supabase is used for exactly one thing: profile photo storage (screens/AccountSettings).
// The anon key below is a public client identifier; access control is enforced by Storage
// RLS policies on the `profile-pictures` bucket - see docs/BACKEND_AUDIT.md.
import { createClient } from '@supabase/supabase-js';

import { supabaseConfig, isSupabaseConfigured } from './config';

if (!isSupabaseConfigured()) {
  console.warn(
    'Supabase is not configured: set EXPO_PUBLIC_SUPABASE_URL and ' +
      'EXPO_PUBLIC_SUPABASE_ANON_KEY in .env. Profile photo upload will fail until then.'
  );
}

export const supabase = createClient(
  supabaseConfig.url ?? 'https://unconfigured.supabase.co',
  supabaseConfig.anonKey ?? 'unconfigured',
  {
    auth: {
      // The app authenticates with Firebase, not Supabase. Disable Supabase's own session
      // handling so it never tries to persist or refresh a session it does not have.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
);
