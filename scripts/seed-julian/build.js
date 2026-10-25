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
  const rest = ['acceleration', 'braking', 'turning', 'phone', 'attention'].map((k) => a[k]);
  if (!r.ranked || scored.some((v) => v === null)) must.push('not ranked, or a category has no score');
  else {
    // Speed is the one bad category (about 30); every other one sits between 75 and 100, not all alike
    if (a.speed < 24 || a.speed > 36) must.push(`speed ${a.speed}`);
    if (Math.min(...rest) < 75) must.push(`a category is under 75: ${rest}`);
    if (Math.max(...rest) - Math.min(...rest) < 6) must.push(`the other categories are too alike: ${rest}`);
  }
  if (!Object.values(r.achievements).every(Boolean)) must.push('an achievement is missing');
  const active = r.spots.filter((s) => s.state === 'active');
  const kinds = new Set(active.map((s) => s.kind));
  if (active.length < 3 || !kinds.has('speeding')) must.push(`spots ${active.map((x) => x.kind)}`);
  if (!r.spots.some((s) => s.state === 'cleared' && s.clearedDaysAgo <= 30)) must.push('no spot cleared lately');
  if (r.drives < 170 || r.clean / r.scored < 0.1) must.push(`drives ${r.drives}, clean ${r.clean}`);
  if (r.recentMerits.length < 4 || !r.merits[5]) must.push(`merit tiers ${r.recentMerits}, all ${JSON.stringify(r.merits)}`);
  const h = r.home;
  // (the speeding and clean tiles read red: Home marks over 4 speeding events per 100 mi red, and a driver who speeds like this shows it)
  if (h.window !== '7d' || h.harsh.color === 'red') must.push(`home colours ${h.speeding.color}/${h.harsh.color}/${h.clean.color}`);
  const mean = (list) => list.reduce((s, w) => s + w.score, 0) / Math.max(1, list.length);
  const gap = mean(r.trend.filter((w) => w.weeksAgo <= 2)) - mean(r.trend.filter((w) => w.weeksAgo >= 9));
  if (gap < 4) must.push(`score trend ${gap.toFixed(1)}`);
  const gain = r.rating - r.rating7;
  if (!(gain > 0)) must.push(`7-day trend ${gain.toFixed(1)}`);

  // closer to the story is better: speed near 30, the rest spread between about 78 and 94, a rating that rose lately
  let penalty = 0;
  penalty += outside(a.speed ?? 0, 28, 33) * 2;
  penalty += outside(gain, 0.5, 2.5) * 2;
  penalty += outside(a.braking ?? 0, 78, 86) + outside(a.phone ?? 0, 80, 90) + outside(a.attention ?? 0, 88, 95) + outside(a.acceleration ?? 0, 86, 95) + outside(a.turning ?? 0, 84, 94);
  // a week with some goals still under way reads better than one with everything done or nothing started
  const doneGoals = Object.values(r.goals).filter((g) => Number(g.split('/')[0]) >= Number(g.split('/')[1])).length;
  penalty += r.thisWeekDrives >= 4 && doneGoals > 2 ? 3 : 0;
  // (something to report in the last week needs a drive of last week still within 7 days: not possible on a Sunday)
  penalty += (r.disputable.hazard ? 0 : 3) + (r.disputable.mounted ? 0 : 3);
  penalty += kinds.has('hard_brake') ? 0 : 3;
  penalty += active.length > 5 ? 3 : 0;
  penalty += outside(gap, 7, 40);
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
