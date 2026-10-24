'use strict';
/**
 * A person's whole history, oldest drive first: for each planned trip the recording (sim.js), its
 * events (events.js) and the upload a phone would have sent (a finalize-trip v5 body), with what
 * finalize-trip stores of it. Everything is a pure function of the person, the plan and `now`: the
 * same inputs give the same drives, ids included.
 *
 * Nothing about scores is written here. The Safety Rating, the drive scores, the merit tiers, the
 * goals, the achievements and the problem spots are all derived afterwards, by the server's engine
 * and by the app's own code, from these uploads.
 */
require('./tshook.js');
const scoring = require('../../packages/scoring/src/index.ts');
const { localInstant, localDay, TZ, dayKey } = require('./calendar.js');
const { recordDrive, loadTrack, nearestIndex, headingAt, angleDiff, distanceM, between, round } = require('./sim.js');
const { makeEvents, forcedEvent, normal, uuid } = require('./events.js');
const { DAYS } = require('./people.js');
const { weekKey } = require('./weeks.js');

const APP_VERSION = '2.0.0';
const DASHCAM_ID = 'a4c138f0d2e1';

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

const AXES = ['speed', 'braking', 'acceleration', 'turning', 'phone'];
const lerp = (a, b, f) => a + (b - a) * f;

/** The driver's level on a day: multiples of the typical rate per category, and the share of calm drives. */
function skillAt(person, back) {
  const p = Math.min(1, Math.max(0, 1 - back / DAYS));
  const s = person.skill;
  const week = Math.floor((DAYS - back) / 7);
  const wob = mulberry32(person.seed + week * 977)() * 2 - 1;
  const k = {};
  for (const a of AXES) {
    const f = Math.pow(1 - p, (s.curves && s.curves[a]) ?? s.curve);
    k[a] = Math.max(0.05, (s.end[a] + (s.start[a] - s.end[a]) * f) * (1 + s.wobble * wob));
  }
  return { k, pCalm: lerp(s.calm[0], s.calm[1], p) };
}

/** Where along its route each problem spot is (a latitude and longitude), once. */
function spotPlaces(person) {
  return (person.spots ?? []).map((s) => {
    const tr = loadTrack(s.route, Boolean(s.reverse));
    let i = 0;
    while (i < tr.n - 1 && tr.cum[i] < s.atM) i += 1;
    return { ...s, lat: tr.lat[i], lng: tr.lng[i], heading: headingAt(tr, i) };
  });
}

/** The upload (v5) a phone would have sent for a recorded drive. */
function toPayload(rec, events, rnd, dashcam, origin, expired) {
  const { tr } = rec;
  const exposure = rec.exposure;
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
    start: { lat: round(tr.lat[0], 4), lng: round(tr.lng[0], 4) },
    end: { lat: round(tr.lat[tr.n - 1], 4), lng: round(tr.lng[tr.n - 1], 4) },
    polyline: rec.polyline,
    integrity: {
      mockLocation: false,
      motionMismatch: false,
      validGnssPct: round(between(rnd, 93, 99.6), 1),
      maxSpeedMph: round(Math.max(...Array.from(rec.v)) / 0.44704 + between(rnd, 1, 4), 1),
    },
    events,
    appVersion: APP_VERSION,
    origin,
    notDrivingExpired: expired,
    exposure,
  };
  if (dashcam) {
    const movingS = exposure.movingS;
    payload.dashcam = { deviceId: DASHCAM_ID, movingS, coveredS: Math.min(movingS, Math.round(movingS * dashcam.watched)), synced: true };
  }
  return payload;
}

/** What finalize-trip stores of a fresh upload (its `buildStoredDrive`): the kept events, the DashPal seconds, scored or too short. */
function storeUpload(p) {
  const kept = scoring.keepDashcamEvents(p.events);
  const dashcam = p.dashcam
    ? { deviceId: p.dashcam.deviceId, movingS: p.dashcam.movingS, coveredS: p.dashcam.coveredS, synced: p.dashcam.synced, on: scoring.dashcamDrive(p.dashcam) }
    : { deviceId: null, movingS: 0, coveredS: 0, synced: false, on: false };
  const cls = scoring.classifyDrive({ miles: p.miles, durationS: p.durationS, events: kept });
  return { kept, dashcam, scored: cls.scored, reason: cls.reason, activeEventCount: cls.activeEventCount };
}

/**
 * Every drive of `person`'s history as of `now`, oldest first: { trip, payload, stored }.
 * `opts.passenger` adds one more drive, a ride as a passenger the driver will mark "Wasn't driving".
 */
function buildHistory(person, now, opts = {}) {
  const rndPlan = mulberry32(person.seed);
  const planned = person.plan(now, rndPlan).filter((t) => localInstant(t.day, t.minutes) < now - 2 * 3600 * 1000);
  const shorts = (person.shorts ?? []).map((s) => ({ ...s, day: localDay(now, s.back), route: 'home_school', reverse: false, truncateM: 260, weekend: false, short: true }));
  let trips = [...planned, ...shorts.filter((t) => localInstant(t.day, t.minutes) < now - 2 * 3600 * 1000)];
  if (opts.passenger) {
    const at = localInstant(opts.passenger.day, opts.passenger.minutes);
    trips = trips.filter((t) => Math.abs(localInstant(t.day, t.minutes) - at) > 50 * 60_000);
    trips.push(opts.passenger);
  }
  trips.sort((a, b) => localInstant(a.day, a.minutes) - localInstant(b.day, b.minutes));
  const places = spotPlaces(person);
  const seen = (person.spots ?? []).length > 0 ? [] : undefined;
  // this week's goals read as in progress: a few clean drives, one with only a phone pickup, the rest with only speeding
  const weekNow = weekKey(now);
  const modes = new Map();
  let nth = 0;
  trips.forEach((t, i) => {
    if (person.weekMix && !t.short && t.kind !== 'passenger' && weekKey(localInstant(t.day, t.minutes)) === weekNow) {
      modes.set(i, nth < person.weekMix.length ? person.weekMix[nth] : ['hard_brake', 'hard_accel', 'hard_corner'][nth % 3]);
      nth += 1;
    }
  });

  // the drives that carry DashPal's drowsiness: the longest evening drive near each chosen day
  const drowsy = new Set();
  if (person.dashcam) {
    for (const b of person.dashcam.drowsyBacks) {
      const near = trips
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => !t.short && t.kind !== 'passenger' && Math.abs(t.day.back - b) <= 6 && t.minutes >= 18 * 60 && (t.route.includes('friend') || t.route.includes('home_')))
        .sort((x, y) => y.t.minutes - x.t.minutes);
      if (near[0]) drowsy.add(near[0].i);
    }
  }

  // phase one: record every drive (its route, timing and counters)
  const recorded = trips.map((trip, index) => {
    const rt = mulberry32(person.seed * 31 + index * 7919 + 17);
    const startedAtMs = localInstant(trip.day, trip.minutes) + Math.floor(rt() * 59) * 1000;
    const tempo = between(rt, person.tempo[0], person.tempo[1]);
    const rec = recordDrive({ ...trip, startedAtMs, tempo }, rt);
    const short = Boolean(trip.short);
    if (short !== scoring.tooShort(rec.miles, rec.durationS)) throw new Error(`a drive is not as short (or long) as it should be: ${trip.route} ${rec.miles} mi ${rec.durationS} s`);
    return { trip, index, rt, rec, startedAtMs, short, back: trip.day.back, mode: modes.get(index) ?? null };
  });

  // events planted on two drives of the last week (before this week), so there is something to report there
  const planted = new Map();
  if (person.plant) {
    const open = recorded.filter((p) => !p.short && p.trip.kind !== 'passenger' && !p.trip.forceCalm && p.mode === null && now - p.rec.endedAt < 6.2 * 86_400_000 && weekKey(p.rec.startedAt) !== weekNow && p.rec.miles >= 2);
    person.plant.forEach((kind, i) => {
      const pick = open[Math.floor(((i + 1) * open.length) / (person.plant.length + 1))];
      if (pick) planted.set(pick.index, [...(planted.get(pick.index) ?? []), kind]);
    });
  }

  // phase two: which drives repeat each problem spot. Any drive of the same road, the same way, passes
  // the place (the app's own rule: within 35 m, heading within 45 degrees); a spot that is meant to be
  // active gets a hit among its last three passes, so a quiet week cannot clear it
  const rs = mulberry32(person.seed ^ 0x5b07);
  const hits = places.map(() => new Set());
  places.forEach((spot, si) => {
    const passes = [];
    for (const p of recorded) {
      if (p.short || p.trip.kind === 'passenger') continue;
      const at = nearestIndex(p.rec.tr, spot.lat, spot.lng);
      if (at.m > 25 || angleDiff(headingAt(p.rec.tr, at.i), spot.heading) > 40) continue;
      const allowed = !p.trip.forceCalm && p.mode !== 'calm';
      passes.push({ p, at: at.i, allowed });
    }
    for (const x of passes) if (x.allowed && rs() < spot.hit(x.p.back)) hits[si].add(x.p.index);
    if (spot.active) {
      const tail = passes.slice(-3);
      if (!tail.some((x) => hits[si].has(x.p.index))) {
        const x = [...tail].reverse().find((y) => y.allowed);
        if (x) hits[si].add(x.p.index);
      }
    }
  });

  // phase three: the events, and the upload
  return recorded.map(({ trip, index, rt, rec, startedAtMs, short, back, mode }) => {
    const { k, pCalm } = skillAt(person, back);
    const forced = [];
    places.forEach((spot, si) => {
      if (!hits[si].has(index)) return;
      const at = nearestIndex(rec.tr, spot.lat, spot.lng);
      const e = forcedEvent(rec, spot, at.i, rt);
      if (e) forced.push(e);
    });
    const passenger = trip.kind === 'passenger';
    const u = Math.exp(normal(rt) * 0.45 - 0.1);
    const calm = !passenger && !trip.rough && forced.length === 0 && (mode !== null || trip.forceCalm || rt() < pCalm);
    let dashcam = null;
    if (person.dashcam && back <= person.dashcam.fromBack && !short && !passenger) {
      const f = (person.dashcam.fromBack - back) / person.dashcam.fromBack;
      const watched = rt() < 0.05 ? between(rt, 0.3, 0.7) : between(rt, 0.88, 0.99);
      dashcam = { watched, eyes: lerp(person.dashcam.eyes[0], person.dashcam.eyes[1], f), drowsy: drowsy.has(index) };
    }
    const extra = [...(forced.length > 0 || mode === null || mode === 'calm' ? [] : [mode === 'speed' ? 'speeding' : mode === 'phone' ? 'phone_pickup' : mode]), ...(planted.get(index) ?? [])];
    const ctx = {
      k: passenger ? { speed: 0, braking: 0, acceleration: 0, turning: 0, phone: 6 } : trip.rough ? Object.fromEntries(Object.entries(k).map(([a, v]) => [a, Math.max(v, 1) * 4.5])) : k,
      calm: short || (calm && !passenger),
      seen,
      extra,
      u,
      pCalm,
      spots: places,
      forced,
      dashcam,
      schoolZone: person.schoolZone && trip.route.includes('school') ? person.schoolZone : null,
    };
    let events = short ? [] : makeEvents(rec, ctx, rt);
    if (trip.rough) {
      // a rushed drive scores under 75 (merit 1): more events until it does
      for (let more = 0; more < 6 && roughScore(rec, events, dashcam) >= 72; more += 1) {
        events = makeEvents(rec, { ...ctx, calm: false, extra: ['speeding', 'phone_pickup', 'speeding'], forced: events.filter((e) => !scoring.isDashcamType(e.type)), k: { ...ctx.k, braking: 40 } }, rt);
      }
    }
    const origin = rt() < person.origin ? 'auto' : 'manual';
    const expired = origin === 'auto' && back > 0 && rt() < 0.35;
    const payload = toPayload(rec, events, rt, dashcam, origin, passenger ? false : expired);
    return { trip: { ...trip, startedAtMs, kind: trip.kind ?? null }, payload, stored: storeUpload(payload) };
  });
}

/** The score of a recorded drive with these events, as the recap computes it. */
function roughScore(rec, events, dashcam) {
  const watched = dashcam ? scoring.watchedMiles(rec.miles, rec.exposure.movingS, Math.round(rec.exposure.movingS * dashcam.watched)) : 0;
  const kept = scoring.keepDashcamEvents(events);
  return scoring.driveScore(kept.map((e) => ({ id: e.id ?? 'x', type: e.type, tier: e.tier, startedAt: e.startedAt, durationS: e.durationS, status: 'active', measured: e.measured })), rec.miles, watched, rec.exposure) ?? 100;
}

/** What a history should add up to as of `now`: the scoring package's own ratingAt, categories and counts. */
function summarize(drives, now) {
  const scored = drives.filter((d) => d.stored.scored && d.trip.kind !== 'passenger');
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
    miles: round(scored.reduce((s, d) => s + d.payload.miles, 0), 1),
    miles90: round(rating.miles, 1),
    rating: rating.rating,
    ranked: rating.ranked,
    axes: Object.fromEntries(Object.entries(rating.scores).map(([k, v]) => [k, v === null ? null : Math.round(v)])),
    counts,
  };
}

module.exports = { buildHistory, summarize, storeUpload, mulberry32, skillAt, distanceM, APP_VERSION, DASHCAM_ID };
