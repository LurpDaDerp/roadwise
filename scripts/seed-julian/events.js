'use strict';
/**
 * The events of one recorded drive: what the phone's detectors would have reported along its speed
 * profile. How many of each there are follows the driver's level that day (`ctx.k`, a multiple of
 * the scoring package's typical rate per chance to slip) and whether the drive is a calm one; where
 * they are is a place on the visible route that fits (a speeding stretch with the same limit all
 * the way, a hard brake before a stop, a hard start after one, a hard turn at a real corner).
 * Places the driver keeps doing the same thing (`ctx.spots`) are forced; random events keep clear
 * of them.
 */
require('./tshook.js');
const scoring = require('../../packages/scoring/src/index.ts');
const { distanceM, MPH, between, round } = require('./sim.js');

const intBetween = (rnd, lo, hi) => Math.floor(between(rnd, lo, hi + 1));
const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function poisson(rnd, lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  for (let p = rnd(); p > limit; p *= rnd()) k += 1;
  return k;
}

function normal(rnd) {
  return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}

/** A version-4 uuid from the generator, so a fixed seed gives fixed ids. */
function uuid(rnd) {
  const hex = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16));
  hex[12] = '4';
  hex[16] = '89ab'[Math.floor(rnd() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// How big an event is

/** A speeding episode: its rows over the line (every one counts), its tier and how far over the line it went. Mostly short and mild, now and then a long hard one, as real speeding is. */
function drawSpeeding(rnd, heavy = false) {
  // a habitual speeder (`heavy`) holds a high speed for long stretches, well over the line
  const d = heavy ? Math.min(150, Math.round(14 + -Math.log(1 - rnd()) * 32)) : Math.min(70, Math.round(3 + -Math.log(1 - rnd()) * 13));
  const roll = rnd();
  const tier = heavy ? (roll < 0.06 ? 'minor' : roll < 0.28 ? 'moderate' : 'severe') : roll < 0.4 ? 'minor' : roll < 0.82 ? 'moderate' : 'severe';
  const peakOver = tier === 'minor' ? between(rnd, 0.8, 3.8) : tier === 'moderate' ? between(rnd, 4.4, 8.8) : between(rnd, 9.4, heavy ? 26 : 15);
  const meanOver = peakOver * between(rnd, heavy ? 0.8 : 0.6, 0.95);
  return { d, tier, peakOver, overMphS: round(scoring.speedingChargedS(d) * meanOver, 1) };
}

const hardTier = (rnd) => (rnd() < 0.16 ? 'severe' : 'minor');
const hardG = (type) => (type === 'hard_brake' ? scoring.HARD_BRAKE_G : type === 'hard_accel' ? scoring.HARD_ACCEL_G : scoring.HARD_CORNER_G);
/** A hard event's peak force (g) at its tier: just past the tier's threshold (an event weighs its peak over the threshold, squared). */
const hardPeak = (type, tier, rnd) => {
  const g = hardG(type);
  return round(tier === 'severe' ? between(rnd, g.severe, g.severe + 0.03) : between(rnd, g.minor, g.minor + 0.015), 2);
};
/** The mean speed factor (scoring `speedFactor`) over the track points `at`: a pickup or a DashPal event weighs more the faster the car. */
const paceFactor = (v, at) => (at.length > 0 ? scoring.speedFactor(at.reduce((sum, i) => sum + v[i], 0) / at.length / MPH) : 1);
const drawPhone = (rnd) => {
  const r = rnd();
  if (r < 0.55) return intBetween(rnd, 4, 14);
  if (r < 0.85) return intBetween(rnd, scoring.PHONE_SEVERE_S + 1, 40);
  return intBetween(rnd, 41, 100);
};

/** Mean weights per event, from a fixed draw, so the expected counts follow the scoring package's own arithmetic. */
const MEAN_WEIGHT = (() => {
  let s = 12345;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  let speed = 0;
  let speedHeavy = 0;
  let phone = 0;
  const hard = { hard_brake: 0, hard_accel: 0, hard_corner: 0 };
  const N = 6000;
  for (let i = 0; i < N; i += 1) {
    const e = drawSpeeding(rnd);
    speed += scoring.speedingWeight(e.d, e.overMphS, e.tier);
    const h = drawSpeeding(rnd, true);
    speedHeavy += scoring.speedingWeight(h.d, h.overMphS, h.tier);
    phone += scoring.PHONE_PICKUP_WEIGHT_S + drawPhone(rnd);
    // each hard event weighs its peak over its threshold, squared (hardEvent's own peaks)
    for (const type of Object.keys(hard)) {
      const tier = hardTier(rnd);
      hard[type] += scoring.hardEventWeight(type, tier, hardPeak(type, tier, rnd));
    }
  }
  return {
    speed: speed / N,
    speedHeavy: speedHeavy / N,
    phone: phone / N,
    hard: { hard_brake: hard.hard_brake / N, hard_accel: hard.hard_accel / N, hard_corner: hard.hard_corner / N },
  };
})();

// ---------------------------------------------------------------------------------------------
// Where

function prepare(rec) {
  if (rec.prep) return rec.prep;
  const { tr, turns, v, t } = rec;
  const near = new Uint8Array(tr.n); // within 90 m of a stop or a turn
  const marks = [...rec.sim.stops.keys(), ...turns.map((x) => x.i)];
  for (const m of marks) {
    for (let i = m; i >= 0 && tr.cum[m] - tr.cum[i] <= 90; i -= 1) near[i] = 1;
    for (let i = m; i < tr.n && tr.cum[i] - tr.cum[m] <= 90; i += 1) near[i] = 1;
  }
  const usable = (i) => i >= rec.lo && i <= rec.hi && t[i] >= 35 && t[i] <= rec.durationS - 50;
  const cruise = [];
  const fast = [];
  const afterStop = [];
  const beforeStop = [];
  for (let i = rec.lo; i <= rec.hi; i += 1) {
    if (!usable(i)) continue;
    if (!near[i] && v[i] >= 18 * MPH && tr.limit[i] >= 20 && tr.cls[i] !== 'service_other') cruise.push(i);
    if (v[i] >= 12 * MPH) fast.push(i);
  }
  for (const s of rec.sim.stops.keys()) {
    for (let i = s + 1; i < tr.n && tr.cum[i] - tr.cum[s] <= 110; i += 1) {
      if (usable(i) && v[i] >= 8 * MPH && v[i] <= 22 * MPH) afterStop.push(i);
    }
    for (let i = s - 1; i >= 0 && tr.cum[s] - tr.cum[i] <= 110; i -= 1) {
      if (usable(i) && v[i] >= 15 * MPH && tr.cum[s] - tr.cum[i] >= 25) beforeStop.push(i);
    }
  }
  const corners = turns.filter((x) => x.deg >= 60 && usable(x.i) && tr.cls[x.i] !== 'motorway').map((x) => x.i);
  rec.prep = { cruise, fast, afterStop, beforeStop, corners, usable };
  return rec.prep;
}

const eventTime = (rec, i) => rec.startedAt + Math.round(rec.t[i] * 1000);
const here = (rec, i) => ({ lat: round(rec.tr.lat[i], 5), lng: round(rec.tr.lng[i], 5) });

/** A speeding event starting at index i, or null when no stretch with one limit is long enough. */
function speedingAt(rec, i, rnd, draw, zone) {
  const { tr } = rec;
  const L = tr.limit[i];
  const T = scoring.speedTolerance(L, zone);
  const speedMph = round(L + T + draw.peakOver, 1);
  if (scoring.speedTier(speedMph, L, zone) !== draw.tier) return null;
  let d = draw.d;
  const reach = (secs) => {
    const need = secs * speedMph * MPH;
    let e = i;
    while (e < rec.hi && tr.cum[e] - tr.cum[i] < need) {
      e += 1;
      if (tr.limit[e] !== L) return false;
    }
    return tr.cum[e] - tr.cum[i] >= need * 0.999;
  };
  while (d > 1 && !reach(d)) d -= 1;
  if (!reach(d)) return null;
  const overMphS = d === draw.d ? draw.overMphS : round(scoring.speedingChargedS(d) * (draw.overMphS / scoring.speedingChargedS(draw.d)), 1);
  return {
    type: 'speeding',
    tier: draw.tier,
    startedAt: eventTime(rec, i),
    durationS: d,
    ...here(rec, i),
    ...(zone ? { zone } : {}),
    measured: { speedMph, limitMph: L, overMphS },
  };
}

function hardEvent(rec, type, i, rnd) {
  const tier = hardTier(rnd);
  const peakG = hardPeak(type, tier, rnd);
  const mph = rec.v[i] / MPH;
  let speedMph;
  if (type === 'hard_corner') speedMph = Math.sqrt(peakG * 9.81 * between(rnd, 14, 26)) / MPH;
  else if (type === 'hard_brake') speedMph = Math.max(14, mph * between(rnd, 0.95, 1.1));
  else speedMph = Math.max(8, mph * between(rnd, 0.9, 1.1));
  return {
    type,
    tier,
    startedAt: eventTime(rec, i),
    durationS: intBetween(rnd, 1, 3),
    ...here(rec, i),
    measured: { peakG, speedMph: round(speedMph, 1) },
  };
}

function phoneAt(rec, i, rnd) {
  const inHand = Math.min(drawPhone(rnd), Math.floor(rec.durationS - rec.t[i] - 8));
  if (inHand < 1) return null;
  const speedMph = round(Math.max(scoring.PHONE_PICKUP_MIN_MPH, (rec.v[i] / MPH) * between(rnd, 0.92, 1.02)), 1);
  return {
    type: 'phone_pickup',
    tier: scoring.phonePickupTier(inHand),
    startedAt: eventTime(rec, i),
    durationS: inHand,
    ...here(rec, i),
    measured: { speedMph, maxSpeedMph: round(speedMph + between(rnd, 0, 6), 1) },
  };
}

// ---------------------------------------------------------------------------------------------
// The drive

/**
 * ctx: { k: { speed, braking, acceleration, turning, phone } (multiples of the typical rate),
 *   calm (no random events), u (this drive's intensity, mean 1), pCalm (the share of calm drives,
 *   so eventful ones carry the rest), spots: [{ lat, lng, kind }] (random events stay 250 m clear),
 *   forced: [event], dashcam: { watched (0..1 share of moving seconds covered), eyes (per watched mile), drowsy (bool) },
 *   schoolZone: { lat, lng } | null }
 */
function makeEvents(rec, ctx, rnd) {
  const events = [];
  const { tr, v } = rec;
  const prep = prepare(rec);
  const busy = []; // [from, to] ms of events already placed
  const free = (start, dur, gap = 8) => busy.every(([a, b]) => start > b + gap * 1000 || start + dur * 1000 < a - gap * 1000);
  const occupy = (e) => busy.push([e.startedAt, e.startedAt + Math.max(1, e.durationS) * 1000]);
  const clear = (i) => ctx.spots.every((s) => distanceM([tr.lat[i], tr.lng[i]], [s.lat, s.lng]) > 250);
  // a place where two earlier drives already had the same event is left alone, so only the places
  // the driver is meant to keep repeating ever become problem spots
  const crowded = (e) => {
    if (e.lat === undefined || ctx.seen === undefined) return false;
    // a habitual speeder speeds on the same roads again and again: those are spots too
    if (e.type === 'speeding' && ctx.heavySpeed) return false;
    const eps = e.type === 'speeding' ? 280 : 90;
    return ctx.seen.filter((o) => o.type === e.type && distanceM([o.lat, o.lng], [e.lat, e.lng]) < eps).length >= 2;
  };
  const place = (list, make, tries = 40, ignoreCrowd = false) => {
    for (let n = 0; n < tries && list.length > 0; n += 1) {
      const i = pick(rnd, list);
      // an event that must happen (ignoreCrowd) may sit near a spot after many tries
      if (!clear(i) && !(ignoreCrowd && n > tries / 2)) continue;
      const e = make(i);
      if (e && free(e.startedAt, e.durationS) && (ignoreCrowd || !crowded(e))) {
        events.push(e);
        occupy(e);
        if (ctx.seen !== undefined && e.lat !== undefined) ctx.seen.push({ type: e.type, lat: e.lat, lng: e.lng });
        return true;
      }
    }
    return false;
  };

  for (const f of ctx.forced ?? []) {
    events.push(f);
    occupy(f);
    if (ctx.seen !== undefined && f.lat !== undefined) ctx.seen.push({ type: f.type, lat: f.lat, lng: f.lng });
  }
  // one event of a chosen kind on an otherwise calm drive
  for (const kind of ctx.extra ?? []) {
    if (kind === 'speeding') {
      place(
        prep.cruise,
        (i) => {
          const draw = drawSpeeding(rnd);
          draw.d = Math.max(draw.d, 7);
          return speedingAt(rec, i, rnd, draw, null);
        },
        200,
        true
      );
    } else if (kind === 'phone_pickup') {
      place(prep.fast, (i) => phoneAt(rec, i, rnd), 200, true);
    } else if (kind === 'hard_brake') {
      place(prep.beforeStop.length > 0 ? prep.beforeStop : prep.fast, (i) => hardEvent(rec, 'hard_brake', i, rnd), 200, true);
    } else if (kind === 'hard_accel') {
      place(prep.afterStop.length > 0 ? prep.afterStop : prep.fast, (i) => hardEvent(rec, 'hard_accel', i, rnd), 200, true);
    } else if (kind === 'hard_corner') {
      place(prep.corners.length > 0 ? prep.corners : prep.fast, (i) => hardEvent(rec, 'hard_corner', i, rnd), 200, true);
    }
  }

  if (!ctx.calm) {
    const share = 1 / Math.max(0.2, 1 - ctx.pCalm);
    const ex = rec.exposure;
    const scale = ctx.u * share;
    const n = {
      braking: poisson(rnd, (ctx.k.braking * 0.01 * ex.slowdowns * scale) / MEAN_WEIGHT.hard.hard_brake),
      acceleration: poisson(rnd, (ctx.k.acceleration * 0.008 * ex.speedups * scale) / MEAN_WEIGHT.hard.hard_accel),
      turning: poisson(rnd, (ctx.k.turning * 0.008 * ex.turns * scale) / MEAN_WEIGHT.hard.hard_corner),
      speed: poisson(rnd, (ctx.k.speed * 0.04 * ex.limitS * scale) / (ctx.heavySpeed ? MEAN_WEIGHT.speedHeavy : MEAN_WEIGHT.speed)),
      phone: poisson(rnd, (ctx.k.phone * 0.04 * ex.phoneS * scale) / (MEAN_WEIGHT.phone * paceFactor(v, prep.fast))),
    };
    for (let c = 0; c < n.speed; c += 1) {
      place(prep.cruise, (i) => {
        const draw = drawSpeeding(rnd, ctx.heavySpeed);
        const zone = ctx.schoolZone && distanceM([tr.lat[i], tr.lng[i]], [ctx.schoolZone.lat, ctx.schoolZone.lng]) < 450 && tr.limit[i] <= 25 ? 'school' : null;
        return speedingAt(rec, i, rnd, draw, zone);
      });
    }
    for (let c = 0; c < n.braking; c += 1) place(rnd() < 0.7 && prep.beforeStop.length ? prep.beforeStop : prep.fast, (i) => hardEvent(rec, 'hard_brake', i, rnd));
    for (let c = 0; c < n.acceleration; c += 1) place(prep.afterStop.length ? prep.afterStop : prep.fast, (i) => hardEvent(rec, 'hard_accel', i, rnd));
    for (let c = 0; c < n.turning; c += 1) place(prep.corners, (i) => hardEvent(rec, 'hard_corner', i, rnd));
    for (let c = 0; c < n.phone; c += 1) place(prep.fast, (i) => phoneAt(rec, i, rnd));
  }

  // DashPal: eyes off the road (spaced at least 5 min apart here) and, now and then, drowsiness
  const d = ctx.dashcam;
  if (d && d.watched > 0) {
    const watchedMiles = rec.miles * d.watched;
    const gapMs = 305_000;
    const want = poisson(rnd, (d.eyes * watchedMiles) / paceFactor(v, prep.fast.filter((i) => v[i] >= 18 * MPH)));
    const mine = [];
    for (let c = 0; c < want; c += 1) {
      place(prep.fast.filter((i) => v[i] >= 18 * MPH), (i) => {
        const startedAt = eventTime(rec, i);
        if (mine.some((t) => Math.abs(t - startedAt) < gapMs)) return null;
        mine.push(startedAt);
        return {
          type: 'eyes_off',
          tier: 'severe',
          startedAt,
          durationS: rnd() < 0.8 ? intBetween(rnd, 3, 6) : intBetween(rnd, 7, 12),
          ...here(rec, i),
          measured: { source: 'dashcam', speedMph: round(v[i] / MPH, 1) },
        };
      });
    }
    if (d.drowsy) {
      place(prep.fast.filter((i) => v[i] >= 25 * MPH && rec.t[i] > rec.durationS * 0.4), (i) => ({
        type: 'drowsy',
        tier: 'severe',
        startedAt: eventTime(rec, i),
        durationS: intBetween(rnd, 2, 4),
        ...here(rec, i),
        measured: { source: 'dashcam', speedMph: round(v[i] / MPH, 1) },
      }));
    }
  }
  return events.sort((a, b) => a.startedAt - b.startedAt).map((e) => ({ id: uuid(rnd), ...e }));
}

/** A forced event at track point i (a problem spot's repeated event). */
function forcedEvent(rec, spot, i, rnd) {
  const { tr } = rec;
  if (i < rec.lo || i > rec.hi) return null;
  if (spot.kind === 'speeding') {
    const L = tr.limit[i];
    const speedMph = round(L + scoring.speedTolerance(L) + spot.over, 1);
    const tier = scoring.speedTier(speedMph, L);
    const d = Math.max(1, spot.durationS - 5);
    // starts early enough to be at speed along the stretch
    return {
      type: 'speeding',
      tier,
      startedAt: eventTime(rec, i),
      durationS: d,
      ...here(rec, i),
      measured: { speedMph, limitMph: L, overMphS: round(scoring.speedingChargedS(d) * spot.over * between(rnd, 0.8, 1), 1) },
    };
  }
  const g = spot.kind === 'hard_brake' ? scoring.HARD_BRAKE_G : spot.kind === 'hard_corner' ? scoring.HARD_CORNER_G : scoring.HARD_ACCEL_G;
  // a firm one, just past its threshold (an event weighs its peak over the threshold, squared)
  const peakG = round(between(rnd, g.minor + 0.005, g.minor + 0.03), 2);
  const speedMph = spot.kind === 'hard_corner' ? Math.sqrt(peakG * 9.81 * between(rnd, 14, 26)) / MPH : Math.max(spot.kind === 'hard_brake' ? 16 : 8, (rec.v[i] / MPH) * between(rnd, 0.9, 1.1));
  return {
    type: spot.kind,
    tier: 'minor',
    startedAt: eventTime(rec, i),
    durationS: intBetween(rnd, 1, 3),
    ...here(rec, i),
    measured: { peakG, speedMph: round(speedMph, 1) },
  };
}

module.exports = { makeEvents, forcedEvent, poisson, normal, uuid, intBetween, pick, MEAN_WEIGHT };
