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
 *                      file and the queue item — and the queued payload is asserted byte-equal to
 *                      the one the finalizer returned and then uploaded;
 *   3. upload          the gzip trace to `traces/<uid>/<clientTripId>.bin.gz` with a user JWT;
 *   4. finalize-trip   POST the payload to the edge function, which re-scores it and calls the
 *                      `apply_trip` writer;
 *   5. read back       the stored `trips`, `trip_events` and `score_daily` rows with the service
 *                      key, and assert the authoritative numbers against the device's provisional
 *                      ones (the golden: Δ = 0, `provisionalMismatch: false`);
 *   6. trip-actions    dispute the worked example's most expensive scored event, change its role to
 *                      passenger, and delete a trip that is still scored — asserting how each one
 *                      *moves* the day aggregates, not merely that a row is still there;
 *   7. idempotency     re-POST every payload and prove `replayed: true` with the rows unmoved;
 *   8. negative control  post a payload that declares a score it did not earn, and prove the server
 *                      returns and stores its own number instead. Without this step every score
 *                      check is server-against-device, and a `finalize-trip` that simply echoed
 *                      `provisional.score` back would pass the whole run.
 *
 * Nothing here is skippable. Each section declares how many checks it must record and the run ends
 * by asserting it recorded exactly that many, so a block that silently does not run is a failure
 * rather than a shorter green run.
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
 * the user instead of a fresh one per run; that user's trips, day rows, baselines and rate limits
 * are deleted first) · --keep (leave the trips behind for inspection) · --external-serve (do not
 * start `supabase functions serve`; assume one is already running).
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

/**
 * The quality-downgrade constants of `supabase/functions/_shared/plausibility.ts:43-46`, mirrored
 * so `downgradesFromPayload` below is the server's rule and not an assumption about it.
 */
const SPEED_DIVERGENCE_FACTOR = 1.25;
const SPEED_DIVERGENCE_SLACK_MPS = 2;
const SPAN_SLACK_S = 1;

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
//
// Every section also declares its check count, and `verifyStepCounts` asserts it at the end. A
// block that is skipped — or a crash halfway through one — therefore fails loudly instead of
// producing a shorter run that still reads as "all passed".
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

/** Numbers out of Postgres carry more digits than the scorer's; three decimals is the contract. */
const round3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(3)) : v);
const map3 = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round3(Number(v))])) : o);

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

/** One readable line per stored `score_daily` row — the numbers a golden is read for. */
const dayLine = (d) =>
  d === null || d === undefined
    ? 'no row'
    : `${d.day} longTermScore ${d.long_term_score} band ${d.band} provisional ${d.provisional} ` +
      `safeDay ${d.safe_day} goodDay ${d.good_day} phoneFreeDay ${d.phone_free_day} ` +
      `exposure ${d.exposure} drivingS ${d.driving_s} tripsScored ${d.trips_scored} severeEvents ${d.severe_events}`;

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

/** The accounting: one check per section, comparing the checks it ran with the checks it promised. */
function verifyStepCounts() {
  if (counted || steps.length === 0) return;
  counted = true;
  const prior = steps.slice();
  beginStep('check accounting', prior.length);
  for (const s of prior) checkEq(`"${s.title}" ran every check it declares`, s.ran, s.expected);
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
  // The CLI may print a "Stopped services" line before the JSON.
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`BLOCKED: \`npx supabase status\` printed no JSON:\n${out}`);
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
// HTTP: the surfaces the device touches (functions, storage) and the one the assertions do
// (PostgREST with the service key — a read the app itself is never allowed to make).
// ---------------------------------------------------------------------------

/**
 * Statuses that mean "the runtime answered". The gateway 401s an unauthenticated GET; a function
 * that is not being served 503s, and a wrong path 404s. Anything else — a 500 from the gateway,
 * say — is not a working runtime and must not be mistaken for one.
 */
const FUNCTIONS_READY_STATUSES = new Set([200, 400, 401, 405]);

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

    async functionsReady(name) {
      try {
        const res = await fetch(`${API_URL}/functions/v1/${name}`, { method: 'GET' });
        return FUNCTIONS_READY_STATUSES.has(res.status);
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

/** Every field `traceSchema` (`src/core/replay/trace.ts`) allows. */
const TRACE_KEYS = ['name', 'mode', 'night', 'precipitation', 'rows', 'limits', 'expected', 'noEvents'];

/**
 * A trace replayed at a new wall-clock start: every timestamp moves by the same delta.
 *
 * The fields are listed rather than spread, so a timestamp-bearing field added to `traceSchema`
 * later fails here instead of being carried through unshifted into a golden that still passes.
 */
function rebaseTrace(trace, startedAt) {
  const unknown = Object.keys(trace).filter((k) => !TRACE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `e2e-trip: rebaseTrace does not know the trace field(s) ${unknown.join(', ')}; if any of them carries a timestamp it must be shifted too`
    );
  }
  const delta = startedAt - trace.rows[0].ts;
  const out = {
    name: trace.name,
    mode: trace.mode,
    night: trace.night,
    precipitation: trace.precipitation,
    rows: trace.rows.map((r) => ({ ...r, ts: r.ts + delta })),
    limits: trace.limits.map((l) => ({ ...l, fromTs: l.fromTs + delta })),
    expected: trace.expected.map((e) => ({ ...e, startsNear: e.startsNear + delta })),
  };
  if (trace.noEvents !== undefined) out.noEvents = trace.noEvents;
  return out;
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

/**
 * Run one trip through the finalizer and take the payload back off the sync queue.
 *
 * Records 2 checks: the queue item is byte-equal to the payload the finalizer returned (so what is
 * uploaded below is what the runner would have sent), and the trace file was written.
 */
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
  const gzip = files.get(device.finalize.tracePathFor(clientTripId)) ?? null;

  const queuedMatches = queued != null && result.payload != null && canonical(queued) === canonical(result.payload);
  check(
    'the payload on the sync queue is the one the finalizer returned',
    queuedMatches,
    queuedMatches
      ? `${result.payload.events.length} events, ${JSON.stringify(result.payload).length} bytes`
      : `queued ${show(queued)}`
  );
  check('the trace file was written and gzipped', gzip !== null && gzip.length > 0, `${gzip?.length ?? 0} bytes`);

  return { scored: result.scored, payload: result.payload, queued, gzip };
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
// Scoring the same trip the way the server does, from the payload alone. `packages/scoring` is the
// source of truth for both ends, so every expected value here is computed rather than written down.
// ---------------------------------------------------------------------------

/**
 * The quality downgrades `checkPlausibility` (`_shared/plausibility.ts:160-173`) would apply, in
 * its order. Mirrored rather than assumed away: `metricsFromPayload` needs to withhold the IMU on
 * exactly the same condition the server does, and the self-check pins both branches.
 */
function downgradesFromPayload(p) {
  const out = [];
  if (p.tracePath === null) out.push('no_trace');
  if (p.incomplete) out.push('incomplete');
  const spanS = (p.endedAt - p.startedAt) / 1000;
  if (p.durationS > spanS + SPAN_SLACK_S) out.push('duration_exceeds_span');
  const max = p.rowsDigest.maxSustainedSpeedMps;
  const allowed = Math.max(max * SPEED_DIVERGENCE_FACTOR, max + SPEED_DIVERGENCE_SLACK_MPS);
  if (p.durationS > 0 && p.distanceM / p.durationS > allowed) out.push('distance_exceeds_speed');
  return out;
}

/** `tripMetrics` (`supabase/functions/_shared/plausibility.ts:185`) over an upload payload. */
function metricsFromPayload(payload) {
  return {
    distanceM: payload.distanceM,
    durationS: payload.durationS,
    validGnssPct: payload.rowsDigest.validGnssPct,
    imuPresent: downgradesFromPayload(payload).length === 0 && payload.rowsDigest.imuPresent,
    role: payload.role,
    maxSustainedSpeedMps: payload.rowsDigest.maxSustainedSpeedMps,
  };
}

/** `toScorableEvent` (`supabase/functions/_shared/rescore.ts:64`) over one payload event. */
function scorableEvent(e, status) {
  return {
    id: e.id,
    category: e.category,
    startedAt: e.startedAt,
    durationS: e.durationMs / 1000,
    q: e.q,
    corrected: e.corrected,
    status: status ?? e.status,
    measured: { ...e.measured },
    context: { night: e.context.night === true, precipitation: e.context.precipitation === true },
  };
}

function scorableFromPayload(payload, statusOverrides = {}) {
  return payload.events.map((e) => scorableEvent(e, statusOverrides[e.id]));
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

const SELF_CHECKS = 20;

function selfCheck() {
  beginStep('self-check (pure helpers, no stack)', SELF_CHECKS);

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
    night: false,
    precipitation: false,
    rows: [{ ts: 1_000, speed: 3 }, { ts: 2_000, speed: 4 }],
    limits: [{ fromTs: 1_000, limitMps: 10 }],
    expected: [{ category: 'phone', startsNear: 1_500 }],
  };
  const moved = rebaseTrace(trace, 9_000);
  checkEq('rebasing shifts the rows', moved.rows.map((r) => r.ts), [9_000, 10_000]);
  checkEq('rebasing shifts the limits', moved.limits[0].fromTs, 9_000);
  checkEq('rebasing shifts the expectations', moved.expected[0].startsNear, 9_500);
  checkEq('rebasing leaves everything else alone', moved.rows[1].speed, 4);
  checkEq(
    'rebasing refuses a trace field it does not know, rather than carrying it through unshifted',
    (() => {
      try {
        rebaseTrace({ ...trace, startsAt: 7 }, 9_000);
        return 'carried through';
      } catch {
        return 'refused';
      }
    })(),
    'refused'
  );

  // The quality cap: the server withholds the IMU on any downgrade, so this must agree with it.
  const clean = {
    tracePath: 'x.bin.gz', incomplete: false, startedAt: 0, endedAt: 150_000, durationS: 150,
    distanceM: 1_500, rowsDigest: { maxSustainedSpeedMps: 20, validGnssPct: 100, imuPresent: true }, role: 'driver',
  };
  checkEq('a consistent payload carries no quality downgrade', downgradesFromPayload(clean), []);
  checkEq('a trip without a trace, or longer than its own span, is downgraded', downgradesFromPayload({ ...clean, tracePath: null, durationS: 400 }), ['no_trace', 'duration_exceeds_span']);
  checkEq('a downgraded payload withholds the IMU from the scorer, as the server does', metricsFromPayload({ ...clean, tracePath: null }).imuPresent, false);

  // The event a driver would dispute first is the most expensive *scored* one.
  const ev = (id, status) => ({ id, status, category: 'braking', startedAt: 1, durationMs: 1000, q: 1, corrected: false, measured: {}, context: { night: false, precipitation: false } });
  const payload = {
    events: [{ ...ev('a', 'scored'), category: 'phone' }, { ...ev('b', 'scored'), durationMs: 2000 }, ev('c', 'possible')],
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
    `BLOCKED: the edge functions runtime never answered on ${api.apiUrl}/functions/v1/finalize-trip.\n` +
      `Run \`npx supabase functions serve\` yourself, or check Docker.\n${log.join('').slice(-4000)}`
  );
}

/** How many checks `uploadTrip` records. Every one of them runs on every path. */
const UPLOAD_CHECKS = 21;

/**
 * One upload and everything it must be true of: the trace object, the function call, and the rows
 * the writer left behind.
 *
 * Nothing here is guarded. A 200 with no readable row, or an error reply, fails the remaining
 * checks (optional chaining yields `undefined`, which `canonical` never lets pass for a real value)
 * instead of skipping them — a skipped check would otherwise read as a shorter green run.
 */
async function uploadTrip(api, ctx, device, trip, expect = {}) {
  const { uid, jwt, expectedDay } = ctx;
  const want = {
    score: trip.scored.score,
    status: trip.scored.status,
    dataQuality: trip.scored.dataQuality,
    categoryDeductions: trip.scored.categoryDeductions,
    eventDeductions: trip.scored.eventDeductions ?? {},
    mismatch: false,
    ...expect,
  };
  const id = trip.payload.clientTripId;

  const put = await api.uploadTrace(uid, id, trip.gzip, jwt);
  check(`the trace object is stored under ${uid.slice(0, 8)}…/${id.slice(0, 8)}…`, put.status === 200, `HTTP ${put.status}`);

  const res = await api.invoke('finalize-trip', trip.payload, jwt);
  check('finalize-trip answered 200', res.status === 200, res.status === 200 ? `x-request-id ${res.requestId}` : res.text.slice(0, 300));

  const [stored] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${id}&select=*`);
  check('the trip row was stored', stored != null, stored ? `id ${stored.id}` : 'no row for this client trip id');

  const eventRows = stored ? await api.rows('trip_events', `trip_id=eq.${stored.id}&select=*&order=started_at`) : [];
  const dayKey = res.body?.day?.day;
  const [day] = typeof dayKey === 'string' ? await api.rows('score_daily', `user_id=eq.${uid}&day=eq.${dayKey}&select=*`) : [];
  console.log(`   server: score ${res.body?.score} ${res.body?.status}, day ${show(res.body?.day)}`);

  checkEq('the authoritative score equals the expected score (Δ = 0)', res.body?.score, want.score);
  checkEq('provisionalMismatch is what this payload deserves', res.body?.provisionalMismatch, want.mismatch);
  checkEq('the writer stored the trip, not a replay', res.body?.replayed, false);
  checkEq('the status is the scorer status', res.body?.status, want.status);
  checkEq('the stored score is the answered score', stored?.score, res.body?.score);
  checkEq('the stored data quality is the scorer grade', stored?.data_quality, want.dataQuality);
  checkEq('the stored category deductions are the scorer breakdown', map3(stored?.category_deductions), map3(want.categoryDeductions));
  checkEq('the stored local day is the trip day in its zone', stored?.local_day, expectedDay);
  checkEq('trips.rows_digest is stored verbatim', stored?.rows_digest, trip.payload.rowsDigest);
  checkEq('trips.trace_path is the derived storage key', stored?.trace_path, `${uid}/${id}.bin.gz`);
  checkEq('trips.conditions is the server clock rule, not a client field', stored?.conditions, {
    night: device.finalize.nightAt(trip.payload.startedAt, trip.payload.tz, device.scoring.CONSTANTS),
    precipitation: false,
  });
  checkEq('every payload event was stored', eventRows.length, trip.payload.events.length);
  checkEq(
    'the stored per-event status, severity, multiplier and deduction are the scorer\'s',
    trip.payload.events.map((e) => {
      const row = eventRows.find((r) => r.client_event_id === e.id);
      return {
        id: e.id,
        status: row?.status,
        severity: round3(Number(row?.severity)),
        contextMultiplier: round3(Number(row?.context_multiplier)),
        deduction: row?.deduction == null ? null : round3(Number(row.deduction)),
      };
    }),
    trip.payload.events.map((e) => ({
      id: e.id,
      status: e.status,
      severity: round3(device.scoring.severity(scorableEvent(e))),
      contextMultiplier: round3(device.scoring.contextMultiplier(scorableEvent(e))),
      deduction: want.status === 'final' ? round3(want.eventDeductions[e.id] ?? 0) : null,
    }))
  );
  checkEq('the answered day is the trip local day', dayKey, expectedDay);
  check('the answered day row is a stored day row', day != null && day.day === expectedDay, dayLine(day ?? null));
  checkEq('the stored long-term score matches the answer', day?.long_term_score, res.body?.day?.longTermScore);
  checkEq('the stored trips_scored matches the answer', day?.trips_scored, res.body?.day?.tripsScored);
  checkEq('the stored driving_s matches the answer', day?.driving_s, res.body?.day?.drivingS);

  return { res, stored, events: eventRows, day };
}

/** The `score_daily` row of `day`, or null. */
async function readDay(api, uid, day) {
  const [row] = await api.rows('score_daily', `user_id=eq.${uid}&day=eq.${day}&select=*`);
  return row ?? null;
}

/**
 * The long-term score `packages/scoring` gives for the user's live scored trips *right now* — the
 * same set and the same rounding `dayRows` uses, computed here so the day row is checked against an
 * independent number rather than against itself.
 */
async function expectedLongTerm(api, device, uid) {
  const rows = await api.rows(
    'trips',
    `user_id=eq.${uid}&deleted_at=is.null&status=in.(final,provisional)&select=ended_at,score,exposure,duration_s`
  );
  const trips = rows
    .filter((r) => r.score !== null)
    .map((r) => ({
      endedAt: Date.parse(r.ended_at),
      score: Number(r.score),
      exposure: Number(r.exposure),
      durationS: Number(r.duration_s),
    }));
  const lt = device.scoring.longTermScore(trips, Date.now());
  return lt.score === null ? null : Math.round(lt.score);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  selfCheck();
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

  try {
    serve = args.includes('--external-serve') ? null : await startFunctionsServe(api, serveLog);
    check('the edge functions runtime answers', await api.functionsReady('finalize-trip'));

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
    // It is also the trip the delete lands on later, while it is still scored.
    beginStep('a 40-minute uneventful drive (so the long-term score is not withheld)', UPLOAD_CHECKS + 4);
    const fillerStart = epochAtLocalHour(year, month, day, TRIP_HOURS.filler, TZ);
    const fillerId = crypto.randomUUID();
    const fillerRows = straightTrack(device, fillerStart, 2400);
    await persistRecording(device, db, fillerId, fillerRows, TZ, 30);
    const fillerSession = closedSession(device, {
      clientTripId: fillerId,
      trace: { mode: 'mounted' },
      rows: fillerRows,
      events: [],
      limitFor: syntheticLimit(fillerStart),
    });
    const filler = await finalizeAndQueue(device, db, fillerSession, fillerId, TZ);
    checkEq('an uneventful drive scores 100', filler.scored.score, 100);
    const fillerOut = await uploadTrip(api, ctx, device, filler);
    checkEq('the long-term score is still withheld after one trip', fillerOut.res.body?.day?.longTermScore, null);
    trips.push({ name: 'filler', clientTripId: fillerId, trip: filler, out: fillerOut });

    // ---- the two recorded traces -------------------------------------------------
    for (const [name, hour, prefix] of [
      ['speeding-corrected', TRIP_HOURS.speeding, 't1'],
      ['phone-pickup', TRIP_HOURS.phone, 't2'],
    ]) {
      beginStep(`replay → finalize → upload → finalize-trip: ${name}`, UPLOAD_CHECKS + 5);
      const startedAt = epochAtLocalHour(year, month, day, hour, TZ);
      check('the trip starts in the past, inside the server 30-day window', startedAt < now && now - startedAt < 30 * 86_400_000, new Date(startedAt).toISOString());

      const raw = device.trace.parseTrace(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', '__fixtures__', 'traces', `${name}.json`), 'utf8')));
      const trace = device.trace.parseTrace(rebaseTrace(raw, startedAt));
      // The server rewrites every event's `context.night` from the trip's own clock rule. The
      // replay fed the detectors `trace.night`, so the two must agree or the golden would diverge
      // for a reason that has nothing to do with the pipeline.
      checkEq(
        'the rebased start agrees with the night flag the trace was replayed under',
        device.finalize.nightAt(startedAt, TZ, device.scoring.CONSTANTS),
        trace.night
      );
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
      console.log(
        `   device: score ${trip.scored.score} ${trip.scored.status} grade ${trip.scored.dataQuality}, ` +
          `${Math.round(trip.payload.distanceM)} m in ${trip.payload.durationS.toFixed(1)} s, ` +
          `${trip.payload.events.length} events (${trip.payload.events.filter((e) => e.status === 'scored').length} scored)`
      );
      const out = await uploadTrip(api, ctx, device, trip);
      trips.push({ name, clientTripId, trip, out });
    }

    // ---- the §9.4 worked example ------------------------------------------------
    beginStep('the §9.4 worked example through the function', UPLOAD_CHECKS + 10);
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
    const workedOut = await uploadTrip(api, ctx, device, worked);
    // The spec constant, asserted against the server independently of the device's number.
    checkEq('the function re-scores the worked example to the spec 74', workedOut.res.body?.score, 74);
    checkEq('apply_trip stored 74', workedOut.stored?.score, 74);
    checkEq('the stored trip is not flagged severe', workedOut.stored?.had_severe_event, false);
    check(
      'with four trips and over an hour of driving the long-term score is no longer withheld',
      typeof workedOut.res.body?.day?.longTermScore === 'number' && workedOut.res.body?.day?.band !== null,
      `longTermScore ${workedOut.res.body?.day?.longTermScore} band ${workedOut.res.body?.day?.band} provisional ${workedOut.res.body?.day?.provisional}`
    );
    checkEq('the writer stored the band', workedOut.day?.band, workedOut.res.body?.day?.band);
    checkEq(
      'the day long-term score is what the scoring package gives for the stored trips',
      workedOut.day?.long_term_score,
      await expectedLongTerm(api, device, uid)
    );

    // ---- dispute ------------------------------------------------------------------
    beginStep('trip-actions: dispute the most expensive scored event', 16);
    const beforeDispute = await readDay(api, uid, expectedDay);
    const target = topScoredEvent(worked.payload);
    const metrics = metricsFromPayload(worked.payload);
    const asIs = device.scoring.scoreTrip(metrics, scorableFromPayload(worked.payload));
    checkEq('the package reproduces the stored score from the payload alone', asIs.score, worked.scored.score);
    const without = device.scoring.scoreTrip(metrics, scorableFromPayload(worked.payload, { [target.id]: 'removed' }));
    console.log(`   disputing ${target.id} (${target.category}, ${worked.payload.provisional.eventDeductions[target.id].toFixed(3)} points); the package predicts ${without.score} without it`);

    const reason = DISPUTE_REASON_FOR[target.category] ?? 'hazard';
    const dispute = await api.invoke('trip-actions', { action: 'dispute', clientEventId: target.id, reason }, jwt);
    check('trip-actions answered 200', dispute.status === 200, dispute.status === 200 ? '' : dispute.text.slice(0, 300));
    checkEq('the dispute was auto-accepted', dispute.body?.autoAccepted, true);
    checkEq('the recomputed score is what the scoring package predicts without the event', dispute.body?.score, without.score);
    checkEq('the trip is still final', dispute.body?.status, 'final');
    const [afterDispute] = await api.rows('trips', `id=eq.${workedOut.stored?.id}&select=*`);
    checkEq('apply_recompute stored the recomputed score', afterDispute?.score, without.score);
    const disputedEvents = await api.rows('trip_events', `trip_id=eq.${workedOut.stored?.id}&select=*`);
    const removed = disputedEvents.find((e) => e.client_event_id === target.id);
    checkEq('the disputed event is removed', removed?.status, 'removed');
    checkEq('the removed event costs nothing', removed?.deduction == null ? removed?.deduction : Number(removed.deduction), 0);
    const disputes = await api.rows('event_disputes', `user_id=eq.${uid}&select=*`);
    checkEq('event_disputes has exactly one row for this run', disputes.length, 1);
    checkEq('the dispute row names the event', disputes[0]?.event_id, removed?.id);
    checkEq('the dispute row carries the reason', disputes[0]?.reason, reason);
    checkEq('the dispute row is marked accepted', disputes[0]?.auto_accepted, true);
    checkEq('the reply carries the day rows it wrote', dispute.body?.days?.some((d) => d.day === expectedDay), true);

    const dayAfterDispute = await readDay(api, uid, expectedDay);
    console.log(`   day after the dispute: ${dayLine(dayAfterDispute)}`);
    checkEq(
      'the day long-term score moved to what the package gives for the recomputed trips',
      dayAfterDispute?.long_term_score,
      await expectedLongTerm(api, device, uid)
    );
    checkEq('a dispute does not change how many trips the day counts', dayAfterDispute?.trips_scored, beforeDispute?.trips_scored);
    checkEq('a dispute does not change the day driving time', dayAfterDispute?.driving_s, beforeDispute?.driving_s);

    // ---- set-role passenger --------------------------------------------------------
    beginStep('trip-actions: set-role passenger', 12);
    const role = await api.invoke('trip-actions', { action: 'set-role', clientTripId: workedId, role: 'passenger' }, jwt);
    check('trip-actions answered 200', role.status === 200, role.status === 200 ? '' : role.text.slice(0, 300));
    checkEq('the role is passenger', role.body?.role, 'passenger');
    checkEq('a passenger trip is unscored', role.body?.status, 'unscored');
    checkEq('a passenger trip has no score', role.body?.score, null);
    const [afterRole] = await api.rows('trips', `id=eq.${workedOut.stored?.id}&select=*`);
    checkEq('the stored role is passenger', afterRole?.role, 'passenger');
    checkEq('the stored status is unscored', afterRole?.status, 'unscored');
    checkEq('the stored score is cleared', afterRole?.score, null);
    checkEq('the stored reason is passenger', afterRole?.unscored_reason, 'passenger');
    const dayAfterRole = await readDay(api, uid, expectedDay);
    console.log(`   day after the role change: ${dayLine(dayAfterRole)}`);
    checkEq('the day counts one scored trip fewer', dayAfterRole?.trips_scored, dayAfterDispute?.trips_scored - 1);
    checkEq('the day loses exactly that trip driving time', dayAfterRole?.driving_s, dayAfterDispute?.driving_s - Math.round(worked.payload.durationS));
    checkEq('the day loses exactly that trip exposure', round3(Number(dayAfterRole?.exposure)), round3(Number(dayAfterDispute?.exposure) - worked.scored.exposure));
    checkEq('the long-term score follows the trips that are left', dayAfterRole?.long_term_score, await expectedLongTerm(api, device, uid));

    // ---- delete, on a trip that is still scored -------------------------------------
    beginStep('trip-actions: delete a trip that is still scored', 10);
    const bucketBefore = await api.listTraces(uid);
    check('the trace object is in the bucket before the delete', bucketBefore.includes(`${fillerId}.bin.gz`), bucketBefore.join(', '));
    const del = await api.invoke('trip-actions', { action: 'delete', clientTripId: fillerId }, jwt);
    check('trip-actions answered 200', del.status === 200, del.status === 200 ? '' : del.text.slice(0, 300));
    checkEq('the trip is reported deleted', del.body?.deleted, true);
    const [afterDelete] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${fillerId}&select=*`);
    check('deleted_at is set', afterDelete?.deleted_at != null, String(afterDelete?.deleted_at));
    checkEq('the stored trace path is cleared', afterDelete?.trace_path, null);
    const bucketAfter = await api.listTraces(uid);
    checkEq('the storage object is gone', bucketAfter.includes(`${fillerId}.bin.gz`), false);
    const dayAfterDelete = await readDay(api, uid, expectedDay);
    console.log(`   day after the delete: ${dayLine(dayAfterDelete)}`);
    checkEq('the day counts one scored trip fewer', dayAfterDelete?.trips_scored, dayAfterRole?.trips_scored - 1);
    checkEq('the day loses exactly the deleted trip driving time', dayAfterDelete?.driving_s, dayAfterRole?.driving_s - Math.round(filler.payload.durationS));
    checkEq('the day loses exactly the deleted trip exposure', round3(Number(dayAfterDelete?.exposure)), round3(Number(dayAfterRole?.exposure) - filler.scored.exposure));
    checkEq('the long-term score follows the trips that are left', dayAfterDelete?.long_term_score, await expectedLongTerm(api, device, uid));

    // ---- idempotency --------------------------------------------------------------
    beginStep('idempotency: the same payload again', trips.length * 4);
    for (const t of trips) {
      const [before] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${t.clientTripId}&select=*`);
      const again = await api.invoke('finalize-trip', t.trip.payload, jwt);
      checkEq(`${t.name}: the second upload is a replay`, again.status === 200 && again.body?.replayed, true);
      checkEq(`${t.name}: the replay answers the stored score`, again.body?.score, before?.score);
      const [after] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${t.clientTripId}&select=*`);
      checkEq(`${t.name}: the stored row did not move`, { ...after, updated_at: null }, { ...before, updated_at: null });
      checkEq(`${t.name}: updated_at did not move either`, after?.updated_at, before?.updated_at);
    }

    // ---- the negative control -------------------------------------------------------
    // Every check so far compares the server's number with the device's, so a `finalize-trip` that
    // stored `provisional.score` verbatim would pass all of them. This one posts a payload whose
    // declared score, category totals and per-event derived fields are all wrong, and proves the
    // server answers and stores its own numbers instead.
    beginStep('negative control: a payload that declares a score it did not earn', 11);
    const lie = JSON.parse(JSON.stringify(worked.payload));
    lie.clientTripId = crypto.randomUUID();
    lie.tracePath = `${lie.clientTripId}.bin.gz`;
    lie.events = lie.events.map((e) => ({
      ...e,
      id: `nc-${e.id}`,
      severity: 0,
      contextMultiplier: 1,
      deduction: e.deduction === null ? null : 0,
    }));
    const declaredScore = Math.max(0, worked.scored.score - 24);
    lie.provisional = {
      ...lie.provisional,
      score: declaredScore,
      categoryDeductions: { phone: 0, speeding: 0, braking: 0, accel: 0, cornering: 0, focus: 0 },
      eventDeductions: {},
    };
    const truth = device.scoring.scoreTrip(metricsFromPayload(lie), scorableFromPayload(lie));
    console.log(`   the payload declares ${declaredScore}; the scoring package says this trip is worth ${truth.score}`);

    const lieput = await api.uploadTrace(uid, lie.clientTripId, worked.gzip, jwt);
    check('the trace object is stored', lieput.status === 200, `HTTP ${lieput.status}`);
    const lieRes = await api.invoke('finalize-trip', lie, jwt);
    check('finalize-trip answered 200', lieRes.status === 200, lieRes.status === 200 ? `x-request-id ${lieRes.requestId}` : lieRes.text.slice(0, 300));
    const [lieStored] = await api.rows('trips', `user_id=eq.${uid}&client_trip_id=eq.${lie.clientTripId}&select=*`);
    check('the trip row was stored', lieStored != null, lieStored ? `id ${lieStored.id}` : 'no row');
    checkEq('the server answers the score it computed, not the score it was told', lieRes.body?.score, truth.score);
    checkEq('the declared score is not what came back', lieRes.body?.score === declaredScore, false);
    checkEq('the server reports the provisional mismatch', lieRes.body?.provisionalMismatch, true);
    checkEq('apply_trip stored the server score', lieStored?.score, truth.score);
    checkEq('the stored category deductions are the server breakdown, not the declared zeros', map3(lieStored?.category_deductions), map3(truth.categoryDeductions));
    const lieEvents = await api.rows('trip_events', `trip_id=eq.${lieStored?.id}&select=*&order=started_at`);
    checkEq(
      'the stored per-event deductions are the server numbers, not the declared zeros',
      lie.events.map((e) => {
        const row = lieEvents.find((r) => r.client_event_id === e.id);
        return { id: e.id, deduction: row?.deduction == null ? null : round3(Number(row.deduction)) };
      }),
      lie.events.map((e) => ({ id: e.id, deduction: round3(truth.eventDeductions[e.id] ?? 0) }))
    );
    checkEq(
      'the stored per-event severity is the server number, not the declared zero',
      lie.events.map((e) => round3(Number(lieEvents.find((r) => r.client_event_id === e.id)?.severity))),
      lie.events.map((e) => round3(device.scoring.severity(scorableEvent(e))))
    );
    checkEq(
      'the stored per-event context multiplier is the server number, not the declared 1',
      lie.events.map((e) => round3(Number(lieEvents.find((r) => r.client_event_id === e.id)?.context_multiplier))),
      lie.events.map((e) => round3(device.scoring.contextMultiplier(scorableEvent(e))))
    );

    // ---- the golden, in one place ---------------------------------------------------
    beginStep('golden values', 0);
    const finalTrips = await api.rows('trips', `user_id=eq.${uid}&select=client_trip_id,score,status,role,data_quality,local_day,deleted_at&order=started_at`);
    console.log(JSON.stringify(finalTrips, null, 2));
    const finalDays = await api.rows('score_daily', `user_id=eq.${uid}&select=*&order=day`);
    console.log(JSON.stringify(finalDays, null, 2));
    const finalBaselines = await api.rows('baselines', `user_id=eq.${uid}&select=*`);
    console.log(JSON.stringify(finalBaselines, null, 2));
  } finally {
    // Cleanup and the spawned runtime are released whatever happened above, so a thrown error
    // neither leaks a `functions serve` process nor leaves this run's rows behind.
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

/** The accounting, the count and the failure list — printed on every path, thrown or not. */
function summarise() {
  verifyStepCounts();
  closeStep();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  [${f.step}] ${f.name} — ${f.detail}`);
  }
  return failed.length === 0;
}

main()
  .then(() => {
    if (!summarise()) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`\ne2e-trip: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    summarise();
    process.exitCode = 1;
  });
