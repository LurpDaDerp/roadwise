// Entry point: wires the handler to the runtime's clients. The publishable-key client verifies the
// caller's token with Auth; the secret-key client, which never leaves this process, takes the
// budget and builds the export (both service-role only). See handler.ts for the contract.
import { createClient } from '@supabase/supabase-js';
import { createVerifyJwt, requireApiKey, requireEnv } from '../_shared/auth.ts';
import { createExportDb, handleAccountExport } from './handler.ts';

const url = requireEnv('SUPABASE_URL', 'account-export');
const verifyJwt = createVerifyJwt(url, requireApiKey('publishable', 'account-export'));
const db = createExportDb(
  createClient(url, requireApiKey('secret', 'account-export'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
);

Deno.serve((req) => handleAccountExport(req, { verifyJwt, db }));
