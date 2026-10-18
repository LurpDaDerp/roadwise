// Entry point: the publishable-key client verifies the caller's token with Auth; the secret-key
// client, which never leaves this process, deletes the auth user and purges the audit log. See
// handler.ts.
import { createClient } from '@supabase/supabase-js';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createDeletePorts, handleAccountDelete } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'account-delete');
const verifyJwt = createVerifyJwt(url, requireApiKey('publishable', 'account-delete'));
const ports = createDeletePorts(
  createClient(url, requireApiKey('secret', 'account-delete'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
);

Deno.serve((req) => handleAccountDelete(req, { verifyJwt, ports }));
