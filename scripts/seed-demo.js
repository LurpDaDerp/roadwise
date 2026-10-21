#!/usr/bin/env node
'use strict';
/**
 * Seeds the demo account: about 60 drives over the last 120 days around Seattle, so every screen
 * (Home, Analytics with its spots to watch, History, the drive summaries, Profile, Friends) has
 * something to show.
 *
 *   local:  SUPABASE_URL=http://127.0.0.1:54621 SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/seed-demo.js
 *   hosted: SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<secret key> node scripts/seed-demo.js
 *           (the CLI must be logged in and linked to <ref>; the database must have every migration)
 *
 * It touches only the demo account's own rows.
 *
 * The demo signs in with demo@roadwise.app and DEMO_PASSWORD (printed at the end); its username is
 * demo_driver.
 *
 * Re-running starts over: the old demo account is deleted (every row of it cascades from
 * auth.users) and a new one is made. Nothing derived is written by hand. The account is created
 * through the Auth admin API and onboarded through the app's own RPCs (claim_username,
 * complete_onboarding, update_profile). Every drive goes through the same path as a phone upload:
 * a v5 upload (its counters as the server would estimate them, and its seconds at driving speed, so
 * every drive was watched for phone use; now and then a phone pickup), stored as finalize-trip
 * stores it (`keepDashcamEvents`, `classifyDrive`) through `private.drive_context` +
 * `private.apply_drive`, oldest first. So the Safety Rating (Phone use included), the weekly goals
 * and the achievements are the server's own derivations. A few places repeat the same event
 * (`DEMO_SPOTS`), so Spots to watch has two active spots and one cleared; phone pickups never repeat
 * at a place (spots never read them).
 *
 * `private.*` is not on the Data API, so the drives go through `supabase db query`: `--local` when
 * SUPABASE_URL is a local address, else `--linked` (the CLI's linked project, which must be the
 * project SUPABASE_URL names). The drives are sent in batches, each one checking that drive_context
 * answers version 23 with nothing stored and no merge (two demo drives never start within 5 min
 * and 150 m of each other).
 *
 * Env:
 *   SUPABASE_URL                the project URL (local: `supabase status`, API_URL)
 *   SUPABASE_SERVICE_ROLE_KEY   the service_role / secret key (local: `supabase status`)
 *   SUPABASE_ANON_KEY           optional: the key the demo user's own calls use (default: the service key)
 *   DEMO_PASSWORD               optional: default `RoadWiseDemo!2026`
 *
 * The drives are generated from a fixed seed relative to now, so two runs on the same day give the
 * same account. scripts/__tests__/seed-demo.test.ts checks the generator against the upload
 * contract, the integrity rules, the rating and the spots.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * Node cannot require the TypeScript sources (the scoring package's imports have no extension), so
 * outside Jest they are transpiled on the fly with the project's own TypeScript.
 */
function installTsHook() {
  if (process.env.JEST_WORKER_ID !== undefined || require.extensions['.ts']) return;
  const ts = require('typescript');
  require.extensions['.ts'] = (module, filename) => {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    });
    module._compile(out.outputText, filename);
  };
}
installTsHook();

const scoring = require('../packages/scoring/src/index.ts');
const { parseFinalizeUpload } = require('../src/data/sync/payload.ts');
// A Deno module (its imports name `.ts`): the path is built so the scripts' typecheck does not follow it.
const { integrityReason } = require(path.join(ROOT, 'supabase', 'functions', '_shared', 'finalize_rules.ts'));
const { sunIsDown, dayKey } = require('../src/lib/time.ts');
const { encodeRuns } = require('../src/lib/polyline.ts');

const DEMO_EMAIL = 'demo@roadwise.app';
const DEMO_USERNAME = 'demo_driver';
const DEFAULT_PASSWORD = 'RoadWiseDemo!2026';
const TERMS_VERSION = '2026-10-05';
const TZ = 'America/Los_Angeles';
const APP_VERSION = '3.0.0-demo';
const SEED = 20261019;
const DAYS = 120;
const M_PER_MILE = 1609.344;
/** Roads wind more than the straight chords between waypoints. */
const ROAD_FACTOR = 1.03;
/** The DashPal dashcam the demo drives with (an identity MAC, lowercase hex). */
const DASHCAM_ID = 'a4c138f0d2e1';

// ---------------------------------------------------------------------------------------------
// Randomness and ids

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rnd, lo, hi) => lo + (hi - lo) * rnd();
const intBetween = (rnd, lo, hi) => Math.floor(between(rnd, lo, hi + 1));
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function poisson(rnd, lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  for (let p = rnd(); p > limit; p *= rnd()) k += 1;
  return k;
}

/** A version-4 uuid from the generator, so a fixed seed gives fixed ids. */
function uuid(rnd) {
  const hex = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16));
  hex[12] = '4';
  hex[16] = '89ab'[Math.floor(rnd() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

// ---------------------------------------------------------------------------------------------
// Local time in Seattle

function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant of a Seattle wall-clock time. */
function localInstant(day, minutes) {
  const guess = Date.UTC(day.y, day.m - 1, day.d, 0, minutes);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

/** The Seattle calendar day `back` days before the one holding `now`. */
function localDay(now, back) {
  const [y, m, d] = dayKey(new Date(now), TZ).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - back));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), back };
}

// ---------------------------------------------------------------------------------------------
// Places and roads (waypoints along real roads; the route between two is a straight chord)

/** [lat, lng, limit mph of the stretch that starts here] */
const HOME = [47.6614, -122.3341, 25]; // N 45th St & Wallingford Ave N
const TO_I5_SOUTH = [HOME, [47.6613, -122.329, 30], [47.6612, -122.3236, 60], [47.653, -122.3222, 60], [47.644, -122.3232, 60]];
const I5_TO_I90 = [[47.63, -122.3255, 60], [47.62, -122.327, 60], [47.61, -122.329, 60], [47.5935, -122.3205, 60]];
const I90_EAST = [[47.5905, -122.305, 60], [47.5895, -122.295, 60], [47.5885, -122.265, 60], [47.588, -122.23, 60], [47.583, -122.195, 60], [47.578, -122.17, 60], [47.578, -122.145, 60], [47.565, -122.095, 60]];
const I5_SOUTH_FROM_I90 = [[47.575, -122.3215, 60], [47.55, -122.317, 60], [47.525, -122.3, 60], [47.5, -122.28, 60], [47.475, -122.265, 60]];
const SR520_EAST = [[47.6438, -122.315, 60], [47.6442, -122.303, 60], [47.643, -122.29, 50], [47.64, -122.265, 50], [47.639, -122.24, 60], [47.6365, -122.22, 60]];
const I5_NORTH = [HOME, [47.6613, -122.329, 30], [47.6612, -122.3236, 60], [47.67, -122.3233, 60], [47.685, -122.3237, 60], [47.698, -122.3245, 60]];

const ROUTES = {
  work: { label: 'South Lake Union', points: [HOME, [47.6612, -122.342, 30], [47.6553, -122.3421, 30], [47.6497, -122.342, 30], [47.6497, -122.3497, 25], [47.6475, -122.3498, 30], [47.644, -122.3445, 35], [47.636, -122.341, 35], [47.629, -122.3395, 30], [47.6246, -122.3385, 30]] },
  greenLake: { label: 'Green Lake', points: [HOME, [47.669, -122.3341, 25], [47.672, -122.333, 30], [47.676, -122.331, 30], [47.6806, -122.3283, 25]] },
  ballard: { label: 'Ballard', points: [HOME, [47.6614, -122.342, 30], [47.6614, -122.349, 30], [47.659, -122.36, 35], [47.663, -122.375, 30], [47.6686, -122.3763, 30], [47.6686, -122.3843, 25]] },
  uVillage: { label: 'U Village', points: [HOME, [47.6613, -122.329, 30], [47.6614, -122.3175, 30], [47.6614, -122.3127, 30], [47.6615, -122.305, 30], [47.6625, -122.299, 25]] },
  capitolHill: { label: 'Capitol Hill', points: [...TO_I5_SOUTH, [47.63, -122.3255, 60], [47.62, -122.327, 30], [47.618, -122.322, 30], [47.6153, -122.3209, 25]] },
  northgate: { label: 'Northgate', points: [...I5_NORTH, [47.706, -122.326, 30]] },
  bellevue: { label: 'Bellevue Square', points: [...TO_I5_SOUTH, ...SR520_EAST, [47.634, -122.205, 35], [47.625, -122.2015, 35], [47.6168, -122.2033, 30]] },
  kirkland: { label: 'Kirkland', points: [...TO_I5_SOUTH, ...SR520_EAST, [47.6385, -122.188, 60], [47.655, -122.19, 60], [47.669, -122.187, 35], [47.6765, -122.199, 30], [47.6763, -122.2085, 25]] },
  redmond: { label: 'Redmond', points: [...TO_I5_SOUTH, ...SR520_EAST, [47.6385, -122.188, 60], [47.642, -122.16, 60], [47.648, -122.14, 60], [47.66, -122.125, 40], [47.671, -122.118, 30]] },
  alki: { label: 'Alki Beach', points: [HOME, [47.6614, -122.342, 30], [47.661, -122.347, 40], [47.647, -122.3473, 45], [47.633, -122.344, 40], [47.623, -122.343, 50], [47.608, -122.34, 50], [47.594, -122.336, 50], [47.58, -122.341, 50], [47.5715, -122.35, 45], [47.5705, -122.37, 35], [47.576, -122.381, 30], [47.585, -122.387, 30], [47.59, -122.39, 25], [47.5795, -122.4095, 25]] },
  issaquah: { label: 'Issaquah', points: [...TO_I5_SOUTH, ...I5_TO_I90, ...I90_EAST, [47.545, -122.045, 35]] },
  northBend: { label: 'North Bend', points: [...TO_I5_SOUTH, ...I5_TO_I90, ...I90_EAST, [47.545, -122.045, 60], [47.535, -121.99, 60], [47.528, -121.93, 60], [47.516, -121.87, 45], [47.4935, -121.786, 30]] },
  seatac: { label: 'SeaTac', points: [...TO_I5_SOUTH, ...I5_TO_I90, ...I5_SOUTH_FROM_I90, [47.465, -122.275, 55], [47.46, -122.295, 35], [47.444, -122.301, 25]] },
  renton: { label: 'Renton', points: [...TO_I5_SOUTH, ...I5_TO_I90, ...I5_SOUTH_FROM_I90, [47.468, -122.245, 60], [47.473, -122.22, 60], [47.49, -122.205, 35], [47.5005, -122.2045, 25]] },
  lynnwood: { label: 'Alderwood', points: [...I5_NORTH, [47.725, -122.324, 60], [47.75, -122.321, 60], [47.775, -122.311, 60], [47.8, -122.295, 60], [47.818, -122.278, 40], [47.8285, -122.2685, 30]] },
  everett: { label: 'Everett', points: [...I5_NORTH, [47.725, -122.324, 60], [47.75, -122.321, 60], [47.775, -122.311, 60], [47.8, -122.295, 60], [47.818, -122.278, 60], [47.855, -122.265, 60], [47.89, -122.25, 60], [47.925, -122.225, 60], [47.955, -122.2, 35], [47.979, -122.2021, 30]] },
  tacoma: { label: 'Tacoma', points: [...TO_I5_SOUTH, ...I5_TO_I90, ...I5_SOUTH_FROM_I90, [47.42, -122.27, 60], [47.37, -122.295, 60], [47.32, -122.305, 60], [47.28, -122.32, 60], [47.24, -122.36, 60], [47.24, -122.41, 40], [47.2529, -122.4443, 30]] },
};

/** Weekend and evening destinations, weighted by how often they come up. */
const OUTINGS = ['bellevue', 'bellevue', 'alki', 'ballard', 'uVillage', 'greenLake', 'kirkland', 'redmond', 'issaquah', 'northBend', 'lynnwood', 'everett', 'seatac', 'renton', 'tacoma', 'northgate', 'capitolHill'];
const ERRANDS = ['uVillage', 'greenLake', 'ballard', 'capitolHill', 'northgate'];

const R_M = 6_371_000;
const rad = (deg) => (deg * Math.PI) / 180;
function distanceM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The waypoints as a dense track (a point about every 120 m), each point with its stretch's limit. */
function densify(waypoints) {
  const out = [];
  for (let i = 0; i + 1 < waypoints.length; i += 1) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const steps = Math.max(1, Math.round(distanceM(a, b) / 120));
    for (let s = 0; s < steps; s += 1) {
      const f = s / steps;
      out.push({ lat: a[0] + (b[0] - a[0]) * f, lng: a[1] + (b[1] - a[1]) * f, limit: a[2] });
    }
  }
  const last = waypoints[waypoints.length - 1];
  out.push({ lat: last[0], lng: last[1], limit: last[2] });
  return out;
}

function routePoints(name, reverse) {
  const pts = ROUTES[name].points.slice();
  if (!reverse) return pts;
  // Reversed, each stretch keeps its limit: the limit moves to the stretch's other end.
  const rev = pts.reverse();
  return rev.map((p, i) => [p[0], p[1], (rev[i + 1] ?? p)[2]]);
}

// ---------------------------------------------------------------------------------------------
// The calendar

/**
 * What the demo driver did, day by day: commutes to South Lake Union on some weekdays (every
 * weekday in the last week), weekend outings, a few evening errands and late nights. Denser in the
 * last 30 days, so the Safety Rating is ranked.
 */
function planTrips(now, rnd) {
  const trips = [];
  const add = (day, minutes, route, reverse, extra = {}) => trips.push({ day, minutes, route, reverse, ...extra });
  for (let back = DAYS - 1; back >= 0; back -= 1) {
    const day = localDay(now, back);
    const weekend = day.dow === 0 || day.dow === 6;
    const lastWeek = back < 8;
    const recent = back < 30;
    if (!weekend) {
      const commute = lastWeek ? true : recent ? rnd() < 0.42 : rnd() < 0.1;
      let lateHome = false;
      if (commute) {
        add(day, intBetween(rnd, 7 * 60 + 25, 8 * 60 + 40), 'work', false);
        lateHome = rnd() < 0.2;
        add(day, lateHome ? intBetween(rnd, 19 * 60, 20 * 60 + 15) : intBetween(rnd, 17 * 60, 18 * 60 + 45), 'work', true);
      }
      // No evening errand after a late commute home: leaving again minutes after arriving would read
      // as one drive continued (the server joins drives within 5 min and 150 m).
      if (recent && !lastWeek && !lateHome && rnd() < 0.07) {
        const errand = pick(rnd, ERRANDS);
        add(day, intBetween(rnd, 19 * 60 + 30, 20 * 60 + 30), errand, false);
        add(day, intBetween(rnd, 22 * 60 + 20, 23 * 60 + 15), errand, true);
      }
    } else {
      const outing = lastWeek ? true : recent ? rnd() < 0.4 : rnd() < 0.3;
      if (outing) {
        const route = pick(rnd, OUTINGS);
        add(day, intBetween(rnd, 9 * 60 + 30, 13 * 60 + 30), route, false);
        const evening = rnd();
        const home = evening < 0.25 ? intBetween(rnd, 22 * 60 + 15, 23 * 60 + 30) : evening < 0.6 ? intBetween(rnd, 18 * 60 + 30, 21 * 60) : intBetween(rnd, 14 * 60 + 30, 17 * 60 + 30);
        add(day, home, route, true);
      }
    }
  }
  // One move of the car down the block: too short to score, so History shows an unscored drive.
  add(localDay(now, 11), 12 * 60 + 5, 'greenLake', false, { short: true });
  return trips.sort((a, b) => b.day.back - a.day.back || a.minutes - b.minutes);
}

// ---------------------------------------------------------------------------------------------
// One drive

/** Average moving speed on a stretch, mph: city stretches lose time at lights, rush hour slows the freeway. */
function paceMph(limit, minutes, rnd) {
  const rush = (minutes >= 7 * 60 && minutes <= 9 * 60 + 15) || (minutes >= 16 * 60 + 30 && minutes <= 18 * 60 + 45);
  if (limit >= 50) return limit * (rush ? between(rnd, 0.55, 0.8) : between(rnd, 0.9, 1.02));
  return limit * between(rnd, 0.62, 0.8);
}

/** The drive as the phone would have recorded it: track, timing, distance and night miles. */
function recordDrive(trip, rnd) {
  let track = densify(routePoints(trip.route, trip.reverse));
  if (trip.short) track = track.slice(0, 6);
  const startedAt = localInstant(trip.day, trip.minutes) + intBetween(rnd, 0, 59) * 1000;
  const paceBy = new Map();
  // A move down the block pulls away and parks at once: under MIN_SCORED_S as well as under half a mile.
  let t = trip.short ? between(rnd, 5, 15) : between(rnd, 25, 70);
  let distM = 0;
  let nightM = 0;
  const times = [t];
  const cum = [0];
  for (let i = 1; i < track.length; i += 1) {
    const a = track[i - 1];
    const b = track[i];
    const d = distanceM([a.lat, a.lng], [b.lat, b.lng]) * ROAD_FACTOR;
    if (!paceBy.has(a.limit)) paceBy.set(a.limit, paceMph(a.limit, trip.minutes, rnd));
    const mps = (paceBy.get(a.limit) * M_PER_MILE) / 3600;
    const mid = startedAt + (t + d / mps / 2) * 1000;
    if (sunIsDown(new Date(mid), a.lat, a.lng)) nightM += d;
    t += d / mps;
    distM += d;
    times.push(t);
    cum.push(distM);
  }
  const durationS = Math.round(t + (trip.short ? between(rnd, 5, 15) : between(rnd, 20, 90)));
  const miles = round(distM / M_PER_MILE, 2);
  if (Boolean(trip.short) !== scoring.tooShort(miles, durationS)) throw new Error('a drive is not as short (or long) as the scoring package needs it to be');
  // The phone trims the first and last 0.25 mi (plus up to 400 m of jitter) off the route it sends.
  const trimStart = 402 + between(rnd, 0, 400);
  const trimEnd = 402 + between(rnd, 0, 400);
  const visible = track.map((_, i) => i).filter((i) => cum[i] >= trimStart && cum[i] <= distM - trimEnd);
  const polyline = encodeRuns([visible.map((i) => ({ lat: track[i].lat, lng: track[i].lng }))]);
  return {
    track,
    times,
    visible,
    startedAt,
    endedAt: startedAt + durationS * 1000,
    durationS,
    miles,
    nightMiles: Math.min(miles, round(nightM / M_PER_MILE, 2)),
    paceBy,
    polyline,
  };
}

/**
 * Events per drive: the earlier months had harder driving than the last 30 days. Hard brakes, starts
 * and turns stay near the scoring package's typical rates (`BASELINE`: about 1 per 100 slowdowns and
 * 1 per 125 speed-ups or turns), so with the Fremont spot the demo reads as a decent driver: a Safety
 * Rating around 80 and no category under 60.
 */
function eventRates(back) {
  if (back >= 30) return { speeding: 0.19, hard_brake: 0.02, hard_accel: 0.016, hard_corner: 0.012 };
  if (back >= 13) return { speeding: 0.17, hard_brake: 0.012, hard_accel: 0.01, hard_corner: 0.008 };
  return { speeding: 0.15, hard_brake: 0.008, hard_accel: 0.008, hard_corner: 0.006 };
}

/** mph-seconds over the speeding line after the grace, at a steady `over` mph past the line for `durationS` rows. */
const overMphSOf = (durationS, over) => round(Math.max(1, durationS - scoring.SPEEDING_GRACE_S) * over, 1);

/** The events of one drive, on its visible route, with what the detectors would have measured. */
function makeEvents(trip, rec, rnd, opts) {
  const rates = eventRates(trip.day.back);
  // Indices on the visible route where an event may start: after the first 45 s, with room before the
  // end, and away from the demo spots (only `spotEvents` repeats there, so a cleared spot stays cleared).
  const slots = rec.visible.filter(
    (i) => rec.times[i] >= 45 && rec.times[i] <= rec.durationS - 75 && DEMO_SPOTS.every((spot) => distanceM([rec.track[i].lat, rec.track[i].lng], spot.at) > SPOT_CLEAR_M)
  );
  if (slots.length === 0 || trip.short) return [];
  const taken = new Set();
  const slot = () => {
    for (let tries = 0; tries < 20; tries += 1) {
      const i = pick(rnd, slots);
      if (![...taken].some((j) => Math.abs(j - i) < 3)) {
        taken.add(i);
        return i;
      }
    }
    return null;
  };
  const events = [];
  const at = (i) => ({
    startedAt: rec.startedAt + Math.round(rec.times[i] * 1000),
    lat: round(rec.track[i].lat, 5),
    lng: round(rec.track[i].lng, 5),
    mph: rec.paceBy.get(rec.track[i].limit) ?? rec.track[i].limit,
    limit: rec.track[i].limit,
  });
  const scale = Math.pow(rec.miles, 0.85);

  for (let n = poisson(rnd, rates.speeding * scale); n > 0; n -= 1) {
    const i = slot();
    if (i === null) break;
    const p = at(i);
    const roll = rnd();
    const tier = roll < 0.72 ? 'minor' : roll < 0.95 ? 'moderate' : 'severe';
    const over = tier === 'minor' ? between(rnd, 0.6, 3.6) : tier === 'moderate' ? between(rnd, 4.6, 8.6) : between(rnd, 9.6, 15);
    const speedMph = round(p.limit + scoring.speedTolerance(p.limit) + over, 1);
    if (scoring.speedTier(speedMph, p.limit) !== tier) throw new Error('speeding tier drifted from the scoring package');
    // Every over-the-line row, more than the grace (a shorter episode is never an event).
    const durationS = intBetween(rnd, scoring.SPEEDING_GRACE_S + 1, tier === 'severe' ? 18 : 70);
    const overMphS = overMphSOf(durationS, speedMph - p.limit - scoring.speedTolerance(p.limit));
    events.push({ type: 'speeding', tier, startedAt: p.startedAt, durationS, lat: p.lat, lng: p.lng, measured: { speedMph, limitMph: p.limit, overMphS } });
  }
  const harsh = (type, rate, g) => {
    for (let n = poisson(rnd, rate * scale); n > 0; n -= 1) {
      const i = slot();
      if (i === null) break;
      const p = at(i);
      const severe = rnd() < 0.18;
      const peakG = round(severe ? between(rnd, g.severe, g.severe + 0.12) : between(rnd, g.minor, g.severe - 0.01), 2);
      events.push({
        type,
        tier: severe ? 'severe' : 'minor',
        startedAt: p.startedAt,
        durationS: intBetween(rnd, 1, 3),
        lat: p.lat,
        lng: p.lng,
        measured: { peakG, speedMph: round(p.mph * between(rnd, 0.6, 1.05), 1) },
      });
    }
  };
  harsh('hard_brake', rates.hard_brake, scoring.HARD_BRAKE_G);
  harsh('hard_accel', rates.hard_accel, scoring.HARD_ACCEL_G);
  harsh('hard_corner', rates.hard_corner, scoring.HARD_CORNER_G);

  if (opts.dashcamEvent) {
    const i = slot();
    if (i !== null) {
      const p = at(i);
      events.push({
        type: opts.dashcamEvent,
        tier: 'severe',
        startedAt: p.startedAt,
        durationS: opts.dashcamEvent === 'drowsy' ? intBetween(rnd, 2, 4) : intBetween(rnd, 3, 6),
        lat: p.lat,
        lng: p.lng,
        measured: { source: 'dashcam', speedMph: round(Math.max(25, p.mph), 1) },
      });
    }
  }
  return events.sort((a, b) => a.startedAt - b.startedAt).map((e) => ({ id: uuid(rnd), ...e }));
}

/**
 * Phone pickups per mile^0.85 (as the other events scale) on a drive that already had an event: the
 * demo driver reaches for the phone on the drives where the attention slips anyway (so a clean drive
 * stays clean), less in the last month. At these rates Phone use reads around 80, near the rest of
 * the categories, so it shows on Analytics without moving the Safety Rating far.
 */
function phoneRate(back) {
  if (back >= 30) return PHONE_RATE[0];
  if (back >= 13) return PHONE_RATE[1];
  return PHONE_RATE[2];
}
const PHONE_RATE = [0.4, 0.34, 0.3];

/**
 * The phone pickups of one drive, from their own generator (`rnd`), so the rest of the history and
 * the spots are the same with or without them. Each starts at driving speed on the visible route,
 * at least a minute from every other event and away from the demo spots; mostly a few seconds in
 * hand (moderate), now and then longer (severe, past `PHONE_SEVERE_S`).
 */
function phonePickups(trip, rec, rnd, others) {
  if (trip.short || others.every((e) => scoring.isDashcamType(e.type))) return [];
  const slots = rec.visible.filter(
    (i) => rec.times[i] >= 45 && rec.times[i] <= rec.durationS - 75 && DEMO_SPOTS.every((spot) => distanceM([rec.track[i].lat, rec.track[i].lng], spot.at) > SPOT_CLEAR_M)
  );
  if (slots.length === 0) return [];
  const used = others.map((e) => e.startedAt);
  const pickups = [];
  for (let n = poisson(rnd, phoneRate(trip.day.back) * Math.pow(rec.miles, 0.85)); n > 0; n -= 1) {
    let placed = null;
    for (let tries = 0; tries < 20 && placed === null; tries += 1) {
      const i = pick(rnd, slots);
      const startedAt = rec.startedAt + Math.round(rec.times[i] * 1000);
      if (used.every((t) => Math.abs(t - startedAt) >= 60_000)) placed = { i, startedAt };
    }
    if (placed === null) break;
    used.push(placed.startedAt);
    const p = rec.track[placed.i];
    const pace = rec.paceBy.get(p.limit) ?? p.limit;
    const inHand = rnd() < 0.6 ? intBetween(rnd, 3, scoring.PHONE_SEVERE_S) : intBetween(rnd, scoring.PHONE_SEVERE_S + 1, 50);
    const speedMph = round(Math.max(scoring.PHONE_PICKUP_MIN_MPH, pace * between(rnd, 0.85, 1.0)), 1);
    pickups.push({
      id: uuid(rnd),
      type: 'phone_pickup',
      tier: scoring.phonePickupTier(inHand),
      startedAt: placed.startedAt,
      durationS: inHand,
      lat: round(p.lat, 5),
      lng: round(p.lng, 5),
      measured: { speedMph, maxSpeedMph: round(speedMph + between(rnd, 0, 6), 1) },
    });
  }
  return pickups;
}

/**
 * The seconds a drive spent at driving speed (`PHONE_PICKUP_MIN_MPH` or more), with the motion
 * sensors read throughout: every stretch it drove at that pace, held to its moving time and to the
 * bound the server holds it to (ceil(mi x 450) + 60, as limit time).
 */
function phoneSecondsOf(rec, movingS) {
  let secs = 0;
  for (let i = 1; i < rec.track.length; i += 1) {
    if ((rec.paceBy.get(rec.track[i - 1].limit) ?? 0) >= scoring.PHONE_PICKUP_MIN_MPH) secs += rec.times[i] - rec.times[i - 1];
  }
  return Math.min(movingS, Math.ceil(rec.miles * 360 * 1.25) + 60, Math.round(secs));
}

// ---------------------------------------------------------------------------------------------
// Problem spots: places the demo driver keeps doing the same thing (spots.md §8)

/**
 * Places the demo driver keeps doing the same thing, so Analytics › Spots to watch has something
 * to show. `rule` picks the matching drives (same route and direction): `lastDays` + `hit(n)`, n
 * counting the matching drives in that window oldest first; or the `count` newest that started
 * `newestBefore` days ago or more (a spot that has since cleared).
 */
const DEMO_SPOTS = [
  // Speeding on the 35 mph stretch down Dexter on the way to work: 2 of every 3 commutes in the last 45 days.
  { type: 'speeding', route: 'work', reverse: false, at: [47.6415, -122.3434], rule: { lastDays: 45, hit: (n) => n % 3 !== 2 }, durationS: 16, overMph: 7 },
  // A firm (minor) brake just before the turn in Fremont on the way home: every third evening commute in the last 45 days.
  { type: 'hard_brake', route: 'work', reverse: true, at: [47.6492, -122.3497], rule: { lastDays: 45, hit: (n) => n % 3 === 0 }, peakG: 0.38 },
  // Hard starts from the light at N 39th: the 4 newest commutes started more than 16 days ago, clean since (a cleared spot).
  { type: 'hard_accel', route: 'work', reverse: false, at: [47.6553, -122.3421], rule: { newestBefore: 16, count: 4 }, peakG: 0.36 },
];

/** No random event starts this close to a demo spot. */
const SPOT_CLEAR_M = 250;

/** For each demo spot, the indices of the planned trips it repeats on. */
function spotTrips(trips) {
  return DEMO_SPOTS.map((spot) => {
    const matching = trips.map((t, i) => ({ t, i })).filter(({ t }) => !t.short && t.route === spot.route && Boolean(t.reverse) === spot.reverse);
    if (spot.rule.lastDays !== undefined) {
      const inWindow = matching.filter(({ t }) => t.day.back < spot.rule.lastDays);
      return new Set(inWindow.filter((_, n) => spot.rule.hit(n)).map(({ i }) => i));
    }
    const old = matching.filter(({ t }) => t.day.back >= spot.rule.newestBefore);
    return new Set(old.slice(-spot.rule.count).map(({ i }) => i));
  });
}

/** The track index nearest a point. */
function nearestIndex(track, at) {
  let best = 0;
  let bestM = Infinity;
  track.forEach((p, i) => {
    const m = distanceM([p.lat, p.lng], at);
    if (m < bestM) {
      bestM = m;
      best = i;
    }
  });
  return best;
}

/** The demo spots' events on one drive: each at the track point nearest its place, when that point is visible. */
function spotEvents(tripIndex, rec, rndSpots, picked) {
  const events = [];
  DEMO_SPOTS.forEach((spot, s) => {
    if (!picked[s].has(tripIndex)) return;
    const i = nearestIndex(rec.track, spot.at);
    if (!rec.visible.includes(i)) return;
    const p = rec.track[i];
    const base = { startedAt: rec.startedAt + Math.round(rec.times[i] * 1000), lat: round(p.lat, 5), lng: round(p.lng, 5) };
    const pace = rec.paceBy.get(p.limit) ?? p.limit;
    if (spot.type === 'speeding') {
      const speedMph = round(p.limit + scoring.speedTolerance(p.limit) + spot.overMph, 1);
      const tier = scoring.speedTier(speedMph, p.limit);
      events.push({ ...base, type: 'speeding', tier, durationS: spot.durationS, measured: { speedMph, limitMph: p.limit, overMphS: overMphSOf(spot.durationS, spot.overMph) } });
    } else {
      const g = spot.type === 'hard_brake' ? scoring.HARD_BRAKE_G : spot.type === 'hard_accel' ? scoring.HARD_ACCEL_G : scoring.HARD_CORNER_G;
      events.push({
        ...base,
        type: spot.type,
        tier: spot.peakG >= g.severe ? 'severe' : 'minor',
        durationS: 2,
        measured: { peakG: spot.peakG, speedMph: round(pace * between(rndSpots, 0.6, 1.0), 1) },
      });
    }
  });
  return events.map((e) => ({ id: uuid(rndSpots), ...e }));
}

// ---------------------------------------------------------------------------------------------
// The whole history, stored as finalize-trip stores it

/** The finalize-trip upload (v5) a phone would have sent for a recorded drive. */
function toPayload(trip, rec, events, rnd, dashcam) {
  const first = rec.track[0];
  const last = rec.track[rec.track.length - 1];
  const exposure = scoring.estimateExposure(rec.miles, rec.durationS);
  const payload = {
    v: 5,
    clientTripId: uuid(rnd),
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    tz: TZ,
    localDay: dayKey(new Date(rec.startedAt), TZ),
    miles: rec.miles,
    nightMiles: rec.nightMiles,
    durationS: rec.durationS,
    start: { lat: round(first.lat, 4), lng: round(first.lng, 4) },
    end: { lat: round(last.lat, 4), lng: round(last.lng, 4) },
    polyline: rec.polyline,
    integrity: { mockLocation: false, motionMismatch: false, validGnssPct: round(between(rnd, 92, 99.5), 1), maxSpeedMph: round(Math.max(...rec.paceBy.values()) * 1.12, 1) },
    events,
    appVersion: APP_VERSION,
    origin: 'manual',
    notDrivingExpired: false,
    // the counters the phone would have counted, as the server would estimate them for this drive,
    // and its seconds at driving speed
    exposure: { ...exposure, phoneS: phoneSecondsOf(rec, exposure.movingS) },
  };
  if (dashcam) {
    const movingS = Math.round(rec.durationS * 0.93);
    payload.dashcam = { deviceId: DASHCAM_ID, movingS, coveredS: Math.round(movingS * 0.96), synced: true };
  }
  return payload;
}

/** What finalize-trip stores of a fresh upload (handler.ts `buildStoredDrive`): the kept events, the DashPal seconds, scored or too short. */
function storeUpload(p) {
  const kept = scoring.keepDashcamEvents(p.events);
  const dashcam = p.dashcam
    ? { deviceId: p.dashcam.deviceId, movingS: p.dashcam.movingS, coveredS: p.dashcam.coveredS, synced: p.dashcam.synced, on: scoring.dashcamDrive(p.dashcam) }
    : { deviceId: null, movingS: 0, coveredS: 0, synced: false, on: false };
  const cls = scoring.classifyDrive({ miles: p.miles, durationS: p.durationS, events: kept });
  return { kept, dashcam, scored: cls.scored, reason: cls.reason, activeEventCount: cls.activeEventCount };
}

/** The `private.apply_drive` envelope finalize-trip would build (handler.ts). */
function toEnvelope(userId, p, stored) {
  const { kept, dashcam, scored, reason } = stored;
  return {
    user: userId,
    mergeInto: null,
    dashcam,
    payload: {
      clientTripId: p.clientTripId,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      tz: p.tz,
      localDay: p.localDay,
      miles: p.miles,
      nightMiles: p.nightMiles,
      durationS: Math.round(p.durationS),
      end: p.end,
      polyline: p.polyline,
      appVersion: p.appVersion,
      dashcam: p.dashcam ?? null,
      origin: p.origin,
      notDrivingExpired: p.notDrivingExpired,
      exposure: p.exposure ? scoring.clampExposure(p.exposure) : null,
    },
    scored,
    reason,
    events: kept.map((e) => ({
      id: e.id,
      type: e.type,
      tier: e.tier,
      startedAt: e.startedAt,
      durationS: e.durationS,
      zone: null,
      status: 'active',
      lat: e.lat,
      lng: e.lng,
      measured: e.measured,
    })),
    scoringVersion: scoring.SCORING_VERSION,
  };
}

/**
 * Every drive of the demo history, oldest first: the trip, the upload and what finalize-trip
 * stores of it. The demo spots' repeated events come from their own generator, so the rest of the
 * history is the same with or without them.
 */
function buildHistory(now, seed = SEED) {
  const rnd = mulberry32(seed);
  const rndSpots = mulberry32(seed ^ 0x5b07);
  const rndPhone = mulberry32(seed ^ 0x9e37);
  const trips = planTrips(now, rnd).filter((t) => localInstant(t.day, t.minutes) < now - 2 * 3600 * 1000);
  const picked = spotTrips(trips);
  const scoredIdx = trips.map((t, i) => (t.short ? -1 : i)).filter((i) => i >= 0);
  // DashPal rode along on three outings in the last two weeks: one caught eyes off the road, one drowsiness on a late drive home.
  const dashcamIdx = scoredIdx.filter((i) => trips[i].day.back < 14 && trips[i].route !== 'work').slice(-3);
  const lateIdx = dashcamIdx.reduce((a, i) => (a === undefined || trips[i].minutes > trips[a].minutes ? i : a), undefined);
  const eyesIdx = dashcamIdx.find((i) => i !== lateIdx);

  return trips.map((trip, i) => {
    const rec = recordDrive(trip, rnd);
    const dashcamEvent = i === lateIdx ? 'drowsy' : i === eyesIdx ? 'eyes_off' : null;
    const others = [...makeEvents(trip, rec, rnd, { dashcamEvent }), ...spotEvents(i, rec, rndSpots, picked)];
    const events = [...others, ...phonePickups(trip, rec, rndPhone, others)].sort((a, b) => a.startedAt - b.startedAt);
    const payload = toPayload(trip, rec, events, rnd, dashcamIdx.includes(i));
    return { trip, payload, stored: storeUpload(payload) };
  });
}

/**
 * What the history should add up to on the server: the Safety Rating as of `now` (scoring
 * `ratingAt`, as migration 0026's `private.rating_at` computes it), its categories (whole numbers,
 * as Analytics shows them) and the event counts.
 */
function summarize(drives, now) {
  const scored = drives.filter((d) => d.stored.scored);
  const rating = scoring.ratingAt(
    scored.map((d) => ({
      id: d.payload.clientTripId,
      startedAt: d.payload.startedAt,
      miles: d.payload.miles,
      watchedMiles: d.payload.dashcam ? scoring.watchedMiles(d.payload.miles, d.payload.dashcam.movingS, d.payload.dashcam.coveredS) : 0,
      exposure: scoring.clampExposure(d.payload.exposure),
      events: d.stored.kept,
    })),
    now
  );
  const counts = {};
  for (const d of drives) for (const e of d.payload.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return {
    drives: drives.length,
    scored: scored.length,
    clean: scored.filter((d) => d.stored.activeEventCount === 0).length,
    drives90: scored.filter((d) => d.payload.startedAt > now - 90 * 86400000).length,
    miles: round(scored.reduce((s, d) => s + d.payload.miles, 0), 1),
    miles90: round(rating.miles, 1),
    rating: rating.rating,
    ranked: rating.ranked,
    axes: Object.fromEntries(Object.entries(rating.scores).map(([k, v]) => [k, v === null ? null : Math.round(v)])),
    counts,
  };
}

/** Why finalize-trip would not take an upload as a fresh scored drive (null: it would): the v5 contract and the integrity rules. */
function uploadProblem(p) {
  const parsed = parseFinalizeUpload(p);
  if (!parsed.success) return `breaks the upload contract: ${parsed.error.message}`;
  if (p.v !== 5) return 'is not a v5 upload';
  const refused = integrityReason(p);
  if (refused) return `would be stored unscored as ${refused}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The database

function cliTarget(url) {
  const host = new URL(url).hostname;
  if (['127.0.0.1', 'localhost', '::1', '[::1]', 'host.docker.internal'].includes(host)) return { flag: '--local', label: 'local' };
  const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(host)?.[1];
  const linkedFile = path.join(ROOT, 'supabase', '.temp', 'project-ref');
  const linked = fs.existsSync(linkedFile) ? fs.readFileSync(linkedFile, 'utf8').trim() : null;
  if (!ref || ref !== linked) {
    throw new Error(`SUPABASE_URL names project ${ref ?? host}, but the CLI is linked to ${linked ?? 'nothing'}: run \`npx supabase link --project-ref ${ref ?? '<ref>'}\` first`);
  }
  return { flag: '--linked', label: `linked project ${ref}` };
}

/** One SQL statement through `supabase db query`; returns the rows. */
/**
 * Runs one statement through `supabase db query` and returns its rows. A statement that returns
 * rows must come back with them: when the CLI prints no JSON (not logged in, not linked, an older
 * CLI, a prompt) the error carries what it did print. A DO block (`rows: false`) answers only its
 * command tag.
 */
function runSql(target, sql, { rows: wantRows = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-demo-'));
  const file = path.join(dir, 'q.sql');
  fs.writeFileSync(file, sql, 'utf8');
  const win = process.platform === 'win32';
  const quote = (a) => (win && /\s/.test(a) ? `"${a}"` : a);
  const args = ['supabase', 'db', 'query', target.flag, '--yes', '-f', file, '--output-format', 'json'].map(quote);
  const r = spawnSync(win ? 'npx.cmd' : 'npx', args, { cwd: ROOT, encoding: 'utf8', shell: win, maxBuffer: 256 * 1024 * 1024 });
  fs.rmSync(dir, { recursive: true, force: true });
  const out = r.stdout ?? '';
  const parsed = parseQueryOutput(out);
  const printed = () => `${out}\n${r.stderr ?? ''}`.trim() || String(r.error ?? 'no output');
  if (r.status === 0 && parsed === null && !wantRows) return [];
  if (r.status !== 0 || parsed === null || parsed._tag === 'Error') {
    throw new Error(`supabase db query (${target.flag}) failed: ${parsed?.error?.message ?? printed()}`);
  }
  if (wantRows && !(parsed.rows?.length > 0)) {
    throw new Error(`supabase db query (${target.flag}) returned no rows for \`${sql.slice(0, 80)}\`. The CLI printed:\n${printed()}`);
  }
  return (parsed.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v])));
}

/**
 * The JSON in what `supabase db query --output-format json` printed, as `{ rows }` (or its error
 * object), or null when there is none. CLI versions differ: some print `{ boundary, rows, warning }`,
 * others the bare array of rows; either may have status lines around it.
 */
function parseQueryOutput(out) {
  const starts = ['[', '{'].map((c) => out.indexOf(c)).filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = out.lastIndexOf(out[start] === '[' ? ']' : '}');
  if (end < start) return null;
  try {
    const value = JSON.parse(out.slice(start, end + 1));
    return Array.isArray(value) ? { rows: value } : value;
  } catch {
    return null;
  }
}

/** A JSON value as a dollar-quoted SQL literal. */
function jsonLiteral(value) {
  const text = JSON.stringify(value);
  if (text.includes('$j$')) throw new Error('a JSON value holds the $j$ quote');
  return `$j$${text}$j$::jsonb`;
}

const contextCall = (userId, p) =>
  `private.drive_context('${userId}'::uuid, '${p.clientTripId}'::uuid, to_timestamp(${p.startedAt} / 1000.0), '${p.localDay}'::date, ` +
  `${p.start.lat}, ${p.start.lng}, to_timestamp(${p.endedAt} / 1000.0))`;

/**
 * One batch of drives as one statement: for each, the server's context must be a fresh drive
 * (version 23, nothing stored, no merge), then apply_drive stores it.
 */
function batchSql(userId, items) {
  const lines = items.map(({ payload, envelope }) =>
    [
      `  c := ${contextCall(userId, payload)};`,
      `  if c -> 'version' <> '23'::jsonb or c -> 'existing' <> 'null'::jsonb or c -> 'merge' <> 'null'::jsonb then`,
      `    raise exception 'seed-demo: the server context for drive ${payload.clientTripId} is %, not a fresh drive', c;`,
      '  end if;',
      `  perform private.apply_drive(${jsonLiteral(envelope)});`,
    ].join('\n')
  );
  return `do $seed$\ndeclare c jsonb;\nbegin\n${lines.join('\n')}\nend $seed$`;
}

// ---------------------------------------------------------------------------------------------
// The account

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const password = process.env.DEMO_PASSWORD || DEFAULT_PASSWORD;
  if (!url || !serviceKey) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (local: `npx supabase status`).');
    process.exit(2);
  }
  const target = cliTarget(url);
  const { createClient } = require('@supabase/supabase-js');
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, serviceKey, opts);

  console.log(`Seeding ${DEMO_EMAIL} on the ${target.label} database (${url})`);

  // 1. A fresh account. The old one goes with all its rows (they cascade from auth.users). It is
  // deleted in SQL, not through `auth.admin.deleteUser`: GoTrue deletes as supabase_auth_admin,
  // and the profiles delete trigger (0009 `profile_gone`) then has no rights on public.inbox.
  const [{ n: removed }] = runSql(target, `with d as (delete from auth.users where lower(email) = '${DEMO_EMAIL}' returning id) select count(*)::int as n from d`);
  if (removed > 0) console.log('  deleted the previous demo account');
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email: DEMO_EMAIL, password, email_confirm: true });
  if (createError) throw createError;
  const userId = created.user.id;

  const asUser = createClient(url, process.env.SUPABASE_ANON_KEY || serviceKey, opts);
  const { error: signInError } = await asUser.auth.signInWithPassword({ email: DEMO_EMAIL, password });
  if (signInError) throw signInError;
  const rpc = async (fn, args) => {
    const { data, error } = await asUser.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  await rpc('claim_username', { p: DEMO_USERNAME });
  await rpc('complete_onboarding', { p_terms_version: TERMS_VERSION });
  await rpc('update_profile', { p_state: 'WA' });
  console.log(`  created ${userId} as @${DEMO_USERNAME}, onboarded`);

  // 2. The drives, oldest first.
  const drives = buildHistory(Date.now());
  for (const d of drives) {
    const problem = uploadProblem(d.payload);
    if (problem) throw new Error(`drive ${d.payload.clientTripId}: ${problem}`);
  }
  let batch = [];
  let batchBytes = 0;
  let sent = 0;
  const flush = () => {
    if (batch.length === 0) return;
    runSql(target, batchSql(userId, batch), { rows: false });
    sent += batch.length;
    process.stdout.write(`  stored ${sent}/${drives.length} drives\r`);
    batch = [];
    batchBytes = 0;
  };
  for (const d of drives) {
    const envelope = toEnvelope(userId, d.payload, d.stored);
    batch.push({ payload: d.payload, envelope });
    batchBytes += JSON.stringify(envelope).length;
    if (batch.length >= 12 || batchBytes > 120_000) flush();
  }
  flush();
  process.stdout.write('\n');

  // 3. What the app will read.
  const summary = await rpc('get_my_summary');
  let restored = 0;
  let before = null;
  for (;;) {
    const page = await rpc('list_my_drives', before ? { p_limit: 50, p_before: before } : { p_limit: 50 });
    restored += page.length;
    if (page.length < 50) break;
    before = new Date(Math.min(...page.map((x) => x.startedAt))).toISOString();
  }
  const g = summary.progress;
  const expect = summarize(drives, Date.now());
  console.log(`  list_my_drives: ${restored} drives`);
  if (restored !== drives.length) throw new Error(`stored ${drives.length} drives but the app would restore ${restored}`);
  console.log(`  Safety Rating ${g.safety_rating} (${g.ranked ? 'ranked' : 'unranked'}, ${g.miles_90d} mi in 90 days); the scoring package expects ${expect.rating}`);
  console.log(`  achievements: ${summary.achievements.join(', ') || 'none'}`);
  console.log(`  this week's goals: ${summary.challenges.map((c) => `${c.title} ${c.progress}/${c.target}`).join(', ') || 'none'}`);
  console.log(`  categories: ${Object.entries(expect.axes).map(([k, v]) => `${k} ${v ?? '-'}`).join(', ')}`);
  console.log(`  events: ${Object.entries(expect.counts).map(([k, v]) => `${k} ${v}`).join(', ')}; ${expect.clean} of ${expect.scored} scored drives clean`);
  console.log(`\nSign in with ${DEMO_EMAIL} / ${password} (username @${DEMO_USERNAME})`);
}

module.exports = { buildHistory, summarize, uploadProblem, toEnvelope, batchSql, parseQueryOutput, DEMO_SPOTS };

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nseed-demo failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
