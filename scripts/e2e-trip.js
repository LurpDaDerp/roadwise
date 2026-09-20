#!/usr/bin/env node
'use strict';
/**
 * The end-to-end trip golden: a recorded drive through every piece M2 built, and the
 * authoritative numbers asserted at each step.
 *
 *   npm run e2e:trip
 *
 * What it does, in the order the real device runner does it (Task 3, "one pass"):
 *
 *   1. replay          a committed trace (`src/core/__fixtures__/traces/*.json`) through the M1
 *                      detector suite (`src/core/replay/runTrace.ts`);
 *   2. finalize        the closed session through `finalizeTrip` (`src/core/engine/finalize.ts`)
 *                      over a real SQLite (sql.js), which writes the trip, the events, the trace
 *                      file and the queue item — the payload taken back off the queue, not out of
 *                      the finalizer's return value;
 *   3. upload          the gzip trace to `traces/<uid>/<clientTripId>.bin.gz` with a user JWT;
 *   4. finalize-trip   POST the payload to the edge function, which re-scores it and calls the
 *                      `apply_trip` writer;
 *   5. read back       the stored `trips`, `trip_events` and `score_daily` rows with the service
 *                      key, and assert the authoritative numbers against the device's provisional
 *                      ones (the golden: Δ = 0, `provisionalMismatch: false`);
 *   6. trip-actions    dispute the worked example's most expensive scored event (the recomputed
 *                      score is checked against what `packages/scoring` predicts without it, never
 *                      against a hard-coded number), then set-role passenger, then delete;
 *   7. idempotency     re-POST a finalize payload and prove `replayed: true` with the rows unmoved.
 *
 * Local only, by construction: every key is read from `npx supabase status -o json` at run time and
 * nothing is written to this file or to the repository. The run refuses to start unless the stack's
 * API URL is 127.0.0.1 or localhost, so neither a hosted project nor a linked one can be reached.
 *
 * Node reads the app's TypeScript directly (`--experimental-strip-types`, in the npm script); the
 * module hooks below teach its resolver the two path aliases (`@/`, `@scoring`) and the extensionless
 * imports the app writes, which is all Metro and Jest add on top of plain ESM for this subtree.
 *
 * Flags: --self-check (run the pure-helper checks and stop, no stack needed) · --user <uuid> (pin
 * the user instead of a fresh one per run) · --keep (leave the trips behind for inspection) ·
 * --external-serve (do not start `supabase functions serve`; assume one is already running).
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
/** Local hour each trip starts at, yesterday: inside the day, never inside the night window. */
const TRIP_HOURS = { filler: 7, speeding: 9, phone: 10, worked: 11 };
const TRACES_BUCKET = 'traces';

// ---------------------------------------------------------------------------
// The module hooks: `@/x` -> src/x, `@scoring` -> packages/scoring/src/index.ts, and the
// extensionless relative imports the app writes. Only files inside this repository (and never
// inside node_modules) are redirected; everything else goes to Node's own resolver untouched.
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
  if (specifier.startsWith('@scoring/')) {
    return path.join(ROOT, 'packages', 'scoring', 'src', specifier.slice('@scoring/'.length));
  }
  if (specifier.startsWith('@/')) return path.join(ROOT, 'src', specifier.slice(2));
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (typeof parentURL !== 'string' || !parentURL.startsWith('file:')) return null;
  const parent = fileURLToPath(parentURL);
  // A relative import inside a dependency is Node's business, not ours.
  if (!parent.startsWith(ROOT) || parent.includes(`${path.sep}node_modules${path.sep}`)) return null;
  return path.resolve(path.dirname(parent), specifier);
}

function registerSourceHooks() {
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = aliasTarget(specifier, context.parentURL);
      const file = target === null ? null : resolveSourceFile(target);
      if (file === null) return nextResolve(specifier, context);
      // Everything under src/ and packages/ is ESM TypeScript; naming the format skips Node's
      // "reparsing as ES module" probe and the warning that comes with it.
      const format = file.endsWith('.json')
        ? 'json'
        : file.endsWith('.ts') || file.endsWith('.tsx')
          ? 'module-typescript'
          : undefined;
      return { url: pathToFileURL(file).href, format, shortCircuit: true };
    },
  });
}

/** Import an app module by its repository-relative path. */
const importSource = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

// ---------------------------------------------------------------------------
// Assertions. Everything is recorded, nothing throws: a golden that stops at the first
// divergence hides the rest of the divergence, and the whole point of this script is the list.
// ---------------------------------------------------------------------------

const results = [];
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
  results.push({ step, name, ok, detail: detail ?? '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function checkEq(name, actual, expected) {
  const ok = canonical(actual) === canonical(expected);
  return check(name, ok, ok ? show(actual) : `got ${show(actual)}, expected ${show(expected)}`);
}

function checkClose(name, actual, expected, epsilon) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= epsilon;
  return check(name, ok, ok ? show(actual) : `got ${show(actual)}, expected ${expected} ±${epsilon}`);
}

/** One readable line per stored `score_daily` row — the numbers a golden is read for. */
const dayLine = (d) =>
  `${d.day} longTermScore ${d.long_term_score} band ${d.band} provisional ${d.provisional} ` +
  `safeDay ${d.safe_day} goodDay ${d.good_day} phoneFreeDay ${d.phone_free_day} ` +
  `exposure ${d.exposure} drivingS ${d.driving_s} tripsScored ${d.trips_scored} severeEvents ${d.severe_events}`;

function beginStep(title) {
  step = title;
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------
// Time in a zone. The trips are placed at a fixed local hour *yesterday*, so every run is inside
// the server's 30-day age window, never ahead of its clock, and never inside the night window
// (23:00–04:59) that would make the server rewrite each event's `context.night`.
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

/** `wall clock in tz` − `utc`, in ms, at the instant `ts`. */
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

/** The calendar date in `tz`, as Postgres derives `trips.local_day`. */
function localDayIn(ts, tz) {
  const p = zoneParts(ts, tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Yesterday's date in `tz` — the local day every trip of this run is dated. */
function yesterdayIn(now, tz) {
  const p = zoneParts(now - 86_400_000, tz);
  return { year: p.year, month: p.month, day: p.day };
}

// ---------------------------------------------------------------------------
// The local stack: keys at run time, never from a file, never from this repository.
// ---------------------------------------------------------------------------

const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

function supabaseStatus() {
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The CLI may print a "Stopped services" line before the JSON.
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`supabase status printed no JSON:\n${out}`);
  return JSON.parse(out.slice(start));
}

function requireLocal(apiUrl) {
  if (!LOCAL_URL.test(apiUrl)) {
    throw new Error(
      `e2e-trip: only the local stack is supported (API_URL is ${apiUrl}); this script writes trips, disputes and storage objects and must never touch a hosted project`
    );
  }
  const env = process.env.SUPABASE_URL;
  if (env && !LOCAL_URL.test(env)) {
    throw new Error(`e2e-trip: SUPABASE_URL is ${env}; only the local stack is supported`);
  }
}

function devJwt(sub) {
  return execFileSync('node', [path.join(ROOT, 'scripts', 'dev-jwt.js'), '--sub', sub, '--ensure-user'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// ---------------------------------------------------------------------------
// HTTP: the three surfaces the device touches (functions, storage) and the one the assertions do
// (PostgREST with the service key — a read the app itself is never allowed to make).
// ---------------------------------------------------------------------------

function makeApi(stack) {
  const { API_URL, ANON_KEY, SERVICE_ROLE_KEY, SECRET_KEY } = stack;
  const serviceKey = SERVICE_ROLE_KEY || SECRET_KEY;

  const asUser = (jwt) => ({ apikey: ANON_KEY, Authorization: `Bearer ${jwt}` });
  const asService = () => ({ apikey: serviceKey, Authorization: `Bearer ${serviceKey}` });

  return {
    apiUrl: API_URL,

    /** POST an edge function as the user, exactly as `supabase.functions.invoke` would. */
    async invoke(name, body, jwt) {
      const res = await fetch(`${API_URL}/functions/v1/${name}`, {
        method: 'POST',
        headers: { ...asUser(jwt), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, body: json, text, requestId: res.headers.get('x-request-id') };
    },

    /** Is the functions runtime answering? An unauthenticated GET is 401 when it is, 503 when it is not. */
    async functionsReady(name) {
      try {
        const res = await fetch(`${API_URL}/functions/v1/${name}`, { method: 'GET' });
        return res.status !== 503 && res.status !== 404;
      } catch {
        return false;
      }
    },

    /** The trace object, put where the storage policy lets this user put it. */
    async uploadTrace(uid, clientTripId, gzip, jwt) {
      const key = `${uid}/${clientTripId}.bin.gz`;
      const res = await fetch(`${API_URL}/storage/v1/object/${TRACES_BUCKET}/${key}`, {
        method: 'POST',
        headers: { ...asUser(jwt), 'Content-Type': 'application/gzip', 'x-upsert': 'false' },
        body: gzip,
      });
      return { status: res.status, text: await res.text(), key };
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

    async removeTraces(uid, names) {
      if (names.length === 0) return;
      await fetch(`${API_URL}/storage/v1/object/${TRACES_BUCKET}`, {
        method: 'DELETE',
        headers: { ...asService(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: names.map((n) => `${uid}/${n}`) }),
      }).catch(() => undefined);
    },

    /** A PostgREST read with the service key: what is actually stored, RLS or not. */
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

// ---------------------------------------------------------------------------
// The device half.
// ---------------------------------------------------------------------------

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The replay harness numbers events `e1, e2, …` per trace so a failure line is readable; a device
 * mints a uuid per event. Two traces in one run would therefore both claim `e1` — a duplicate
 * primary key locally and, worse, `409 ambiguous_event` on the server, where a client event id is
 * looked up across the whole user. One prefix per trip restores what the device guarantees.
 */
function namespaceEvents(events, prefix) {
  const rename = (id) => `${prefix}-${id}`;
  return events.map((e) => ({
    ...e,
    id: rename(e.id),
    ...(e.absorbedIds ? { absorbedIds: e.absorbedIds.map(rename) } : {}),
  }));
}

/** A trace replayed at a new wall-clock start: every timestamp moves by the same delta. */
function rebaseTrace(trace, startedAt) {
  const base = trace.rows[0].ts;
  const delta = startedAt - base;
  return {
    ...trace,
    rows: trace.rows.map((r) => ({ ...r, ts: r.ts + delta })),
    limits: trace.limits.map((l) => ({ ...l, fromTs: l.fromTs + delta })),
    expected: trace.expected.map((e) => ({ ...e, startsNear: e.startsNear + delta })),
  };
}

/**
 * What the recorder leaves behind before a finalize: the `recording` trip row and every row up to
 * the last checkpoint. The tail stays in the session's ring for `finalizeTrip` to make durable,
 * so the script exercises that path rather than handing the finalizer a fully persisted trip.
 */
async function persistRecording(device, db, clientTripId, rows, tz, tail) {
  const upTo = Math.max(0, rows.length - tail);
  await device.db.createTripsRepo(db).insert(
    {
      client_trip_id: clientTripId,
      started_at: rows[0].ts,
      tz,
      status: 'recording',
      checkpoint_ts: upTo > 0 ? rows[upTo - 1].ts : null,
    },
    rows[0].ts
  );
  await device.db
    .createSamplesRepo(db)
    .appendMany(clientTripId, rows.slice(0, upTo).map((r) => ({ ts: r.ts, row: r })));
}

/** The closed session the engine hands the finalizer, with the events the detectors produced. */
function closedSession(device, { clientTripId, trace, rows, events, limitFor }) {
  const session = device.session.createSession({
    clientTripId,
    mode: trace.mode,
    role: 'driver',
    startSource: 'manual',
    startedAt: rows[0].ts,
  });
  for (const row of rows) device.session.appendRow(session, row, limitFor(row));
  session.events = events;
  session.alerts = [];
  return device.session.closeSession(session, rows[rows.length - 1].ts + 1000);
}

/** Run one trip through the finalizer and take the payload back off the sync queue. */
async function finalizeAndQueue(device, db, session, clientTripId, tz) {
  const files = new Map();
  const result = await device.finalize.finalizeTrip(session, {
    db,
    scoring: device.scoring,
    tz,
    fs: {
      // The device gzips the canonical trace text on the way to disk; so do we, and the bytes we
      // keep are the bytes the runner would upload.
      writeGzip: async (p, bytes) => {
        files.set(p, zlib.gzipSync(Buffer.from(bytes)));
      },
    },
    hash: { sha256: async (text) => sha256Hex(text) },
    now: () => Date.now(),
  });
  const queued = await device.queue.findFinalize(db, clientTripId);
  return {
    scored: result.scored,
    payload: result.payload,
    queued,
    gzip: files.get(device.finalize.tracePathFor(clientTripId)) ?? null,
  };
}

/**
 * `n` rows at 1 Hz from San Francisco at 10 m/s: east for the first half, then north, with a lost
 * fix every 50th row and a little IMU noise so the trip grades A. 1320 of them are the §9.4 worked
 * example's 22 minutes and 13.2 km.
 */
function straightTrack(device, startedAt, N) {
  const { row } = device.rows;
  const SF = { lat: 37.7749, lng: -122.4194 };
  const M_PER_DEG_LAT = 111_194.93;
  const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((SF.lat * Math.PI) / 180);
  const SPEED = 10;
  const half = Math.floor(N / 2);
  return Array.from({ length: N }, (_, i) =>
    row({
      ts: startedAt + i * 1000,
      lat: SF.lat + (Math.max(0, i - half) * SPEED) / M_PER_DEG_LAT,
      lng: SF.lng + (Math.min(i, half) * SPEED) / M_PER_DEG_LNG,
      speed: SPEED,
      course: i <= half ? 90 : 0,
      gnssValid: i % 50 !== 25,
      aLonMax: 0.02,
      aLonMin: -0.02,
    })
  );
}

function workedExampleEvents(device, startedAt) {
  const { mph } = device.rows;
  const event = (p) => ({
    corrected: false,
    status: 'scored',
    context: { night: false, precipitation: false },
    alertable: true,
    source: 'gnss',
    ...p,
  });
  return [
    event({ id: 'p1', category: 'phone', startedAt: startedAt + 300_000, durationS: 12, q: 0.9, measured: { speedMps: mph(35) }, source: 'os' }),
    event({ id: 's1', category: 'speeding', startedAt: startedAt + 600_000, durationS: 45, q: 0.85, measured: { overMps: mph(12), limitMps: mph(35) }, context: { night: false, precipitation: true } }),
    event({ id: 'b1', category: 'braking', startedAt: startedAt + 900_000, durationS: 1, q: 0.8, measured: { peakG: 0.42 }, source: 'both' }),
    event({ id: 'x1', category: 'braking', startedAt: startedAt + 5_000, durationS: 1, q: 0.4, status: 'possible', alertable: false, measured: { peakG: 0.31 }, source: 'both' }),
  ];
}

// ---------------------------------------------------------------------------
// Scoring the same trip the way the server re-scores a stored one, from the payload alone.
// `packages/scoring` is the source of truth for both ends, so the dispute's expected score is
// computed here rather than written down.
// ---------------------------------------------------------------------------

/** `tripMetrics` (`supabase/functions/_shared/plausibility.ts`) over a payload with no downgrades. */
function metricsFromPayload(payload) {
  return {
    distanceM: payload.distanceM,
    durationS: payload.durationS,
    validGnssPct: payload.rowsDigest.validGnssPct,
    imuPresent: payload.rowsDigest.imuPresent,
    role: payload.role,
    maxSustainedSpeedMps: payload.rowsDigest.maxSustainedSpeedMps,
  };
}

/** `toScorableEvent` (`supabase/functions/_shared/rescore.ts`) over the payload's events. */
function scorableFromPayload(payload, statusOverrides = {}) {
  return payload.events.map((e) => ({
    id: e.id,
    category: e.category,
    startedAt: e.startedAt,
    durationS: e.durationMs / 1000,
    q: e.q,
    corrected: e.corrected,
    status: statusOverrides[e.id] ?? e.status,
    measured: { ...e.measured },
    context: { night: e.context.night === true, precipitation: e.context.precipitation === true },
  }));
}

/** The scored event that costs the most points — the one a driver would dispute first. */
function topScoredEvent(payload) {
  const deductions = payload.provisional.eventDeductions ?? {};
  const scored = payload.events.filter((e) => e.status === 'scored' && deductions[e.id] !== undefined);
  scored.sort((a, b) => deductions[b.id] - deductions[a.id] || a.id.localeCompare(b.id));
  return scored[0] ?? null;
}

const DISPUTE_REASON_FOR = { phone: 'passenger_phone', speeding: 'hazard' };

// ---------------------------------------------------------------------------
// The self-check: the pure helpers above, with no stack and no network. It runs at the top of
// every full run too, so a broken helper is never mistaken for a broken pipeline.
// ---------------------------------------------------------------------------

function selfCheck() {
  beginStep('self-check (pure helpers, no stack)');

  // A zone with daylight saving, on both sides of a transition.
  const march = epochAtLocalHour(2026, 3, 9, 9, TZ);
  checkEq('9am local on a PDT day is the right instant', new Date(march).toISOString(), '2026-03-09T16:00:00.000Z');
  const january = epochAtLocalHour(2026, 1, 9, 9, TZ);
  checkEq('9am local on a PST day is the right instant', new Date(january).toISOString(), '2026-01-09T17:00:00.000Z');
  checkEq('the local day is the calendar date in the zone', localDayIn(march, TZ), '2026-03-09');
  checkEq(
    'an instant just before local midnight still belongs to that day',
    localDayIn(epochAtLocalHour(2026, 3, 9, 23, TZ) + 3_599_000, TZ),
    '2026-03-09'
  );
  checkEq('UTC and the zone disagree about the day, as they should', localDayIn(january + 15 * 3_600_000, 'UTC'), '2026-01-10');

  const y = yesterdayIn(Date.UTC(2026, 0, 1, 12), TZ);
  checkEq('yesterday in the zone', `${y.year}-${y.month}-${y.day}`, '2025-12-31');

  // Rebasing moves every timestamp by one delta and nothing else.
  const trace = {
    name: 't',
    mode: 'mounted',
    rows: [{ ts: 1_000, speed: 3 }, { ts: 2_000, speed: 4 }],
    limits: [{ fromTs: 1_000, limitMps: 10 }],
    expected: [{ category: 'phone', startsNear: 1_500 }],
  };
  const moved = rebaseTrace(trace, 9_000);
  checkEq('rebasing shifts the rows', moved.rows.map((r) => r.ts), [9_000, 10_000]);
  checkEq('rebasing shifts the limits', moved.limits[0].fromTs, 9_000);
  checkEq('rebasing shifts the expectations', moved.expected[0].startsNear, 9_500);
  checkEq('rebasing leaves everything else alone', moved.rows[1].speed, 4);

  // The event a driver would dispute first is the most expensive *scored* one.
  const payload = {
    events: [
      { id: 'a', status: 'scored', category: 'phone', startedAt: 1, durationMs: 1000, q: 1, corrected: false, measured: {}, context: { night: false, precipitation: false } },
      { id: 'b', status: 'scored', category: 'braking', startedAt: 2, durationMs: 2000, q: 1, corrected: false, measured: {}, context: { night: false, precipitation: false } },
      { id: 'c', status: 'possible', category: 'braking', startedAt: 3, durationMs: 1000, q: 1, corrected: false, measured: {}, context: { night: false, precipitation: false } },
    ],
    provisional: { eventDeductions: { a: 4, b: 9, c: 99 } },
  };
  checkEq('the top scored event is the most expensive one', topScoredEvent(payload).id, 'b');
  checkEq('a `possible` event is never the one disputed', topScoredEvent(payload).status, 'scored');
  checkEq('a trip with nothing scored has nothing to dispute', topScoredEvent({ events: [], provisional: {} }), null);
  checkEq(
    'the scorer sees the stored duration in seconds, and an overridden status',
    scorableFromPayload(payload, { b: 'removed' }).map((e) => `${e.id}:${e.status}:${e.durationS}`),
    ['a:scored:1', 'b:removed:2', 'c:possible:1']
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
  checkEq(
    'the local URL is accepted',
    (() => {
      try {
        requireLocal('http://127.0.0.1:54321');
        return 'accepted';
      } catch {
        return 'refused';
      }
    })(),
    'accepted'
  );
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function loadDevice() {
  registerSourceHooks();
  const [scoring, finalize, session, dbIndex, sqljs, runTrace, trace, queue, rows, detectors] = await Promise.all([
    importSource('packages/scoring/src/index.ts'),
    importSource('src/core/engine/finalize.ts'),
    importSource('src/core/engine/session.ts'),
    importSource('src/data/db/index.ts'),
    importSource('src/data/db/__fixtures__/sqljsDriver.ts'),
    importSource('src/core/replay/runTrace.ts'),
    importSource('src/core/replay/trace.ts'),
    importSource('src/data/sync/queue.ts'),
    importSource('src/core/detectors/__fixtures__/rows.ts'),
    importSource('src/core/detectors/index.ts'),
  ]);
  return { scoring, finalize, session, db: dbIndex, sqljs, runTrace, trace, queue, rows, detectors };
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
    `e2e-trip: the edge functions runtime never answered on ${api.apiUrl}/functions/v1/finalize-trip.\n` +
      `Run \`npx supabase functions serve\` yourself, or check Docker.\n${log.join('').slice(-4000)}`
  );
}

/** One upload: the trace object, then the function, then the rows that came out of the writer. */
async function uploadAndRead(api, ctx, trip) {
  const { uid, jwt } = ctx;
  const put = await api.uploadTrace(uid, trip.payload.clientTripId, trip.gzip, jwt);
  check(`the trace object is stored under ${uid.slice(0, 8)}…/${trip.payload.clientTripId.slice(0, 8)}…`, put.status === 200, `HTTP ${put.status}`);

  const res = await api.invoke('finalize-trip', trip.payload, jwt);
  check('finalize-trip answered 200', res.status === 200, res.status === 200 ? `x-request-id ${res.requestId}` : res.text.slice(0, 300));
  if (res.status !== 200) return { res, stored: null, events: [], day: null };

  const [stored] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${trip.payload.clientTripId}&select=*`);
  const events = stored ? await api.rows('trip_events', `trip_id=eq.${stored.id}&select=*&order=started_at`) : [];
  const [day] = await api.rows('score_daily', `user_id=eq.${uid}&day=eq.${res.body.day.day}&select=*`);
  console.log(`   server: score ${res.body.score} ${res.body.status}, day ${show(res.body.day)}`);
  return { res, stored, events, day };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  selfCheck();
  if (args.includes('--self-check')) return;

  beginStep('local stack');
  const stack = supabaseStatus();
  requireLocal(stack.API_URL);
  check('the stack is local', true, stack.API_URL);
  const api = makeApi(stack);
  const serveLog = [];
  const serve = args.includes('--external-serve') ? null : await startFunctionsServe(api, serveLog);
  check('the edge functions runtime answers', await api.functionsReady('finalize-trip'));

  const uid = flag('--user') ?? crypto.randomUUID();
  const jwt = devJwt(uid);
  check('a user JWT was minted for the local stack', jwt.split('.').length === 3, `user ${uid}`);

  // A user of this run's own, wiped first so the dispute allowance and the day rows are this
  // run's alone even when `--user` pins the subject.
  await api.removeTraces(uid, await api.listTraces(uid));
  await api.wipe('trips', `user_id=eq.${uid}`);
  await api.wipe('score_daily', `user_id=eq.${uid}`);
  await api.wipe('baselines', `user_id=eq.${uid}`);
  await api.wipe('rate_limits', `user_id=eq.${uid}`);

  const device = await loadDevice();
  const db = await device.sqljs.createSqlJsDb();
  await device.db.migrate(db);

  const now = Date.now();
  const { year, month, day } = yesterdayIn(now, TZ);
  const expectedDay = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const ctx = { uid, jwt, expectedDay };

  const trips = [];
  /** The synthetic track's limit: 35 mph, unknown every tenth second (for `limit_coverage_pct`). */
  const syntheticLimit = (startedAt) => (row) =>
    Math.round((row.ts - startedAt) / 1000) % 10 === 9
      ? device.rows.NO_LIMIT
      : device.rows.limit(device.rows.mph(35));

  // ---- a long, uneventful drive, so the long-term score has something to stand on ----
  // §9.6 withholds the number below three trips or an hour of driving; without this one the whole
  // run would only ever see `longTermScore: null`, which proves nothing about the writer's day row.
  beginStep('a 40-minute uneventful drive (so the long-term score is not withheld)');
  {
    const startedAt = epochAtLocalHour(year, month, day, TRIP_HOURS.filler, TZ);
    const clientTripId = crypto.randomUUID();
    const rows = straightTrack(device, startedAt, 2400);
    await persistRecording(device, db, clientTripId, rows, TZ, 30);
    const session = closedSession(device, {
      clientTripId,
      trace: { mode: 'mounted' },
      rows,
      events: [],
      limitFor: syntheticLimit(startedAt),
    });
    const trip = await finalizeAndQueue(device, db, session, clientTripId, TZ);
    checkEq('an uneventful drive scores 100', trip.scored.score, 100);
    const out = await uploadAndRead(api, ctx, trip);
    if (out.stored) {
      checkEq('the authoritative score equals the device provisional score (Δ = 0)', out.res.body.score, trip.scored.score);
      checkEq('the server reports no provisional mismatch', out.res.body.provisionalMismatch, false);
      checkEq('the long-term score is still withheld after one trip', out.res.body.day.longTermScore, null);
      checkEq('the day row says so', out.res.body.day.provisional, true);
      trips.push({ name: 'filler', clientTripId, trip, out });
    }
  }

  // ---- the two recorded traces -------------------------------------------------
  for (const [name, hour, prefix] of [
    ['speeding-corrected', TRIP_HOURS.speeding, 't1'],
    ['phone-pickup', TRIP_HOURS.phone, 't2'],
  ]) {
    beginStep(`replay → finalize → upload → finalize-trip: ${name}`);
    const startedAt = epochAtLocalHour(year, month, day, hour, TZ);
    check('the trip starts in the past, inside the server 30-day window', startedAt < now && now - startedAt < 30 * 86_400_000, new Date(startedAt).toISOString());
    check('the trip starts in daylight, so the server does not rewrite the event context', !device.finalize.nightAt(startedAt, TZ, device.scoring.CONSTANTS));

    const raw = device.trace.parseTrace(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', '__fixtures__', 'traces', `${name}.json`), 'utf8')));
    const trace = device.trace.parseTrace(rebaseTrace(raw, startedAt));
    const replayed = device.runTrace.runTrace(trace);
    check('the replay harness met the trace expectations', replayed.passes, replayed.failures.join(' | ') || `${replayed.events.length} events`);

    const clientTripId = crypto.randomUUID();
    await persistRecording(device, db, clientTripId, trace.rows, TZ, 30);
    const session = closedSession(device, {
      clientTripId,
      trace,
      rows: trace.rows,
      events: namespaceEvents(replayed.events, prefix),
      limitFor: (row) => device.trace.limitAt(trace.limits, row.ts),
    });
    const trip = await finalizeAndQueue(device, db, session, clientTripId, TZ);
    check('the finalizer queued the payload it validated', JSON.stringify(trip.queued) === JSON.stringify(trip.payload));
    check('the trace file was written and gzipped', trip.gzip !== null && trip.gzip.length > 0, `${trip.gzip?.length ?? 0} bytes`);
    console.log(
      `   device: score ${trip.scored.score} ${trip.scored.status} grade ${trip.scored.dataQuality}, ` +
        `${Math.round(trip.payload.distanceM)} m in ${trip.payload.durationS.toFixed(1)} s, ` +
        `${trip.payload.events.length} events (${trip.payload.events.filter((e) => e.status === 'scored').length} scored)`
    );

    const out = await uploadAndRead(api, ctx, trip);
    if (out.stored === null) break;
    checkEq('the authoritative score equals the device provisional score (Δ = 0)', out.res.body.score, trip.scored.score);
    checkEq('the server reports no provisional mismatch', out.res.body.provisionalMismatch, false);
    checkEq('the writer stored the trip, not a replay', out.res.body.replayed, false);
    checkEq('the status is the device status', out.res.body.status, trip.scored.status === 'final' ? 'final' : trip.scored.status);
    checkEq('the stored score is the answered score', out.stored.score, out.res.body.score);
    checkEq('the stored data quality is the device grade', out.stored.data_quality, trip.scored.dataQuality);
    checkEq('the stored local day is the trip day in its zone', out.stored.local_day, expectedDay);
    checkEq('trips.rows_digest is stored verbatim', out.stored.rows_digest, trip.payload.rowsDigest);
    checkEq('trips.trace_path is the derived storage key', out.stored.trace_path, `${uid}/${clientTripId}.bin.gz`);
    checkEq('every payload event was stored', out.events.length, trip.payload.events.length);
    checkEq('the score_daily row exists for the trip day', out.res.body.day.day, expectedDay);
    check('the answered day row is the stored day row', out.day !== undefined && out.day !== null && out.day.day === expectedDay, out.day ? dayLine(out.day) : 'missing');
    if (out.day) {
      checkEq('the stored long-term score matches the answer', out.day.long_term_score, out.res.body.day.longTermScore);
      checkEq('the stored trips_scored matches the answer', out.day.trips_scored, out.res.body.day.tripsScored);
      checkEq('the stored driving_s matches the answer', out.day.driving_s, out.res.body.day.drivingS);
    }
    trips.push({ name, clientTripId, trip, out });
  }

  // ---- the §9.4 worked example ------------------------------------------------
  beginStep('the §9.4 worked example through the function');
  const workedStart = epochAtLocalHour(year, month, day, TRIP_HOURS.worked, TZ);
  const workedId = crypto.randomUUID();
  const workedRows = straightTrack(device, workedStart, 1320);
  await persistRecording(device, db, workedId, workedRows, TZ, 30);
  const workedSession = closedSession(device, {
    clientTripId: workedId,
    trace: { mode: 'mounted' },
    rows: workedRows,
    events: workedExampleEvents(device, workedStart),
    limitFor: syntheticLimit(workedStart),
  });
  const worked = await finalizeAndQueue(device, db, workedSession, workedId, TZ);
  checkEq('the device scores the worked example 74', worked.scored.score, 74);
  checkClose('the worked example exposure is 1.1', worked.scored.exposure, 1.1, 1e-6);

  const workedOut = await uploadAndRead(api, ctx, worked);
  let workedStored = workedOut.stored;
  if (workedStored) {
    checkEq('the function re-scores the worked example to 74', workedOut.res.body.score, 74);
    checkEq('the worked example is no provisional mismatch', workedOut.res.body.provisionalMismatch, false);
    checkEq('apply_trip stored 74', workedStored.score, 74);
    checkEq('the stored category deductions are the scorer breakdown', Object.fromEntries(Object.entries(workedStored.category_deductions).map(([k, v]) => [k, Number(Number(v).toFixed(3))])), Object.fromEntries(Object.entries(worked.scored.categoryDeductions).map(([k, v]) => [k, Number(Number(v).toFixed(3))])));
    checkEq('the stored trip is not flagged severe', workedStored.had_severe_event, false);
    check('with four trips and over an hour of driving the long-term score is no longer withheld', typeof workedOut.res.body.day.longTermScore === 'number' && workedOut.res.body.day.band !== null, `longTermScore ${workedOut.res.body.day.longTermScore} band ${workedOut.res.body.day.band} provisional ${workedOut.res.body.day.provisional}`);
    checkEq('the writer stored the long-term score as an integer', workedOut.day.long_term_score, workedOut.res.body.day.longTermScore);
    checkEq('the writer stored the band', workedOut.day.band, workedOut.res.body.day.band);
  }

  // ---- dispute, role change, delete -------------------------------------------
  if (workedStored) {
    beginStep('trip-actions: dispute the most expensive scored event');
    const target = topScoredEvent(worked.payload);
    const metrics = metricsFromPayload(worked.payload);
    const asIs = device.scoring.scoreTrip(metrics, scorableFromPayload(worked.payload));
    checkEq('the package reproduces the stored score from the payload alone', asIs.score, worked.scored.score);
    const without = device.scoring.scoreTrip(metrics, scorableFromPayload(worked.payload, { [target.id]: 'removed' }));
    console.log(`   disputing ${target.id} (${target.category}, ${worked.payload.provisional.eventDeductions[target.id].toFixed(3)} points); the package predicts ${without.score} without it`);

    const reason = DISPUTE_REASON_FOR[target.category] ?? 'hazard';
    const dispute = await api.invoke('trip-actions', { action: 'dispute', clientEventId: target.id, reason }, jwt);
    check('trip-actions answered 200', dispute.status === 200, dispute.status === 200 ? '' : dispute.text.slice(0, 300));
    if (dispute.status === 200) {
      checkEq('the dispute was auto-accepted', dispute.body.autoAccepted, true);
      checkEq('the recomputed score is what the scoring package predicts without the event', dispute.body.score, without.score);
      checkEq('the trip is still final', dispute.body.status, 'final');
      const [afterDispute] = await api.rows('trips', `id=eq.${workedStored.id}&select=*`);
      checkEq('apply_recompute stored the recomputed score', afterDispute.score, without.score);
      const events = await api.rows('trip_events', `trip_id=eq.${workedStored.id}&select=*`);
      const removed = events.find((e) => e.client_event_id === target.id);
      checkEq('the disputed event is removed', removed.status, 'removed');
      checkEq('the removed event costs nothing', Number(removed.deduction), 0);
      const disputes = await api.rows('event_disputes', `user_id=eq.${uid}&select=*`);
      checkEq('event_disputes has exactly this run one row', disputes.length, 1);
      checkEq('the dispute row names the event', disputes[0].event_id, removed.id);
      checkEq('the dispute row carries the reason', disputes[0].reason, reason);
      checkEq('the dispute row is marked accepted', disputes[0].auto_accepted, true);
      const [dayAfter] = await api.rows('score_daily', `user_id=eq.${uid}&day=eq.${expectedDay}&select=*`);
      check('the day row was refreshed with the recompute', dayAfter && dayAfter.day === expectedDay, dayAfter ? dayLine(dayAfter) : 'missing');
      checkEq('the reply carries the day rows it wrote', dispute.body.days.some((d) => d.day === expectedDay), true);
    }

    beginStep('trip-actions: set-role passenger');
    const role = await api.invoke('trip-actions', { action: 'set-role', clientTripId: workedId, role: 'passenger' }, jwt);
    check('trip-actions answered 200', role.status === 200, role.status === 200 ? '' : role.text.slice(0, 300));
    if (role.status === 200) {
      checkEq('the role is passenger', role.body.role, 'passenger');
      checkEq('a passenger trip is unscored', role.body.status, 'unscored');
      checkEq('a passenger trip has no score', role.body.score, null);
      const [afterRole] = await api.rows('trips', `id=eq.${workedStored.id}&select=*`);
      checkEq('the stored role is passenger', afterRole.role, 'passenger');
      checkEq('the stored status is unscored', afterRole.status, 'unscored');
      checkEq('the stored score is cleared', afterRole.score, null);
      checkEq('the stored reason is passenger', afterRole.unscored_reason, 'passenger');
      const [dayAfterRole] = await api.rows('score_daily', `user_id=eq.${uid}&day=eq.${expectedDay}&select=*`);
      check('the day no longer counts the passenger trip', dayAfterRole.trips_scored === trips.length, dayLine(dayAfterRole));
    }

    beginStep('trip-actions: delete');
    const before = await api.listTraces(uid);
    check('the trace object is in the bucket before the delete', before.includes(`${workedId}.bin.gz`), before.join(', '));
    const del = await api.invoke('trip-actions', { action: 'delete', clientTripId: workedId }, jwt);
    check('trip-actions answered 200', del.status === 200, del.status === 200 ? '' : del.text.slice(0, 300));
    if (del.status === 200) {
      checkEq('the trip is reported deleted', del.body.deleted, true);
      const [afterDelete] = await api.rows('trips', `id=eq.${workedStored.id}&select=*`);
      check('deleted_at is set', afterDelete.deleted_at !== null, String(afterDelete.deleted_at));
      checkEq('the stored trace path is cleared', afterDelete.trace_path, null);
      const after = await api.listTraces(uid);
      checkEq('the storage object is gone', after.includes(`${workedId}.bin.gz`), false);
      const [dayAfterDelete] = await api.rows('score_daily', `user_id=eq.${uid}&day=eq.${expectedDay}&select=*`);
      check('the day row survives the delete, refreshed without the trip', dayAfterDelete.day === expectedDay, dayLine(dayAfterDelete));
    }
  }

  // ---- idempotency --------------------------------------------------------------
  beginStep('idempotency: the same payload again');
  for (const t of trips) {
    const [before] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${t.clientTripId}&select=*`);
    const again = await api.invoke('finalize-trip', t.trip.payload, jwt);
    checkEq(`${t.name}: the second upload is a replay`, again.status === 200 && again.body.replayed, true);
    checkEq(`${t.name}: the replay answers the stored score`, again.body.score, before.score);
    const [after] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${t.clientTripId}&select=*`);
    checkEq(`${t.name}: the stored row did not move`, { ...after, updated_at: null }, { ...before, updated_at: null });
    checkEq(`${t.name}: updated_at did not move either`, after.updated_at, before.updated_at);
  }

  // ---- the golden, in one place ---------------------------------------------------
  beginStep('golden values');
  const finalTrips = await api.rows('trips', `user_id=eq.${uid}&select=client_trip_id,score,status,role,data_quality,local_day,deleted_at&order=started_at`);
  console.log(JSON.stringify(finalTrips, null, 2));
  const finalDays = await api.rows('score_daily', `user_id=eq.${uid}&select=*&order=day`);
  console.log(JSON.stringify(finalDays, null, 2));
  const finalBaselines = await api.rows('baselines', `user_id=eq.${uid}&select=*`);
  console.log(JSON.stringify(finalBaselines, null, 2));

  if (!args.includes('--keep')) {
    await api.removeTraces(uid, await api.listTraces(uid));
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

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('\nFAILED:');
      for (const f of failed) console.log(`  [${f.step}] ${f.name} — ${f.detail}`);
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error(`\ne2e-trip: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 1;
  });
