#!/usr/bin/env node
'use strict';
/**
 * The M4 push end-to-end: server notifications from a permission lapse to delivered, deferred,
 * capped or expired, and drive summaries that stay local — against the LOCAL stack only.
 *
 *   node --experimental-strip-types scripts/e2e-push.js
 *
 * What it proves, each through the real writers, triggers, edge functions and pg_net:
 *
 *   A  summary     a trip applied through `apply_trip` for a user with a registered token makes a
 *                  `skipped/local` inbox row and ZERO Expo messages; a `too_short` trip makes no row
 *                  (rev1: C1, the drive summary is the phone's local notification).
 *   B  lapse       a background permission lapse (PATCH devices.permissions, reportedFrom
 *                  'background') → one Expo message with the catalog's lapse copy → `sent/ok`; a
 *                  foreground lapse → `skipped/inbox_only`, never pushed.
 *   C  driving     a device recording → `deferred/driving`, push_after ≈ +5 min.
 *   D  quiet       quiet hours covering now → `deferred/quiet_hours`, push_after at the quiet end.
 *   E  capped      local_sent_count 2 today → `deferred/capped` to the next local midnight (ruling T4
 *                  minor: a capped lapse is carried to the next day's first slot, never dropped;
 *                  this supersedes the brief's "skipped capped").
 *   F  DNR         the stub answers DeviceNotRegistered → `failed/expo_error`, registration removed.
 *   G  dedupe      a cap-deferred lapse from yesterday and a fresh lapse of the same device and kind
 *                  → exactly one message (T3 r2, the exact lapse dedupe).
 *   H  dispatch    one sweep driven end to end by 0007's `dispatch_push()` (the SQL signer, pg_net,
 *                  the Deno verifier) → `sent`.
 *   I  receipts    a stub that never returns a receipt: the delivery is checked and left open, then,
 *                  its ticket backdated 25 h, stamped `error/expired`; `dispatch_push()` → `idle`.
 *   J  purge       B6 end to end through `dispatch_purge_traces()`: an expired trace is removed and
 *                  its trace_path cleared, scored_without_trace untouched, a fresh trace kept.
 *   K  catalog     LIVE_TYPES equals the `inbox.type` CHECK.
 *
 * Local only, by construction:
 *   * keys are read from `npx supabase status -o json` at run time; the run refuses to start unless
 *     the API URL is 127.0.0.1 or localhost;
 *   * Expo is a stub in this process (EXPO_PUSH_URL → host.docker.internal:<port>); real Expo is
 *     never contacted;
 *   * the HMAC keys are fresh random values, written only to a git-ignored env file
 *     (`supabase/.env.e2e-push`) and to Vault for the run, and both are removed on every path;
 *   * every user, row, storage object and Vault secret the run made is removed at the end, and the
 *     cleanup is itself asserted, so `npx supabase test db` passes afterwards.
 *
 * It starts its own `supabase functions serve --env-file …` (the functions need the run's keys), so
 * stop any other `functions serve` first. Every section declares its check count; a section that
 * does not run all its checks fails the run.
 */

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TZ = 'America/Los_Angeles';
const ENV_FILE = path.join(ROOT, 'supabase', '.env.e2e-push');
const VAULT_NAMES = ['push_sender_url', 'push_sender_hmac_key', 'purge_traces_url', 'purge_traces_hmac_key'];
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
const RUN = crypto.randomBytes(3).toString('hex');

// ---------------------------------------------------------------------------
// Checks: recorded, never thrown; each section declares its count.
// ---------------------------------------------------------------------------

const results = [];
const sections = [];
let current = null;

function section(name, expected) {
  closeSection();
  current = { name, expected, ran: 0 };
  sections.push(current);
  console.log(`\n== ${name}`);
}
function closeSection() {
  if (current && current.ran !== current.expected) {
    results.push({ section: current.name, name: 'section check count', ok: false, detail: `ran ${current.ran} of ${current.expected}` });
  }
  current = null;
}
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
function check(name, ok, detail = '') {
  if (current) current.ran++;
  results.push({ section: current ? current.name : '-', name, ok: !!ok, detail });
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`);
}
const checkEq = (name, actual, expected) =>
  check(name, show(actual) === show(expected), `got ${show(actual)}, want ${show(expected)}`);

// ---------------------------------------------------------------------------
// The local stack.
// ---------------------------------------------------------------------------

function supabaseStatus() {
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.slice(out.indexOf('{')));
}

function projectId() {
  const m = /^project_id\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8'));
  if (!m) throw new Error('e2e-push: no project_id in supabase/config.toml');
  return m[1];
}

/** SQL as postgres inside the database container; the text goes over stdin, never argv. */
function makeSql(container) {
  return (text) =>
    execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-q'], {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}
/** One JSON value from a query that selects exactly one. */
const sqlJson = (sql, text) => JSON.parse(sql(text) || 'null');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function devJwt(sub) {
  return execFileSync('node', [path.join(ROOT, 'scripts', 'dev-jwt.js'), '--sub', sub, '--ensure-user'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeApi(stack) {
  const { API_URL, ANON_KEY } = stack;
  const serviceKey = stack.SERVICE_ROLE_KEY || stack.SECRET_KEY;
  const call = async (method, url, headers, body) => {
    const res = await fetch(`${API_URL}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
  const asUser = (jwt) => ({ apikey: ANON_KEY, Authorization: `Bearer ${jwt}` });
  const asService = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  return {
    url: API_URL,
    user: (jwt, method, url, body, extra = {}) => call(method, url, { ...asUser(jwt), ...extra }, body),
    service: (method, url, body, extra = {}) => call(method, url, { ...asService, ...extra }, body),
    raw: call,
  };
}

// ---------------------------------------------------------------------------
// The Expo stub: accepts every message, except that a token containing `DNRx` is not registered,
// and a ticket for a token containing `NoRcpt` never gets a receipt.
// ---------------------------------------------------------------------------

function startExpoStub() {
  const state = { messages: [], receiptCalls: [], tickets: new Map(), n: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/send') && Array.isArray(parsed)) {
        const data = parsed.map((m) => {
          state.messages.push({ ...m, authorization: req.headers.authorization ?? null });
          if (m.to.includes('DNRx')) {
            return { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } };
          }
          const id = `stub-${RUN}-${++state.n}`;
          state.tickets.set(id, m.to);
          return { status: 'ok', id };
        });
        res.end(JSON.stringify({ data }));
        return;
      }
      if (req.url.endsWith('/getReceipts') && parsed && Array.isArray(parsed.ids)) {
        state.receiptCalls.push(parsed.ids);
        const data = {};
        for (const id of parsed.ids) {
          const to = state.tickets.get(id);
          if (to && !to.includes('NoRcpt')) data[id] = { status: 'ok' };
        }
        res.end(JSON.stringify({ data }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ errors: [{ code: 'BAD_REQUEST' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve({ server, state, port: server.address().port })));
}

// ---------------------------------------------------------------------------
// Helpers over the stack.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const hmacHeader = (purpose, key) => {
  const ts = Math.floor(Date.now() / 1000);
  return `${ts}.${crypto.createHmac('sha256', key).update(`${purpose}:${ts}`).digest('hex')}`;
};

function localParts(ms, tz = TZ) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) {
    if (x.type !== 'literal') p[x.type] = x.value;
  }
  return p;
}
const localDate = (ms) => {
  const p = localParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
};
const hhmm = (ms) => {
  const p = localParts(ms);
  return `${p.hour}:${p.minute}`;
};

/** An `apply_trip` envelope shaped like 0007's pgTAP fixture (FinalizeTripPayload at HEAD). */
function envelope(uid, client, endedAgoMs, distanceM, durationS, status, reason, tracePath) {
  const ended = Date.now() - endedAgoMs;
  const started = ended - durationS * 1000;
  return {
    userId: uid,
    payload: {
      clientTripId: client,
      startedAt: started,
      endedAt: ended,
      tz: TZ,
      distanceM,
      durationS,
      role: 'driver',
      roleConfidence: null,
      roleSource: 'manual',
      mode: 'mounted',
      cameraSession: false,
      events: [],
      rowsDigest: { count: 900, validGnssPct: 98.5, imuPresent: true, maxSustainedSpeedMps: 31.2, sha256: 'a'.repeat(64) },
      startGeohash5: 'c23nb',
      endGeohash5: 'c23nb',
      polyline: '_p~iF~ps|U',
      tracePath,
      hadSevereEvent: false,
      incomplete: false,
    },
    scored: {
      score: status === 'final' ? 80 : null,
      status,
      reason,
      exposure: 1.25,
      dataQuality: 'A',
      categoryDeductions: { phone: 0, speeding: 20, braking: 0, accel: 0, cornering: 0, focus: 0 },
      eventDeductions: {},
      scoringVersion: 1,
    },
    day: {
      day: localDate(started),
      longTermScore: 80,
      band: 'good',
      provisional: false,
      safeDay: false,
      goodDay: true,
      phoneFreeDay: true,
      cameraDay: false,
      exposure: 1.25,
      drivingS: durationS,
      tripsScored: status === 'final' ? 1 : 0,
      severeEvents: 0,
    },
    baselines: { medians: { speeding: 1.2 } },
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function main() {
  const stack = supabaseStatus();
  if (!LOCAL_URL.test(stack.API_URL)) throw new Error(`e2e-push: local stack only (API_URL is ${stack.API_URL})`);
  if (process.env.SUPABASE_URL && !LOCAL_URL.test(process.env.SUPABASE_URL)) throw new Error('e2e-push: SUPABASE_URL is not local');
  const apiPort = new URL(stack.API_URL).port || '80';
  const sql = makeSql(`supabase_db_${projectId()}`);
  const api = makeApi(stack);
  const catalog = await import(pathToFileURL(path.join(ROOT, 'src', 'notifications', 'catalog.ts')).href);

  const existing = sqlJson(sql, `select coalesce(json_agg(name), '[]') from vault.secrets where name in (${VAULT_NAMES.map(lit).join(',')})`);
  if (existing.length > 0) throw new Error(`e2e-push: Vault already holds ${existing.join(', ')}; refusing to overwrite them`);
  const ignored = execFileSync('git', ['check-ignore', '-q', ENV_FILE], { cwd: ROOT, stdio: 'ignore' });
  void ignored; // throws when the env file would not be ignored

  const pushKey = crypto.randomBytes(32).toString('hex');
  const purgeKey = crypto.randomBytes(32).toString('hex');
  const stub = await startExpoStub();
  fs.writeFileSync(
    ENV_FILE,
    `PUSH_SENDER_HMAC_KEY=${pushKey}\nPURGE_TRACES_HMAC_KEY=${purgeKey}\nEXPO_PUSH_URL=http://host.docker.internal:${stub.port}/push\n`
  );

  const users = [];
  const storageKeys = [];
  let serve = null;
  const serveLog = [];
  try {
    // ---- the runtime ---------------------------------------------------------------
    console.log('starting `supabase functions serve --env-file supabase/.env.e2e-push` …');
    serve = spawn('npx', ['supabase', 'functions', 'serve', '--env-file', ENV_FILE], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serve.stdout.on('data', (d) => serveLog.push(String(d)));
    serve.stderr.on('data', (d) => serveLog.push(String(d)));
    const ready = Date.now() + 150_000;
    let up = false;
    while (Date.now() < ready && !up) {
      await sleep(2_000);
      // 401 only once push-sender booted WITH this run's key (a missing key refuses to boot).
      const probe = await api.raw('POST', '/functions/v1/push-sender', {}, '{}').catch(() => ({ status: 0 }));
      up = probe.status === 401;
    }
    if (!up) throw new Error(`BLOCKED: push-sender never answered 401 on ${api.url}.\n${serveLog.join('').slice(-3000)}`);

    const sweep = async () => {
      const res = await api.raw('POST', '/functions/v1/push-sender', { 'X-Sweep-Signature': hmacHeader('push-sender-sweep', pushKey) }, '{}');
      return res;
    };
    // Due items of other scenarios would be claimed by any sweep: each scenario's rows are
    // asserted by inbox id, and counts only where the scenario is alone in the queue.

    const newUser = async (label) => {
      const id = uuid();
      const jwt = devJwt(id);
      users.push(id);
      const device = `e2e-${label}-${RUN}`;
      const token = `ExponentPushToken[e2e-${label}-${RUN}-tok]`;
      return { id, jwt, device, token, label };
    };
    const addDevice = async (u, permissions = { location: 'always', motion: 'granted' }) => {
      const r = await api.user(u.jwt, 'POST', '/rest/v1/devices', { id: u.device, user_id: u.id, platform: 'ios', permissions }, { Prefer: 'return=minimal' });
      if (r.status >= 300) throw new Error(`device insert ${r.status} ${r.text}`);
    };
    const register = async (u, token = u.token) => {
      const r = await api.user(u.jwt, 'POST', '/rest/v1/rpc/register_push_token', { p_device_id: u.device, p_token: token });
      if (r.status >= 300) throw new Error(`register_push_token ${r.status} ${r.text}`);
    };
    // Scenario setup writes the preferences as postgres: what is under test here is the sender. The
    // client's own write path (H6, the phone's day count) is asserted on its own in section P.
    const prefs = async (u, fields) => {
      const row = { tz: TZ, quiet_enabled: false, ...fields };
      const cols = Object.keys(row);
      sql(`insert into public.notification_prefs (user_id, ${cols.join(', ')})
           values (${lit(u.id)}, ${cols.map((c) => lit(row[c])).join(', ')})
           on conflict (user_id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`);
    };
    const patchDevice = async (u, fields) => {
      const r = await api.user(u.jwt, 'PATCH', `/rest/v1/devices?user_id=eq.${u.id}&id=eq.${encodeURIComponent(u.device)}`, fields, { Prefer: 'return=minimal' });
      if (r.status >= 300) throw new Error(`device patch ${r.status} ${r.text}`);
    };
    const lapse = (u, kind = 'location_always', from = 'background') =>
      patchDevice(u, {
        permissions:
          kind === 'motion'
            ? { location: 'always', motion: 'denied', reportedFrom: from }
            : { location: 'foreground', motion: 'granted', reportedFrom: from },
      });
    const inbox = (uid) =>
      sqlJson(
        sql,
        `select coalesce(json_agg(t order by t.created_at, t.id), '[]') from (
           select id, type, payload, push_state, push_reason, push_attempts, pushed_at, dedupe_key, created_at,
                  extract(epoch from push_after) * 1000 as push_after_ms, extract(epoch from deliver_after) * 1000 as deliver_after_ms
           from public.inbox where user_id = ${lit(uid)}) t`
      );
    const deliveries = (inboxId) =>
      sqlJson(
        sql,
        `select coalesce(json_agg(t), '[]') from (select id, token is not null as token_linked, ticket_id, error, receipt_status, receipt_error,
           receipt_checked_at is not null as checked from public.push_deliveries where inbox_id = ${lit(inboxId)}) t`
      );
    const registrations = (uid) => Number(sql(`select count(*) from public.push_registrations where user_id = ${lit(uid)}`));
    const messagesFor = (inboxId) => stub.state.messages.filter((m) => m.data && m.data.inboxId === inboxId);
    const lapseCopy = (payload) => catalog.renderPush('permission_lapsed', payload);

    // ---- P: the client writes its own preferences ------------------------------------
    // What H6 (Task 7's api.ts) and the phone's day count send: an update without user_id, and an
    // insert with it when there is no row yet.
    section('P client preferences: a signed-in user can insert and update notification_prefs', 2);
    {
      const u = await newUser('prefs');
      const ins = await api.user(u.jwt, 'POST', '/rest/v1/notification_prefs', { user_id: u.id, quiet_enabled: true, tz: TZ }, { Prefer: 'return=minimal' });
      check('insert as the user (201)', ins.status === 201, `${ins.status} ${ins.text}`);
      // The update is checked on its own: the row exists whatever the insert did.
      sql(`insert into public.notification_prefs (user_id, quiet_enabled, tz) values (${lit(u.id)}, true, ${lit(TZ)}) on conflict (user_id) do nothing`);
      const upd = await api.user(
        u.jwt,
        'PATCH',
        `/rest/v1/notification_prefs?user_id=eq.${u.id}&select=local_sent_count`,
        { local_sent_count: 1, local_sent_day: localDate(Date.now()) },
        { Prefer: 'return=representation' }
      );
      check('update as the user (200, the row written)', upd.status === 200 && show(upd.json) === show([{ local_sent_count: 1 }]), `${upd.status} ${upd.text}`);
    }

    // ---- A: drive summaries stay local ---------------------------------------------
    section('A summary: apply_trip → skipped/local, zero Expo messages; too_short → no row', 7);
    {
      const u = await newUser('sum');
      await addDevice(u);
      await register(u);
      await prefs(u, {});
      const final = await api.service('POST', '/rest/v1/rpc/apply_trip', { p: envelope(u.id, `sum-final-${RUN}`, 10 * 60_000, 12_500, 900, 'final', null, null) });
      const short = await api.service('POST', '/rest/v1/rpc/apply_trip', { p: envelope(u.id, `sum-short-${RUN}`, 20 * 60_000, 500, 90, 'unscored', 'too_short', null) });
      check('apply_trip accepted both trips', final.status < 300 && short.status < 300, `${final.status} ${final.text} / ${short.status} ${short.text}`);
      const rows = inbox(u.id);
      checkEq('exactly one inbox row (the too_short trip made none)', rows.length, 1);
      checkEq('it is the final trip\'s summary', rows[0] && [rows[0].type, rows[0].payload.clientTripId], ['trip_summary', `sum-final-${RUN}`]);
      checkEq('born skipped/local', rows[0] && [rows[0].push_state, rows[0].push_reason], ['skipped', 'local']);
      const before = stub.state.messages.length;
      const res = await sweep();
      checkEq('a sweep answers 200', res.status, 200);
      checkEq('zero Expo messages', stub.state.messages.length - before, 0);
      const after = inbox(u.id)[0];
      checkEq('never claimed: still skipped/local, 0 attempts', after && [after.push_state, after.push_reason, after.push_attempts], ['skipped', 'local', 0]);
    }

    // ---- B: a background lapse is pushed once, with the catalog's copy -------------
    section('B lapse: background → one message with the lapse copy → sent; foreground → inbox_only', 11);
    {
      const u = await newUser('lapse');
      await addDevice(u);
      await register(u);
      await prefs(u, {});
      await lapse(u, 'location_always', 'background');
      let rows = inbox(u.id);
      checkEq('one pending location_always row', rows.map((r) => [r.push_state, r.payload.permission]), [['pending', 'location_always']]);
      const row = rows[0];
      const res = await sweep();
      checkEq('the sweep answers 200 with counts', [res.status, typeof res.json?.claimed], [200, 'number']);
      const msgs = messagesFor(row.id);
      checkEq('exactly one Expo message', msgs.length, 1);
      const copy = lapseCopy(row.payload);
      const m = msgs[0] || {};
      checkEq('to the registered token', m.to, u.token);
      checkEq('the catalog\'s lapse copy', [m.title, m.body], [copy.title, copy.body]);
      checkEq('data is the inbox id and /permissions only', m.data, { inboxId: row.id, url: '/permissions' });
      checkEq('Android channel and sound', [m.channelId, m.sound], ['recording_problems', 'default']);
      rows = inbox(u.id);
      checkEq('row sent/ok with pushed_at', [rows[0].push_state, rows[0].push_reason, rows[0].pushed_at !== null], ['sent', 'ok', true]);
      const d = deliveries(row.id);
      checkEq('one delivery with the stub ticket, token linked', d.map((x) => [x.token_linked, /^stub-/.test(x.ticket_id ?? '')]), [[true, true]]);
      // A foreground lapse of another kind: recorded for the inbox, never pushed.
      await lapse(u, 'motion', 'foreground');
      const fg = inbox(u.id).find((r) => r.payload.permission === 'motion');
      checkEq('foreground motion lapse → skipped/inbox_only', fg && [fg.push_state, fg.push_reason], ['skipped', 'inbox_only']);
      await sweep();
      checkEq('and no message for it', fg ? messagesFor(fg.id).length : -1, 0);
    }

    // ---- C: never while driving ----------------------------------------------------
    section('C driving: a recording device → deferred/driving +5 min', 3);
    {
      const u = await newUser('drive');
      await addDevice(u);
      await register(u);
      await prefs(u, {});
      await patchDevice(u, { drive_state: 'recording' });
      await lapse(u);
      const row = inbox(u.id)[0];
      const t0 = Date.now();
      await sweep();
      const after = inbox(u.id)[0];
      checkEq('deferred/driving', after && [after.push_state, after.push_reason], ['deferred', 'driving']);
      const dt = after ? after.push_after_ms - t0 : NaN;
      check('push_after about 5 minutes on', dt > 4.5 * 60_000 && dt < 5.5 * 60_000, `push_after - now = ${dt} ms`);
      checkEq('no message', row ? messagesFor(row.id).length : -1, 0);
    }

    // ---- D: quiet hours ------------------------------------------------------------
    section('D quiet hours covering now → deferred/quiet_hours to the quiet end', 3);
    {
      const u = await newUser('quiet');
      await addDevice(u);
      await register(u);
      const now = Date.now();
      const end = now + 60 * 60_000;
      await prefs(u, { quiet_enabled: true, quiet_start: hhmm(now - 60 * 60_000), quiet_end: hhmm(end) });
      await lapse(u);
      const row = inbox(u.id)[0];
      await sweep();
      const after = inbox(u.id)[0];
      checkEq('deferred/quiet_hours', after && [after.push_state, after.push_reason], ['deferred', 'quiet_hours']);
      checkEq('push_after is the quiet end in the user\'s zone', after && hhmm(after.push_after_ms), hhmm(end));
      checkEq('no message', row ? messagesFor(row.id).length : -1, 0);
    }

    // ---- E: the daily cap ----------------------------------------------------------
    section('E capped: local_sent_count 2 today → deferred/capped to the next local midnight', 4);
    {
      const u = await newUser('cap');
      await addDevice(u);
      await register(u);
      await prefs(u, { local_sent_day: localDate(Date.now()), local_sent_count: 2 });
      await lapse(u);
      const row = inbox(u.id)[0];
      await sweep();
      const after = inbox(u.id)[0];
      checkEq('deferred/capped (a lapse is carried to the next day, never dropped)', after && [after.push_state, after.push_reason], ['deferred', 'capped']);
      checkEq('push_after is 00:00 local', after && hhmm(after.push_after_ms), '00:00');
      checkEq('on the next local day', after && localDate(after.push_after_ms), localDate(Date.now() + 24 * 3_600_000));
      checkEq('no message', row ? messagesFor(row.id).length : -1, 0);
    }

    // ---- F: DeviceNotRegistered ----------------------------------------------------
    section('F DeviceNotRegistered → failed/expo_error, registration removed', 4);
    {
      const u = await newUser('dnr');
      await addDevice(u);
      const dead = `ExponentPushToken[e2e-DNRx-${RUN}-tok]`;
      await register(u, dead);
      await prefs(u, {});
      checkEq('the token is registered', registrations(u.id), 1);
      await lapse(u);
      const row = inbox(u.id)[0];
      await sweep();
      const after = inbox(u.id)[0];
      checkEq('failed/expo_error (its only token)', after && [after.push_state, after.push_reason], ['failed', 'expo_error']);
      checkEq('the delivery records DeviceNotRegistered', row ? deliveries(row.id).map((x) => x.error) : null, ['DeviceNotRegistered']);
      checkEq('the registration is removed', registrations(u.id), 0);
    }

    // ---- G: one lapse, one push ----------------------------------------------------
    section('G dedupe: a cap-deferred lapse and a fresh one of the same device and kind → one message', 5);
    {
      const u = await newUser('dedupe');
      await addDevice(u);
      await register(u);
      await prefs(u, { local_sent_day: localDate(Date.now()), local_sent_count: 2 });
      await lapse(u);
      await sweep();
      const deferred = inbox(u.id)[0];
      checkEq('the first lapse is cap-deferred', deferred && [deferred.push_state, deferred.push_reason], ['deferred', 'capped']);
      // Make it yesterday's row, now due; lift the cap; restore and lapse again: a fresh row today.
      const yesterday = localDate(Date.now() - 24 * 3_600_000);
      sql(`update public.inbox set created_at = now() - interval '20 hours', push_after = now() - interval '1 second',
             dedupe_key = regexp_replace(dedupe_key, ':[0-9]{4}-[0-9]{2}-[0-9]{2}$', ${lit(`:${yesterday}`)})
           where id = ${lit(deferred.id)}`);
      await prefs(u, { local_sent_count: 0 });
      await patchDevice(u, { permissions: { location: 'always', motion: 'granted', reportedFrom: 'foreground' } });
      await lapse(u);
      const rows = inbox(u.id);
      const fresh = rows.find((r) => r.id !== deferred.id);
      checkEq('two due rows of the same device and kind', rows.map((r) => [r.push_state, r.payload.deviceId, r.payload.permission]).sort(), [
        ['deferred', u.device, 'location_always'],
        ['pending', u.device, 'location_always'],
      ]);
      await sweep();
      const sent = stub.state.messages.filter((m) => m.to === u.token);
      checkEq('exactly one message', sent.length, 1);
      checkEq('the fresh one is sent', fresh && inbox(u.id).find((r) => r.id === fresh.id)?.push_state, 'sent');
      const old = inbox(u.id).find((r) => r.id === deferred.id);
      checkEq('the deferred one resolves skipped/subject_gone', old && [old.push_state, old.push_reason], ['skipped', 'subject_gone']);
    }

    // ---- H: one sweep through dispatch_push ----------------------------------------
    section('H dispatch_push: the SQL signer, pg_net and the Deno verifier agree → sent', 3);
    {
      sql(`select vault.create_secret(${lit(`http://host.docker.internal:${apiPort}/functions/v1/push-sender`)}, 'push_sender_url');
           select vault.create_secret(${lit(pushKey)}, 'push_sender_hmac_key');`);
      const u = await newUser('dispatch');
      await addDevice(u);
      await register(u);
      await prefs(u, {});
      await lapse(u);
      const row = inbox(u.id)[0];
      checkEq('dispatch_push() → dispatched', sql('select public.dispatch_push()'), 'dispatched');
      let after = null;
      for (let i = 0; i < 30; i++) {
        await sleep(1_000);
        after = inbox(u.id)[0];
        if (after && after.push_state === 'sent') break;
      }
      checkEq('the row reaches sent/ok', after && [after.push_state, after.push_reason], ['sent', 'ok']);
      checkEq('one message', row ? messagesFor(row.id).length : -1, 1);
    }

    // ---- I: a receipt that never comes → expired → idle ------------------------------
    section('I receipts: never answered → checked and left open → backdated 25 h → error/expired; dispatch_push → idle', 6);
    {
      const u = await newUser('rcpt');
      await addDevice(u);
      const token = `ExponentPushToken[e2e-NoRcpt-${RUN}-tok]`;
      await register(u, token);
      await prefs(u, {});
      await lapse(u);
      const row = inbox(u.id)[0];
      // The cron sweep may run too while Vault is set; wait for the row, whoever sends it.
      await sweep();
      for (let i = 0; i < 20 && inbox(u.id)[0]?.push_state !== 'sent'; i++) await sleep(1_000);
      checkEq('sent with a ticket', row ? [inbox(u.id)[0].push_state, deliveries(row.id).map((d) => /^stub-/.test(d.ticket_id ?? ''))] : null, ['sent', [true]]);
      // Due for a receipt (≥ 15 min old): the stub has none, so it is checked and left open.
      sql(`update public.push_deliveries set created_at = now() - interval '20 minutes' where inbox_id = ${lit(row.id)}`);
      const calls = stub.state.receiptCalls.length;
      await sweep();
      const asked = stub.state.receiptCalls.slice(calls).flat();
      const ticket = deliveries(row.id)[0]?.ticket_id;
      check('the stub was asked for that receipt', asked.includes(ticket), `asked ${show(asked)}`);
      checkEq('checked, still no receipt', deliveries(row.id).map((d) => [d.checked, d.receipt_status]), [[true, null]]);
      sql(`update public.push_deliveries set created_at = now() - interval '25 hours' where inbox_id = ${lit(row.id)}`);
      await sweep();
      checkEq('stamped error/expired', deliveries(row.id).map((d) => [d.receipt_status, d.receipt_error]), [['error', 'expired']]);
      // Everything else this run left is not due: the young tickets of B, G and H, and the
      // deferrals of C, D and E — make that true even on a slow run, then nothing is owed.
      sql(`update public.push_deliveries set receipt_checked_at = now() where receipt_status is null and user_id in (${users.map(lit).join(',')})`);
      checkEq('dispatch_push() → idle', sql('select public.dispatch_push()'), 'idle');
      checkEq('no key in pg_net\'s responses or the cron log', sql(`select (select count(*) from net._http_response where content like ${lit(`%${pushKey}%`)}) + (select count(*) from cron.job_run_details where command like ${lit(`%${pushKey}%`)})`), '0');
    }

    // ---- J: B6's purge end to end ------------------------------------------------------
    section('J purge: an expired trace removed, its trace_path cleared, scored_without_trace untouched', 8);
    {
      const u = await newUser('purge');
      const oldClient = `purge-old-${RUN}`;
      const newClient = `purge-new-${RUN}`;
      const bareClient = `purge-bare-${RUN}`;
      const gz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      for (const client of [oldClient, newClient]) {
        const key = `${u.id}/${client}.bin.gz`;
        const up = await api.user(u.jwt, 'POST', `/storage/v1/object/traces/${key}`, gz, { 'Content-Type': 'application/gzip', 'x-upsert': 'false' });
        if (up.status >= 300) throw new Error(`trace upload ${up.status} ${up.text}`);
        storageKeys.push(key);
      }
      const a = await api.service('POST', '/rest/v1/rpc/apply_trip', { p: envelope(u.id, oldClient, 60 * 60_000, 12_000, 900, 'final', null, `${u.id}/${oldClient}.bin.gz`) });
      const b = await api.service('POST', '/rest/v1/rpc/apply_trip', { p: envelope(u.id, newClient, 50 * 60_000, 12_000, 900, 'final', null, `${u.id}/${newClient}.bin.gz`) });
      const c = await api.service('POST', '/rest/v1/rpc/apply_trip', { p: envelope(u.id, bareClient, 40 * 60_000, 12_000, 900, 'final', null, null) });
      check('three trips applied', a.status < 300 && b.status < 300 && c.status < 300, `${a.status} ${a.text} ${b.status} ${c.status}`);
      // Past retention by the object's own age (half (a) of expired_trace_object_keys).
      sql(`update storage.objects set created_at = now() - interval '15 days' where bucket_id = 'traces' and name = ${lit(`${u.id}/${oldClient}.bin.gz`)}`);
      sql(`select vault.create_secret(${lit(`http://host.docker.internal:${apiPort}/functions/v1/purge-trace-objects`)}, 'purge_traces_url');
           select vault.create_secret(${lit(purgeKey)}, 'purge_traces_hmac_key');`);
      const lastResponse = Number(sql('select coalesce(max(id), 0) from net._http_response'));
      checkEq('dispatch_purge_traces() → dispatched', sql('select public.dispatch_purge_traces()'), 'dispatched');
      let reply = null;
      for (let i = 0; i < 30 && !reply; i++) {
        await sleep(1_000);
        reply = sqlJson(sql, `select row_to_json(t) from (select status_code, content from net._http_response where id > ${lastResponse} and content like '%expired_removed%' order by id desc limit 1) t`);
      }
      const body = reply ? JSON.parse(reply.content) : null;
      checkEq('the purge answered 200 done, one expired removed', reply && [reply.status_code, body.status, body.expired_removed, body.failed], [200, 'done', 1, 0]);
      const objects = sqlJson(sql, `select coalesce(json_agg(name order by name), '[]') from storage.objects where bucket_id = 'traces' and name like ${lit(`${u.id}/%`)}`);
      checkEq('the expired object is gone, the fresh one kept', objects, [`${u.id}/${newClient}.bin.gz`]);
      const trips = sqlJson(sql, `select json_object_agg(client_trip_id, json_build_array(trace_path, scored_without_trace)) from public.trips where user_id = ${lit(u.id)}`);
      checkEq('the purged trip\'s trace_path is cleared', trips && trips[oldClient][0], null);
      checkEq('its scored_without_trace is untouched (false: it was scored with its trace)', trips && trips[oldClient][1], false);
      checkEq('the fresh trip keeps its trace_path', trips && trips[newClient], [`${u.id}/${newClient}.bin.gz`, false]);
      checkEq('the trip scored without a trace still says so', trips && trips[bareClient], [null, true]);
    }

    // ---- K: the catalog and the CHECK agree ------------------------------------------
    section('K LIVE_TYPES equals the inbox.type CHECK', 1);
    {
      const def = sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.inbox'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%type = ANY%'`);
      const types = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
      checkEq('same types, same order', types, [...catalog.LIVE_TYPES]);
    }

    // ---- lock-screen and log hygiene ---------------------------------------------------
    section('hygiene: no key, token or copy in the functions log; copy names no person or place', 2);
    {
      const logText = serveLog.join('');
      const leaks = [pushKey, purgeKey, 'ExponentPushToken[', 'Automatic recording is off', 'X-Sweep-Signature'].filter((s) => logText.includes(s));
      checkEq('the functions log carries none of them', leaks, []);
      const shown = stub.state.messages.map((m) => `${m.title} ${m.body}`).join(' | ');
      check('no device id, run id or digit on any lock screen', !/e2e-|\d/.test(shown), shown);
    }
  } finally {
    closeSection();
    // ---- cleanup, on every path ------------------------------------------------------
    section('cleanup: nothing of this run is left behind', 4);
    try {
      sql(`delete from vault.secrets where name in (${VAULT_NAMES.map(lit).join(',')})`);
    } catch (e) {
      console.error(`vault cleanup: ${e.message}`);
    }
    if (storageKeys.length > 0) {
      await api.service('DELETE', '/storage/v1/object/traces', { prefixes: storageKeys }).catch(() => undefined);
    }
    if (users.length > 0) {
      try {
        sql(`delete from auth.users where id in (${users.map(lit).join(',')})`);
      } catch (e) {
        console.error(`user cleanup: ${e.message}`);
      }
    }
    if (serve) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(serve.pid), '/T', '/F'], { stdio: 'ignore' });
        else serve.kill();
      } catch {
        /* already gone */
      }
    }
    stub.server.close();
    try {
      fs.unlinkSync(ENV_FILE);
    } catch {
      /* never written */
    }
    checkEq('no Vault secret of this run', sql(`select count(*) from vault.secrets where name in (${VAULT_NAMES.map(lit).join(',')})`), '0');
    const leftover =
      users.length === 0
        ? []
        : sqlJson(
            sql,
            `select coalesce(json_agg(t), '[]') from (
               select c.table_name from information_schema.columns c
               join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
               where c.table_schema = 'public' and c.column_name = 'user_id') t`
          ).filter((r) => Number(sql(`select count(*) from public.${r.table_name} where user_id in (${users.map(lit).join(',')})`)) > 0);
    checkEq('no public row references a run user (auth cascade)', leftover.map((r) => r.table_name), []);
    checkEq('no storage object under a run user', users.length === 0 ? '0' : sql(`select count(*) from storage.objects where split_part(name, '/', 1) in (${users.map(lit).join(',')})`), '0');
    checkEq('the env file is gone', fs.existsSync(ENV_FILE), false);
    closeSection();
  }
}

function summarise() {
  closeSection();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed across ${sections.length} sections`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  [${f.section}] ${f.name} — ${f.detail}`);
  }
  return failed.length === 0;
}

main()
  .then(() => {
    if (!summarise()) process.exitCode = 1;
  })
  .catch((err) => {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    console.error(`\ne2e-push: ${err instanceof Error ? err.message : String(err)}${cause}`);
    summarise();
    process.exitCode = 1;
  });
