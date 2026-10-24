'use strict';
/**
 * Builds each person's history for a given `now` and keeps the draw that tells the story the demo
 * needs. A draw is the person's seed plus an offset; the generator is a pure function of it, so the
 * search is repeatable: the same `now` always lands on the same draw. A draw must meet the hard
 * conditions of the story (`must`); among the draws that do, the one closest to the targets
 * (`penalty`) is kept.
 */
const { JULIAN, FRIENDS, PENDING, estMinutes } = require('./people.js');
const { buildHistory } = require('./generate.js');
const { report } = require('./report.js');
const { localDay, localInstant } = require('./calendar.js');

const HOUR = 3_600_000;
const DRAWS = 300;
/** A Julian draw with a penalty this low is taken without searching on. */
const GOOD_ENOUGH = 8;

/** Julian rode along in a friend's car yesterday: a drive he did not drive, to mark "Wasn't driving". */
function passengerTrip(now) {
  for (const back of [0, 1]) {
    const day = localDay(now, back);
    for (let minutes = 20 * 60 + 30; minutes >= 8 * 60; minutes -= 15) {
      const start = localInstant(day, minutes);
      const end = start + estMinutes('home_friendB') * 60_000;
      if (start <= now - 5 * HOUR && end >= now - 20 * HOUR) {
        return { day, minutes, route: 'home_friendB', reverse: true, weekend: day.dow === 0 || day.dow === 6, kind: 'passenger', tempo: 0.95 };
      }
    }
  }
  return null;
}

const outside = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/** What a draw of Julian's history must be, and how far it is from the ideal: { must: [reasons it fails], penalty }. */
function julianStory(r) {
  const must = [];
  const a = r.axes;
  const scored = ['acceleration', 'braking', 'turning', 'phone', 'speed', 'attention'].map((k) => a[k]);
  if (!r.ranked || scored.some((v) => v === null)) must.push('not ranked, or a category has no score');
  else {
    if (a.braking !== Math.min(...scored) || a.braking >= 80) must.push(`braking ${a.braking} is not the weak spot a tip is for`);
    if (a.braking < 62) must.push(`braking ${a.braking} is too low`);
    if (!(r.rating >= 82 && r.rating <= 89)) must.push(`rating ${r.rating}`);
    if (Math.min(a.acceleration, a.turning) < 74) must.push(`acceleration ${a.acceleration} / turning ${a.turning}`);
  }
  if (!Object.values(r.achievements).every(Boolean)) must.push('an achievement is missing');
  const active = r.spots.filter((s) => s.state === 'active');
  const kinds = new Set(active.map((s) => s.kind));
  if (active.length < 3 || active.length > 4 || !kinds.has('speeding') || !kinds.has('hard_brake') || active.filter((x) => x.kind === 'speeding').length > 2) must.push(`spots ${active.map((x) => x.kind)}`);
  if (!r.spots.some((s) => s.state === 'cleared' && s.clearedDaysAgo <= 30)) must.push('no spot cleared lately');
  if (r.drives < 170 || r.clean / r.scored < 0.3) must.push(`drives ${r.drives}, clean ${r.clean}`);
  if (!r.disputable.hazard || !r.disputable.mounted) must.push('nothing to report in the last week');
  if (r.recentMerits.length < 5) must.push(`recent merit tiers ${r.recentMerits}`);
  const h = r.home;
  // (the speeding tile may read red: Home marks over 4 events per 100 mi red, and a driver who still speeds shows it)
  if (h.window !== '7d' || h.harsh.color === 'red' || h.clean.color === 'red') must.push(`home colours ${h.speeding.color}/${h.harsh.color}/${h.clean.color}`);
  const mean = (list) => list.reduce((s, w) => s + w.score, 0) / Math.max(1, list.length);
  const gap = mean(r.trend.filter((w) => w.weeksAgo <= 2)) - mean(r.trend.filter((w) => w.weeksAgo >= 9));
  if (gap < 7) must.push(`score trend ${gap.toFixed(1)}`);
  const gain = r.rating - r.rating7;
  if (!(gain > 0)) must.push(`7-day trend ${gain.toFixed(1)}`);

  // closer to the story is better: a rating in the mid-80s that rose lately, Braking the plain weak spot,
  // the rest good, Home's arrows pointing the way it improved
  let penalty = 0;
  penalty += outside(r.rating, 84.5, 87.5) * 3;
  penalty += outside(gain, 1, 2.5) * 2;
  penalty += outside(a.braking ?? 0, 68, 78);
  penalty += outside(a.phone ?? 0, 80, 88) + outside(a.speed ?? 0, 84, 92) + outside(a.attention ?? 0, 88, 94) + outside(Math.min(a.acceleration ?? 0, a.turning ?? 0), 82, 100);
  // a week with some goals still under way reads better than one with everything done or nothing started
  const doneGoals = Object.values(r.goals).filter((g) => Number(g.split('/')[0]) >= Number(g.split('/')[1])).length;
  penalty += r.thisWeekDrives >= 4 && (doneGoals < 1 || doneGoals > 2) ? 4 : 0;
  penalty += h.speeding.total > h.speeding.avgWeek + 0.05 ? 6 : 0;
  penalty += h.clean.value < h.clean.month ? 6 : 0;
    penalty += outside(gap, 10, 40);
  return { must, penalty };
}

const friendBand = (lo, hi) => (r) => {
  const ok = r.ranked && r.rating >= lo && r.rating <= hi;
  return { must: ok ? [] : [`rating ${r.rating} not in ${lo}-${hi}`], penalty: 0 };
};

const BANDS = {
  maya: friendBand(89.5, 93),
  sofia: friendBand(81, 83),
  ethan: friendBand(77.5, 80),
  priya: friendBand(74, 77),
  marcus: friendBand(69, 73),
  liam: friendBand(66, 72),
  olivia: friendBand(83, 86),
};

function buildPerson(person, now) {
  const judge = person.key === 'julian' ? julianStory : BANDS[person.key];
  const passenger = person.key === 'julian' ? passengerTrip(now) : null;
  let best = null;
  let lastWhy = 'no draw';
  for (let draw = 0; draw < DRAWS; draw += 1) {
    const p = { ...person, seed: person.seed + draw * 1_000_003 };
    const drives = buildHistory(p, now, { passenger });
    const r = report(drives, now);
    const verdict = judge(r);
    if (verdict.must.length > 0) {
      lastWhy = verdict.must.join('; ');
      continue;
    }
    if (best === null || verdict.penalty < best.penalty) best = { person, drives, report: r, draw, penalty: verdict.penalty };
    if (person.key !== 'julian' || best.penalty <= GOOD_ENOUGH) break;
  }
  if (best === null) throw new Error(`${person.key}: no draw in ${DRAWS} tells the story (last: ${lastWhy})`);
  return best;
}

function buildAll(now, only = null) {
  const people = [JULIAN, ...FRIENDS, ...PENDING].filter((p) => only === null || only.includes(p.key));
  return people.map((p) => buildPerson(p, now));
}

const julianFailures = (r) => julianStory(r).must;

module.exports = { buildAll, buildPerson, julianStory, julianFailures, passengerTrip };
