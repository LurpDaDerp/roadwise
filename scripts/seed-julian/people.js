'use strict';
/**
 * The demo drivers: who they are, when and where they drive, and how their driving changes over the
 * 89 days. Julian is the main demo account; the others are his friends and the two pending requests.
 *
 * A plan is the list of trips a person takes (a day, a local time, a route and a direction); how
 * well they drive each one is decided in generate.js from the person's `skill`.
 */
const { localDay, isWeekend } = require('./calendar.js');
const { library } = require('./sim.js');

const DAYS = 89;

const jit = (rnd, center, spread) => Math.round(center + (rnd() - 0.5) * 2 * spread);
const chance = (rnd, p) => rnd() < p;
const pickWeighted = (rnd, list) => {
  const total = list.reduce((s, x) => s + x.w, 0);
  let r = rnd() * total;
  for (const x of list) {
    r -= x.w;
    if (r <= 0) return x;
  }
  return list[list.length - 1];
};

/** About how long a route takes, minutes, for spacing a day's trips. */
function estMinutes(route) {
  const base = route.replace(/~\d+$/, '');
  const miles = library[route]?.miles ?? library[base]?.miles ?? 4;
  return Math.round((miles / 24) * 60 + 4);
}

// ---------------------------------------------------------------------------------------------
// Julian

const SCHOOL_START = '2026-09-02';
const NO_SCHOOL = new Set(['2026-09-07', '2026-11-11', '2026-11-26', '2026-11-27', '2027-01-01']);

function inSchool(day) {
  if (isWeekend(day) || day.iso < SCHOOL_START || NO_SCHOOL.has(day.iso)) return false;
  if (day.m === 12 && day.d >= 21) return false;
  if (day.m === 1 && day.d <= 2) return false;
  if ((day.m === 6 && day.d >= 19) || day.m === 7 || day.m === 8) return false;
  return true;
}

const NEAR = [
  { route: 'greenlake', w: 3 },
  { route: 'gasworks', w: 3 },
  { route: 'target', w: 3 },
  { route: 'goldengardens', w: 2 },
  { route: 'friendA', w: 3 },
  { route: 'friendB', w: 2 },
];
const MEDIUM = [
  { route: 'bellevue', w: 3 },
  { route: 'alki', w: 3 },
  { route: 'redmond', w: 2 },
];
const LONG = [
  { route: 'issaquah', w: 2 },
  { route: 'seatac', w: 1 },
  { route: 'everett', w: 1 },
];

/** An outing's out and back legs: the route ids that exist for it, and which way to drive each. */
function legs(dest, rnd) {
  const out = `home_${dest}`;
  const back = `${dest}_home`;
  if (library[back]) return [{ route: out, reverse: false }, { route: back, reverse: false }];
  return [{ route: out, reverse: false }, { route: out, reverse: true }];
}

function planJulian(now, rnd) {
  const trips = [];
  const weekends = [];
  for (let back = DAYS; back >= 0; back -= 1) {
    const day = localDay(now, back);
    if (isWeekend(day)) weekends.push(day);
  }
  // the long drives of the history, on fixed weekends counted back from the latest (0): two of them
  // calm, so a merit 5 shows up, the latest of them on the most recent Sunday
  const specials = new Map([
    [0, { dest: 'snoqualmie', calm: true }],
    [1, { dest: 'bellevue' }],
    [3, { dest: 'alki', calm: true }],
    [4, { dest: 'tacoma' }],
    [6, { dest: 'seatac' }],
    [8, { dest: 'everett' }],
    [10, { dest: 'issaquah' }],
    [13, { dest: 'tacoma', calm: true }],
    [15, { dest: 'snoqualmie' }],
    [17, { dest: 'redmond' }],
    [19, { dest: 'alki' }],
    [21, { dest: 'bellevue' }],
  ]);
  // a week of drives that are all clean, two weeks back (Monday to Wednesday), for the Perfect Week badge
  const mondayBack = (localDay(now, 0).dow + 6) % 7;
  const perfect = new Set([mondayBack + 14, mondayBack + 13, mondayBack + 12]);

  for (let back = DAYS; back >= 0; back -= 1) {
    const day = localDay(now, back);
    const weekend = isWeekend(day);
    const school = inSchool(day);
    const add = (minutes, route, reverse, extra = {}) => trips.push({ day, minutes, route, reverse, weekend, ...extra });
    const addOuting = (dest, leave, stay, extra = {}) => {
      const [a, b] = legs(dest, rnd);
      add(leave, a.route, a.reverse, extra);
      add(leave + estMinutes(a.route) + stay, b.route, b.reverse, extra);
    };
    const alt = (route) => (library[`${route}~1`] && chance(rnd, 0.22) ? `${route}~1` : route);

    if (!weekend && school) {
      if (chance(rnd, 0.96)) {
        add(jit(rnd, 7 * 60 + 22, 12), alt('home_school'), false);
        const jobDay = day.dow === 2 || day.dow === 4 || day.dow === 5;
        const r = rnd();
        if (jobDay && r < 0.4) {
          add(jit(rnd, 15 * 60 + 22, 8), 'school_job', false);
          add(jit(rnd, 19 * 60 + 40, 45), 'job_home', false);
        } else if (r < 0.8) {
          add(jit(rnd, 15 * 60 + 8, 16), alt('school_home'), false);
        } else {
          add(jit(rnd, 17 * 60 + 25, 35), alt('school_home'), false);
        }
      }
      if (day.dow === 5 && chance(rnd, 0.6)) {
        addOuting('friendA', jit(rnd, 18 * 60 + 50, 40), jit(rnd, 150, 40));
      } else if (chance(rnd, 0.1)) {
        addOuting('target', jit(rnd, 17 * 60 + 50, 50), jit(rnd, 40, 15));
      }
    } else if (!weekend) {
      // summer weekday
      let shifted = false;
      if (chance(rnd, 0.72)) {
        shifted = true;
        if (chance(rnd, 0.7)) {
          add(jit(rnd, 9 * 60 + 32, 10), 'home_job', false);
          add(jit(rnd, 15 * 60 + 40, 25), 'job_home', false);
        } else {
          add(jit(rnd, 16 * 60 + 10, 15), 'home_job', false);
          add(jit(rnd, 21 * 60 + 5, 12), 'job_home', false);
        }
      }
      if (chance(rnd, shifted ? 0.28 : 0.55)) {
        const dest = pickWeighted(rnd, NEAR.concat(MEDIUM.slice(0, 2))).route;
        addOuting(dest, shifted ? jit(rnd, 17 * 60 + 50, 30) : jit(rnd, 13 * 60 + 30, 90), jit(rnd, 100, 45));
      }
    } else {
      const wi = weekends.length - 1 - weekends.findIndex((w) => w.iso === day.iso);
      const special = specials.get(wi);
      const satShift = !special && day.dow === 6 && chance(rnd, 0.5);
      if (satShift) {
        add(jit(rnd, 9 * 60 + 35, 10), 'home_job', false);
        add(jit(rnd, 16 * 60 + 5, 20), 'job_home', false);
      }
      if (special) {
        const [a, b] = legs(special.dest, rnd);
        const leave = jit(rnd, 9 * 60 + 40, 40);
        add(leave, a.route, a.reverse, { forceCalm: special.calm });
        add(leave + estMinutes(a.route) + jit(rnd, 220, 50), b.route, b.reverse, { forceCalm: special.calm });
      } else if (!satShift && chance(rnd, 0.7)) {
        const r = rnd();
        const dest = pickWeighted(rnd, r < 0.62 ? NEAR : r < 0.92 ? MEDIUM : LONG).route;
        addOuting(dest, jit(rnd, 11 * 60 + 20, 110), jit(rnd, 130, 60));
      }
      if (day.dow === 6 && chance(rnd, 0.4)) addOuting('friendB', jit(rnd, 18 * 60 + 45, 40), jit(rnd, 190, 40));
      if (day.dow === 0 && chance(rnd, 0.3)) addOuting('target', jit(rnd, 16 * 60 + 30, 60), jit(rnd, 35, 12));
    }
  }
  for (const t of trips) if (perfect.has(t.day.back)) t.forceCalm = true;
  // two rushed drives lately (late for school, a Friday night out) so the history holds a merit 1
  const rushed = [
    trips.filter((t) => t.route.startsWith('home_school') && !t.reverse && t.day.back >= 8 && t.day.back <= 14 && !t.forceCalm).pop(),
    trips.filter((t) => t.route === 'friendA_home' || (t.route === 'home_friendA' && t.reverse)).filter((t) => t.day.back >= 9 && t.day.back <= 17 && !t.forceCalm).pop(),
  ];
  for (const t of rushed) if (t) t.rough = true;
  return dropOverlaps(trips);
}

/** Within a day each trip starts at least 25 minutes after the one before is expected to end. */
function dropOverlaps(trips) {
  const byDay = new Map();
  for (const t of trips) {
    if (!byDay.has(t.day.back)) byDay.set(t.day.back, []);
    byDay.get(t.day.back).push(t);
  }
  const kept = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => a.minutes - b.minutes);
    let freeAt = -Infinity;
    for (const t of list) {
      if (t.minutes < freeAt + 25) continue;
      kept.push(t);
      freeAt = t.minutes + estMinutes(t.route);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// The friends: a routine of their own each

/**
 * cfg: { startBack (first day they drive), commute: { route, days (dow list), p, am: [center, spread],
 * pm: [center, spread] } | null, outings: [{ route, w }], outingP: [weekdayP, weekendP], stay: [mean, spread] }
 */
function planRoutine(cfg) {
  return (now, rnd) => {
    const trips = [];
    for (let back = Math.min(DAYS, cfg.startBack); back >= 0; back -= 1) {
      const day = localDay(now, back);
      const weekend = isWeekend(day);
      const add = (minutes, route, reverse) => trips.push({ day, minutes, route, reverse, weekend });
      if (cfg.commute && cfg.commute.days.includes(day.dow) && chance(rnd, cfg.commute.p)) {
        add(jit(rnd, cfg.commute.am[0], cfg.commute.am[1]), cfg.commute.route, false);
        add(jit(rnd, cfg.commute.pm[0], cfg.commute.pm[1]), cfg.commute.route, true);
      }
      if (chance(rnd, weekend ? cfg.outingP[1] : cfg.outingP[0])) {
        const dest = pickWeighted(rnd, cfg.outings).route;
        const leave = weekend ? jit(rnd, 11 * 60 + 30, 120) : jit(rnd, 18 * 60 + 10, 50);
        add(leave, dest, false);
        add(leave + estMinutes(dest) + jit(rnd, cfg.stay[0], cfg.stay[1]), dest, true);
      }
    }
    return dropOverlaps(trips);
  };
}

// ---------------------------------------------------------------------------------------------
// People

const K = (speed, braking, acceleration, turning, phone) => ({ speed, braking, acceleration, turning, phone });

const JULIAN = {
  key: 'julian',
  username: 'julian',
  email: 'julian.demo@roadwise.app',
  state: 'WA',
  seed: 20261022,
  plan: planJulian,
  tempo: [0.9, 0.99],
  skill: {
    start: K(5.0, 3.5, 2.5, 2.0, 6.5),
    end: K(0.55, 0.15, 0.06, 0.05, 0.85),
    curve: 2.0,
    // speeding fades more slowly than the rest: it is the habit that takes longest to break
    curves: { speed: 1.5 },
    calm: [0.05, 0.55],
    wobble: 0.22,
  },
  plant: ['hard_brake', 'phone_pickup'],
  dashcam: { fromBack: 88, eyes: [0.09, 0.026], drowsyBacks: [64, 43, 24, 9] },
  schoolZone: { lat: 47.677, lng: -122.3157 },
  origin: 0.85,
  // moving the car a few metres: too short to score
  shorts: [
    { back: 33, minutes: 18 * 60 + 10 },
    { back: 12, minutes: 12 * 60 + 15 },
  ],
  // places Julian keeps doing the same thing: speeding down N 45th on the way to school, a firm brake
  // at the corner by Roosevelt on the way home, and (since cleared) hard starts out of the school lot
  spots: [
    { id: 'speed45th', active: true, kind: 'speeding', route: 'home_school', reverse: false, atM: 760, over: 6.5, durationS: 17, hit: (back) => (back <= 75 ? (back > 35 ? 0.65 : back > 14 ? 0.35 : 0.25) : 0) },
    { id: 'brakeRoosevelt', active: true, kind: 'hard_brake', route: 'school_home', reverse: false, atM: 1895, hit: (back) => (back <= 60 ? (back > 25 ? 0.45 : 0.25) : 0) },
    { id: 'cornerUvillage', active: true, kind: 'hard_corner', route: 'home_job', reverse: false, atM: 2870, hit: (back) => (back <= 55 ? (back > 20 ? 0.4 : 0.25) : 0) },
    { id: 'launchSchool', kind: 'hard_accel', route: 'school_home', reverse: false, atM: 640, hit: (back) => (back <= 62 && back > 22 ? 0.4 : 0) },
  ],
  share: { rating: true, categories: true, achievements: true, stats: true, heatmap: 'friends' },
};

const friend = (o) => ({
  state: 'WA',
  tempo: [0.9, 0.99],
  origin: 0.8,
  spots: [],
  dashcam: null,
  schoolZone: null,
  share: { rating: true, categories: true, achievements: true, stats: true, heatmap: 'friends' },
  ...o,
});

const FRIENDS = [
  friend({
    key: 'maya',
    username: 'maya_chen',
    email: 'maya.demo@roadwise.app',
    seed: 11101,
    friendDaysAgo: 84,
    plan: planRoutine({
      startBack: 89,
      commute: { route: 'maya_uw', days: [1, 2, 3, 4], p: 0.8, am: [8 * 60 + 5, 20], pm: [16 * 60 + 40, 50] },
      outings: [{ route: 'maya_goldengardens', w: 2 }, { route: 'maya_downtown', w: 2 }, { route: 'maya_target', w: 2 }],
      outingP: [0.12, 0.5],
      stay: [120, 50],
    }),
    skill: { start: K(0.95, 1.1, 0.9, 0.8, 1.0), end: K(0.4, 0.5, 0.35, 0.3, 0.55), curve: 1.2, calm: [0.35, 0.7], wobble: 0.2 },
  }),
  friend({
    key: 'sofia',
    username: 'sofia_r',
    email: 'sofia.demo@roadwise.app',
    seed: 11102,
    friendDaysAgo: 71,
    plan: planRoutine({
      startBack: 89,
      commute: null,
      outings: [{ route: 'sofia_target', w: 3 }, { route: 'sofia_lynnwood', w: 3 }, { route: 'sofia_greenlake', w: 2 }, { route: 'sofia_everett', w: 1 }],
      outingP: [0.4, 0.75],
      stay: [90, 40],
    }),
    skill: { start: K(1.5, 1.3, 1.2, 1.0, 1.7), end: K(0.75, 0.8, 0.55, 0.5, 0.95), curve: 1.4, calm: [0.25, 0.55], wobble: 0.25 },
  }),
  friend({
    key: 'ethan',
    username: 'ethan_park',
    email: 'ethan.demo@roadwise.app',
    seed: 11103,
    friendDaysAgo: 52,
    plan: planRoutine({
      startBack: 89,
      commute: { route: 'ethan_msft', days: [1, 2, 3, 4, 5], p: 0.78, am: [8 * 60 + 15, 25], pm: [17 * 60 + 5, 40] },
      outings: [{ route: 'ethan_bellevue', w: 3 }, { route: 'ethan_seattleCenter', w: 2 }, { route: 'ethan_woodinville', w: 2 }],
      outingP: [0.1, 0.55],
      stay: [110, 50],
    }),
    skill: { start: K(3.2, 2.8, 2.4, 2.0, 3.4), end: K(1.7, 1.7, 1.3, 1.1, 2.0), curve: 1.3, calm: [0.2, 0.45], wobble: 0.25 },
  }),
  friend({
    key: 'priya',
    username: 'priya_s',
    email: 'priya.demo@roadwise.app',
    seed: 11104,
    friendDaysAgo: 33,
    plan: planRoutine({
      startBack: 89,
      commute: null,
      outings: [{ route: 'priya_uw', w: 3 }, { route: 'priya_downtown', w: 2 }, { route: 'priya_alki', w: 1 }, { route: 'priya_seattleCenter', w: 2 }],
      outingP: [0.2, 0.5],
      stay: [100, 40],
    }),
    skill: { start: K(3.4, 3.8, 3.0, 2.6, 3.8), end: K(2.1, 2.5, 1.8, 1.6, 2.6), curve: 1.2, calm: [0.12, 0.35], wobble: 0.3 },
    share: { rating: true, categories: true, achievements: true, stats: false, heatmap: 'only_me' },
  }),
  friend({
    key: 'marcus',
    username: 'marcus_j',
    email: 'marcus.demo@roadwise.app',
    seed: 11105,
    friendDaysAgo: 15,
    plan: planRoutine({
      startBack: 89,
      commute: { route: 'marcus_bellevueWork', days: [1, 2, 3, 4, 5], p: 0.75, am: [7 * 60 + 40, 25], pm: [17 * 60 + 20, 45] },
      outings: [{ route: 'marcus_southcenter', w: 3 }, { route: 'marcus_seatac', w: 2 }, { route: 'marcus_tacoma', w: 1 }],
      outingP: [0.12, 0.5],
      stay: [100, 40],
    }),
    skill: { start: K(5.5, 4.6, 4.0, 3.2, 5.0), end: K(4.6, 4.0, 3.2, 2.6, 4.2), curve: 1.0, calm: [0.06, 0.18], wobble: 0.3 },
    // shares only the Safety Rating: the profile a friend sees when the driver keeps the rest private
    share: { rating: true, categories: false, achievements: false, stats: false, heatmap: 'only_me' },
  }),
];

/** Two more drivers: one has asked Julian to be friends, and Julian has asked the other. */
const PENDING = [
  friend({
    key: 'liam',
    username: 'liam_n',
    email: 'liam.demo@roadwise.app',
    seed: 11106,
    plan: planRoutine({
      startBack: 26,
      commute: { route: 'liam_school', days: [1, 2, 3, 4, 5], p: 0.55, am: [7 * 60 + 30, 12], pm: [15 * 60 + 15, 20] },
      outings: [{ route: 'liam_gasworks', w: 1 }],
      outingP: [0.05, 0.3],
      stay: [60, 20],
    }),
    skill: { start: K(4.6, 4.6, 3.8, 3.4, 4.8), end: K(4.0, 4.0, 3.2, 2.8, 4.0), curve: 1.0, calm: [0.06, 0.16], wobble: 0.3 },
    direction: 'incoming',
  }),
  friend({
    key: 'olivia',
    username: 'olivia_t',
    email: 'olivia.demo@roadwise.app',
    seed: 11107,
    plan: planRoutine({
      startBack: 89,
      commute: { route: 'olivia_woodinville', days: [1, 2, 3, 4, 5], p: 0.6, am: [8 * 60, 25], pm: [17 * 60, 40] },
      outings: [{ route: 'olivia_bellevue', w: 3 }, { route: 'olivia_redmond', w: 1 }],
      outingP: [0.08, 0.5],
      stay: [100, 40],
    }),
    skill: { start: K(1.8, 1.7, 1.5, 1.3, 2.0), end: K(1.1, 1.2, 0.9, 0.8, 1.3), curve: 1.2, calm: [0.2, 0.45], wobble: 0.25 },
    direction: 'outgoing',
  }),
];

module.exports = { JULIAN, FRIENDS, PENDING, DAYS, jit, chance, estMinutes };
