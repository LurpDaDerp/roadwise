#!/usr/bin/env node
'use strict';
/**
 * The M3 drive golden: a drive from native events to the authoritative score, with real speed
 * limits, against the local stack.
 *
 *   npm run e2e:drive
 *
 * What it does, in the order a phone does it:
 *
 *   1. tiles           GET the corridor's three z15 tiles from the real `speed-limits` function
 *                      (the seed fixture, `supabase/seed.sql`): the corridor is there at 35 mph, and
 *                      the batch says `fallback: null` — the functions runtime holds no AWS secrets;
 *   2. untagged way    POST a point on the seed's untagged crossing, away from its HPMS section:
 *                      the answer is `unknown`, never a guess, because nothing may ask AWS;
 *   3. drive           the real drive host (`src/drive/host.ts`) runs in Node over sql.js, fed by
 *                      the fake drive-sense replaying `speeding-corrected.json` and then
 *                      `phone-pickup.json` (yesterday, 09:00 and 10:00 local), with the real
 *                      speed-limit client fetching its tiles from the real function — at most one
 *                      batch per kilometre plus the trip-start batch, and no point lookup;
 *   4. drain           the real sync runner (`src/data/sync/runner.ts`) drains the queue against the
 *                      real `finalize-trip`: the trace goes to Storage, the payload to the function;
 *   5. read back       the stored `trips` and `trip_events`: the authoritative score equals the
 *                      device's provisional one (Δ = 0, `provisionalMismatch: false`), the stored
 *                      `limit_coverage_pct` is the device's (≥ 90), and the local rows followed.
 *
 * `src/drive/__tests__/golden.test.ts` is the same flow in Jest, with the tiles built from a TS copy
 * of the seed; this run replaces that copy with the database and the function.
 *
 * Nothing here is skippable. Each section declares how many checks it must record and the run ends
 * by asserting it recorded exactly that many (the pattern of `scripts/e2e-trip.js`), so a block that
 * silently does not run is a failure rather than a shorter green run.
 *
 * Local only, by construction: every key is read from `npx supabase status -o json` at run time and
 * the run refuses any API URL that is not 127.0.0.1 or localhost.
 *
 * Node reads the app's TypeScript directly (`--experimental-strip-types`, in the npm script). The
 * module hooks below teach its resolver the path aliases (`@/`, `@scoring`, `@drive-sense`) and the
 * extensionless imports the app writes. `@drive-sense` resolves to its pure JS face only (the row
 * contract and the fake): the native module lookup needs `expo-modules-core`, which Node cannot load
 * and a replay does not need.
 *
 * Flags: --self-check (the pure helpers and a stackless replay through the host, then stop) ·
 * --user <uuid> (pin the user instead of a fresh one; that user's rows are deleted first) · --keep
 * (leave the trips behind for inspection) · --external-serve (assume `supabase functions serve` is
 * already running).
 */

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mod = require('node:module');
const { fileURLToPath, pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TZ = 'America/Los_Angeles';
/** Local hour each drive starts at, yesterday: inside the day, never inside the night window. */
const TRIP_HOURS = { speeding: 9, phone: 10 };
const TRACES_BUCKET = 'traces';
const TRACE_DIR = path.join(ROOT, 'src', 'core', '__fixtures__', 'traces');

/** The seed fixture (`supabase/seed.sql`, B1 "Measured tile contents"). */
const CORRIDOR_ID = '9000000001';
const CORRIDOR_TILES = ['15/5249/11443', '15/5250/11443', '15/5251/11443'];
/** On the untagged crossing (9000000004, lng −122.3200), 44 m south of its HPMS section's end. */
const UNTAGGED_POINT = { lat: 47.6041, lng: -122.32, heading: 0 };
const COVERAGE_MIN_PCT = 90;
const M_PER_DEG = 111_320;

// ---------------------------------------------------------------------------
// The module hooks: `@/x` -> src/x, `@scoring` -> packages/scoring/src/index.ts, `@drive-sense` ->
// its pure face (below), and the extensionless relative imports the app writes. Only files inside
// this repository (and never inside node_modules) are redirected.
// ---------------------------------------------------------------------------

const EXTENSIONS = ['.ts', '.tsx', '.js', '.json'];
const DRIVE_SENSE_URL = 'roadwise-e2e:drive-sense';
const DRIVE_SENSE_SRC = path.join(ROOT, 'modules', 'drive-sense', 'src');

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
  if (specifier.startsWith('@scoring/')) {
    return path.join(ROOT, 'packages', 'scoring', 'src', specifier.slice('@scoring/'.length));
  }
  if (specifier.startsWith('@drive-sense/')) return path.join(DRIVE_SENSE_SRC, specifier.slice('@drive-sense/'.length));
  if (specifier.startsWith('@/')) return path.join(ROOT, 'src', specifier.slice(2));
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (typeof parentURL !== 'string' || !parentURL.startsWith('file:')) return null;
  const parent = fileURLToPath(parentURL);
  if (!parent.startsWith(ROOT) || parent.includes(`${path.sep}node_modules${path.sep}`)) return null;
  return path.resolve(path.dirname(parent), specifier);
}

/**
 * `@drive-sense` as the host and this script use it at run time: the row contract (`parseRow`) and
 * the fake. Every other import of it in the host's graph is `import type`, which Node strips.
 */
function driveSenseSource() {
  const rowSchema = pathToFileURL(path.join(DRIVE_SENSE_SRC, 'rowSchema.ts')).href;
  const fake = pathToFileURL(path.join(DRIVE_SENSE_SRC, 'fake.ts')).href;
  return [
    `export { parseRow, ROW_DECIMALS } from ${JSON.stringify(rowSchema)};`,
    `export { createFakeDriveSense, driveSenseError } from ${JSON.stringify(fake)};`,
  ].join('\n');
}

function registerSourceHooks() {
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@drive-sense') return { url: DRIVE_SENSE_URL, format: 'module', shortCircuit: true };
      const target = aliasTarget(specifier, context.parentURL);
      const file = target === null ? null : resolveSourceFile(target);
      if (file === null) return nextResolve(specifier, context);
      const format = file.endsWith('.json')
        ? 'json'
        : file.endsWith('.ts') || file.endsWith('.tsx')
          ? 'module-typescript'
          : undefined;
      return { url: pathToFileURL(file).href, format, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (url === DRIVE_SENSE_URL) return { format: 'module', source: driveSenseSource(), shortCircuit: true };
      return nextLoad(url, context);
    },
  });
}

/** Import an app module by its repository-relative path. */
const importSource = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

// ---------------------------------------------------------------------------
// Assertions: recorded, never thrown, and counted per section (`scripts/e2e-trip.js`).
// ---------------------------------------------------------------------------

const results = [];
const steps = [];
let step = 'start';

const show = (value) =>
  typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v === undefined ? '<undefined>' : v));

/** JSON with every object's keys sorted: jsonb comes back from Postgres in its own key order. */
const canonical = (value) =>
  JSON.stringify(value, (_key, v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v === undefined ? '<undefined>' : v;
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, v[k]])
    );
  });

function check(name, ok, detail) {
  results.push({ step, name, ok: ok === true, detail: detail ?? '' });
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok === true;
}

function checkEq(name, actual, expected) {
  const ok = canonical(actual) === canonical(expected);
  return check(name, ok, ok ? show(actual) : `got ${show(actual)}, expected ${show(expected)}`);
}

function checkClose(name, actual, expected, epsilon) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= epsilon;
  return check(name, ok, ok ? show(actual) : `got ${show(actual)}, expected ${expected} ±${epsilon}`);
}

function closeStep() {
  const last = steps[steps.length - 1];
  if (last) last.ran = results.length - last.from;
}

/** Start a section. `expected` is how many checks it must record — asserted at the end of the run. */
function beginStep(title, expected) {
  closeStep();
  step = title;
  steps.push({ title, expected, from: results.length, ran: 0 });
  console.log(`\n== ${title}`);
}

let counted = false;

function verifyStepCounts() {
  if (counted || steps.length === 0) return;
  counted = true;
  const prior = steps.slice();
  beginStep('check accounting', prior.length);
  for (const s of prior) checkEq(`"${s.title}" ran every check it declares`, s.ran, s.expected);
}

// ---------------------------------------------------------------------------
// Time in a zone: the drives are placed at a fixed local hour yesterday, inside the server's
// 30-day window and outside the night window.
// ---------------------------------------------------------------------------

function zoneParts(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function zoneOffsetMs(ts, tz) {
  const p = zoneParts(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** The epoch ms at which the clock in `tz` reads `y-m-d hh:00:00`. */
function epochAtLocalHour(y, m, d, hour, tz) {
  const wall = Date.UTC(y, m - 1, d, hour, 0, 0);
  let guess = wall;
  for (let i = 0; i < 4; i += 1) {
    const next = wall - zoneOffsetMs(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function yesterdayIn(now, tz) {
  const p = zoneParts(now - 86_400_000, tz);
  return { year: p.year, month: p.month, day: p.day };
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** A trace's rows moved to a new start: every timestamp by one delta, nothing else. */
function rebaseRows(rows, startedAt) {
  const delta = startedAt - rows[0].ts;
  return rows.map((r) => ({ ...r, ts: r.ts + delta }));
}

/** Path length in km over the equirectangular metres the matcher uses. */
function pathKm(rows) {
  let m = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    const k = Math.cos((a.lat * Math.PI) / 180) * M_PER_DEG;
    m += Math.hypot((b.lng - a.lng) * k, (b.lat - a.lat) * M_PER_DEG);
  }
  return m / 1000;
}

/** A known limit, as the session counts one (`src/core/engine/session.ts`). */
const knownLimit = (s) => s !== null && s !== undefined && s.source !== 'unknown' && s.limitMps !== null;

/** Share of lookups with a known limit, 0–100. */
const coveragePct = (lookups) =>
  lookups.length === 0 ? 0 : (lookups.filter((l) => knownLimit(l.sample)).length * 100) / lookups.length;

// ---------------------------------------------------------------------------
// The local stack.
// ---------------------------------------------------------------------------

const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

function supabaseStatus() {
  let out;
  try {
    out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('').trim() || String(err.message ?? err);
    throw new Error(
      `BLOCKED: \`npx supabase status\` failed, so there is no local stack to run the golden against.\n` +
        `Start it with \`npx supabase start\` (Docker must be running).\n${detail}`
    );
  }
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`BLOCKED: \`npx supabase status\` printed no JSON:\n${out}`);
  return JSON.parse(out.slice(start));
}

function requireLocal(apiUrl) {
  if (!LOCAL_URL.test(apiUrl)) {
    throw new Error(
      `e2e-drive: only the local stack is supported (API_URL is ${apiUrl}); this script writes trips and storage objects and must never touch a hosted project`
    );
  }
  const env = process.env.SUPABASE_URL;
  if (env && !LOCAL_URL.test(env)) {
    throw new Error(`e2e-drive: SUPABASE_URL is ${env}; only the local stack is supported`);
  }
}

function devJwt(sub) {
  return execFileSync('node', [path.join(ROOT, 'scripts', 'dev-jwt.js'), '--sub', sub, '--ensure-user'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const FUNCTIONS_READY_STATUSES = new Set([200, 400, 401, 405]);

function makeApi(stack) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY, SECRET_KEY } = stack;
  const serviceKey = SERVICE_ROLE_KEY || SECRET_KEY;
  const asService = () => ({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });
  const asUser = (jwt) => ({ apikey: ANON_KEY, Authorization: `Bearer ${jwt}` });

  const reply = async (res) => {
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  };

  return {
    apiUrl: API_URL,
    anonKey: ANON_KEY,

    async functionsReady(name) {
      try {
        const res = await fetch(`${API_URL}/functions/v1/${name}`, { method: 'GET' });
        return FUNCTIONS_READY_STATUSES.has(res.status);
      } catch {
        return false;
      }
    },

    /** `GET speed-limits?tiles=…` as the user, exactly the request the device client makes. */
    async tiles(keys, jwt) {
      return reply(await fetch(`${API_URL}/functions/v1/speed-limits?tiles=${keys.join(',')}`, { headers: asUser(jwt) }));
    },

    /** `POST speed-limits` (one point) as the user. */
    async point(body, jwt) {
      return reply(
        await fetch(`${API_URL}/functions/v1/speed-limits`, {
          method: 'POST',
          headers: { ...asUser(jwt), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    },

    async listTraces(uid) {
      const res = await fetch(`${API_URL}/storage/v1/object/list/${TRACES_BUCKET}`, {
        method: 'POST',
        headers: { ...asService(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: `${uid}/`, limit: 100, offset: 0 }),
      });
      if (!res.ok) return [];
      const rows = await res.json();
      return Array.isArray(rows) ? rows.map((r) => r.name) : [];
    },

    /** The stored trace object, gunzipped, or null. */
    async traceText(uid, clientTripId) {
      const res = await fetch(`${API_URL}/storage/v1/object/${TRACES_BUCKET}/${uid}/${clientTripId}.bin.gz`, {
        headers: asService(),
      });
      if (!res.ok) return null;
      return zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
    },

    async removeTraces(uid, names) {
      if (names.length === 0) return;
      await fetch(`${API_URL}/storage/v1/object/${TRACES_BUCKET}`, {
        method: 'DELETE',
        headers: { ...asService(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: names.map((n) => `${uid}/${n}`) }),
      }).catch(() => undefined);
    },

    async rows(table, query) {
      const res = await fetch(`${API_URL}/rest/v1/${table}?${query}`, { headers: asService() });
      if (!res.ok) throw new Error(`rest ${table}: ${res.status} ${await res.text()}`);
      return res.json();
    },

    async wipe(table, query) {
      await fetch(`${API_URL}/rest/v1/${table}?${query}`, {
        method: 'DELETE',
        headers: { ...asService(), Prefer: 'return=minimal' },
      }).catch(() => undefined);
    },
  };
}

async function startFunctionsServe(api, log) {
  if (await api.functionsReady('finalize-trip')) return null;
  console.log('   starting `supabase functions serve` …');
  const child = spawn('npx', ['supabase', 'functions', 'serve'], {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    if (await api.functionsReady('finalize-trip')) return child;
    if (child.exitCode !== null) break;
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  throw new Error(
    `BLOCKED: the edge functions runtime never answered on ${api.apiUrl}/functions/v1/finalize-trip.\n` +
      `Run \`npx supabase functions serve\` yourself, or check Docker.\n${log.join('').slice(-4000)}`
  );
}

// ---------------------------------------------------------------------------
// The device half: the real host in Node.
// ---------------------------------------------------------------------------

let loaded = null;

/** The app modules the run drives, loaded once (the hooks are registered once with them). */
function loadDevice() {
  loaded ??= importDevice();
  return loaded;
}

async function importDevice() {
  registerSourceHooks();
  const [scoring, host, client, apiModule, tiles, dbIndex, sqljs, runner, gzip, driveSense, queue, finalize, polyline, units, wire] =
    await Promise.all([
      importSource('packages/scoring/src/index.ts'),
      importSource('src/drive/host.ts'),
      importSource('src/core/speedLimits/client.ts'),
      importSource('src/core/speedLimits/api.ts'),
      importSource('src/core/speedLimits/tiles.ts'),
      importSource('src/data/db/index.ts'),
      importSource('src/data/db/__fixtures__/sqljsDriver.ts'),
      importSource('src/data/sync/runner.ts'),
      importSource('src/boot/gzip.ts'),
      import(DRIVE_SENSE_URL),
      importSource('src/data/sync/queue.ts'),
      importSource('src/core/engine/finalize.ts'),
      importSource('src/lib/polyline.ts'),
      importSource('src/lib/units.ts'),
      importSource('src/core/speedLimits/wire.ts'),
    ]);
  return { scoring, host, client, apiModule, tiles, db: dbIndex, sqljs, runner, gzip, driveSense, queue, finalize, polyline, units, wire };
}

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The host, the limit client, a recording player and the fake bridge, over one sql.js database.
 * `api` is the `SpeedLimitApi` the client fetches through: the real function in a full run, a
 * local stand-in in the self-check.
 */
function createDevice(device, { db, api, startClock }) {
  let clock = startClock;
  const timers = new Map();
  let seq = 0;
  const scheduler = {
    setTimeout(fn) {
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
  const errors = [];
  const real = device.client.createSpeedLimitClient({
    db,
    api,
    now: () => clock,
    online: () => true,
    onError: (e) => errors.push({ ctx: 'limits', error: String(e?.message ?? e) }),
  });
  const lookups = [];
  let judging = null;
  const limits = {
    ...real,
    lookup(lat, lng, course, opts) {
      const sample = real.lookup(lat, lng, course, opts);
      if (judging) lookups.push({ ts: judging.ts, tile: device.tiles.tileKey(device.tiles.tileFor(lat, lng)), sample });
      return sample;
    },
  };
  const delivered = [];
  const player = {
    deliver: async (d) => {
      delivered.push(d);
    },
    stopCurrent: async () => {},
    announce: async () => {},
  };
  const traces = new Map();
  const traceWriter = {
    // The device's writer gzips what finalize hands it (D2); the runner uploads these bytes.
    writeGzip: async (p, bytes) => {
      traces.set(p, device.gzip.gzip(bytes));
    },
    clear: async () => {},
  };
  const fake = device.driveSense.createFakeDriveSense({ platform: 'ios', now: () => clock });
  fake.setState({ location: 'always', motion: 'granted' });
  const host = device.host.createDriveHost({
    db,
    source: fake,
    limits,
    player,
    scoring: device.scoring,
    traceWriter,
    hash: { sha256: async (t) => sha256Hex(t) },
    now: () => clock,
    tz: () => TZ,
    newId: () => crypto.randomUUID(),
    persistence: 'full',
    scheduler,
    onError: (e, ctx) => errors.push({ ctx, error: String(e?.message ?? e) }),
  });

  async function replay(rows) {
    let emitted = 0;
    for (const raw of rows) {
      clock = Math.max(clock, raw.ts + 200);
      judging = device.driveSense.parseRow(raw);
      fake.loadTrace([raw]);
      if (fake.step()) emitted += 1;
      await host.settled();
      await real.settled(); // a tile reply lands between rows, as the network would
    }
    judging = null;
    return emitted;
  }

  /** One manual mounted drive over `rows`, ended from the stopped panel. */
  async function drive(rows) {
    clock = Math.max(clock, rows[0].ts - 5_000);
    const before = { lookups: lookups.length, delivered: delivered.length };
    await host.manualStart({ mode: 'mounted', passenger: false, evidence: 'tap' });
    await host.settled();
    const clientTripId = host.snapshot().clientTripId;
    const emitted = await replay(rows);
    const mid = host.snapshot();
    await host.end();
    await host.untilIdle();
    await host.settled();
    await real.settled();
    return {
      clientTripId,
      emitted,
      mid,
      lookups: lookups.slice(before.lookups),
      delivered: delivered.slice(before.delivered),
      finalized: host.snapshot().lastFinalized,
    };
  }

  return { host, drive, errors, traces, delivered, stop: () => host.stop({ endOpenTrip: false }) };
}

/** Records every request the client makes, so the budget is counted at the wire. */
function countingApi(inner) {
  const batches = [];
  const points = [];
  return {
    batches,
    points,
    api: {
      async getTiles(keys) {
        batches.push([...keys]);
        return inner.getTiles(keys);
      },
      async lookupPoint(req) {
        points.push(req);
        return inner.lookupPoint(req);
      },
    },
  };
}

/** Loads a fixture trace's rows. */
const traceRows = (name) => JSON.parse(fs.readFileSync(path.join(TRACE_DIR, `${name}.json`), 'utf8')).rows;
const traceExpected = (name) => JSON.parse(fs.readFileSync(path.join(TRACE_DIR, `${name}.json`), 'utf8')).expected;

// ---------------------------------------------------------------------------
// The self-check: the pure helpers, and one stackless replay through the host with a stand-in tile
// API serving the seed corridor, so the Node module graph and the harness are proven before any
// stack is touched. It runs at the top of every full run too.
// ---------------------------------------------------------------------------

const SELF_CHECKS = 14;

async function selfCheck() {
  beginStep('self-check (pure helpers and a stackless replay, no stack)', SELF_CHECKS);

  const march = epochAtLocalHour(2026, 3, 9, 9, TZ);
  checkEq('9am local on a PDT day is the right instant', new Date(march).toISOString(), '2026-03-09T16:00:00.000Z');
  const y = yesterdayIn(Date.UTC(2026, 0, 1, 12), TZ);
  checkEq('yesterday in the zone', `${y.year}-${y.month}-${y.day}`, '2025-12-31');
  const moved = rebaseRows([{ ts: 1_000, speed: 3 }, { ts: 2_000, speed: 4 }], 9_000);
  checkEq('rebasing shifts every row by one delta and nothing else', moved, [{ ts: 9_000, speed: 3 }, { ts: 10_000, speed: 4 }]);
  checkClose('the path length of 1 km due east is 1 km', pathKm([{ lat: 47.6, lng: 0 }, { lat: 47.6, lng: 1000 / (M_PER_DEG * Math.cos((47.6 * Math.PI) / 180)) }]), 1, 1e-9);
  checkEq(
    'coverage counts only known limits',
    coveragePct([{ sample: null }, { sample: { source: 'unknown', limitMps: null } }, { sample: { source: 'posted', limitMps: 15 } }, { sample: { source: 'cached', limitMps: 11 } }]),
    50
  );
  checkEq(
    'a hosted URL is refused',
    (() => {
      try {
        requireLocal('https://abcdefg.supabase.co');
        return 'accepted';
      } catch {
        return 'refused';
      }
    })(),
    'refused'
  );

  // The stackless replay: the real host and client, tiles from a stand-in holding the corridor.
  const device = await loadDevice();
  const db = await device.sqljs.createSqlJsDb();
  await device.db.migrate(db);
  const corridor = {
    id: CORRIDOR_ID,
    provider: 'osm',
    limitMph: 35,
    highway: 'primary',
    oneway: 0,
    line: device.polyline.encodePolyline([
      { lat: 47.6062, lng: -122.333 },
      { lat: 47.6062, lng: -122.299 },
    ]),
  };
  const rows = traceRows('speeding-corrected');
  const standIn = countingApi({
    getTiles: async (keys) => ({
      tiles: keys.map((tile) => ({ tile, expiresAt: rows[0].ts + 86_400_000, truncated: false, segments: [corridor] })),
      fallback: null,
    }),
    lookupPoint: async () => {
      throw new Error('no point lookup without a fallback');
    },
  });
  const d = createDevice(device, { db, api: standIn.api, startClock: rows[0].ts - 5_000 });
  await d.host.start();
  const one = await d.drive(rows);
  checkEq('the host took every row the fake bridge emitted', one.emitted, rows.length);
  checkEq('the host reported no error', d.errors, []);
  checkEq('the corridor limit reached the engine', one.mid.limit?.source, 'posted');
  check('limit coverage along the trace is at least 90 %', coveragePct(one.lookups) >= COVERAGE_MIN_PCT, `${coveragePct(one.lookups).toFixed(2)} %`);
  checkEq('the drive finalized', one.finalized?.ok, true);
  const queued = await device.queue.findFinalize(db, one.clientTripId);
  checkEq('a valid payload is queued', queued?.clientTripId, one.clientTripId);
  checkEq('the queued payload carries the speeding episode with its correction credit',
    queued?.events.filter((e) => e.category === 'speeding').map((e) => ({ corrected: e.corrected, alertShown: e.alertShown, status: e.status })),
    [{ corrected: true, alertShown: true, status: 'scored' }]);
  check('the stand-in saw no point lookup and at most one batch per km plus the start batch',
    standIn.points.length === 0 && standIn.batches.length <= 1 + Math.floor(pathKm(rows)),
    `${standIn.batches.length} batches, ${standIn.points.length} point lookups`);
  await d.stop();
}

// ---------------------------------------------------------------------------
// The sync runner's Supabase, in Node: the real supabase-js client with the user's JWT for Storage
// and Functions, and a session that is this run's user (the client has no stored session).
// ---------------------------------------------------------------------------

function runnerSupabase(api, jwt, uid) {
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(api.apiUrl, api.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const session = { data: { session: { user: { id: uid } } } };
  const answers = [];
  return {
    answers,
    client,
    supabase: {
      auth: { getSession: async () => session, refreshSession: async () => session },
      storage: client.storage,
      functions: {
        async invoke(name, options) {
          const out = await client.functions.invoke(name, options);
          if (name === 'finalize-trip') answers.push({ body: options.body, data: out.data, error: out.error ? String(out.error.message ?? out.error) : null });
          return out;
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  await selfCheck();
  if (args.includes('--self-check')) return;

  beginStep('local stack', 3);
  const stack = supabaseStatus();
  requireLocal(stack.API_URL);
  check(
    'the local stack reported the keys this run needs',
    Boolean(stack.API_URL && stack.ANON_KEY && (stack.SERVICE_ROLE_KEY || stack.SECRET_KEY)),
    stack.API_URL
  );
  const api = makeApi(stack);
  const serveLog = [];
  let serve = null;
  const uid = flag('--user') ?? crypto.randomUUID();
  let host = null;

  try {
    serve = args.includes('--external-serve') ? null : await startFunctionsServe(api, serveLog);
    check('the edge functions runtime answers', await api.functionsReady('finalize-trip'));
    const jwt = devJwt(uid);
    check('a user JWT was minted for the local stack', jwt.split('.').length === 3, `user ${uid}`);

    await api.removeTraces(uid, await api.listTraces(uid));
    await api.wipe('trips', `user_id=eq.${uid}`);
    await api.wipe('score_daily', `user_id=eq.${uid}`);
    await api.wipe('baselines', `user_id=eq.${uid}`);
    await api.wipe('rate_limits', `user_id=eq.${uid}`);

    const device = await loadDevice();

    // ---- 1. the tiles, from the real function over the seed -------------------------------------
    beginStep('speed-limits: the corridor tiles from the real function', 7);
    const batch = await api.tiles(CORRIDOR_TILES, jwt);
    checkEq('GET speed-limits answered 200', batch.status, 200);
    const parsed = device.wire.TileBatchResponseSchema.safeParse(batch.body);
    check('the batch is one the device accepts (TileBatchResponseSchema)', parsed?.success === true, parsed?.success ? '' : show(parsed?.error?.issues ?? batch.text.slice(0, 300)));
    checkEq('the batch says fallback null: no AWS secrets, so nothing may ask AWS', batch.body?.fallback, null);
    checkEq('the tiles come back in the order asked', batch.body?.tiles?.map((t) => t.tile), CORRIDOR_TILES);
    const corridorIn = (t) => t.segments.filter((s) => s.id === CORRIDOR_ID);
    checkEq(
      'the corridor is in each of the three tiles, as OSM primary at 35 mph',
      batch.body?.tiles?.map((t) => corridorIn(t).map((s) => ({ provider: s.provider, limitMph: s.limitMph, highway: s.highway }))),
      CORRIDOR_TILES.map(() => [{ provider: 'osm', limitMph: 35, highway: 'primary' }])
    );
    checkEq('no tile was truncated', batch.body?.tiles?.map((t) => t.truncated), CORRIDOR_TILES.map(() => false));
    check('every tile expires within the 30-day ceiling', (batch.body?.tiles ?? []).every((t) => t.expiresAt > Date.now() && t.expiresAt <= Date.now() + 30 * 86_400_000 + 60_000), '');

    // ---- 2. a point on the untagged way: unknown, never a guess ---------------------------------
    beginStep('speed-limits: a point on the untagged way', 4);
    const point = await api.point(UNTAGGED_POINT, jwt);
    checkEq('POST speed-limits answered 200', point.status, 200);
    checkEq('the untagged way is unknown: no limit, no provider, confidence 0', point.body, {
      limitMph: null,
      source: 'unknown',
      matchConfidence: 0,
      parallelRoads: false,
      provider: null,
    });
    const pointParsed = device.wire.PointResponseSchema.safeParse(point.body);
    check('the answer is one the device accepts (PointResponseSchema)', pointParsed.success === true, pointParsed.success ? '' : show(pointParsed.error.issues));
    const cache = await api.rows('limits_cache', 'select=segment_key&limit=1').catch(() => null);
    checkEq('nothing was written to the AWS cache', Array.isArray(cache) ? cache.length : 'unreadable', 0);

    // ---- 3. two drives through the real host, limits from the real function ---------------------
    const db = await device.sqljs.createSqlJsDb();
    await device.db.migrate(db);
    // Whose device this is, as the bootstrap's identity stage records it before any drive.
    const settings = device.db.createSettingsRepo(db);
    await settings.set(device.queue.DEVICE_OWNER_KEY, uid);
    await settings.set(device.queue.SESSION_UID_KEY, uid);

    const sb = runnerSupabase(api, jwt, uid);
    const wire = countingApi(device.apiModule.createSupabaseSpeedLimitApi(sb.client));
    const now = Date.now();
    const { year, month, day } = yesterdayIn(now, TZ);
    const speedingRows = rebaseRows(traceRows('speeding-corrected'), epochAtLocalHour(year, month, day, TRIP_HOURS.speeding, TZ));
    const phoneRows = rebaseRows(traceRows('phone-pickup'), epochAtLocalHour(year, month, day, TRIP_HOURS.phone, TZ));
    const d = createDevice(device, { db, api: wire.api, startClock: speedingRows[0].ts - 5_000 });
    host = d;
    await d.host.start();

    beginStep('drive 1: speeding-corrected through the host, with the real tiles', 10);
    const batchesBefore = wire.batches.length;
    const one = await d.drive(speedingRows);
    const oneBatches = wire.batches.slice(batchesBefore);
    const km = pathKm(speedingRows.map((r) => device.driveSense.parseRow(r)));
    checkEq('the host took every row the fake bridge emitted', one.emitted, speedingRows.length);
    checkEq('35 mph posted on the corridor, at a confidence the HUD shows', one.mid.limit, {
      limitMps: device.units.mphToMps(35),
      source: 'posted',
      matchConfidence: 0.95,
      parallelRoads: false,
    });
    for (const tile of CORRIDOR_TILES) {
      const inTile = one.lookups.filter((l) => l.tile === tile);
      check(
        `limit coverage in ${tile} is at least 90 % of its rows`,
        inTile.length >= 20 && coveragePct(inTile) >= COVERAGE_MIN_PCT,
        `${inTile.length} rows, ${coveragePct(inTile).toFixed(2)} %`
      );
    }
    check(
      'every known answer on the corridor was its 35 mph, never the parallel 25',
      one.lookups.filter((l) => knownLimit(l.sample)).every((l) => Math.abs(l.sample.limitMps - device.units.mphToMps(35)) < 1e-9),
      ''
    );
    check(
      'at most one tile batch per km plus the trip-start batch',
      oneBatches.length >= 1 && oneBatches.length <= 1 + Math.floor(km),
      `${oneBatches.length} batches over ${km.toFixed(2)} km: ${show(oneBatches)}`
    );
    checkEq('the trip-start batch is the prefetch set at the first fix', oneBatches[0], ['15/5249/11443', '15/5250/11443', '15/5249/11444', '15/5250/11444']);
    checkEq('the drive finalized as provisional', one.finalized && { ok: one.finalized.ok, status: one.finalized.status }, { ok: true, status: 'provisional' });
    checkEq(
      'the alerts: L1 speeding, handed to the player in order',
      one.delivered.map((a) => [a.kind, a.level, a.ts - speedingRows[0].ts]),
      [['speeding', 1, 39_000], ['speeding', 1, 69_000]]
    );

    beginStep('drive 2: phone-pickup through the host, tiles from SQLite', 5);
    const phoneBefore = wire.batches.length;
    const two = await d.drive(phoneRows);
    checkEq('the host took every row the fake bridge emitted', two.emitted, phoneRows.length);
    check('limit coverage along the trace is at least 90 %', coveragePct(two.lookups) >= COVERAGE_MIN_PCT, `${coveragePct(two.lookups).toFixed(2)} %`);
    checkEq('no tile request: every tile it needs is fresh in SQLite', wire.batches.length - phoneBefore, 0);
    checkEq('the drive finalized as provisional', two.finalized && { ok: two.finalized.ok, status: two.finalized.status }, { ok: true, status: 'provisional' });
    checkEq('the alert: L1 phone', two.delivered.map((a) => [a.kind, a.level, a.ts - phoneRows[0].ts]), [['phone', 1, 62_000]]);

    beginStep('the device, before the drain', 6);
    checkEq('the host reported no error across both drives', d.errors, []);
    checkEq('no point lookup was ever made (every batch said fallback null)', wire.points.length, 0);
    const payloads = [];
    for (const t of [one, two]) payloads.push(await device.queue.findFinalize(db, t.clientTripId));
    checkEq('both payloads are queued and valid', payloads.map((p) => p?.clientTripId), [one.clientTripId, two.clientTripId]);
    const [p1, p2] = payloads;
    checkEq('drive 1: one speeding episode, scored, with its correction credit',
      p1?.events.map((e) => [e.category, e.status, e.corrected, e.alertShown]), [['speeding', 'scored', true, true]]);
    checkEq('drive 2: one phone event, scored, alert shown', p2?.events.map((e) => [e.category, e.status, e.alertShown]), [['phone', 'scored', true]]);
    check('both payloads carry limit coverage of at least 90 %', payloads.every((p) => (p?.limitCoveragePct ?? 0) >= COVERAGE_MIN_PCT), show(payloads.map((p) => p?.limitCoveragePct)));
    await d.stop();
    host = null;

    // ---- 4. the drain, against the real finalize-trip --------------------------------------------
    beginStep('drain: the real sync runner against the real finalize-trip', 4);
    const traceFs = {
      exists: async (p) => d.traces.has(p),
      read: async (p) => d.traces.get(p),
      remove: async (p) => {
        d.traces.delete(p);
      },
      list: async () => [...d.traces.keys()],
    };
    const runnerErrors = [];
    const runner = device.runner.createSyncRunner({
      db,
      supabase: sb.supabase,
      fs: traceFs,
      net: { isWifi: () => true },
      isRecording: () => false,
      onError: (e, ctx) => runnerErrors.push({ ctx, error: String(e?.message ?? e) }),
    });
    const drained = await runner.drainOnce();
    checkEq('the drain sent both drives and nothing failed', { done: drained.done, failed: drained.failed }, { done: 2, failed: 0 });
    checkEq('finalize-trip was called once per drive, with the queued payloads', sb.answers.map((a) => a.body?.clientTripId), [one.clientTripId, two.clientTripId]);
    checkEq('every call answered without error', sb.answers.map((a) => a.error), [null, null]);
    checkEq('the runner reported nothing', runnerErrors, []);
    await runner.stop();

    // ---- 5. read back: authoritative equals provisional --------------------------------------------
    const trips = device.db.createTripsRepo(db);
    for (const [i, t, p, name] of [
      [0, one, p1, 'speeding-corrected'],
      [1, two, p2, 'phone-pickup'],
    ]) {
      beginStep(`read back: ${name}`, 11);
      const answer = sb.answers[i]?.data;
      const [stored] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${t.clientTripId}&select=*`);
      checkEq('the authoritative score equals the provisional score (Δ = 0)', answer?.score, p?.provisional.score);
      checkEq('provisionalMismatch is false and this was not a replay', [answer?.provisionalMismatch, answer?.replayed], [false, false]);
      checkEq('the stored score is the answered score', stored?.score, answer?.score);
      check(
        'the stored limit_coverage_pct is the device value, at least 90',
        stored != null && Math.abs(Number(stored.limit_coverage_pct) - p.limitCoveragePct) < 1e-6 && Number(stored.limit_coverage_pct) >= COVERAGE_MIN_PCT,
        `stored ${stored?.limit_coverage_pct}, device ${p?.limitCoveragePct}`
      );
      checkEq('trips.rows_digest is the device digest', stored?.rows_digest, p?.rowsDigest);
      const text = await api.traceText(uid, t.clientTripId);
      const expectedRows = rebaseRows(traceRows(name), (i === 0 ? speedingRows : phoneRows)[0].ts).map((r) => device.driveSense.parseRow(r));
      checkEq('the stored trace is the rows as parseRow rounded them (D2)', text === null ? null : sha256Hex(text), sha256Hex(device.finalize.canonicalJson(expectedRows)));
      checkEq('the trace digest is the one the trip carries', text === null ? null : sha256Hex(text), stored?.rows_digest?.sha256);
      const events = stored ? await api.rows('trip_events', `trip_id=eq.${stored.id}&select=*&order=started_at`) : [];
      checkEq(
        'the stored events are the device events, alert shown and correction credit kept',
        events.map((e) => [e.client_event_id, e.category, e.status, e.alert_shown, e.corrected]),
        (p?.events ?? []).map((e) => [e.id, e.category, e.status, e.alertShown, e.corrected])
      );
      const want = traceExpected(name)[0];
      check(
        `the ${want.category} event starts where the fixture says`,
        events.length === 1 && Math.abs(Date.parse(events[0].started_at) - (t === one ? speedingRows : phoneRows)[0].ts - (want.startsNear - 1_700_000_000_000)) <= 2_000,
        events[0]?.started_at ?? 'no event'
      );
      const local = await trips.get(t.clientTripId);
      checkEq('the local trip followed the server', local && { score: local.score, sync_state: local.sync_state }, { score: answer?.score, sync_state: 'synced' });
      checkEq('the answered status is the stored status', answer?.status, stored?.status);
    }

    beginStep('golden values', 0);
    const finalTrips = await api.rows('trips', `user_id=eq.${uid}&select=client_trip_id,score,status,role,data_quality,limit_coverage_pct,local_day&order=started_at`);
    console.log(JSON.stringify(finalTrips, null, 2));
  } finally {
    if (host) await host.stop().catch(() => undefined);
    if (!args.includes('--keep')) {
      await api.removeTraces(uid, await api.listTraces(uid)).catch(() => undefined);
      await api.wipe('trips', `user_id=eq.${uid}`);
      await api.wipe('score_daily', `user_id=eq.${uid}`);
      await api.wipe('baselines', `user_id=eq.${uid}`);
      await api.wipe('rate_limits', `user_id=eq.${uid}`);
    }
    if (serve) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(serve.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          serve.kill();
        }
      } catch {
        /* the runtime is the CLI's to clean up */
      }
    }
  }
}

/**
 * The checks a full run must record, section by section, plus one accounting check per section.
 * Asserted at the end, so a run that stopped early can never read as a short green run.
 */
const FULL_RUN_CHECKS = SELF_CHECKS + 3 + 7 + 4 + 10 + 5 + 6 + 4 + 11 + 11 + 0;
const FULL_RUN_SECTIONS = 11;

function summarise(full) {
  verifyStepCounts();
  closeStep();
  if (full) {
    const want = FULL_RUN_CHECKS + FULL_RUN_SECTIONS + 1;
    step = 'check accounting';
    checkEq('the run recorded every check a full run records', results.length + 1, want);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  [${f.step}] ${f.name} — ${f.detail}`);
  }
  return failed.length === 0;
}

const full = !process.argv.includes('--self-check');
main()
  .then(() => {
    if (!summarise(full)) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`\ne2e-drive: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    summarise(full);
    process.exitCode = 1;
  });
