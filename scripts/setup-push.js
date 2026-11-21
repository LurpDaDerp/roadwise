#!/usr/bin/env node
'use strict';
/**
 * Turns on server pushes (the weekly recap, a friend request, the monthly Wrapped) on the linked
 * Supabase project. Run it once per project, and again to rotate the key:
 *
 *   node scripts/setup-push.js
 *
 * Why it is needed: pg_cron's `push-sender-sweep` runs `private.dispatch_push()` every minute
 * (0005_push.sql). With a push due, it reads two Vault secrets, `push_sender_url` and
 * `push_sender_hmac_key`, and posts to the push-sender function, which checks the signed header
 * with its own `PUSH_SENDER_HMAC_KEY` (supabase/functions/push-sender). Until all three are set
 * the sweep answers `unconfigured`, every push stays `pending` in `public.inbox`, and nothing is
 * ever sent. No migration can set them: the key is a secret and the URL names the project.
 *
 * What it does: makes a new random key (64 hex characters, never printed), sets it as the
 * function secret and as the Vault secret, and points the Vault URL at this project's push-sender.
 * The function secret goes first, so the sweep never signs with a key the function does not have
 * yet. Pushes older than their time to live (`TTL_MS` in _shared/push_copy.ts) are skipped as
 * `stale`, so rows that waited while pushes were off are not sent late.
 *
 * Needs the Supabase CLI logged in and linked (`npx supabase link --project-ref <ref>`).
 * scripts/__tests__/setup-push.test.ts checks the SQL and the key.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** A hosted project's ref: 20 lower-case letters and digits. */
const REF_RE = /^[a-z0-9]{20}$/;
/** The sweep key as this script makes it: 32 random bytes in hex (push-sender needs 32 bytes or more). */
const KEY_RE = /^[0-9a-f]{64}$/;

/** A new sweep key: 32 random bytes as 64 hex characters. */
function newSweepKey() {
  return crypto.randomBytes(32).toString('hex');
}

/** The push-sender URL of a hosted project. */
function pushSenderUrl(ref) {
  if (!REF_RE.test(ref)) throw new Error(`not a Supabase project ref: "${ref}"`);
  return `https://${ref}.supabase.co/functions/v1/push-sender`;
}

/**
 * The statement that stores both Vault secrets, creating each or replacing its value. The key and
 * the ref are checked against their patterns first, so nothing else can reach the SQL text.
 */
function vaultSql(ref, key) {
  if (!KEY_RE.test(key)) throw new Error('the sweep key must be 64 hex characters');
  const url = pushSenderUrl(ref);
  const upsert = (name, value, about) =>
    `  select s.id into v_id from vault.secrets s where s.name = '${name}';\n` +
    `  if v_id is null then\n` +
    `    perform vault.create_secret('${value}', '${name}', '${about}');\n` +
    `  else\n` +
    `    perform vault.update_secret(v_id, '${value}');\n` +
    `  end if;\n`;
  return (
    'do $setup$\ndeclare\n  v_id uuid;\nbegin\n' +
    upsert('push_sender_hmac_key', key, 'Signs the push sweep (private.dispatch_push)') +
    upsert('push_sender_url', url, 'Where the push sweep posts (private.dispatch_push)') +
    'end\n$setup$;\n'
  );
}

/** The linked project's ref (`supabase/.temp/project-ref`, written by `supabase link`). */
function linkedRef(root = ROOT) {
  const file = path.join(root, 'supabase', '.temp', 'project-ref');
  if (!fs.existsSync(file)) throw new Error('the Supabase CLI is not linked: run `npx supabase link --project-ref <ref>` first');
  const ref = fs.readFileSync(file, 'utf8').trim();
  if (!REF_RE.test(ref)) throw new Error(`supabase/.temp/project-ref does not hold a project ref: "${ref}"`);
  return ref;
}

/** Runs the Supabase CLI and returns what it printed; throws with its output when it fails. */
function cli(args) {
  const win = process.platform === 'win32';
  const quote = (a) => (win && /\s/.test(a) ? `"${a}"` : a);
  const r = spawnSync(win ? 'npx.cmd' : 'npx', ['supabase', ...args].map(quote), { cwd: ROOT, encoding: 'utf8', shell: win });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.status !== 0) throw new Error(`supabase ${args[0]} ${args[1]} failed: ${out || String(r.error ?? 'no output')}`);
  return out;
}

/** `work` with a private temp file holding `text`; the file is removed afterwards whatever happens. */
function withTempFile(name, text, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-push-'));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
    return work(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const ref = linkedRef();
  const key = newSweepKey();
  // The function first: the sweep then never signs with a key the function does not have.
  withTempFile('push.env', `PUSH_SENDER_HMAC_KEY=${key}\n`, (file) => cli(['secrets', 'set', '--project-ref', ref, '--env-file', file]));
  withTempFile('vault.sql', vaultSql(ref, key), (file) => cli(['db', 'query', '--linked', '--yes', '-f', file]));
  const names = cli(['db', 'query', '--linked', '--yes', '--output-format', 'json', "select name from vault.secrets where name in ('push_sender_hmac_key', 'push_sender_url') order by name"]);
  if (!names.includes('push_sender_hmac_key') || !names.includes('push_sender_url')) {
    throw new Error(`the Vault secrets were not stored. The CLI printed:\n${names}`);
  }
  console.log(`Server pushes are set up on ${ref}: push-sender has its key, and the sweep has the key and ${pushSenderUrl(ref)}.`);
  console.log('The next due push goes out within a minute. Pushes that waited past their time to live are skipped as stale.');
}

module.exports = { newSweepKey, pushSenderUrl, vaultSql, linkedRef, KEY_RE, REF_RE };

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`setup-push: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
