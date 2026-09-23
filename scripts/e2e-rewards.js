#!/usr/bin/env node
'use strict';
/**
 * The M5 rewards end-to-end: drives uploaded through the real `finalize-trip`, corrected through the
 * real `trip-actions`, settled by the real SQL engine, read back as stored — against the LOCAL stack
 * only.
 *
 *   node --experimental-strip-types scripts/e2e-rewards.js
 *
 * Sections (each declares its check count; a section that stops early fails the run):
 *   A  ledger       a safe phone-free day earns exactly 50 + 25, a ~60-score day nothing; a replayed
 *                   upload and a re-run settlement add nothing.
 *   B  finality     (rev1: R-A) after settlement nothing moves a day: an accepted dispute, a passenger
 *                   answer and a delete are recorded as contradictions and change no points, outcome
 *                   or streak; before settlement a passenger answer counts.
 *   H  watermark    (R-A) a device's synced_through holds a day until it passes the close; a device left
 *                   behind holds it at most 72 h; a future watermark is stored as now; a signed-out
 *                   phone holds nothing.
 *   I  zone hop     (R-B) two drives an hour apart in Kiritimati and Pago Pago: two day keys, one
 *                   earning day, one zone_hop contradiction.
 *   C  streak/goal  seven settled safe days: the streak milestone, one rewards push for the settlement
 *                   (§R9's highest priority), the weekly goal achieved +150 once.
 *   D  challenge    join_challenge('phone_down') through the user's JWT; ten passing driving days →
 *                   completed +200 once; safe_days_7 earned.
 *   E  referral     (flag on for the run, restored — R-F) invitee and referrer +500 once each; a shared
 *                   push token (R-C) and a shared device id → rejected, no points, no notification; a
 *                   15-day-old account → 'code window closed' for a real and a random code alike (R-D);
 *                   a wrong code through real PostgREST → HTTP 400 with the exact body, both budgets
 *                   charged (T6 security M-1); my_referrals' exact keys.
 *   J  concurrency  (R-G) `call public.settle_due_rewards(5000)` while 20 uploads run in parallel: every
 *                   upload 200, no lock wait above 2 s.
 *   F  security     no client DML on any rewards table, no settle RPC, no cross-user or anon reads.
 *   G  catalog      LIVE_TYPES equals the inbox.type CHECK; push-sender's policy defers a claimed
 *                   goal_completed inside quiet hours.
 *   cleanup         every user and row this run made is gone (asserted), the referral flag, the global
 *                   redeem budget and the settle-rewards job are as they were.
 *
 * Settlement is driven explicitly (T5 review m1): the settle-rewards cron job is paused for the run
 * (cron.alter_job, restored on every path) and each section calls settle_due_rewards_at(p_limit, p_now)
 * with the instant it is testing, or the real CALL (section J).
 *
 * Fixture moves made as postgres, each named where it happens: a challenge enrolment's start_day
 * backdated (a start is always tomorrow by design, and uploads cannot be in the future); a day's
 * inbox/goal state is never touched; auth.users.created_at backdated for the 15-day account (R-D).
 *
 * Local only, by construction: keys come from `npx supabase status -o json`, and the run refuses a
 * non-local API URL; nothing is sent anywhere but the local stack.
 */

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const mod = require('node:module');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
const RUN = crypto.randomBytes(3).toString('hex');
const HOUR = 3_600_000;
const MIN = 60_000;
const REWARD_TABLES = [
  'progress',
  'points_ledger',
  'reward_days',
  'reward_due',
  'weekly_goals',
  'reward_contradictions',
  'user_badges',
  'user_challenges',
  'referral_codes',
  'push_token_seen',
];

// ---------------------------------------------------------------------------
// Module hooks (as scripts/e2e-trip.js): `@scoring` and the extensionless imports the app writes.
// ---------------------------------------------------------------------------
const EXTENSIONS = ['.ts', '.tsx', '.js', '.json'];
function resolveSourceFile(base) {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) if (fs.existsSync(base + ext)) return base + ext;
  for (const ext of EXTENSIONS) {
    const index = path.join(base, `index${ext}`);
    if (fs.existsSync(index)) return index;
  }
  return null;
}
function aliasTarget(specifier, parentURL) {
  if (specifier === '@scoring') return path.join(ROOT, 'packages', 'scoring', 'src', 'index.ts');
  if (specifier.startsWith('@/')) return path.join(ROOT, 'src', specifier.slice(2));
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (typeof parentURL !== 'string' || !parentURL.startsWith('file:')) return null;
  const parent = fileURLToPath(parentURL);
  if (!parent.startsWith(ROOT) || parent.includes(`${path.sep}node_modules${path.sep}`)) return null;
  return path.resolve(path.dirname(parent), specifier);
}
function registerSourceHooks() {
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = aliasTarget(specifier, context.parentURL);
      const file = target === null ? null : resolveSourceFile(target);
      if (file === null) return nextResolve(specifier, context);
      const format = file.endsWith('.ts') || file.endsWith('.tsx') ? 'module-typescript' : undefined;
      return { url: pathToFileURL(file).href, format, shortCircuit: true };
    },
  });
}
const importSource = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

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
/** Canonical JSON (object keys sorted), so a comparison never depends on key order. */
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(canonical(v)));
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
  if (!m) throw new Error('e2e-rewards: no project_id in supabase/config.toml');
  return m[1];
}
/** SQL as postgres inside the database container, over stdin. */
function makeSql(container) {
  return (text) =>
    execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-q'], {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}
const lit = (s) => (s === null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const iso = (ms) => new Date(ms).toISOString();

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
      body: body === undefined ? undefined : JSON.stringify(body),
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
  return {
    url: API_URL,
    user: (jwt, method, url, body, extra = {}) => call(method, url, { ...asUser(jwt), ...extra }, body),
    anon: (method, url, body) => call(method, url, { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }, body),
    service: (method, url, body) => call(method, url, { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, body),
    fn: (name, body, jwt) => call('POST', `/functions/v1/${name}`, asUser(jwt), body),
  };
}

// ---------------------------------------------------------------------------
// Zoned time (Intl): local days, and the instant of a wall-clock time in a zone.
// ---------------------------------------------------------------------------
function parts(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms))) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  return p;
}
const pad = (n) => String(n).padStart(2, '0');
const localDay = (ms, tz) => {
  const p = parts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The instant a local wall-clock time names in `tz` (the later of a repeated hour). */
function zonedMs(day, hh, mm, tz) {
  const [y, mo, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  const offset = (t) => {
    const p = parts(t, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / MIN) * MIN;
  };
  const candidates = [offset(wall - 86_400_000), offset(wall + 86_400_000)].map((o) => wall - o);
  const exact = candidates.filter((c) => {
    const p = parts(c, tz);
    return p.year === y && p.month === mo && p.day === d && p.hour === hh && p.minute === mm;
  });
  return Math.max(...(exact.length > 0 ? exact : candidates));
}
/** §R2's wall close of a day: (D+1) 02:00 in the zone. */
const closeOf = (day, tz) => zonedMs(addDays(day, 1), 2, 0, tz);
/** A zone where it is daytime now, so today's and yesterday's closes are hours in the past. */
function daytimeZone(now) {
  for (const tz of ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland', 'America/Honolulu']) {
    const h = parts(now, tz).hour;
    if (h >= 6 && h <= 19) return tz;
  }
  throw new Error('e2e-rewards: no candidate zone is in daytime (cannot happen)');
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
async function main() {
  const stack = supabaseStatus();
  if (!LOCAL_URL.test(stack.API_URL)) throw new Error(`e2e-rewards: local stack only (API_URL is ${stack.API_URL})`);
  if (process.env.SUPABASE_URL && !LOCAL_URL.test(process.env.SUPABASE_URL)) throw new Error('e2e-rewards: SUPABASE_URL is not local');
  const container = `supabase_db_${projectId()}`;
  const sql = makeSql(container);
  const sqlJson = (text) => JSON.parse(sql(text) || 'null');
  const api = makeApi(stack);
  registerSourceHooks();
  const S = await importSource('packages/scoring/src/index.ts');
  const catalog = await import(pathToFileURL(path.join(ROOT, 'src', 'notifications', 'catalog.ts')).href);
  const policy = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', '_shared', 'push_policy.ts')).href);
  const serverCatalog = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', '_shared', 'catalog.ts')).href);

  const NOW = Date.now();
  const TZ = daytimeZone(NOW);
  const TODAY = localDay(NOW, TZ);
  const YESTERDAY = addDays(TODAY, -1);
  const at0205 = (day) => closeOf(day, TZ) + 5 * MIN;
  console.log(`zone ${TZ}, today ${TODAY}, run ${RUN}`);

  // what the run changes outside its own users, restored on every path
  const cronJob = sqlJson(`select row_to_json(t) from (select jobid, active from cron.job where jobname = 'settle-rewards') t`);
  if (!cronJob) throw new Error('e2e-rewards: no settle-rewards cron job (is 0009 applied?)');
  const flagsBefore = sqlJson(`select value from public.app_config where key = 'feature_flags'`);
  const globalBefore = sqlJson(`select row_to_json(g) from (select window_start, count from public.global_rate_limits where key = 'referral_redeem_global') g`);
  sql(`select cron.alter_job(${cronJob.jobid}, active := false)`);

  const users = [];
  let serve = null;
  const serveLog = [];
  try {
    // ---- the runtime -------------------------------------------------------------
    const ready = async () => {
      const r = await fetch(`${api.url}/functions/v1/finalize-trip`, { method: 'GET' }).catch(() => ({ status: 0 }));
      return [200, 400, 401, 405].includes(r.status);
    };
    if (!(await ready())) {
      console.log('starting `supabase functions serve` …');
      serve = spawn('npx', ['supabase', 'functions', 'serve'], { cwd: ROOT, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      serve.stdout.on('data', (d) => serveLog.push(String(d)));
      serve.stderr.on('data', (d) => serveLog.push(String(d)));
      const until = Date.now() + 150_000;
      let up = false;
      while (!up && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2_000));
        up = await ready();
      }
      if (!up) throw new Error(`BLOCKED: the functions runtime never answered.\n${serveLog.join('').slice(-3000)}`);
    }

    // ---- helpers over the stack ------------------------------------------------------
    const newUser = (label) => {
      const id = crypto.randomUUID();
      const jwt = devJwt(id);
      users.push(id);
      return { id, jwt, label };
    };
    let tripSeq = 0;
    /** A scored upload: `durationS` of driving from `startedAt`, with the given events. */
    const buildTrip = ({ startedAt, durationS = 900, tz = TZ, events = [] }) => {
      const clientTripId = `e2e-${RUN}-${++tripSeq}`;
      const distanceM = Math.round(durationS * 13.4);
      const evs = events.map((e, i) => {
        const base = {
          id: `${clientTripId}-ev${i}`,
          category: e.category,
          startedAt: startedAt + (i + 1) * 60_000,
          durationS: e.durationS,
          durationMs: Math.round(e.durationS * 1000),
          q: 0.9,
          corrected: false,
          status: 'scored',
          measured: e.measured,
          context: { night: false, precipitation: false },
          lat: null,
          lng: null,
          alertShown: false,
          source: e.category === 'speeding' ? 'gnss' : 'os',
          deduction: null,
        };
        return { ...base, severity: S.severity(base), contextMultiplier: S.contextMultiplier(base) };
      });
      // no trace → the server withholds the IMU (grade B at best): score as the server will
      const metrics = { distanceM, durationS, validGnssPct: 98, imuPresent: false, role: 'driver', maxSustainedSpeedMps: 20 };
      const provisional = S.scoreTrip(metrics, evs);
      return {
        clientTripId,
        startedAt,
        endedAt: startedAt + durationS * 1000,
        tz,
        distanceM,
        durationS,
        role: 'driver',
        roleConfidence: null,
        roleSource: 'manual',
        mode: 'mounted',
        cameraSession: false,
        provisional,
        events: evs.map((e) => ({ ...e, deduction: provisional.status === 'final' ? (provisional.eventDeductions[e.id] ?? 0) : null })),
        rowsDigest: { count: durationS, validGnssPct: 98, imuPresent: true, maxSustainedSpeedMps: 20, sha256: 'a'.repeat(64) },
        startGeohash5: null,
        endGeohash5: null,
        limitCoveragePct: 80,
        polyline: '',
        tracePath: null,
        hadSevereEvent: false,
        incomplete: false,
      };
    };
    const upload = async (u, payload) => {
      const r = await api.fn('finalize-trip', payload, u.jwt);
      if (r.status !== 200) console.log(`   (upload ${payload.clientTripId}: ${r.status} ${r.text.slice(0, 300)})`);
      return r;
    };
    /** One trip on `day` at local `hour`, uploaded; returns the payload and the response. */
    const drive = async (u, day, hour, opts = {}) => {
      const payload = buildTrip({ startedAt: zonedMs(day, hour, 0, opts.tz ?? TZ), ...opts });
      return { payload, res: await upload(u, payload) };
    };
    const PHONE = (durationS) => ({ category: 'phone', durationS, measured: { speedMps: 15 } });
    const SPEEDING = { category: 'speeding', durationS: 60, measured: { overMps: 6, limitMps: 15.6464 } };
    // a sweep never runs before the writes it must see: the enqueue queues at greatest(now, the day's close)
    // (final review I1), so a simulated instant already in the past is taken as now.
    // settle_due_rewards_at swallows a user's failed settlement (it backs the user off 1 h and counts them
    // done), so every sweep is followed by a check that no run user failed. A failure is retried once by
    // settling that user directly at the same instant: a transient (a 55P03 lock timeout against this
    // run's own concurrent writes) then succeeds and is logged; a real error raises there, and the user,
    // its failure count and the error are printed as evidence (0009 keeps no last_error column).
    const runUsers = () => `array[${users.map(lit).join(', ')}]::uuid[]`;
    const settle = (ms) => {
      const at = sql(`select greatest(${lit(iso(ms))}::timestamptz, now())`);
      const n = Number(sql(`select public.settle_due_rewards_at(500, ${lit(at)}::timestamptz)`));
      const failed = sqlJson(`select coalesce(json_agg(json_build_array(user_id, failures) order by user_id), '[]')
        from public.reward_due where user_id = any(${runUsers()}) and failures > 0`);
      const unrecovered = [];
      for (const [uid, failures] of failed) {
        try {
          sql(`select public.settle_rewards(${lit(uid)}, ${lit(at)}::timestamptz)`);
          console.log(`   (the sweep at ${at} failed ${uid}'s settlement (failures ${failures}); one retry succeeded)`);
        } catch (e) {
          unrecovered.push(`${uid} failures=${failures} error=${String(e.stderr || e.message).trim()}`);
        }
      }
      check('the sweep failed no settlement of this run (after at most one retry)', unrecovered.length === 0, unrecovered.join(' | '));
      // evidence for a sweep that silently skipped a user: a run user queued within a minute after the
      // sweep's instant (an enqueue at now() that the sweep could not see) is logged, never asserted
      const justMissed = sqlJson(`select coalesce(json_agg(json_build_array(user_id, due_at, failures)), '[]') from public.reward_due
        where user_id = any(${runUsers()}) and due_at > ${lit(at)}::timestamptz and due_at <= ${lit(at)}::timestamptz + interval '1 minute'`);
      if (justMissed.length > 0) console.log(`   (the sweep at ${at} left run users queued just after it: ${JSON.stringify(justMissed)})`);
      return n;
    };
    const ledger = (uid) =>
      sqlJson(`select coalesce(json_agg(json_build_array(type, amount, ref_key) order by type, ref_key), '[]') from public.points_ledger where user_id = ${lit(uid)}`);
    const rewardDay = (uid, day) =>
      sqlJson(`select row_to_json(t) from (select outcome, outcome_reason, tier, phone_free, points, streak_after, predicates
               from public.reward_days where user_id = ${lit(uid)} and day = ${lit(day)}) t`);
    const scoreDay = (uid, day) =>
      sqlJson(`select row_to_json(t) from (select safe_day, good_day, phone_free_day, trips_scored, trips_all from public.score_daily where user_id = ${lit(uid)} and day = ${lit(day)}) t`);
    const contradictions = (uid, kind) =>
      sqlJson(`select coalesce(json_agg(json_build_array(day, detail) order by created_at), '[]') from public.reward_contradictions where user_id = ${lit(uid)} and kind = ${lit(kind)}`);
    const progress = (uid) =>
      sqlJson(`select row_to_json(t) from (select points, streak_days, best_streak, safe_days, settled_through, level from public.progress where user_id = ${lit(uid)}) t`);
    const rewardsInbox = (uid) =>
      sqlJson(`select coalesce(json_agg(json_build_array(type, push_state, push_reason, payload) order by created_at, dedupe_key), '[]') from public.inbox
               where user_id = ${lit(uid)} and type in ('streak_milestone', 'goal_completed', 'level_up', 'referral_qualified')`);
    const rpc = (u, fn, body = {}) => api.user(u.jwt, 'POST', `/rest/v1/rpc/${fn}`, body);
    const tripAction = (u, body) => api.fn('trip-actions', body, u.jwt);
    const addDevice = async (u, id, extra = {}) => {
      const r = await api.user(u.jwt, 'POST', '/rest/v1/devices', { id, user_id: u.id, platform: 'ios', ...extra }, { Prefer: 'return=minimal' });
      if (r.status >= 300) throw new Error(`device insert ${r.status} ${r.text}`);
    };
    const patchDevice = (u, id, fields) =>
      api.user(u.jwt, 'PATCH', `/rest/v1/devices?user_id=eq.${u.id}&id=eq.${encodeURIComponent(id)}`, fields, { Prefer: 'return=minimal' });

    // ---- A: the ledger ------------------------------------------------------------
    section('A ledger: a safe phone-free day earns 50 + 25, a ~60 day nothing; replays add nothing', 13);
    const A = newUser('a');
    {
      const B = newUser('b');
      const a1 = await drive(A, YESTERDAY, 12);
      const b1 = await drive(B, YESTERDAY, 12, { events: [PHONE(18), SPEEDING] });
      checkEq('both uploads 200', [a1.res.status, b1.res.status], [200, 200]);
      const bScore = b1.payload.provisional.score;
      check(`B's drive scores about 60 (${bScore}): not good, not phone-free`, bScore >= 50 && bScore < 70, `score ${bScore}`);
      settle(at0205(TODAY));
      checkEq('A: exactly 50 + 25', ledger(A.id), [['phone_free_day', 25, YESTERDAY], ['safe_day', 50, YESTERDAY]]);
      checkEq('A: the settled day', rewardDay(A.id, YESTERDAY) && [rewardDay(A.id, YESTERDAY).outcome, rewardDay(A.id, YESTERDAY).tier, rewardDay(A.id, YESTERDAY).points], ['safe', 'safe', 75]);
      checkEq('B: nothing', ledger(B.id), []);
      const bDay = rewardDay(B.id, YESTERDAY);
      checkEq('B: settled with no tier, no bonus, 0 points', bDay && [bDay.tier, bDay.phone_free, bDay.points], ['none', false, 0]);
      const a2 = await upload(A, a1.payload);
      const b2 = await upload(B, b1.payload);
      checkEq('replays answer 200 replayed', [a2.status, a2.json?.replayed, b2.status, b2.json?.replayed], [200, true, 200, true]);
      settle(at0205(TODAY));
      settle(NOW);
      checkEq('a re-run settlement adds nothing to A', ledger(A.id).length, 2);
      checkEq('nor to B', ledger(B.id).length, 0);
      checkEq('A progress 75 points', progress(A.id)?.points, 75);
    }

    // ---- B: finality -----------------------------------------------------------------
    section('B finality: after settlement a dispute, a passenger answer and a delete change nothing but the record', 24);
    {
      const F = newUser('final');
      const dGood = addDays(TODAY, -4);
      const dBad = addDays(TODAY, -3);
      const dSafe = addDays(TODAY, -2);
      const good = await drive(F, dGood, 12, { events: [PHONE(12)] });
      const bad = await drive(F, dBad, 12, { events: [PHONE(18), SPEEDING] });
      const safe = await drive(F, dSafe, 12);
      checkEq('three uploads 200', [good.res.status, bad.res.status, safe.res.status], [200, 200, 200]);
      settle(at0205(TODAY));
      const goodDay = rewardDay(F.id, dGood);
      checkEq(`the good day (${good.payload.provisional.score}) settled good, 20 points`, goodDay && [goodDay.tier, goodDay.points], ['good', 20]);
      const ledger0 = ledger(F.id);
      const prog0 = progress(F.id);
      const days0 = [dGood, dBad, dSafe].map((d) => rewardDay(F.id, d));

      // (1) an accepted dispute removes the good day's only event
      const ev = good.payload.events[0].id;
      const disp = await tripAction(F, { action: 'dispute', clientEventId: ev, reason: 'phone_moved' });
      checkEq('the dispute is accepted', [disp.status, disp.json?.autoAccepted], [200, true]);
      checkEq('score_daily for the day is now safe', scoreDay(F.id, dGood)?.safe_day, true);
      settle(NOW);
      checkEq('the reward day is unchanged', rewardDay(F.id, dGood), days0[0]);
      checkEq('one changed_after_settlement contradiction for it', contradictions(F.id, 'changed_after_settlement').filter(([d]) => d === dGood).length, 1);

      // (2) passenger on a settled unsafe day's drive
      const role = await tripAction(F, { action: 'set-role', clientTripId: bad.payload.clientTripId, role: 'passenger' });
      checkEq('the passenger answer is stored', role.status, 200);
      settle(NOW);
      checkEq('the unsafe day is unchanged', rewardDay(F.id, dBad), days0[1]);
      const relabel = contradictions(F.id, 'relabel_with_events').filter(([d]) => d === dBad);
      checkEq('one relabel_with_events row, marked settled', relabel.map(([, detail]) => [detail.to, detail.daySettled]), [['passenger', true]]);
      // (final review m1) the bad day settled neutral (a new driver's provisional 'learning' day), and with no driver drive it would
      // settle neutral again: nothing about the result changed, so the relabel row is the only record
      checkEq('no changed_after_settlement row for that day (its result would not change)', contradictions(F.id, 'changed_after_settlement').filter(([d]) => d === dBad).length, 0);

      // (3) delete the safe day's drive
      const del = await tripAction(F, { action: 'delete', clientTripId: safe.payload.clientTripId });
      checkEq('the delete is stored', del.status, 200);
      checkEq('score_daily for that day is no longer safe (Task 3)', scoreDay(F.id, dSafe)?.safe_day, false);
      settle(NOW);
      checkEq('the settled outcome is unchanged', rewardDay(F.id, dSafe), days0[2]);
      checkEq('and recorded as a contradiction', contradictions(F.id, 'changed_after_settlement').filter(([d]) => d === dSafe).length, 1);

      checkEq('points unchanged by all three', ledger(F.id), ledger0);
      const prog1 = progress(F.id);
      checkEq('streak unchanged by all three', prog1 && [prog1.points, prog1.streak_days, prog1.best_streak], prog0 && [prog0.points, prog0.streak_days, prog0.best_streak]);

      // (4) before settlement a passenger answer counts
      const P = newUser('pre');
      const pBad = await drive(P, YESTERDAY, 12, { events: [PHONE(18), SPEEDING] });
      checkEq('an unsettled bad drive uploaded', pBad.res.status, 200);
      const pRole = await tripAction(P, { action: 'set-role', clientTripId: pBad.payload.clientTripId, role: 'passenger' });
      checkEq('answered passenger before the close', pRole.status, 200);
      settle(at0205(TODAY));
      const pDay = rewardDay(P.id, YESTERDAY);
      checkEq('the day settles per the new facts: no driver drive, not unsafe', pDay && [pDay.outcome, pDay.outcome_reason, pDay.points], ['neutral', 'no_drive', 0]);
    }

    // ---- H: the watermark --------------------------------------------------------------
    section('H watermark: a device holds a day until it syncs past the close, at most 72 h; signed out holds nothing', 13);
    {
      const C = closeOf(YESTERDAY, TZ);
      const W1 = newUser('w1');
      const W2 = newUser('w2');
      const W3 = newUser('w3');
      for (const [u, id] of [[W1, 'w1'], [W2, 'w2'], [W3, 'w3']]) {
        await addDevice(u, `e2e-${id}-${RUN}`);
        const r = await patchDevice(u, `e2e-${id}-${RUN}`, { synced_through: iso(C - HOUR) });
        if (r.status >= 300) throw new Error(`watermark patch ${r.status} ${r.text}`);
        await drive(u, YESTERDAY, 12);
      }
      const r3 = await patchDevice(W3, `e2e-w3-${RUN}`, { signed_out_at: iso(NOW) });
      checkEq('W3 signs out (signed_out_at written by the client)', r3.status, 204);
      settle(C + HOUR);
      checkEq('close + 1 h, W1\'s phone synced only to before the close: not settled', rewardDay(W1.id, YESTERDAY), null);
      checkEq('W3\'s signed-out phone holds nothing: settled', rewardDay(W3.id, YESTERDAY)?.outcome, 'safe');
      const p1 = await patchDevice(W1, `e2e-w1-${RUN}`, { synced_through: iso(Date.now()) });
      checkEq('W1\'s phone PATCHes a watermark after the close (204)', p1.status, 204);
      settle(Math.max(C + 2 * HOUR, Date.now()));
      checkEq('the next run settles W1', rewardDay(W1.id, YESTERDAY)?.outcome, 'safe');
      settle(C + 71 * HOUR);
      checkEq('W2\'s phone left behind still holds the day at close + 71 h', rewardDay(W2.id, YESTERDAY), null);
      settle(C + 72 * HOUR + MIN);
      checkEq('… and no longer at close + 72 h', rewardDay(W2.id, YESTERDAY)?.outcome, 'safe');
      const f = await patchDevice(W1, `e2e-w1-${RUN}`, { synced_through: iso(Date.now() + 24 * HOUR) });
      const stored = Date.parse(sqlJson(`select to_json(synced_through) from public.devices where user_id = ${lit(W1.id)}`));
      checkEq('a future watermark is accepted (204)', f.status, 204);
      check('… and stored as now', stored <= Date.now() + 5_000 && stored >= Date.now() - 60_000, `stored ${iso(stored)}`);
    }

    // ---- I: the zone hop -----------------------------------------------------------
    section('I zone hop: Kiritimati then Pago Pago an hour apart → two day keys, one earning day, one zone_hop', 6);
    {
      const Z = newUser('zone');
      // two instants an hour apart at 05:00 and 06:00 UTC (never 10:00 UTC, where the two zones' dates are 2 apart)
      const todayUtc = new Date(NOW).toISOString().slice(0, 10);
      let u0 = Date.parse(`${todayUtc}T05:00:00Z`);
      if (u0 + 90 * MIN > NOW) u0 -= 86_400_000;
      const k = buildTrip({ startedAt: u0, tz: 'Pacific/Kiritimati' });
      const p = buildTrip({ startedAt: u0 + HOUR, tz: 'Pacific/Pago_Pago' });
      const rk = await upload(Z, k);
      const rp = await upload(Z, p);
      checkEq('both uploads 200', [rk.status, rp.status], [200, 200]);
      const dK = localDay(u0, 'Pacific/Kiritimati');
      const dP = localDay(u0 + HOUR, 'Pacific/Pago_Pago');
      // (an upload also writes today's day row, empty when it holds no drive: only days with drives count here)
      const keys = sqlJson(`select coalesce(json_agg(day order by day), '[]') from public.score_daily where user_id = ${lit(Z.id)} and trips_all > 0`);
      checkEq('two day keys, one per zone', keys, [dP, dK].sort());
      settle(Math.max(closeOf(dK, 'Pacific/Kiritimati'), closeOf(dP, 'Pacific/Pago_Pago')) + 5 * MIN);
      const rows = [dP, dK].sort().map((d) => rewardDay(Z.id, d));
      checkEq('one earning day, the other settled as a zone hop', rows.map((r) => r && [r.tier, r.outcome_reason]).sort(), [['none', 'zone_hop'], ['safe', 'safe']]);
      checkEq('one zone_hop contradiction', contradictions(Z.id, 'zone_hop').length, 1);
      checkEq('points for one day only', ledger(Z.id).reduce((s, [, amount]) => s + amount, 0), 75);
      if (rows.some((r) => r === null)) {
        // evidence for an unsettled zone-hop pair (seen once, 2026-09-23 06:29 UTC): the user's queue row,
        // day rows and trips at the check
        console.log(`   (zone hop unsettled: u0 ${iso(u0)}, now ${iso(Date.now())}, state ${JSON.stringify(sqlJson(`select json_build_object(
          'due', (select json_agg(r) from public.reward_due r where user_id = ${lit(Z.id)}),
          'days', (select json_agg(json_build_array(day, trips_all, updated_at) order by day) from public.score_daily where user_id = ${lit(Z.id)}),
          'trips', (select json_agg(json_build_array(local_day, tz, started_at) order by started_at) from public.trips where user_id = ${lit(Z.id)}),
          'settled', (select json_agg(json_build_array(day, outcome_reason) order by day) from public.reward_days where user_id = ${lit(Z.id)}),
          'dbNow', now())`))})`);
      }
    }

    // ---- C: streak and weekly goal -------------------------------------------------
    section('C streak and goal: seven safe days → the milestone, one push for the settlement, the goal +150 once', 11);
    {
      const U = newUser('streak');
      const days = [7, 6, 5, 4, 3, 2, 1].map((n) => addDays(TODAY, -n));
      const statuses = [];
      for (const d of days) statuses.push((await drive(U, d, 12)).res.status);
      checkEq('seven uploads 200', statuses, [200, 200, 200, 200, 200, 200, 200]);
      settle(at0205(TODAY));
      checkEq('seven safe settled days', days.map((d) => rewardDay(U.id, d)?.outcome), days.map(() => 'safe'));
      const prog = progress(U.id);
      checkEq('the streak is 7', prog && [prog.streak_days, prog.best_streak], [7, 7]);
      const inbox = rewardsInbox(U.id);
      console.log(`   (rewards inbox: ${inbox.map(([type, state, , payload]) => `${type}${payload.kind ? `/${payload.kind}` : ''}:${state}`).join(', ')})`);
      const milestone = inbox.find(([type, , , payload]) => type === 'streak_milestone' && payload.days === 7);
      check('a streak_milestone row for 7 days', !!milestone, show(inbox));
      const pending = inbox.filter(([, state]) => state === 'pending');
      const others = inbox.filter(([, state]) => state !== 'pending');
      checkEq('exactly one rewards row pending for the settlement', pending.length, 1);
      checkEq('every other one skipped/inbox_only', others.every(([, state, reason]) => state === 'skipped' && reason === 'inbox_only'), true);
      const priority = { referral_qualified: 5, goal_completed: 4, level_up: 3, streak_milestone: 1 };
      const rank = ([type, , , payload]) => (type === 'level_up' && payload.kind === 'badge' ? 2 : priority[type]);
      checkEq('the pending one is the highest priority present (§R9)', pending[0] && rank(pending[0]), Math.max(...inbox.map(rank)));
      // the ISO week holding at least four of the seven days
      const weekOf = (d) => {
        const dt = new Date(`${d}T00:00:00Z`);
        return addDays(d, -((dt.getUTCDay() + 6) % 7));
      };
      const counts = {};
      for (const d of days) counts[weekOf(d)] = (counts[weekOf(d)] ?? 0) + 1;
      const week = Object.keys(counts).find((w) => counts[w] >= 4);
      const goal = sqlJson(`select row_to_json(t) from (select state, pass_days from public.weekly_goals where user_id = ${lit(U.id)} and week_start = ${lit(week)}) t`);
      checkEq(`the week of ${week} (${counts[week]} days) achieved its goal`, goal?.state, 'achieved');
      settle(at0205(TODAY));
      checkEq('+150 once for it, after a re-run too', ledger(U.id).filter(([type, , ref]) => type === 'weekly_goal' && ref === week), [['weekly_goal', 150, week]]);
    }

    // ---- D: challenge and badges ----------------------------------------------------
    section('D challenge and badges: phone_down joined → ten passing days → +200 once; safe_days_7', 8);
    {
      const U = newUser('challenge');
      const join = await rpc(U, 'join_challenge', { p_def_id: 'phone_down' });
      checkEq('join_challenge through the user\'s JWT (200), starting tomorrow', [join.status, join.json?.start_day], [200, addDays(TODAY, 1)]);
      // FIXTURE (as postgres): a start is always tomorrow and an upload can't be in the future, so the
      // enrolment is moved back ten days to let already-driven days count
      sql(`update public.user_challenges set start_day = ${lit(addDays(TODAY, -10))} where id = ${lit(join.json?.id)}`);
      const statuses = [];
      for (let n = 10; n >= 1; n--) statuses.push((await drive(U, addDays(TODAY, -n), 12)).res.status);
      checkEq('ten uploads 200', statuses.every((s) => s === 200), true);
      settle(at0205(TODAY));
      const uc = sqlJson(`select row_to_json(t) from (select state, pass_days from public.user_challenges where id = ${lit(join.json?.id)}) t`);
      checkEq('the challenge completed on ten passing days', uc && [uc.state, uc.pass_days], ['completed', 10]);
      settle(at0205(TODAY));
      checkEq('+200 once, after a re-run too', ledger(U.id).filter(([type]) => type === 'challenge').map(([, amount]) => amount), [200]);
      const badges = sqlJson(`select coalesce(json_agg(badge_id order by badge_id), '[]') from public.user_badges where user_id = ${lit(U.id)}`);
      check('safe_days_7 earned', badges.includes('safe_days_7'), show(badges));
      check('a goal_completed challenge row in the inbox', rewardsInbox(U.id).some(([type, , , payload]) => type === 'goal_completed' && payload.kind === 'challenge' && payload.challengeId === 'phone_down'), show(rewardsInbox(U.id)));
    }

    // ---- E: referral -------------------------------------------------------------------
    section('E referral: +500 once each side; shared token or device rejected; window, wrong code, keys', 29);
    {
      sql(`update public.app_config set value = value || '{"referral": true}'::jsonb where key = 'feature_flags'`);
      const R = newUser('referrer');
      const code = (await rpc(R, 'get_my_referral_code')).json?.code;
      check('R has a code', typeof code === 'string' && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code), show(code));
      // R's phone: a device and a push token (R-C's history)
      const rDevice = `e2e-rdev-${RUN}`;
      await addDevice(R, rDevice);
      const token = `ExponentPushToken[e2e-${RUN}-shared]`;
      const reg = await rpc(R, 'register_push_token', { p_device_id: rDevice, p_token: token });
      checkEq('R registers a push token', reg.status, 204);

      const threeDrives = async (u) => {
        const start = Date.now() + MIN;
        const out = [];
        for (let i = 0; i < 3; i++) {
          out.push((await upload(u, buildTrip({ startedAt: start + i * 5 * MIN, durationS: 240 }))).status);
        }
        return out;
      };
      const settleToday = () => settle(at0205(addDays(TODAY, 1)));

      // I: an honest invitee
      const I = newUser('invitee');
      const red = await rpc(I, 'redeem_referral_code', { p_code: code.toLowerCase().replace(/(.{4})/, '$1-') });
      checkEq('I redeems R\'s code (typed lower-case with a hyphen)', [red.status, red.json], [200, { status: 'pending' }]);
      checkEq('three drives after redeeming', await threeDrives(I), [200, 200, 200]);
      settleToday();
      checkEq('I +500 once', ledger(I.id).filter(([type]) => type === 'referral').map(([, a]) => a), [500]);
      checkEq('R +500 once', ledger(R.id).filter(([type]) => type === 'referral').map(([, a]) => a), [500]);
      settleToday();
      checkEq('a re-run adds nothing to either', [ledger(I.id), ledger(R.id)].map((l) => l.filter(([type]) => type === 'referral').length), [1, 1]);
      const refInbox = (u) => rewardsInbox(u.id).filter(([type]) => type === 'referral_qualified').map(([, , , p]) => p.role);
      checkEq('one referral notification each', [refInbox(I), refInbox(R)], [['invitee'], ['referrer']]);

      // I2: shares R's push token (reassigned through register_push_token) → rejected
      const I2 = newUser('tokenshare');
      await addDevice(I2, `e2e-i2dev-${RUN}`);
      const reg2 = await rpc(I2, 'register_push_token', { p_device_id: `e2e-i2dev-${RUN}`, p_token: token });
      checkEq('I2 registers the same token (it moves)', reg2.status, 204);
      checkEq('I2 redeems', (await rpc(I2, 'redeem_referral_code', { p_code: code })).json, { status: 'pending' });
      await threeDrives(I2);
      settleToday();
      const st2 = sqlJson(`select row_to_json(t) from (select status, reject_reason from public.referrals where invitee_id = ${lit(I2.id)}) t`);
      checkEq('R-C: rejected as a shared device', st2 && [st2.status, st2.reject_reason], ['rejected', 'shared_device']);

      // S: carries one of R's device ids → rejected
      const S2 = newUser('deviceshare');
      await addDevice(S2, rDevice);
      checkEq('S redeems', (await rpc(S2, 'redeem_referral_code', { p_code: code })).json, { status: 'pending' });
      await threeDrives(S2);
      settleToday();
      const st3 = sqlJson(`select row_to_json(t) from (select status, reject_reason from public.referrals where invitee_id = ${lit(S2.id)}) t`);
      checkEq('a shared device id: rejected', st3 && [st3.status, st3.reject_reason], ['rejected', 'shared_device']);
      checkEq('no referral points for I2 or S', [ledger(I2.id), ledger(S2.id)].map((l) => l.filter(([type]) => type === 'referral').length), [0, 0]);
      checkEq('R still +500 once', ledger(R.id).filter(([type]) => type === 'referral').length, 1);
      checkEq('no referral notification for I2 or S, and still one for R', [refInbox(I2), refInbox(S2), refInbox(R)], [[], [], ['referrer']]);

      // O: a 15-day-old account (FIXTURE: auth.users.created_at moved back, as postgres)
      const O = newUser('old');
      sql(`update auth.users set created_at = now() - interval '15 days' where id = ${lit(O.id)}`);
      const random = Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('');
      const o1 = await rpc(O, 'redeem_referral_code', { p_code: code });
      const o2 = await rpc(O, 'redeem_referral_code', { p_code: random });
      checkEq('R-D: a real code → code window closed (400)', [o1.status, o1.json?.message], [400, 'code window closed']);
      checkEq('… a random code → the identical answer', [o2.status, o2.json], [o1.status, o1.json]);

      // X: a wrong code through the real PostgREST (T6 security M-1)
      const X = newUser('wrongcode');
      let wrong;
      do {
        wrong = Array.from({ length: 8 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('');
      } while (Number(sql(`select count(*) from public.referral_codes where code = ${lit(wrong)}`)) > 0);
      const g0 = sqlJson(`select row_to_json(g) from (select count, (window_start + interval '1 hour' <= now()) as expired from public.global_rate_limits where key = 'referral_redeem_global') g`);
      const w = await rpc(X, 'redeem_referral_code', { p_code: wrong });
      checkEq('HTTP 400 with the exact PostgREST body', [w.status, w.json], [400, { code: '22023', details: null, hint: null, message: 'invalid code' }]);
      const userBudget = Number(sql(`select coalesce((select count from public.rate_limits where user_id = ${lit(X.id)} and key = 'referral_redeem'), 0)`));
      const g1 = Number(sql(`select count from public.global_rate_limits where key = 'referral_redeem_global'`));
      checkEq('the user budget was charged (committed)', userBudget, 1);
      checkEq('the global budget was charged (committed)', g1, g0 && !g0.expired ? g0.count + 1 : 1);
      const m = await rpc(X, 'redeem_referral_code', { p_code: 'no!' });
      const userBudget2 = Number(sql(`select count from public.rate_limits where user_id = ${lit(X.id)} and key = 'referral_redeem'`));
      const g2 = Number(sql(`select count from public.global_rate_limits where key = 'referral_redeem_global'`));
      checkEq('a malformed code: 400 invalid code, the user budget charged, the global one not (r1-M3)', [m.status, m.json?.message, userBudget2, g2], [400, 'invalid code', 2, g1]);

      // my_referrals: exactly the documented keys for everyone
      const KEYS = ['canRedeem', 'cap', 'code', 'joined', 'myCode', 'qualified', 'rewardedThisYear'];
      const shapes = [];
      for (const u of [R, I, I2, S2, O, X]) {
        const r = await rpc(u, 'my_referrals');
        shapes.push(r.status === 200 && r.json ? Object.keys(r.json).sort().join(',') : `${r.status}`);
      }
      checkEq('my_referrals has exactly the documented keys for every user', [...new Set(shapes)], [KEYS.join(',')]);
      const mine = (await rpc(I, 'my_referrals')).json;
      const theirs = (await rpc(R, 'my_referrals')).json;
      checkEq('I reads counted; R reads its counts, nothing about anyone', [mine?.myCode, theirs?.qualified, theirs?.joined], ['counted', 1, 3]);
      sql(`update public.app_config set value = ${lit(JSON.stringify(flagsBefore))}::jsonb where key = 'feature_flags'`);
      checkEq('the referral flag is restored', sqlJson(`select value from public.app_config where key = 'feature_flags'`), flagsBefore);
    }

    // ---- J: concurrency ----------------------------------------------------------------
    section('J concurrency: the CALL settles while 20 uploads run: every upload 200, no lock wait above 2 s', 5);
    {
      const J = [];
      for (let i = 0; i < 20; i++) J.push(newUser(`j${i}`));
      // a backlog the CALL will be settling: ten days of drives each, due now (uploaded 20 at a time)
      for (let n = 10; n >= 1; n--) await Promise.all(J.map((u) => drive(u, addDays(TODAY, -n), 9)));
      // a sampler of lock waits (pg_stat_activity, fresh snapshot each 50 ms) for the whole window
      const sampler = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-q', '-c',
        `do $$ declare m float := 0; v float; begin
           for i in 1 .. 300 loop
             perform pg_stat_clear_snapshot();
             select coalesce(max(extract(epoch from clock_timestamp() - query_start)), 0) into v
               from pg_stat_activity where wait_event_type = 'Lock' and pid <> pg_backend_pid();
             m := greatest(m, v);
             perform pg_sleep(0.05);
           end loop;
           raise notice 'maxwait=%', m;
         end $$;`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let samplerOut = '';
      sampler.stdout.on('data', (d) => (samplerOut += String(d)));
      sampler.stderr.on('data', (d) => (samplerOut += String(d)));
      const samplerDone = new Promise((resolve) => sampler.on('close', resolve));
      await new Promise((r) => setTimeout(r, 300));
      const callStart = Date.now();
      let callEnd = 0;
      const proc = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'call public.settle_due_rewards(5000)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let procOut = '';
      proc.stderr.on('data', (d) => (procOut += String(d)));
      const procDone = new Promise((resolve) =>
        proc.on('close', (c) => {
          callEnd = Date.now();
          resolve(c);
        })
      );
      // rounds of 20 parallel uploads (the same users' later drives yesterday) for as long as the CALL runs
      const spans = [];
      const results20 = [];
      for (let round = 0; round < 8 && (round === 0 || callEnd === 0); round++) {
        const statuses = await Promise.all(
          J.map(async (u) => {
            const t0 = Date.now();
            const status = (await drive(u, YESTERDAY, 11 + round)).res.status;
            spans.push([t0, Date.now()]);
            return status;
          })
        );
        results20.push(...statuses);
      }
      const code = await procDone;
      await samplerDone;
      const maxWait = Number((/maxwait=([0-9.eE+-]+)/.exec(samplerOut) || [])[1]);
      const during = spans.filter(([a, b]) => a >= callStart && b <= callEnd).length;
      console.log(`   (${results20.length} uploads in ${results20.length / 20} rounds; ${during} started and finished inside the CALL's ${callEnd - callStart} ms)`);
      check('uploads ran inside the CALL', during > 0, `${during} of ${results20.length}`);
      checkEq('every upload 200', results20.every((st) => st === 200) ? 'all 200' : results20, 'all 200');
      checkEq('the CALL finished cleanly', [code, procOut.includes('ERROR')], [0, false]);
      check(`no lock wait above 2 s (max observed ${Number.isFinite(maxWait) ? maxWait.toFixed(3) : '?'} s)`, Number.isFinite(maxWait) && maxWait < 2, samplerOut.trim());
      checkEq('the CALL settled the whole backlog', J.filter((u) => rewardDay(u.id, YESTERDAY) !== null).length, 20);
    }

    // ---- F: security -------------------------------------------------------------------
    section('F security: no client DML, no settle RPC, no cross-user or anon reads', 6);
    {
      const B2 = newUser('other');
      const before = sqlJson(`select json_build_object(${REWARD_TABLES.map((t) => `${lit(t)}, (select count(*) from public.${t})`).join(', ')}, 'referrals', (select count(*) from public.referrals), 'badge_defs', (select count(*) from public.badge_defs), 'challenge_defs', (select count(*) from public.challenge_defs))`);
      const refused = [];
      for (const t of [...REWARD_TABLES, 'referrals', 'badge_defs', 'challenge_defs']) {
        const key = t.endsWith('_defs') ? 'id' : t === 'referrals' ? 'invitee_id' : 'user_id';
        const val = t.endsWith('_defs') ? 'x' : A.id;
        const ins = await api.user(A.jwt, 'POST', `/rest/v1/${t}`, { [key]: val }, { Prefer: 'return=minimal' });
        const upd = await api.user(A.jwt, 'PATCH', `/rest/v1/${t}?${key}=eq.${val}`, { created_at: iso(NOW) }, { Prefer: 'return=minimal' });
        const dlt = await api.user(A.jwt, 'DELETE', `/rest/v1/${t}?${key}=eq.${val}`, undefined, { Prefer: 'return=minimal' });
        for (const [verb, r] of [['insert', ins], ['update', upd], ['delete', dlt]]) if (r.status < 400) refused.push(`${verb} ${t} → ${r.status}`);
      }
      checkEq('INSERT, UPDATE and DELETE on every rewards table are refused for A', refused, []);
      const after = sqlJson(`select json_build_object(${REWARD_TABLES.map((t) => `${lit(t)}, (select count(*) from public.${t})`).join(', ')}, 'referrals', (select count(*) from public.referrals), 'badge_defs', (select count(*) from public.badge_defs), 'challenge_defs', (select count(*) from public.challenge_defs))`);
      checkEq('and no row changed', after, before);
      const rpcs = [];
      for (const [fn, body] of [
        ['settle_rewards', { p_user: A.id, p_now: iso(NOW) }],
        ['settle_due_rewards_at', { p_limit: 1, p_now: iso(NOW) }],
        ['settle_days', { p_user: A.id, p_tz: TZ, p_now: iso(NOW) }],
        ['reward_credit', { p_user: A.id, p_type: 'safe_day', p_amount: 1000, p_ref: 'x', p_key: 'x' }],
        ['settle_referrals', { p_user: A.id, p_now: iso(NOW) }],
      ]) {
        const r = await rpc(A, fn, body);
        if (r.status < 400) rpcs.push(`${fn} → ${r.status}`);
      }
      checkEq('the settle and credit functions are refused to a client', rpcs, []);
      checkEq('A\'s ledger unchanged by it all', ledger(A.id).length, 2);
      const leaks = [];
      for (const t of ['progress', 'points_ledger', 'reward_days', 'weekly_goals', 'user_badges', 'user_challenges']) {
        const r = await api.user(B2.jwt, 'GET', `/rest/v1/${t}?user_id=eq.${A.id}&select=user_id`);
        if (!(r.status === 200 && Array.isArray(r.json) && r.json.length === 0)) leaks.push(`${t} → ${r.status} ${r.text.slice(0, 80)}`);
      }
      checkEq('another user reads none of A\'s rows', leaks, []);
      const anon = [];
      for (const t of [...REWARD_TABLES, 'referrals']) {
        const r = await api.anon('GET', `/rest/v1/${t}?select=*&limit=1`);
        if (r.status < 400 && !(Array.isArray(r.json) && r.json.length === 0)) anon.push(`${t} → ${r.status}`);
      }
      checkEq('anon reads nothing', anon, []);
    }

    // ---- G: the catalog ------------------------------------------------------------------
    section('G catalog: LIVE_TYPES equals the inbox.type CHECK; a goal_completed push is deferred in quiet hours', 2);
    {
      const def = sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.inbox'::regclass and conname = 'inbox_type_check'`);
      checkEq('the same six types, in catalog order', [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]), [...catalog.LIVE_TYPES]);
      const now = Date.now();
      const quiet = { enabled: true, start: `${pad(parts(now - HOUR, 'UTC').hour)}:00`, end: `${pad(parts(now + 2 * HOUR, 'UTC').hour)}:00` };
      const item = {
        inboxId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        type: 'goal_completed',
        payload: { kind: 'weekly_goal', category: 'phone', weekStart: '2026-09-21', points: 150, prorated: false },
        createdAt: now - MIN,
        read: false,
        dismissed: false,
        subjectGone: false,
        ctx: { tz: 'UTC', quiet, categories: {}, drivingSince: null, recent: [], localSentToday: 0, tokens: ['ExponentPushToken[e2e-policy]'] },
      };
      const d = policy.decide(item, now, serverCatalog.CATALOG);
      checkEq('push-sender defers it to the quiet end', [d.kind, d.reason], ['defer', 'quiet_hours']);
    }
  } finally {
    closeSection();
    section('cleanup: nothing of this run is left, and what it changed is restored', 6);
    try {
      sql(`update public.app_config set value = ${lit(JSON.stringify(flagsBefore))}::jsonb where key = 'feature_flags'`);
    } catch (e) {
      console.error(`flag restore: ${e.message}`);
    }
    try {
      sql(globalBefore
        ? `update public.global_rate_limits set count = ${globalBefore.count}, window_start = ${lit(globalBefore.window_start)} where key = 'referral_redeem_global'`
        : `delete from public.global_rate_limits where key = 'referral_redeem_global'`);
    } catch (e) {
      console.error(`budget restore: ${e.message}`);
    }
    if (users.length > 0) {
      try {
        sql(`delete from auth.users where id in (${users.map(lit).join(',')})`);
      } catch (e) {
        console.error(`user cleanup: ${e.message}`);
      }
    }
    try {
      sql(`select cron.alter_job(${cronJob.jobid}, active := ${cronJob.active})`);
    } catch (e) {
      console.error(`cron restore: ${e.message}`);
    }
    if (serve) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(serve.pid), '/T', '/F'], { stdio: 'ignore' });
        else serve.kill();
      } catch {
        /* already gone */
      }
    }
    const ids = users.length === 0 ? `(null::uuid)` : `(${users.map(lit).join(',')})`;
    const tables = sqlJson(`select coalesce(json_agg(json_build_array(c.table_name, c.column_name)), '[]') from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name in ('user_id', 'referrer_id', 'invitee_id')`);
    const leftover = tables.filter(([t, c]) => Number(sql(`select count(*) from public.${t} where ${c} in ${ids}`)) > 0).map(([t, c]) => `${t}.${c}`);
    checkEq('no public row references a run user', leftover, []);
    checkEq('no auth user of the run', Number(sql(`select count(*) from auth.users where id in ${ids}`)), 0);
    checkEq('the referral flag is as it was', sqlJson(`select value from public.app_config where key = 'feature_flags'`), flagsBefore);
    checkEq('the global redeem budget is as it was', sqlJson(`select row_to_json(g) from (select window_start, count from public.global_rate_limits where key = 'referral_redeem_global') g`), globalBefore);
    checkEq('the settle-rewards job is as it was', sqlJson(`select to_json(active) from cron.job where jobid = ${cronJob.jobid}`), cronJob.active);
    checkEq('no inbox row of the run', Number(sql(`select count(*) from public.inbox where user_id in ${ids}`)), 0);
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
    console.error(`\ne2e-rewards: ${err instanceof Error ? err.message : String(err)}${cause}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    summarise();
    process.exitCode = 1;
  });
