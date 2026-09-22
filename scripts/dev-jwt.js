#!/usr/bin/env node
'use strict';
/**
 * Mints a user JWT for the LOCAL Supabase stack, so an edge function can be exercised with
 * `curl -H "Authorization: Bearer $(node scripts/dev-jwt.js)"` against `supabase functions serve`.
 *
 *   node scripts/dev-jwt.js [--sub <uuid>] [--email <addr>] [--ttl <seconds>] [--ensure-user]
 *
 * The signing secret is read at run time — `SUPABASE_JWT_SECRET` if set, otherwise the
 * `JWT_SECRET` that `npx supabase status -o json` prints for the running stack — and is never
 * written anywhere. The token is HS256 with the claims GoTrue issues (`sub`, `role`
 * `authenticated`, `aud` `authenticated`, `iss`, `iat`, `exp`), so both the functions gateway
 * and `auth.getUser()` inside the function accept it. No `session_id`: GoTrue refuses a token whose
 * session it cannot find, and a minted token has none.
 *
 * `--ensure-user` creates the auth user for `--sub` through the local admin API (with the
 * service key from the same status output) when it does not exist yet: `auth.getUser()` looks
 * the subject up, so a minted token for a subject that is not in `auth.users` is refused. It also
 * gives a user with no birth date an adult one (1990-01-01): since migration 0006 a drive is only
 * accepted once the age question is answered.
 *
 * Local only: the effective API URL (env or status output) must be 127.0.0.1 or localhost, so
 * neither a remote SUPABASE_URL nor a linked project can be minted for or written to.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

const sub = flag('--sub') || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const email = flag('--email') || `${sub.slice(0, 8)}@dev.local`;
const ttl = Number(flag('--ttl') || 3600);
if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 7 * 86400) {
  console.error('dev-jwt: --ttl must be a whole number of seconds, at most one week');
  process.exit(2);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) {
  console.error('dev-jwt: --sub must be a uuid');
  process.exit(2);
}

function status() {
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // The CLI may print a "Stopped services" line before the JSON.
  return JSON.parse(out.slice(out.indexOf('{')));
}

const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function mint(secret, apiUrl) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    iss: `${apiUrl}/auth/v1`,
    sub,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    iat: now,
    exp: now + ttl,
  };
  const body = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

async function ensureUser(apiUrl, serviceKey) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  const existing = await fetch(`${apiUrl}/auth/v1/admin/users/${sub}`, { headers });
  if (!existing.ok) {
    const created = await fetch(`${apiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: sub, email, email_confirm: true }),
    });
    if (!created.ok) {
      throw new Error(`dev-jwt: creating the user failed: ${created.status} ${await created.text()}`);
    }
  }
  // Migration 0006 accepts a drive only once its driver has answered the age question (an
  // `unknown` band is refused as retryable `age_pending`), so a dev user is an adult. Only a
  // missing birth date is filled: a date already set (a test that wants a minor) is left alone.
  const aged = await fetch(`${apiUrl}/rest/v1/private_profiles?user_id=eq.${sub}&birth_date=is.null`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ birth_date: '1990-01-01' }),
  });
  if (!aged.ok) {
    throw new Error(`dev-jwt: setting the birth date failed: ${aged.status} ${await aged.text()}`);
  }
}

(async () => {
  let secret = process.env.SUPABASE_JWT_SECRET;
  let apiUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || has('--ensure-user') || !process.env.SUPABASE_URL) {
    const s = status();
    secret = secret || s.JWT_SECRET;
    apiUrl = process.env.SUPABASE_URL || s.API_URL || apiUrl;
    serviceKey = serviceKey || s.SERVICE_ROLE_KEY || s.SECRET_KEY;
  }
  // The effective URL decides, whatever env or the status output said: nothing is minted for, or
  // written to, a project that is not on this machine.
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(apiUrl)) {
    throw new Error('dev-jwt: only the local stack is supported (SUPABASE_URL must be 127.0.0.1 or localhost)');
  }
  if (!secret) throw new Error('dev-jwt: no JWT secret (is the local stack running?)');
  if (has('--ensure-user')) {
    if (!serviceKey) throw new Error('dev-jwt: no service key for --ensure-user');
    await ensureUser(apiUrl, serviceKey);
  }
  process.stdout.write(mint(secret, apiUrl) + '\n');
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
