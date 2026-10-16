/** @jest-environment node */
// The forgot-to-start reminder's policy against its decision table (src/reminder/vectors.ts), then
// the properties no row can show alone:
// - ground truth: simulated days of driving, parks, red lights and drives the driver starts and
//   ends, delivered the way each platform delivers them (Android: transition batches with delays,
//   tier changes and their replays; iOS: significant-location wakes, motion histories and GPS
//   looks). The true sessions are derived from the timeline alone with the user's rule (a session
//   ends 30 min after its last driving moment; a drive counts as driving), and the policy may post at
//   most once in each, never while a drive is open, and only after driving speed with no drive open
//   since the last drive;
// - invariants over random operation streams (a token claimed once, handed over once, a claim only
//   inside a live session, no session ending while a drive is open, every note timeout ahead).
import {
  CALM_CTX,
  captureEnded,
  captureStarted,
  claim,
  clampTimes,
  foldCaptureTransitions,
  foldMotion,
  gate,
  INITIAL,
  lookEnded,
  newLook,
  newSession,
  onFix,
  onStop,
  onTransitions,
  onWake,
  posted,
  REMINDER,
  setEnabled,
  settle,
  statusOf,
  summarizeActivities,
  tapDelivered,
  tier,
  type Activity,
  type FixVerdict,
  type GatePhase,
  type LookTracker,
  type ReminderState,
  type Transition,
  type TransitionKind,
} from '../src/reminder/policy';
import { matchReminderRow, runReminderRow } from '../src/reminder/selfTest';
import { REMINDER_VECTORS, T0 } from '../src/reminder/vectors';

const S = 1_000;
const M = 60_000;
const H = 3_600_000;
const GAP = REMINDER.SESSION_GAP_MS;

/** mulberry32: a small seeded generator, so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => Math.round(lo + r() * (hi - lo));

describe('the decision table', () => {
  test('has a row for every kind and unique names', () => {
    const kinds = new Set(REMINDER_VECTORS.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(['claim', 'expires', 'fixes', 'gate', 'ops', 'stop', 'stored', 'summary', 'tap', 'transitions', 'wake']);
    const names = REMINDER_VECTORS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(REMINDER_VECTORS.length).toBeGreaterThanOrEqual(120);
  });

  test.each(REMINDER_VECTORS.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(matchReminderRow(v, runReminderRow(v))).toEqual([]);
  });

  test('every gate reason is reached by some gate row, in every phase it belongs to', () => {
    const reached = (phase: GatePhase) => new Set(REMINDER_VECTORS.flatMap((v) => (v.kind === 'gate' && v.phase === phase ? [v.expected] : [])));
    expect([...reached('stop')].sort()).toEqual(['capturing', 'no-session', 'not-driven', 'off', 'ok', 'on-foot', 'permission', 'reminded', 'stale'].sort());
    expect([...reached('wake')].sort()).toEqual(['capturing', 'off', 'ok', 'permission']);
    expect([...reached('look')].sort()).toEqual(['no-session', 'not-fresh', 'ok', 'reminded', 'resting']);
  });

  test('no row holds a value JSON cannot carry', () => {
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    for (const v of REMINDER_VECTORS) walk(v, v.name);
    expect(bad).toEqual([]);
  });
});

describe('the rules no limit remains for', () => {
  const driven = (over: Partial<ReminderState> = {}) => ({ ...setEnabled(INITIAL, true), session: { ...newSession(T0 - H, T0 - 30 * S, false), drove: true }, ...over });

  test('only the session rule decides: a reminder may come right after a drive, on a call, with RoadWise open, 20 s into a trip, any number a day', () => {
    // nothing in the state or the context can say any of those things any more
    expect(Object.keys(CALM_CTX).sort()).toEqual(['automotiveAgeMs', 'capturing', 'eventAgeMs', 'onFoot', 'permissionsOk']);
    expect(Object.keys(INITIAL).sort()).toEqual(['enabled', 'lastDriveEndAt', 'lookRestUntil', 'postedAt', 'session', 'tapAt', 'tapSeen', 'token', 'v']);
    expect(gate(driven({ lastDriveEndAt: T0 - S }), CALM_CTX, T0, 'stop')).toBe('ok');
    // five sessions in a row, each reminded once
    let s = setEnabled(INITIAL, true);
    let posts = 0;
    for (let i = 0; i < 5; i += 1) {
      const t = T0 + i * 2 * H;
      const r = onTransitions(s, [{ kind: 'vehicle-enter', ts: t }, { kind: 'vehicle-exit', ts: t + 10 * M }, { kind: 'still-enter', ts: t + 10 * M + 5 * S }], t + 10 * M + 10 * S, 0, CALM_CTX, `tok-${i}`);
      if (r.effect === 'post') posts += 1;
      s = r.state;
    }
    expect(posts).toBe(5);
  });

  test('the constants: no back-off, no daily cap, no spacing, no TTL', () => {
    expect(Object.keys(REMINDER).sort()).toEqual(
      [
        'AUTOMOTIVE_FRESH_MS',
        'CLOCK_FUTURE_MS',
        'IN_VEHICLE_NOTE_MS',
        'IOS_DRIVING_MPS',
        'IOS_LOOK_MAX_MS',
        'IOS_LOOK_NO_DRIVE_MS',
        'IOS_LOOK_REST_MS',
        'IOS_MOTION_LOOKBACK_MS',
        'SESSION_GAP_MS',
        'SPEED_ACC_MAX_MPS',
        'STALE_EVENT_MS',
        'STILL_AFTER_VEHICLE_MS',
        'STOP_HOLD_MS',
        'STOP_MPS',
        'TAP_FRESH_MS',
        'TAP_SEEN_MAX',
      ].sort()
    );
    expect(REMINDER.SESSION_GAP_MS).toBe(30 * M);
  });

  test('the tier follows the capture, the switch and the session', () => {
    const on = setEnabled(INITIAL, true);
    expect(tier(on, false, false)).toBe('none');
    expect(tier(INITIAL, true, true)).toBe('capture');
    expect(tier(INITIAL, false, true)).toBe('none');
    expect(tier(on, false, true)).toBe('idle');
    expect(tier({ ...on, session: newSession(T0, T0, true) }, false, true)).toBe('session');
  });

  test('status: unavailable, off, needs, on; nothing else', () => {
    const on = setEnabled(INITIAL, true);
    expect(statusOf(on, false, []).state).toBe('unavailable');
    expect(statusOf(INITIAL, true, ['motion'])).toEqual({ enabled: false, state: 'off', missing: [] });
    expect(statusOf(on, true, ['notifications', 'motion'])).toEqual({ enabled: true, state: 'needs', missing: ['notifications', 'motion'] });
    expect(statusOf(on, true, [])).toEqual({ enabled: true, state: 'on', missing: [] });
  });

  test('a handed-over token list keeps the last 8', () => {
    let s = setEnabled(INITIAL, true);
    for (let i = 0; i < 12; i += 1) s = tapDelivered(s, `tok-${i}`, T0).state;
    expect(s.tapSeen).toEqual(['tok-4', 'tok-5', 'tok-6', 'tok-7', 'tok-8', 'tok-9', 'tok-10', 'tok-11']);
    expect(tapDelivered(s, 'tok-11', T0).delivered).toBe(false);
  });

  test('nothing mutates its input', () => {
    const s = { ...setEnabled(INITIAL, true), session: newSession(T0 - H, T0 - 40 * M, false), token: 'tok-a' };
    const frozen = JSON.stringify(s);
    posted(s, T0, 'tok-b');
    captureStarted(s, T0);
    captureEnded(s, T0, T0 - M);
    settle(s, T0, false);
    claim(s, 'tok-a', T0, false, false);
    tapDelivered(s, 'tok-a', T0);
    onTransitions(s, [{ kind: 'vehicle-enter', ts: T0 }], T0, 0, CALM_CTX, 'tok-c');
    foldCaptureTransitions(s, [{ kind: 'vehicle-exit', ts: T0 }], 0);
    onWake(s, T0, { lastAutomotiveAt: T0, automotiveSince: T0 - M, onFootNow: false }, CALM_CTX);
    onStop(s, CALM_CTX, T0, false, 'tok-d', T0);
    lookEnded(s, T0, T0, 'look-max');
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

// ——— ground truth ———

/** Driving intervals merged into the user's sessions: a gap of 30 min or more starts a new one. */
function trueSessions(driving: readonly [number, number][]): [number, number][] {
  const sorted = [...driving].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a - last[1] < GAP) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const sessionOf = (sessions: readonly [number, number][], t: number) => sessions.findIndex(([a, b]) => t >= a && t < b + GAP);

interface Trip {
  /** Moving from start to end (red lights inside it on iOS). */
  start: number;
  end: number;
  lights: [number, number][];
  /** After the trip: still in the car this long, then on foot this long, then still. */
  sitMs: number;
  walkMs: number;
}
interface Drive {
  start: number;
  end: number;
}

/** A few days of trips and parks, and the drives the driver starts and ends somewhere in them. */
function timeline(r: () => number): { trips: Trip[]; drives: Drive[] } {
  const trips: Trip[] = [];
  let t = T0;
  const n = between(r, 6, 14);
  for (let i = 0; i < n; i += 1) {
    const dur = between(r, 3 * M, 70 * M);
    const lights: [number, number][] = [];
    for (let l = t + between(r, M, 4 * M); l < t + dur - 2 * M; l += between(r, 2 * M, 8 * M)) lights.push([l, l + between(r, 30 * S, 2 * M)]);
    const trip: Trip = { start: t, end: t + dur, lights, sitMs: r() < 0.3 ? between(r, 10 * S, 3 * M) : between(r, 0, 20 * S), walkMs: r() < 0.6 ? between(r, 30 * S, 4 * M) : 0 };
    trips.push(trip);
    // parks from a minute to three hours, a good share of them near the 30 min line
    const park = r() < 0.4 ? between(r, 25 * M, 35 * M) : between(r, M, 3 * H);
    t = trip.end + Math.max(park, trip.sitMs + trip.walkMs + M);
  }
  const drives: Drive[] = [];
  let free = T0;
  for (const trip of trips) {
    if (r() > 0.4 || trip.start < free) continue;
    const start = between(r, trip.start, trip.end - M);
    const next = trips[trips.indexOf(trip) + 1];
    const latest = next ? Math.min(next.start - M, trip.end + 20 * M) : trip.end + 20 * M;
    const end = r() < 0.5 ? between(r, start + M, Math.max(start + M, trip.end - 10 * S)) : between(r, trip.end, latest);
    drives.push({ start, end });
    free = end + M;
  }
  return { trips, drives };
}

describe('Android: a drive ended while the car drives on (no new IN_VEHICLE ENTER comes)', () => {
  const ON = setEnabled(INITIAL, true);
  const ev = (kind: TransitionKind, ts: number): Transition => ({ kind, ts });
  /** The park 10 min after the end: EXIT, then STILL 20 s later, delivered 10 s after that. */
  const park = (s: ReminderState, end: number) =>
    onTransitions(s, [ev('vehicle-exit', end + 10 * M), ev('still-enter', end + 10 * M + 20 * S)], end + 10 * M + 30 * S, end, CALM_CTX, 'tok-park');

  test('a session from before the drive: the park after the end reminds once', () => {
    let s = onTransitions(ON, [ev('vehicle-enter', T0)], T0 + 5 * S, T0 - H, CALM_CTX, 'tok-x').state;
    s = captureStarted(settle(s, T0 + M, false), T0 + M);
    const end = T0 + 20 * M;
    s = captureEnded(settle(s, end, true), end, end, true, true);
    const r = park(s, end);
    expect(r).toMatchObject({ effect: 'post', reason: 'ok' });
    expect(r.state.session).toMatchObject({ reminded: true });
    // the next stop in that session brings none
    const again = onTransitions(r.state, [ev('vehicle-enter', end + 15 * M), ev('vehicle-exit', end + 20 * M), ev('still-enter', end + 20 * M + 10 * S)], end + 20 * M + 20 * S, end, CALM_CTX, 'tok-y');
    expect(again).toMatchObject({ effect: 'refresh', reason: 'reminded' });
  });

  test('a drive started before any session (Start tapped in the driveway): the end opens one, and the park reminds', () => {
    let s = captureStarted(ON, T0);
    expect(s.session).toBeNull();
    const end = T0 + 20 * M;
    s = captureEnded(settle(s, end, true), end, end, true, true);
    expect(park(s, end)).toMatchObject({ effect: 'post', reason: 'ok' });
  });

  test('a drive ended parked (not driving at the end) brings none at the next stop until driving is seen again', () => {
    let s = onTransitions(ON, [ev('vehicle-enter', T0)], T0 + 5 * S, T0 - H, CALM_CTX, 'tok-x').state;
    s = captureStarted(settle(s, T0 + M, false), T0 + M);
    const end = T0 + 20 * M;
    s = captureEnded(settle(s, end, true), end, end - 3 * M, false, true);
    expect(park(s, end)).toMatchObject({ effect: 'none', reason: 'not-driven' });
  });
});

describe('ground truth (Android): at most one reminder a true session, never during a drive, only after driving speed', () => {
  type Act = 'vehicle' | 'still' | 'walking';
  const enterOf: Record<Act, TransitionKind> = { vehicle: 'vehicle-enter', still: 'still-enter', walking: 'walking-enter' };

  function simulate(seed: number) {
    const r = rng(seed);
    const { trips, drives } = timeline(r);
    // The phone's own activity changes.
    const changes: { ts: number; act: Act }[] = [];
    for (const trip of trips) {
      changes.push({ ts: trip.start, act: 'vehicle' });
      const exit = trip.end + trip.sitMs;
      changes.push({ ts: exit, act: trip.walkMs > 0 && r() < 0.5 ? 'walking' : 'still' });
      const first = changes[changes.length - 1]!.act;
      if (trip.walkMs > 0) changes.push({ ts: exit + trip.walkMs, act: first === 'walking' ? 'still' : 'walking' });
    }
    changes.sort((a, b) => a.ts - b.ts);
    type Ev = { at: number; kind: 'change'; ts: number; act: Act } | { at: number; kind: 'start' | 'end'; drive: Drive };
    const evs: Ev[] = [
      ...changes.map((c): Ev => ({ at: c.ts, kind: 'change', ts: c.ts, act: c.act })),
      ...drives.flatMap((d): Ev[] => [
        { at: d.start, kind: 'start', drive: d },
        { at: d.end, kind: 'end', drive: d },
      ]),
    ].sort((a, b) => a.at - b.at);

    let s = setEnabled(INITIAL, true);
    let act: Act = 'still';
    let actSince = T0 - H;
    let capturing = false;
    let sub = { tier: tier(s, false, true), at: T0 - 2 * H };
    let pending: Transition[] = [];
    const posts: { at: number; lastDriveEndAt: number }[] = [];
    let tokens = 0;
    const wanted = (k: TransitionKind): boolean =>
      sub.tier === 'session' ? true : sub.tier === 'idle' ? k === 'vehicle-enter' : sub.tier === 'capture' ? k !== 'still-enter' : false;
    const deliver = (at: number) => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      if (capturing) {
        s = foldCaptureTransitions(s, batch, sub.at);
      } else {
        const res = onTransitions(s, batch, at, sub.at, CALM_CTX, `tok-${(tokens += 1)}`);
        if (res.effect === 'post') posts.push({ at, lastDriveEndAt: res.state.lastDriveEndAt });
        if (res.state.token !== '') expect(res.expiresAt).toBeGreaterThan(at);
        s = res.state;
      }
      resync(at);
    };
    // A changed tier is a new request: stamped, and Play services replays the current activity.
    const resync = (at: number) => {
      const want = tier(s, capturing, true);
      if (want === sub.tier) return;
      sub = { tier: want, at };
      pending.push({ kind: enterOf[act], ts: Math.min(actSince, at - 1) });
      deliver(at);
    };
    for (const e of evs) {
      if (e.kind === 'change') {
        const k = enterOf[e.act];
        if (act === 'vehicle' && wanted('vehicle-exit')) pending.push({ kind: 'vehicle-exit', ts: e.ts });
        if (wanted(k)) pending.push({ kind: k, ts: e.ts });
        act = e.act;
        actSince = e.ts;
        // Play services delivers what it has, 0-5 min late, before anything later happens.
        deliver(e.ts + between(r, 0, Math.min(5 * M, (evs[evs.indexOf(e) + 1]?.at ?? e.ts + 5 * M) - e.ts)));
      } else if (e.kind === 'start') {
        deliver(e.at);
        s = captureStarted(settle(s, e.at, false), e.at);
        expect(s.token).toBe('');
        capturing = true;
        resync(e.at);
      } else {
        deliver(e.at);
        s = captureEnded(settle(s, e.at, true), e.at);
        capturing = false;
        resync(e.at);
      }
      if (capturing) expect(settle(s, e.at + 10 * H, true).session).toEqual(s.session);
    }
    return { trips, drives, posts };
  }

  test.each(Array.from({ length: 500 }, (_, i) => i + 1))('seed %i', (seed) => {
    const { trips, drives, posts } = simulate(seed);
    const driving: [number, number][] = [...trips.map((t): [number, number] => [t.start, t.end + t.sitMs]), ...drives.map((d): [number, number] => [d.start, d.end])];
    const sessions = trueSessions(driving);
    const per = new Map<number, number>();
    for (const p of posts) {
      expect(drives.some((d) => p.at >= d.start && p.at < d.end)).toBe(false);
      const i = sessionOf(sessions, p.at);
      expect(i).toBeGreaterThanOrEqual(0);
      per.set(i, (per.get(i) ?? 0) + 1);
      // driving speed (a trip starting) after the last drive ended, inside this true session
      const [a] = sessions[i]!;
      expect(trips.some((t) => t.start > p.lastDriveEndAt && t.start >= a && t.start <= p.at)).toBe(true);
    }
    for (const [, n] of per) expect(n).toBe(1);
  });

  test('the simulation does post (it is not vacuous)', () => {
    let total = 0;
    for (let seed = 1; seed <= 50; seed += 1) total += simulate(seed).posts.length;
    expect(total).toBeGreaterThan(50);
  });
});

describe('ground truth (iOS): at most one reminder a true session, never during a drive, inVehicle never set', () => {
  function simulate(seed: number) {
    const r = rng(seed);
    const { trips, drives } = timeline(r);
    const moving = (t: number) => trips.some((tr) => t >= tr.start && t < tr.end && !tr.lights.some(([a, b]) => t >= a && t < b));
    const walking = (a: number, b: number) =>
      trips.some((tr) => tr.walkMs > 0 && tr.end + tr.sitMs < b && tr.end + tr.sitMs + tr.walkMs > a);
    // CoreMotion's records: moving car, a car standing still at lights and while sitting parked, a walk, then still.
    const acts: Activity[] = [];
    for (const tr of trips) {
      let t = tr.start;
      for (const [a, b] of tr.lights) {
        acts.push({ start: t, automotive: true, stationary: false, onFoot: false, confident: true });
        acts.push({ start: a, automotive: true, stationary: true, onFoot: false, confident: r() < 0.8 });
        t = b;
      }
      acts.push({ start: t, automotive: true, stationary: false, onFoot: false, confident: true });
      acts.push({ start: tr.end, automotive: true, stationary: true, onFoot: false, confident: true });
      if (tr.walkMs > 0) acts.push({ start: tr.end + tr.sitMs, automotive: false, stationary: false, onFoot: true, confident: true });
      acts.push({ start: tr.end + tr.sitMs + tr.walkMs, automotive: false, stationary: true, onFoot: false, confident: true });
    }
    const history = (now: number) => summarizeActivities(acts.filter((a) => a.start >= now - REMINDER.IOS_MOTION_LOOKBACK_MS && a.start <= now), now);

    // significant-location wakes: every 1-8 min while moving, a few while parked
    const wakes: number[] = [];
    for (const tr of trips) {
      for (let w = tr.start + between(r, 20 * S, 4 * M); w < tr.end; w += between(r, M, 8 * M)) wakes.push(w);
      if (r() < 0.5) wakes.push(tr.end + between(r, 0, 40 * M));
    }
    wakes.sort((a, b) => a - b);
    const starts = drives.map((d) => d.start);

    type Ev = { at: number; kind: 'wake' | 'start' | 'end' };
    const evs: Ev[] = [
      ...wakes.map((at): Ev => ({ at, kind: 'wake' })),
      ...drives.flatMap((d): Ev[] => [
        { at: d.start, kind: 'start' },
        { at: d.end, kind: 'end' },
      ]),
    ].sort((x, y) => x.at - y.at);
    let s = setEnabled(INITIAL, true);
    const posts: number[] = [];
    let capturing = false;
    let lookUntil = 0;
    let n = 0;
    for (const e of evs) {
      // iOS reads the motion history at a drive's start and end too, as at every wake: a session
      // whose last wake came well before the car parked is not ended on a stale clock.
      if (e.kind === 'start') {
        s = captureStarted(foldMotion(clampTimes(s, e.at), e.at, history(e.at), false), e.at);
        capturing = true;
      } else if (e.kind === 'end') {
        s = captureEnded(foldMotion(clampTimes(s, e.at), e.at, history(e.at), true), e.at);
        capturing = false;
      } else if (e.at >= lookUntil) {
        const res = onWake(s, e.at, history(e.at), { ...CALM_CTX, capturing });
        s = res.state;
        if (res.effect === 'start-look') {
          expect(capturing).toBe(false);
          // the look: 1 Hz fixes until it ends, or until a drive starts
          let tr: LookTracker = newLook(e.at);
          const cut = starts.find((x) => x > e.at) ?? Infinity;
          let t = e.at;
          let verdict: FixVerdict = 'none';
          for (; t < cut; t += S) {
            const out = onFix(tr, { t, speed: moving(t) ? 13 : 0.2, speedAcc: 1 }, t);
            tr = out.tracker;
            verdict = out.verdict;
            if (verdict !== 'none') break;
          }
          if (verdict === 'stopped') {
            const stop = onStop(s, CALM_CTX, t, walking(tr.stopStart, t), `tok-${(n += 1)}`, tr.lastFastAt);
            if (stop.effect === 'post') posts.push(t);
            s = stop.state;
          }
          s = lookEnded(s, t, tr.lastFastAt, t >= cut ? 'ended' : verdict);
          lookUntil = t;
        }
      }
      expect(s.session?.inVehicle ?? false).toBe(false);
    }
    return { trips, drives, posts };
  }

  test.each(Array.from({ length: 500 }, (_, i) => i + 1))('seed %i', (seed) => {
    const { trips, drives, posts } = simulate(seed);
    const driving: [number, number][] = [
      ...trips.map((t): [number, number] => [t.start, t.end]),
      ...drives.map((d): [number, number] => [d.start, d.end]),
    ];
    const sessions = trueSessions(driving);
    const per = new Map<number, number>();
    for (const p of posts) {
      expect(drives.some((d) => p >= d.start && p < d.end)).toBe(false);
      const i = sessionOf(sessions, p);
      expect(i).toBeGreaterThanOrEqual(0);
      per.set(i, (per.get(i) ?? 0) + 1);
    }
    for (const [, k] of per) expect(k).toBe(1);
  });

  test('the simulation does post, at red lights too (it is not vacuous)', () => {
    let total = 0;
    for (let seed = 1; seed <= 50; seed += 1) total += simulate(seed).posts.length;
    expect(total).toBeGreaterThan(30);
  });
});

describe('invariants over random operation streams', () => {
  test.each(Array.from({ length: 200 }, (_, i) => i + 1))('seed %i', (seed) => {
    const r = rng(seed * 7919);
    let s = setEnabled(INITIAL, true);
    let now = T0;
    let capturing = false;
    const claimed = new Set<string>();
    const handed = new Map<string, number>();
    const pool = ['tok-a', 'tok-b', 'tok-c', 'tok-d'];
    for (let i = 0; i < 200; i += 1) {
      now += between(r, 0, 12 * M);
      const op = Math.floor(r() * 9);
      const tok = pool[Math.floor(r() * pool.length)]!;
      const before = s;
      if (op === 0) {
        const kinds: TransitionKind[] = ['vehicle-enter', 'vehicle-exit', 'still-enter', 'walking-enter', 'running-enter'];
        const events = Array.from({ length: between(r, 0, 4) }, (): Transition => ({ kind: kinds[Math.floor(r() * kinds.length)]!, ts: now - between(r, 0, 4 * M) }));
        if (capturing) s = foldCaptureTransitions(s, events, now - between(r, 0, 10 * M));
        else {
          const res = onTransitions(s, events, now, now - between(r, 0, 10 * M), CALM_CTX, tok);
          if (res.state.token !== '') expect(res.expiresAt).toBeGreaterThan(now);
          const prev = settle(before, now, false).session;
          if (res.effect === 'post') expect(prev !== null && prev.reminded && res.state.session?.startedAt === prev.startedAt).toBe(false);
          s = res.state;
        }
      } else if (op === 1 && !capturing) {
        s = captureStarted(settle(s, now, false), now);
        capturing = true;
        expect(s.token).toBe('');
      } else if (op === 2 && capturing) {
        const ends: (number | null | undefined)[] = [undefined, null, now - between(r, 0, 20 * M)];
        s = captureEnded(settle(s, now, true), now, ends[Math.floor(r() * 3)]);
        capturing = false;
      } else if (op === 3) {
        const res = tapDelivered(s, tok, now);
        if (res.delivered) handed.set(tok, (handed.get(tok) ?? 0) + 1);
        s = res.state;
      } else if (op === 4 || op === 5) {
        const requireDelivery = op === 4;
        const res = claim(s, tok, now, capturing, requireDelivery);
        if (res.ok) {
          expect(claimed.has(`${tok}@${before.postedAt}`)).toBe(false);
          claimed.add(`${tok}@${before.postedAt}`);
          // the session was alive by the time rule, and (Android) the tap fresh
          const x = settle(before, now, capturing).session!;
          expect(x.inVehicle || now - x.lastDrivingAt < GAP).toBe(true);
          if (requireDelivery) expect(now - before.tapAt).toBeLessThanOrEqual(REMINDER.TAP_FRESH_MS);
          expect(res.state.token).toBe('');
        }
        s = res.state;
      } else if (op === 6) {
        s = settle(s, now, capturing);
      } else if (op === 7 && !capturing) {
        const res = onWake(s, now, { lastAutomotiveAt: now - between(r, 0, 40 * M), automotiveSince: now - between(r, 0, 90 * M), onFootNow: r() < 0.2 }, CALM_CTX);
        s = res.state;
      } else if (op === 8) {
        const res = onStop(s, { ...CALM_CTX, capturing }, now, r() < 0.2, `${tok}-${i}`, now - between(r, 0, 2 * M));
        if (res.effect === 'post') expect(capturing).toBe(false);
        s = res.state;
      }
      if (capturing) expect(settle(s, now + 5 * H, true).session === null).toBe(s.session === null);
      expect(clampTimes(s, now)).toEqual(s);
    }
    // with 4 tokens in the pool (fewer than the 8 remembered), none is handed over twice
    for (const [, k] of handed) expect(k).toBe(1);
  });

  test('foldMotion never ends a session while a drive is open', () => {
    const s = { ...setEnabled(INITIAL, true), session: newSession(T0 - 3 * H, T0 - 2 * H, false) };
    expect(foldMotion(s, T0, { lastAutomotiveAt: T0, automotiveSince: T0 - 10 * M, onFootNow: false }, true).session).not.toBeNull();
    expect(foldMotion(s, T0, { lastAutomotiveAt: T0, automotiveSince: T0 - 10 * M, onFootNow: false }, false).session?.startedAt).toBeUndefined();
  });
});
