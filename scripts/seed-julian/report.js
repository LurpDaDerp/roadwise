'use strict';
/**
 * What the app would show for a generated history, computed with the app's own code: the Safety
 * Rating and categories (scoring ratingAt, as the server's rating_at), each drive's score and merit,
 * the weekly trend, the problem spots (core/spots detectSpots) and the week's goals. Used to tune the
 * generator and by the tests; the seed prints it before it writes anything.
 */
require('./tshook.js');
const scoring = require('../../packages/scoring/src/index.ts');
const { detectSpots } = require('../../src/core/spots/detect.ts');
const { decodeRuns } = require('../../src/lib/polyline.ts');
const { summarize } = require('./generate.js');
const { weekKey } = require('./weeks.js');
const { statsFrom } = scoring;

const DAY = 86_400_000;

const toScoringEvent = (e) => ({ id: e.id, type: e.type, tier: e.tier, startedAt: e.startedAt, durationS: e.durationS, status: 'active', measured: e.measured });

/** A drive's score and merit exactly as the recap computes them. */
function driveView(d) {
  if (!d.stored.scored) return { score: null, merit: null };
  const p = d.payload;
  const watched = p.dashcam ? scoring.watchedMiles(p.miles, p.dashcam.movingS, p.dashcam.coveredS) : 0;
  const score = scoring.driveScore(d.stored.kept.map(toScoringEvent), p.miles, watched, scoring.clampExposure(p.exposure));
  return { score, merit: scoring.driveMerit(score, p.miles) };
}

function spotsOf(drives, now) {
  const scored = drives.filter((d) => d.stored.scored && d.payload.polyline);
  const sd = scored.map((d) => ({ clientTripId: d.payload.clientTripId, startedAt: d.payload.startedAt, runs: decodeRuns(d.payload.polyline) }));
  const events = [];
  for (const d of scored) {
    for (const e of d.stored.kept) {
      if (!['speeding', 'hard_brake', 'hard_corner', 'hard_accel'].includes(e.type) || e.lat === null || e.lat === undefined) continue;
      events.push({ id: e.id, clientTripId: d.payload.clientTripId, type: e.type, tier: e.tier, startedAt: e.startedAt, durationS: e.durationS, lat: e.lat, lng: e.lng, speedMph: e.measured?.speedMph ?? null, limitMph: e.measured?.limitMph ?? null });
    }
  }
  return detectSpots(sd, events, now);
}

const ratingDrives = (drives) =>
  drives
    .filter((d) => d.stored.scored && d.trip.kind !== 'passenger')
    .map((d) => ({
      id: d.payload.clientTripId,
      startedAt: d.payload.startedAt,
      miles: d.payload.miles,
      watchedMiles: d.payload.dashcam ? scoring.watchedMiles(d.payload.miles, d.payload.dashcam.movingS, d.payload.dashcam.coveredS) : 0,
      exposure: scoring.clampExposure(d.payload.exposure),
      events: d.stored.kept,
    }));

/** The StatSums of the scored drives that started at or after `since`, as the phone sums its own drives. */
function sumsOf(drives, since) {
  const s = { miles: 0, durationS: 0, nightMiles: 0, drives: 0, cleanDrives: 0, speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0 };
  for (const d of drives) {
    if (!d.stored.scored || d.trip.kind === 'passenger' || d.payload.startedAt < since) continue;
    const count = (t) => d.stored.kept.filter((e) => e.type === t).length;
    s.miles += d.payload.miles;
    s.durationS += d.payload.durationS;
    s.nightMiles += d.payload.nightMiles;
    s.drives += 1;
    s.cleanDrives += d.stored.activeEventCount === 0 ? 1 : 0;
    s.speeding += count('speeding');
    s.hardBrake += count('hard_brake');
    s.hardAccel += count('hard_accel');
    s.hardCorner += count('hard_corner');
  }
  return s;
}

/** Home's four stats as the app builds them: the last 7 days against the 30, with the colour of each. */
function homeOf(drives, now) {
  const week = sumsOf(drives, now - 7 * DAY);
  const month = sumsOf(drives, now - 30 * DAY);
  const use = week.drives > 0 ? week : month;
  const shown = Object.fromEntries(statsFrom(use).map((x) => [x.id, x]));
  const base = Object.fromEntries(statsFrom(month).map((x) => [x.id, x]));
  const avgWeek = (id) => (base[id].total * 7) / 30;
  return {
    window: week.drives > 0 ? '7d' : '30d',
    speeding: { total: shown.speeding.total, color: shown.speeding.color, avgWeek: avgWeek('speeding') },
    harsh: { total: shown.harsh.total, color: shown.harsh.color, avgWeek: avgWeek('harsh') },
    clean: { value: shown.clean.value, color: shown.clean.color, month: base.clean.value },
    miles: shown.miles.value,
  };
}

function report(drives, now) {
  const sum = summarize(drives, now);
  const rating7 = scoring.ratingAt(ratingDrives(drives), now - 7 * DAY);
  const views = drives.map(driveView);
  const merits = {};
  views.forEach((v, i) => {
    if (v.merit !== null && drives[i].trip.kind !== 'passenger') merits[v.merit] = (merits[v.merit] ?? 0) + 1;
  });
  const recentMerits = [
    ...new Set(
      drives
        .map((d, i) => ({ d, v: views[i] }))
        .filter(({ d, v }) => v.merit !== null && d.trip.kind !== 'passenger')
        .slice(-40)
        .map(({ v }) => v.merit)
    ),
  ].sort();
  const weeks = new Map();
  drives.forEach((d, i) => {
    if (!d.stored.scored || views[i].score === null || d.trip.kind === 'passenger') return;
    const w = Math.floor((now - d.payload.startedAt) / (7 * DAY));
    const row = weeks.get(w) ?? { n: 0, score: 0, miles: 0, events: 0, clean: 0 };
    row.n += 1;
    row.score += views[i].score;
    row.miles += d.payload.miles;
    row.events += d.stored.activeEventCount;
    row.clean += d.stored.activeEventCount === 0 ? 1 : 0;
    weeks.set(w, row);
  });
  const trend = [...weeks.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([w, r]) => ({ weeksAgo: w, drives: r.n, score: Math.round(r.score / r.n), per100: Math.round((r.events * 100) / r.miles), clean: Math.round((r.clean * 100) / r.n) }));
  const spots = spotsOf(drives, now).map((s) => ({
    kind: s.kind,
    state: s.state,
    hits: s.hits,
    passes: s.passes,
    rate: s.rate,
    lat: s.pin.lat,
    lng: s.pin.lng,
    clearedDaysAgo: s.clearedAt === null ? null : Math.round((now - s.clearedAt) / DAY),
  }));
  // the achievements, as check_achievements would unlock them while the drives arrive
  const achievements = { first_drive: false, clean_100: false, perfect_week: false };
  let cleanMiles = 0;
  const weekRows = new Map();
  for (const d of drives) {
    if (!d.stored.scored || d.trip.kind === 'passenger') continue;
    achievements.first_drive = true;
    const clean = d.stored.activeEventCount === 0;
    if (clean) cleanMiles += d.payload.miles;
    if (cleanMiles >= 100) achievements.clean_100 = true;
    const wk = weekKey(d.payload.startedAt);
    const row = weekRows.get(wk) ?? { n: 0, allClean: true };
    row.n += 1;
    row.allClean = row.allClean && clean;
    weekRows.set(wk, row);
    if (row.n >= 3 && row.allClean) achievements.perfect_week = true;
  }
  // this week's goals
  const thisWeek = weekKey(now);
  const mine = drives.filter((d) => d.stored.scored && d.trip.kind !== 'passenger' && weekKey(d.payload.startedAt) === thisWeek);
  const goals = {
    no_speeding: `${mine.filter((d) => !d.stored.kept.some((e) => e.type === 'speeding')).length}/4`,
    smooth: `${mine.filter((d) => !d.stored.kept.some((e) => ['hard_brake', 'hard_accel', 'hard_corner'].includes(e.type))).length}/4`,
    clean: `${mine.filter((d) => d.stored.activeEventCount === 0).length}/3`,
  };
  // events of the last week the driver can still report (a drive up to 7 days old, from before this week, so the week's goals stay as they are)
  const awayFromSpot = (e) => spots.every((sp) => Math.abs(sp.lat - e.lat) > 0.0015 || Math.abs(sp.lng - e.lng) > 0.0022);
  const reportable = (type) => {
    for (const d of drives.slice().reverse()) {
      if (!d.stored.scored || d.trip.kind === 'passenger' || now - d.payload.endedAt > 6.8 * DAY || weekKey(d.payload.startedAt) === thisWeek) continue;
      const e = d.stored.kept.find((x) => x.type === type && awayFromSpot(x));
      if (e) return { clientTripId: d.payload.clientTripId, eventId: e.id, type };
    }
    return null;
  };
  return {
    ...sum,
    disputable: { hazard: reportable('hard_brake'), mounted: reportable('phone_pickup') },
    rating7: rating7.rating,
    merits,
    recentMerits,
    trend,
    spots,
    achievements,
    goals,
    home: homeOf(drives, now),
    thisWeekDrives: mine.length,
    nightMiles: Math.round(drives.reduce((s, d) => s + d.payload.nightMiles, 0)),
  };
}

module.exports = { report, driveView, spotsOf, weekKey, ratingDrives };
