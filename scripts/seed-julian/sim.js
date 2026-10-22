'use strict';
/**
 * One drive on a real road, as a phone would have recorded it: the route from routes.json, densified,
 * with a speed profile (cruising at the posted limit, slowing for the turns, stopping at lights and
 * stop signs) that gives every point a time. From that profile come the drive's duration, miles, night
 * miles and the counters the phone would have kept (slowdowns, speed-ups, turns, seconds moving,
 * seconds with a limit, seconds at driving speed), and the route that is uploaded (privacy-trimmed,
 * simplified, a few metres of GPS noise). The events are placed on it by events.js.
 */
require('./tshook.js');
const scoring = require('../../packages/scoring/src/index.ts');
const { sunIsDown } = require('../../src/lib/time.ts');
const { encodeRuns, simplify } = require('../../src/lib/polyline.ts');
const library = require('./routes.json');

const R_M = 6_371_008.8;
const M_PER_MILE = 1609.344;
const MPH = 0.44704;
const STEP_M = 22;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

function distanceM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const angleDiff = (a, b) => Math.abs(((b - a + 540) % 360) - 180);

function decode6(s) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < s.length) {
    for (let axis = 0; axis < 2; axis += 1) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = s.charCodeAt(i++) - 63;
        result |= (b & 31) << shift;
        shift += 5;
      } while (b >= 32);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}

const between = (rnd, lo, hi) => lo + (hi - lo) * rnd();
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const ARTERIAL = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

/** The route as a dense track: a point about every 22 m, each with the limit and class of its stretch. */
function loadTrack(routeId, reverse, truncateM = null) {
  const r = library[routeId];
  if (!r) throw new Error(`no route ${routeId} in routes.json`);
  let pts = decode6(r.shape);
  const segs = new Array(pts.length - 1);
  let from = 0;
  for (const [end, mph, cls] of r.edges) {
    for (let k = from; k < end && k < segs.length; k += 1) segs[k] = { mph, cls };
    from = end;
  }
  for (let k = 0; k < segs.length; k += 1) segs[k] = segs[k] ?? segs[k - 1] ?? { mph: 25, cls: 'residential' };
  if (reverse) {
    pts = pts.slice().reverse();
    segs.reverse();
  }
  const lat = [];
  const lng = [];
  const limit = [];
  const cls = [];
  const cum = [];
  let total = 0;
  for (let k = 0; k < segs.length; k += 1) {
    if (truncateM !== null && total >= truncateM) break;
    const a = pts[k];
    const b = pts[k + 1];
    const len = distanceM(a, b);
    const n = Math.max(1, Math.ceil(len / STEP_M));
    for (let s = 0; s < n; s += 1) {
      const f = s / n;
      lat.push(a[0] + (b[0] - a[0]) * f);
      lng.push(a[1] + (b[1] - a[1]) * f);
      limit.push(segs[k].mph);
      cls.push(segs[k].cls);
      cum.push(total + len * f);
    }
    total += len;
  }
  // the end of the track: the route's own end, or (cut short) where the cut fell
  const endK = lat.length;
  const last = truncateM !== null ? [lat[endK - 1] + 1e-6, lng[endK - 1] + 1e-6] : pts[pts.length - 1];
  lat.push(last[0]);
  lng.push(last[1]);
  limit.push(limit[endK - 1]);
  cls.push(cls[endK - 1]);
  cum.push(truncateM !== null ? cum[endK - 1] + 0.1 : total);
  total = cum[cum.length - 1];
  return { lat, lng, limit, cls, cum, n: lat.length, totalM: total };
}

/** Heading change through each point (over 25 m each side), degrees; and the turn vertices (peaks of 40 degrees or more). */
function findTurns(tr) {
  const { n, cum } = tr;
  const pt = (i) => [tr.lat[i], tr.lng[i]];
  const dTheta = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    let j = i - 1;
    while (j > 0 && cum[i] - cum[j] < 25) j -= 1;
    let k = i + 1;
    while (k < n - 1 && cum[k] - cum[i] < 25) k += 1;
    dTheta[i] = angleDiff(bearing(pt(j), pt(i)), bearing(pt(i), pt(k)));
  }
  const turns = [];
  for (let i = 1; i < n - 1; i += 1) {
    if (dTheta[i] < 40) continue;
    let peak = true;
    for (let j = i - 1; j >= 1 && cum[i] - cum[j] <= 40; j -= 1) if (dTheta[j] > dTheta[i]) peak = false;
    for (let j = i + 1; j < n - 1 && cum[j] - cum[i] <= 40; j += 1) if (dTheta[j] >= dTheta[i]) peak = false;
    if (peak) turns.push({ i, deg: dTheta[i] });
  }
  return turns;
}

function rushFactor(minutes, weekend) {
  if (weekend) return minutes >= 11 * 60 && minutes <= 17 * 60 ? 0.9 : 1;
  if (minutes >= 6 * 60 + 50 && minutes <= 9 * 60) return 0.62;
  if (minutes >= 15 * 60 && minutes <= 18 * 60 + 30) return 0.7;
  return 1;
}

/**
 * The speed profile along the track. `opts`: minutes (local time of day, for traffic), weekend,
 * tempo (how close to the limit this driver cruises, about 0.9 to 1.0).
 */
function simulate(tr, turns, rnd, opts) {
  const { n, cum } = tr;
  const traffic = rushFactor(opts.minutes, opts.weekend);
  const stops = new Map(); // index -> dwell seconds
  const addStop = (i, dwell) => {
    for (const j of stops.keys()) if (Math.abs(cum[j] - cum[i]) < 70) return;
    stops.set(i, dwell);
  };
  const isArterial = (i) => ARTERIAL.has(tr.cls[i]) || ARTERIAL.has(tr.cls[Math.max(0, i - 6)]);
  const heavy = traffic < 0.8 ? 1.5 : 1;
  for (const t of opts.noStops ? [] : turns) {
    if (tr.cls[t.i] === 'motorway') continue;
    const arterial = isArterial(t.i);
    if (rnd() < (arterial ? 0.55 : 0.2) * (traffic < 0.8 ? 1.2 : 1)) addStop(t.i, arterial ? (4 + rnd() * 34) * heavy : 1.5 + rnd() * 3);
  }
  let nextAt = between(rnd, 120, 400);
  for (let i = 1; i < n - 1 && !opts.noStops; i += 1) {
    if (cum[i] < nextAt || tr.cls[i] === 'motorway') continue;
    const arterial = isArterial(i);
    nextAt = cum[i] + (arterial ? between(rnd, 260, 600) : between(rnd, 180, 440));
    if (rnd() < (arterial ? 0.3 : 0.08)) addStop(i, arterial ? (4 + rnd() * 34) * heavy : 1.5 + rnd() * 3);
  }
  // junctions where the road changes class (a side street meeting an arterial)
  for (let i = 1; i < n - 1 && !opts.noStops; i += 1) {
    if (tr.cls[i] !== tr.cls[i - 1] && (ARTERIAL.has(tr.cls[i]) || ARTERIAL.has(tr.cls[i - 1])) && tr.cls[i] !== 'motorway' && tr.cls[i - 1] !== 'motorway' && rnd() < 0.45) {
      addStop(i, 4 + rnd() * 28);
    }
  }

  // cruise targets
  const vmax = new Float64Array(n);
  let drift = 0;
  for (let i = 0; i < n; i += 1) {
    if (i % 18 === 0) drift = between(rnd, -0.05, 0.05);
    const onFreeway = tr.cls[i] === 'motorway' || tr.cls[i] === 'trunk';
    let pace = opts.tempo + drift + (onFreeway ? 0.04 : 0);
    if (onFreeway) pace *= Math.min(1, traffic + 0.15);
    vmax[i] = Math.max(6, tr.limit[i] * pace) * MPH;
    if (cum[i] < 120 || tr.totalM - cum[i] < 120) vmax[i] = Math.min(vmax[i], 11 * MPH);
  }
  // congestion on the busy roads at rush hour
  if (traffic < 0.8) {
    for (let i = 0; i < n; ) {
      if (MAJOR.has(tr.cls[i]) && rnd() < 0.006) {
        const len = between(rnd, 500, 1800);
        const slow = between(rnd, 11, 30) * MPH;
        const start = cum[i];
        while (i < n && cum[i] - start < len) {
          vmax[i] = Math.min(vmax[i], slow * between(rnd, 0.8, 1.2));
          i += 1;
        }
      } else i += 1;
    }
  }
  // slow for the turns
  for (const t of turns) {
    const cap = (t.deg >= 60 ? between(rnd, 10.5, 13) : between(rnd, 15, 19)) * MPH;
    for (let i = Math.max(0, t.i - 1); i <= Math.min(n - 1, t.i + 1); i += 1) vmax[i] = Math.min(vmax[i], cap);
  }
  const v = Float64Array.from(vmax);
  v[0] = 0;
  v[n - 1] = 0;
  for (const i of stops.keys()) v[i] = 0;
  const aUp = between(rnd, 1.35, 1.9);
  const aDown = between(rnd, 1.9, 2.5);
  for (let i = 1; i < n; i += 1) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * aUp * (cum[i] - cum[i - 1])));
  for (let i = n - 2; i >= 0; i -= 1) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * aDown * (cum[i + 1] - cum[i])));
  const t = new Float64Array(n);
  t[0] = opts.noStops ? between(rnd, 3, 8) : between(rnd, 6, 22);
  for (let i = 1; i < n; i += 1) {
    const avg = Math.max(0.5 * (v[i] + v[i - 1]), 0.9);
    t[i] = t[i - 1] + (cum[i] - cum[i - 1]) / avg + (stops.has(i - 1) ? stops.get(i - 1) : 0);
  }
  return { v, t, stops };
}

/** Rises and falls of 12 mph or more along a 1 Hz speed series (the phone's speed-up and slowdown counters). */
function swings(series) {
  const T = 12;
  let slowdowns = 0;
  let speedups = 0;
  let dir = 0;
  let hi = series[0];
  let lo = series[0];
  for (const x of series) {
    if (dir === 0) {
      if (x > hi) hi = x;
      if (x < lo) lo = x;
      if (x - lo >= T) {
        speedups += 1;
        dir = 1;
        hi = x;
      } else if (hi - x >= T) {
        slowdowns += 1;
        dir = -1;
        lo = x;
      }
    } else if (dir === 1) {
      if (x > hi) hi = x;
      if (hi - x >= T) {
        slowdowns += 1;
        dir = -1;
        lo = x;
      }
    } else {
      if (x < lo) lo = x;
      if (x - lo >= T) {
        speedups += 1;
        dir = 1;
        hi = x;
      }
    }
  }
  return { slowdowns, speedups };
}

/** The drive's counters from its profile, as the phone would count them. */
function exposureOf(tr, turns, sim, rnd) {
  const { v, t } = sim;
  const n = tr.n;
  let movingS = 0;
  let phoneS = 0;
  let limitS = 0;
  // some stretches have no known limit (about 4% of the time)
  const unknown = new Uint8Array(n);
  for (let i = 0; i < n; ) {
    const len = Math.floor(between(rnd, 6, 40));
    const u = rnd() < 0.04 ? 1 : 0;
    for (let k = 0; k < len && i < n; k += 1) unknown[i++] = u;
  }
  for (let i = 1; i < n; i += 1) {
    const dt = t[i] - t[i - 1];
    const avg = (v[i] + v[i - 1]) / 2;
    const dwell = dt - (tr.cum[i] - tr.cum[i - 1]) / Math.max(avg, 0.9);
    const drive = dt - Math.max(0, dwell);
    if (avg >= 5 * MPH) movingS += drive;
    if (avg >= 10 * MPH) {
      phoneS += drive;
      if (!unknown[i]) limitS += drive;
    }
  }
  const total = t[n - 1];
  const series = [];
  let j = 1;
  for (let s = 0; s <= Math.floor(total); s += 1) {
    while (j < n - 1 && t[j] < s) j += 1;
    const span = t[j] - t[j - 1];
    const f = span > 0 ? Math.min(1, Math.max(0, (s - t[j - 1]) / span)) : 1;
    series.push(((v[j - 1] + (v[j] - v[j - 1]) * f) / MPH));
  }
  const { slowdowns, speedups } = swings(series);
  let nTurns = 0;
  // a turn counts when the car is doing 10 mph or more at some point within 40 m of it
  for (const tn of turns) {
    if (tn.deg < 60) continue;
    let top = 0;
    for (let i = tn.i; i >= 0 && tr.cum[tn.i] - tr.cum[i] <= 40; i -= 1) top = Math.max(top, v[i]);
    for (let i = tn.i; i < n && tr.cum[i] - tr.cum[tn.i] <= 40; i += 1) top = Math.max(top, v[i]);
    if (top >= 10 * MPH) nTurns += 1;
  }
  return {
    slowdowns: Math.max(1, slowdowns),
    speedups: Math.max(1, speedups),
    turns: nTurns,
    movingS: Math.round(movingS),
    limitS: Math.round(Math.min(limitS, movingS)),
    phoneS: Math.round(Math.min(phoneS, movingS)),
  };
}

/** The uploaded route: the visible part of the track (first and last 402 m, plus jitter, trimmed), simplified, with GPS noise. */
function encodeRoute(tr, lo, hi, rnd) {
  const pts = [];
  for (let i = lo; i <= hi; i += 1) {
    pts.push({ lat: tr.lat[i] + (rnd() - 0.5) * 3.2e-5, lng: tr.lng[i] + (rnd() - 0.5) * 4.6e-5 });
  }
  for (const eps of [1.2, 2, 3, 4, 6, 9, 14, 20]) {
    const poly = encodeRuns([simplify(pts, eps)]);
    if (poly.length <= 15_000) return poly;
  }
  throw new Error('a route does not fit the polyline limit');
}

/**
 * Record a drive. `trip`: { route, reverse, startedAtMs (the wall-clock start), minutes, weekend, tempo }.
 * Returns the recording: the track and profile (for the events), the numbers the upload needs, the
 * route string, and the visible index range.
 */
function recordDrive(trip, rnd) {
  const tr = loadTrack(trip.route, Boolean(trip.reverse), trip.truncateM ?? null);
  const turns = findTurns(tr);
  const sim = simulate(tr, turns, rnd, { minutes: trip.minutes, weekend: trip.weekend, tempo: trip.tempo, noStops: trip.truncateM !== undefined && trip.truncateM !== null });
  const exposure = exposureOf(tr, turns, sim, rnd);
  const { t, v } = sim;
  const durationS = Math.round(t[tr.n - 1] + (trip.truncateM ? between(rnd, 4, 12) : between(rnd, 12, 55)));
  const miles = round((tr.totalM * 1.004) / M_PER_MILE, 2);
  const startedAt = trip.startedAtMs;
  let nightM = 0;
  for (let i = 1; i < tr.n; i += 1) {
    const mid = startedAt + ((t[i] + t[i - 1]) / 2) * 1000;
    if (sunIsDown(new Date(mid), tr.lat[i], tr.lng[i])) nightM += tr.cum[i] - tr.cum[i - 1];
  }
  const trimStart = 402 + between(rnd, 0, 300);
  const trimEnd = 402 + between(rnd, 0, 300);
  let lo = 0;
  while (lo < tr.n - 1 && tr.cum[lo] < trimStart) lo += 1;
  let hi = tr.n - 1;
  while (hi > 0 && tr.totalM - tr.cum[hi] < trimEnd) hi -= 1;
  const visible = hi - lo >= 4;
  return {
    trip,
    tr,
    turns,
    sim,
    v,
    t,
    startedAt,
    endedAt: startedAt + durationS * 1000,
    durationS,
    miles,
    nightMiles: Math.min(miles, round((nightM * 1.004) / M_PER_MILE, 2)),
    exposure: scoring.clampExposure(exposure),
    lo: visible ? lo : 0,
    hi: visible ? hi : tr.n - 1,
    polyline: visible ? encodeRoute(tr, lo, hi, rnd) : '',
  };
}

/** The track point nearest (lat, lng) and how far it is, metres. */
function nearestIndex(tr, lat, lng) {
  let best = 0;
  let bestM = Infinity;
  for (let i = 0; i < tr.n; i += 1) {
    const dLat = (tr.lat[i] - lat) * 111_320;
    if (Math.abs(dLat) > bestM) continue;
    const d = distanceM([tr.lat[i], tr.lng[i]], [lat, lng]);
    if (d < bestM) {
      bestM = d;
      best = i;
    }
  }
  return { i: best, m: bestM };
}

/** The direction of travel at track point i (over 25 m each side), degrees clockwise from north. */
function headingAt(tr, i) {
  let j = i;
  while (j > 0 && tr.cum[i] - tr.cum[j] < 25) j -= 1;
  let k = i;
  while (k < tr.n - 1 && tr.cum[k] - tr.cum[i] < 25) k += 1;
  return bearing([tr.lat[j], tr.lng[j]], [tr.lat[k], tr.lng[k]]);
}

module.exports = { nearestIndex, headingAt, recordDrive, loadTrack, findTurns, distanceM, bearing, angleDiff, library, MPH, M_PER_MILE, between, round };
