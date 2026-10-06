// Entry point: the anon client verifies the caller's token with Auth; the service client, which
// never leaves this process, deletes the auth user and purges the audit log. See handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createVerifyJwt, requireEnv } from '../_shared/auth.ts';
import { createDeletePorts, handleAccountDelete } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'account-delete');
const verifyJwt = createVerifyJwt(url, requireEnv('SUPABASE_ANON_KEY', 'account-delete'));
const ports = createDeletePorts(
  createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY', 'account-delete'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
);

Deno.serve((req) => handleAccountDelete(req, { verifyJwt, ports }));
