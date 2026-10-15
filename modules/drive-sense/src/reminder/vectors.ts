// The forgot-to-start reminder's decision table: every rule in `policy.ts` as an input and the
// answer it must give. `__tests__/reminderPolicy.test.ts` runs each row against the reference; the
// Kotlin and Swift mirrors follow the same rules under the same names (README "Forgot-to-start
// reminder").
import {
  CALM_CTX,
  INITIAL,
  newTracker,
  newTrip,
  REMINDER as R,
  setEnabled,
  type Activity,
  type Fix,
  type FixVerdict,
  type GatePhase,
  type GateReason,
  type MotionSummary,
  type Outcome,
  type ReminderCtx,
  type ReminderState,
  type ReminderTrip,
  type SessionTracker,
  type Transition,
  type WatchEnd,
} from './policy';

/** A fixed afternoon, so every row reads in plain offsets from it. */
export const T0 = 1_760_000_000_000;
const S = 1_000;
const M = 60_000;
const H = 3_600_000;
const D = R.DAY_MS;

/** The fields a row checks; `trip` is matched field by field, or null for no trip. */
export type StateMatch = Omit<Partial<ReminderState>, 'trip'> & { trip?: Partial<ReminderTrip> | null };

type Op =
  | { op: 'settle'; now: number }
  | { op: 'posted'; now: number }
  | { op: 'resolve'; outcome: Outcome; now: number }
  | { op: 'captureStarted'; now: number }
  | { op: 'captureEnded'; now: number }
  | { op: 'appForeground' }
  | { op: 'setEnabled'; on: boolean }
  | { op: 'sessionEnded'; now: number };

export type ReminderVector =
  | { name: string; kind: 'gate'; state: ReminderState; ctx: ReminderCtx; now: number; phase: GatePhase; expected: GateReason }
  | { name: string; kind: 'ops'; state: ReminderState; ops: Op[]; expected: StateMatch }
  | {
      name: string;
      kind: 'transitions';
      state: ReminderState;
      events: Transition[];
      arrival: number;
      subscribedAt: number;
      ctx: ReminderCtx;
      expected: { effect: 'none' | 'post' | 'withdraw'; reason?: GateReason; state?: StateMatch };
    }
  | {
      name: string;
      kind: 'wake';
      state: ReminderState;
      now: number;
      motion: MotionSummary;
      ctx: ReminderCtx;
      expected: { effect: 'none' | 'start-session'; reason: GateReason; trip?: Partial<ReminderTrip> | null };
    }
  | { name: string; kind: 'summary'; activities: Activity[]; now: number; expected: MotionSummary }
  | { name: string; kind: 'fixes'; tracker: SessionTracker; fixes: { fix: Fix; now: number }[]; expected: FixVerdict[] }
  | {
      name: string;
      kind: 'stop';
      state: ReminderState;
      ctx: ReminderCtx;
      now: number;
      walked: boolean;
      expected: { effect: 'post' | 'arrival' | 'seek' | 'end'; reason: GateReason };
    }
  | {
      name: string;
      kind: 'watchEnd';
      state: ReminderState;
      how: WatchEnd;
      now: number;
      expected: { effect: 'seek' | 'end'; state: StateMatch };
    };

// ——— builders ———

const ON = setEnabled(INITIAL, true);
const trip = (over: Partial<ReminderTrip> = {}): ReminderTrip => ({ ...newTrip(T0 - 10 * M), ...over });
const on = (over: Partial<ReminderState> = {}, t: Partial<ReminderTrip> | null = {}): ReminderState => ({
  ...ON,
  trip: t === null ? null : trip(t),
  ...over,
});
const ctx = (over: Partial<ReminderCtx> = {}): ReminderCtx => ({ ...CALM_CTX, ...over });
const ev = (kind: Transition['kind'], ts: number): Transition => ({ kind, ts });
const fix = (t: number, speed: number, lat = 37, lng = -122, speedAcc = 1, hAcc = 5): { fix: Fix; now: number } => ({
  fix: { t, speed, speedAcc, hAcc, lat, lng },
  now: t,
});
/** The trip's car stretch ended at T0 − 30 s with an IN_VEHICLE EXIT (Android). */
const exited = (over: Partial<ReminderTrip> = {}): Partial<ReminderTrip> => ({ inVehicle: false, vehicleExitAt: T0 - 30 * S, lastVehicleAt: T0 - 30 * S, ...over });
const motion = (lastAutomotiveAt: number, automotiveSince = lastAutomotiveAt - 5 * M, onFootNow = false): MotionSummary => ({
  lastAutomotiveAt,
  automotiveSince,
  onFootNow,
});
const seeking = (over: Partial<SessionTracker> = {}): SessionTracker => ({ ...newTracker(T0), ...over });

export const REMINDER_VECTORS: ReminderVector[] = [
  // ——— the gate, each reason in order ———
  { name: 'gate: off', kind: 'gate', state: INITIAL, ctx: ctx(), now: T0, phase: 'stop', expected: 'off' },
  { name: 'gate: paused beats quiet', kind: 'gate', state: on({ pausedUntil: T0 + D, quietUntil: T0 + H }), ctx: ctx(), now: T0, phase: 'stop', expected: 'paused' },
  { name: 'gate: quiet after an unused post', kind: 'gate', state: on({ quietUntil: T0 + H }), ctx: ctx(), now: T0, phase: 'stop', expected: 'quiet' },
  { name: 'gate: Not driving quiet', kind: 'gate', state: on({ notDrivingUntil: T0 + H }), ctx: ctx(), now: T0, phase: 'stop', expected: 'quiet' },
  { name: 'gate: permission', kind: 'gate', state: on(), ctx: ctx({ permissionsOk: false }), now: T0, phase: 'stop', expected: 'permission' },
  { name: 'gate: a drive is open', kind: 'gate', state: on(), ctx: ctx({ capturing: true }), now: T0, phase: 'stop', expected: 'capturing' },
  { name: 'gate: no trip', kind: 'gate', state: on({}, null), ctx: ctx(), now: T0, phase: 'stop', expected: 'no-trip' },
  { name: 'gate: a drive was open in this trip', kind: 'gate', state: on({}, { recorded: true }), ctx: ctx(), now: T0, phase: 'stop', expected: 'recorded' },
  { name: 'gate: once a trip', kind: 'gate', state: on({}, { reminded: true }), ctx: ctx(), now: T0, phase: 'stop', expected: 'reminded' },
  { name: 'gate: 9 min after a drive', kind: 'gate', state: on({ lastCaptureEndAt: T0 - 9 * M }), ctx: ctx(), now: T0, phase: 'stop', expected: 'after-drive' },
  { name: 'gate: 10 min after a drive is fine', kind: 'gate', state: on({ lastCaptureEndAt: T0 - 10 * M }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: 2 posts in 24 h (an unseen one counts)', kind: 'gate', state: on({ posts: [T0 - 20 * H, T0 - 5 * H] }), ctx: ctx(), now: T0, phase: 'stop', expected: 'daily-cap' },
  { name: 'gate: a post 24 h ago no longer counts', kind: 'gate', state: on({ posts: [T0 - D, T0 - 5 * H] }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: a second post 59 min after the last is blocked', kind: 'gate', state: on({ posts: [T0 - 59 * M] }), ctx: ctx(), now: T0, phase: 'stop', expected: 'spacing' },
  { name: 'gate: a second post 60 min after the last is allowed', kind: 'gate', state: on({ posts: [T0 - 60 * M] }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: the daily cap comes before the hour', kind: 'gate', state: on({ posts: [T0 - 5 * H, T0 - 30 * M] }), ctx: ctx(), now: T0, phase: 'stop', expected: 'daily-cap' },
  { name: 'gate: wake within the hour of a post does no motion or GPS work', kind: 'gate', state: on({ posts: [T0 - 30 * M] }, null), ctx: ctx(), now: T0, phase: 'wake', expected: 'spacing' },
  { name: 'gate: 89 s into the trip is too soon', kind: 'gate', state: on({}, { startedAt: T0 - 89 * S }), ctx: ctx(), now: T0, phase: 'stop', expected: 'too-soon' },
  { name: 'gate: 90 s into the trip', kind: 'gate', state: on({}, { startedAt: T0 - 90 * S }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: RoadWise is open', kind: 'gate', state: on(), ctx: ctx({ appForeground: true }), now: T0, phase: 'stop', expected: 'foreground' },
  { name: 'gate: on a call', kind: 'gate', state: on(), ctx: ctx({ inCall: true }), now: T0, phase: 'stop', expected: 'in-call' },
  { name: 'gate: a stop 46 s old is stale', kind: 'gate', state: on(), ctx: ctx({ eventAgeMs: 46 * S }), now: T0, phase: 'stop', expected: 'stale' },
  { name: 'gate: on foot after the stop', kind: 'gate', state: on(), ctx: ctx({ onFoot: true }), now: T0, phase: 'stop', expected: 'on-foot' },
  { name: 'gate: wake needs no trip', kind: 'gate', state: on({}, null), ctx: ctx(), now: T0, phase: 'wake', expected: 'ok' },
  { name: 'gate: wake in Low Power Mode', kind: 'gate', state: on({}, null), ctx: ctx({ lowPower: true }), now: T0, phase: 'wake', expected: 'low-power' },
  { name: 'gate: session, two used', kind: 'gate', state: on({}, { sessions: 2 }), ctx: ctx(), now: T0, phase: 'session', expected: 'sessions' },
  { name: 'gate: session, 9 min after the last', kind: 'gate', state: on({}, { sessions: 1, lastSessionEndAt: T0 - 9 * M }), ctx: ctx(), now: T0, phase: 'session', expected: 'sessions' },
  { name: 'gate: session, 10 min after the last', kind: 'gate', state: on({}, { sessions: 1, lastSessionEndAt: T0 - 10 * M }), ctx: ctx(), now: T0, phase: 'session', expected: 'ok' },
  { name: 'gate: session, car motion 121 s old', kind: 'gate', state: on(), ctx: ctx({ automotiveAgeMs: 121 * S }), now: T0, phase: 'session', expected: 'not-fresh' },

  // ——— Android: the activity-transition batch ———
  {
    name: 'android: [EXIT, STILL] in one batch posts',
    kind: 'transitions',
    state: on({}, { startedAt: T0 - 10 * M, lastVehicleAt: T0 - 2 * M }),
    events: [ev('vehicle-exit', T0 - 30 * S), ev('still-enter', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'post', reason: 'ok', state: { showing: true, pendingAt: T0, quietUntil: T0 + R.UNUSED_QUIET_MS, posts: [T0], trip: { reminded: true } } },
  },
  {
    name: 'android: a STILL after an EXIT from the batch before posts',
    kind: 'transitions',
    state: on({}, exited()),
    events: [ev('still-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'post', reason: 'ok' },
  },
  {
    name: 'android: [EXIT, STILL, WALKING] is an arrival, no post',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S), ev('walking-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'on-foot', state: { showing: false, trip: { inVehicle: false } } },
  },
  {
    name: 'android: [EXIT, STILL, IN_VEHICLE] drove on, no post',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S), ev('vehicle-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'on-foot', state: { showing: false, trip: { inVehicle: true } } },
  },
  {
    name: 'android: a STILL listed before its EXIT at the same time still counts (EXIT is read first)',
    kind: 'transitions',
    state: on(),
    events: [ev('still-enter', T0 - 20 * S), ev('vehicle-exit', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'post', reason: 'ok', state: { showing: true, trip: { inVehicle: false, reminded: true } } },
  },
  {
    name: 'android: a lone STILL (no EXIT within 2 min) does not count',
    kind: 'transitions',
    state: on({}, { inVehicle: false, vehicleExitAt: T0 - 3 * M, lastVehicleAt: T0 - 3 * M }),
    events: [ev('still-enter', T0 - 1 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none' },
  },
  {
    name: 'android: a STILL with no trip (phone on a desk) does not count',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('still-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', state: { trip: null } },
  },
  {
    name: 'android: a replay from before the subscription is dropped',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('vehicle-enter', T0 - 2 * M), ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: T0 - 20 * S,
    ctx: ctx(),
    expected: { effect: 'none', state: { trip: null } },
  },
  {
    name: 'android: right after a re-subscribe, a STILL whose EXIT came before it does not count',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: T0 - 20 * S,
    ctx: ctx(),
    expected: { effect: 'none', state: { trip: { inVehicle: true } } },
  },
  {
    name: 'android: a stop 46 s old on arrival is stale',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 60 * S), ev('still-enter', T0 - 46 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'stale' },
  },
  {
    name: 'android: a stop 45 s old still counts',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 60 * S), ev('still-enter', T0 - 45 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'post', reason: 'ok' },
  },
  {
    name: 'android: IN_VEHICLE ENTER while showing withdraws (pending stays)',
    kind: 'transitions',
    state: on({ showing: true, postedAt: T0 - M, pendingAt: T0 - M, posts: [T0 - M] }, exited({ reminded: true })),
    events: [ev('vehicle-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'withdraw', state: { showing: false, pendingAt: T0 - M, missStreak: 0, trip: { inVehicle: true, reminded: true } } },
  },
  {
    name: 'android: WALKING ENTER while showing withdraws; the post still waits for its outcome, quiet stays',
    kind: 'transitions',
    state: on({ showing: true, postedAt: T0 - M, pendingAt: T0 - M, quietUntil: T0 + 3 * H, posts: [T0 - M] }, exited({ reminded: true })),
    events: [ev('walking-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'withdraw', state: { showing: false, pendingAt: T0 - M, missStreak: 0, quietUntil: T0 + 3 * H } },
  },
  {
    name: 'android: walked off after a post and no drive in 30 min is a miss',
    kind: 'transitions',
    state: on({ showing: false, postedAt: T0 - 30 * M, pendingAt: T0 - 30 * M, quietUntil: T0 + 3 * H, posts: [T0 - 30 * M] }, exited({ reminded: true })),
    events: [],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', state: { pendingAt: 0, missStreak: 1 } },
  },
  {
    name: 'android: picking up the phone (no STILL EXIT is even read) leaves the reminder up',
    kind: 'transitions',
    state: on({ showing: true, postedAt: T0 - M, pendingAt: T0 - M, posts: [T0 - M] }, exited({ reminded: true })),
    events: [],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', state: { showing: true } },
  },
  {
    name: 'android: one walking misread then IN_VEHICLE within 10 min keeps the trip (and its reminder)',
    kind: 'transitions',
    state: on({}, { startedAt: T0 - 30 * M, lastVehicleAt: T0 - 9 * M, inVehicle: false, reminded: true }),
    events: [ev('vehicle-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', state: { trip: { startedAt: T0 - 30 * M, reminded: true, inVehicle: true } } },
  },
  {
    name: 'android: WALKING ENTER in the car ends the car time but not the trip',
    kind: 'transitions',
    state: on({}, { startedAt: T0 - 30 * M, lastVehicleAt: T0 - 20 * M }),
    events: [ev('walking-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', state: { trip: { startedAt: T0 - 30 * M, inVehicle: false, lastVehicleAt: T0 - 10 * S } } },
  },
  {
    name: 'android: out of the car 10 min closes the trip; the next IN_VEHICLE opens a new one',
    kind: 'transitions',
    state: on({}, { startedAt: T0 - 40 * M, lastVehicleAt: T0 - 10 * M, inVehicle: false, reminded: true }),
    events: [ev('vehicle-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', state: { trip: { startedAt: T0 - 5 * S, reminded: false, inVehicle: true } } },
  },
  {
    name: 'android: a stop 60 s into the trip is too soon',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('vehicle-enter', T0 - 70 * S), ev('vehicle-exit', T0 - 20 * S), ev('still-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'too-soon' },
  },
  {
    name: 'android: a stop while RoadWise is open does not post',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 30 * S), ev('still-enter', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx({ appForeground: true }),
    expected: { effect: 'none', reason: 'foreground' },
  },
  {
    name: 'android: a stop during a call does not post, and the trip stays eligible',
    kind: 'transitions',
    state: on(),
    events: [ev('vehicle-exit', T0 - 30 * S), ev('still-enter', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx({ inCall: true }),
    expected: { effect: 'none', reason: 'in-call', state: { trip: { reminded: false } } },
  },
  {
    name: 'android: a second stop in a reminded trip does not post',
    kind: 'transitions',
    state: on({ posts: [T0 - 20 * M] }, { reminded: true }),
    events: [ev('vehicle-exit', T0 - 30 * S), ev('still-enter', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'reminded' },
  },
  {
    name: 'android: a reminder that led to a drive, then a new trip whose stop is 59 min after it, does not post',
    kind: 'transitions',
    state: on({ posts: [T0 - 59 * M], postedAt: T0 - 59 * M, lastCaptureEndAt: T0 - 15 * M }, exited({ startedAt: T0 - 12 * M })),
    events: [ev('vehicle-exit', T0 - 30 * S), ev('still-enter', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'spacing', state: { posts: [T0 - 59 * M], trip: { reminded: false } } },
  },
  {
    name: 'android: a reminder that led to a drive, then a new trip whose stop is 60 min after it, posts',
    kind: 'transitions',
    state: on({ posts: [T0 - 60 * M], postedAt: T0 - 60 * M, lastCaptureEndAt: T0 - 15 * M }, exited({ startedAt: T0 - 12 * M })),
    events: [ev('vehicle-exit', T0 - 30 * S), ev('still-enter', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: T0 - H,
    ctx: ctx(),
    expected: { effect: 'post', reason: 'ok', state: { posts: [T0 - 60 * M, T0] } },
  },

  // ——— iOS: the wake ———
  { name: 'summary: the newest car stretch ends where the next activity starts', kind: 'summary', activities: [
      { start: T0 - 20 * M, automotive: false, onFoot: true, confident: true },
      { start: T0 - 15 * M, automotive: true, onFoot: false, confident: true },
      { start: T0 - 8 * M, automotive: true, onFoot: false, confident: false },
      { start: T0 - 6 * M, automotive: true, onFoot: false, confident: true },
      { start: T0 - M, automotive: false, onFoot: false, confident: true },
    ], now: T0, expected: { lastAutomotiveAt: T0 - M, automotiveSince: T0 - 15 * M, onFootNow: false } },
  { name: 'summary: a walk breaks the car run; walking now', kind: 'summary', activities: [
      { start: T0 - 20 * M, automotive: true, onFoot: false, confident: true },
      { start: T0 - 10 * M, automotive: false, onFoot: true, confident: true },
      { start: T0 - 5 * M, automotive: true, onFoot: false, confident: true },
      { start: T0 - 30 * S, automotive: false, onFoot: true, confident: true },
    ], now: T0, expected: { lastAutomotiveAt: T0 - 30 * S, automotiveSince: 0, onFootNow: true } },
  { name: 'summary: nothing', kind: 'summary', activities: [], now: T0, expected: { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false } },
  { name: 'summary: 10 min with no car motion starts a new car run', kind: 'summary', activities: [
      { start: T0 - 70 * M, automotive: true, onFoot: false, confident: true },
      { start: T0 - 60 * M, automotive: false, onFoot: false, confident: true },
      { start: T0 - 4 * M, automotive: true, onFoot: false, confident: true },
    ], now: T0, expected: { lastAutomotiveAt: T0, automotiveSince: T0 - 4 * M, onFootNow: false } },
  { name: 'summary: 9 min with no car motion keeps the run', kind: 'summary', activities: [
      { start: T0 - 20 * M, automotive: true, onFoot: false, confident: true },
      { start: T0 - 13 * M, automotive: false, onFoot: false, confident: true },
      { start: T0 - 4 * M, automotive: true, onFoot: false, confident: true },
    ], now: T0, expected: { lastAutomotiveAt: T0, automotiveSince: T0 - 20 * M, onFootNow: false } },
  {
    name: 'ios wake: fresh car motion opens a trip from the start of the run and starts a session',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 10 * S, T0 - 6 * M),
    ctx: ctx(),
    expected: { effect: 'start-session', reason: 'ok', trip: { startedAt: T0 - 6 * M, sessions: 1, inVehicle: true } },
  },
  {
    name: 'ios wake: car motion 121 s old opens nothing',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 121 * S),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-trip', trip: null },
  },
  {
    name: 'ios wake: walking now opens nothing',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 10 * S, T0 - 6 * M, true),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-trip', trip: null },
  },
  {
    name: 'ios wake: a 15 min gap between wakes with car motion in the history keeps the trip',
    kind: 'wake',
    state: on({}, { startedAt: T0 - 40 * M, lastVehicleAt: T0 - 15 * M, reminded: true }),
    now: T0,
    motion: motion(T0 - 20 * S, T0 - 40 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'reminded', trip: { startedAt: T0 - 40 * M, lastVehicleAt: T0 - 20 * S } },
  },
  {
    name: 'ios wake: 10 min with no car motion closes the trip',
    kind: 'wake',
    state: on({}, { startedAt: T0 - 40 * M, lastVehicleAt: T0 - 15 * M, reminded: true }),
    now: T0,
    motion: motion(T0 - 10 * M, T0 - 40 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-trip', trip: null },
  },
  {
    name: 'ios wake: a new drive after a 1 h park is a new trip, even with no wake while parked',
    kind: 'wake',
    state: on({}, { startedAt: T0 - 90 * M, lastVehicleAt: T0 - 60 * M, sessions: 2, lastSessionEndAt: T0 - 62 * M }),
    now: T0,
    motion: motion(T0 - 10 * S, T0 - 4 * M),
    ctx: ctx(),
    expected: { effect: 'start-session', reason: 'ok', trip: { startedAt: T0 - 4 * M, lastVehicleAt: T0 - 10 * S, sessions: 1, reminded: false } },
  },
  {
    name: 'ios wake: a car run that began 9 min after the last car moment is the same trip',
    kind: 'wake',
    state: on({}, { startedAt: T0 - 40 * M, lastVehicleAt: T0 - 13 * M, sessions: 2, lastSessionEndAt: T0 - 15 * M }),
    now: T0,
    motion: motion(T0 - 10 * S, T0 - 4 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'sessions', trip: { startedAt: T0 - 40 * M, sessions: 2 } },
  },
  {
    name: 'ios wake: a second session 9 min after the first does not start',
    kind: 'wake',
    state: on({}, { sessions: 1, lastSessionEndAt: T0 - 9 * M, lastVehicleAt: T0 - 30 * S }),
    now: T0,
    motion: motion(T0 - 10 * S),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'sessions', trip: { sessions: 1 } },
  },
  {
    name: 'ios wake: Low Power Mode stops before any motion or GPS',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 10 * S),
    ctx: ctx({ lowPower: true }),
    expected: { effect: 'none', reason: 'low-power', trip: null },
  },
  {
    name: 'ios wake: a trip a drive was open in gets no session',
    kind: 'wake',
    state: on({}, { recorded: true, lastVehicleAt: T0 - M }),
    now: T0,
    motion: motion(T0 - 10 * S),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'recorded' },
  },

  // ——— iOS: the GPS session ———
  {
    name: 'ios fix: under 3 mph held 11.9 s is not a stop; 12 s is',
    kind: 'fixes',
    tracker: seeking(),
    fixes: [fix(T0 + 10 * S, 9), fix(T0 + 20 * S, 0.5), fix(T0 + 31_900, 0.4), fix(T0 + 32 * S, 0.3)],
    expected: ['none', 'none', 'none', 'stopped'],
  },
  {
    name: 'ios fix: no stop counts before 10 mph',
    kind: 'fixes',
    tracker: seeking(),
    fixes: [fix(T0 + 10 * S, 4), fix(T0 + 11 * S, 0), fix(T0 + 30 * S, 0)],
    expected: ['none', 'none', 'none'],
  },
  {
    name: 'ios fix: a fix with no usable speed neither makes nor breaks the hold; 3 mph breaks it',
    kind: 'fixes',
    tracker: seeking({ sawDriving: true }),
    fixes: [fix(T0, 0.5), fix(T0 + 6 * S, -1), fix(T0 + 8 * S, 9, 37, -122, 5), fix(T0 + 12 * S, 0.5), fix(T0 + 13 * S, 1.4), fix(T0 + 14 * S, 0.2), fix(T0 + 25_999, 0.2), fix(T0 + 26 * S, 0.2)],
    expected: ['none', 'none', 'none', 'stopped', 'none', 'none', 'none', 'stopped'],
  },
  {
    name: 'ios fix: 3 min without 10 mph ends the session',
    kind: 'fixes',
    tracker: seeking(),
    fixes: [fix(T0 + 179 * S, 4), fix(T0 + 180 * S, 4)],
    expected: ['none', 'no-drive'],
  },
  {
    name: 'ios fix: a session looks for 10 min at most',
    kind: 'fixes',
    tracker: seeking({ sawDriving: true }),
    fixes: [fix(T0 + 599 * S, 12), fix(T0 + 600 * S, 12)],
    expected: ['none', 'session-max'],
  },
  {
    name: 'ios watch: over 5 mph or 30 m from the stop ends it; 5 min takes it down',
    kind: 'fixes',
    tracker: { ...seeking({ sawDriving: true, stopStart: T0 - 20 * S, stopLat: 37, stopLng: -122 }), watching: true, postedAt: T0 },
    fixes: [fix(T0 + 5 * S, 2.2), fix(T0 + 6 * S, 2.3), fix(T0 + 7 * S, -1, 37.00025), fix(T0 + 8 * S, -1, 37.0003), fix(T0 + 300 * S, 0)],
    expected: ['none', 'driving', 'none', 'moved', 'ttl'],
  },
  {
    name: 'ios watch: a fix 40 m off but only accurate to 21 m is not moved; one accurate to 20 m is',
    kind: 'fixes',
    tracker: { ...seeking({ sawDriving: true, stopStart: T0 - 20 * S, stopLat: 37, stopLng: -122 }), watching: true, postedAt: T0 },
    fixes: [fix(T0 + 5 * S, -1, 37.00036, -122, 1, 21), fix(T0 + 6 * S, -1, 37.00036, -122, 1, -1), fix(T0 + 7 * S, -1, 37.00036, -122, 1, 20)],
    expected: ['none', 'none', 'moved'],
  },
  {
    name: 'ios stop: walking during the hold is an arrival, no post',
    kind: 'stop',
    state: on(),
    ctx: ctx(),
    now: T0,
    walked: true,
    expected: { effect: 'arrival', reason: 'on-foot' },
  },
  { name: 'ios stop: posts', kind: 'stop', state: on(), ctx: ctx(), now: T0, walked: false, expected: { effect: 'post', reason: 'ok' } },
  { name: 'ios stop: too soon waits for the next stop', kind: 'stop', state: on({}, { startedAt: T0 - M }), ctx: ctx(), now: T0, walked: false, expected: { effect: 'seek', reason: 'too-soon' } },
  { name: 'ios stop: a call waits for the next stop', kind: 'stop', state: on(), ctx: ctx({ inCall: true }), now: T0, walked: false, expected: { effect: 'seek', reason: 'in-call' } },
  { name: 'ios stop: RoadWise open ends the session', kind: 'stop', state: on(), ctx: ctx({ appForeground: true }), now: T0, walked: false, expected: { effect: 'end', reason: 'foreground' } },
  {
    name: 'ios watch end: driven on at 19 s is unseen: no miss, quiet lifted, one retry, but not within the hour (the session ends)',
    kind: 'watchEnd',
    state: on({ showing: true, postedAt: T0, pendingAt: T0, quietUntil: T0 + R.UNUSED_QUIET_MS, posts: [T0] }, { reminded: true }),
    how: 'driving',
    now: T0 + 19 * S,
    expected: { effect: 'end', state: { showing: false, pendingAt: 0, quietUntil: 0, missStreak: 0, posts: [T0], trip: { reminded: false, retries: 1 } } },
  },
  {
    name: 'ios stop: the retry after an unseen post is blocked within the hour',
    kind: 'stop',
    state: on({ posts: [T0 - 59 * M], postedAt: T0 - 59 * M }, { startedAt: T0 - 70 * M, retries: 1 }),
    ctx: ctx(),
    now: T0,
    walked: false,
    expected: { effect: 'end', reason: 'spacing' },
  },
  {
    name: 'ios stop: the retry after an unseen post posts an hour on',
    kind: 'stop',
    state: on({ posts: [T0 - 60 * M], postedAt: T0 - 60 * M }, { startedAt: T0 - 70 * M, retries: 1 }),
    ctx: ctx(),
    now: T0,
    walked: false,
    expected: { effect: 'post', reason: 'ok' },
  },
  {
    name: 'ios watch end: unseen again after the retry ends the session',
    kind: 'watchEnd',
    state: on({ showing: true, postedAt: T0, pendingAt: T0, posts: [T0] }, { reminded: true, retries: 1 }),
    how: 'driving',
    now: T0 + 10 * S,
    expected: { effect: 'end', state: { pendingAt: 0, trip: { reminded: true, retries: 1 } } },
  },
  {
    name: 'ios watch end: driven on at 21 s is no retry; the post waits for its outcome',
    kind: 'watchEnd',
    state: on({ showing: true, postedAt: T0, pendingAt: T0, quietUntil: T0 + R.UNUSED_QUIET_MS, posts: [T0] }, { reminded: true }),
    how: 'driving',
    now: T0 + 21 * S,
    expected: { effect: 'end', state: { showing: false, pendingAt: T0, quietUntil: T0 + R.UNUSED_QUIET_MS, trip: { reminded: true, retries: 0 } } },
  },
  {
    name: 'ios watch end: walked off ends the car time; the post still waits for its outcome',
    kind: 'watchEnd',
    state: on({ showing: true, postedAt: T0, pendingAt: T0, posts: [T0] }, { reminded: true }),
    how: 'arrival',
    now: T0 + M,
    expected: { effect: 'end', state: { showing: false, pendingAt: T0, missStreak: 0, trip: { inVehicle: false, lastVehicleAt: T0 + M } } },
  },

  // ——— outcomes, quiet, back-off ———
  {
    name: 'a post: once a trip, 4 h quiet',
    kind: 'ops',
    state: on(),
    ops: [{ op: 'posted', now: T0 }],
    expected: { showing: true, pendingAt: T0, postedAt: T0, posts: [T0], quietUntil: T0 + 4 * H, trip: { reminded: true } },
  },
  {
    name: 'a drive within 30 min of a post converts: streak, pause step and quiet clear',
    kind: 'ops',
    state: on({ missStreak: 2, pauseLevel: 1 }),
    ops: [{ op: 'posted', now: T0 }, { op: 'captureStarted', now: T0 + 30 * M }],
    expected: { missStreak: 0, pauseLevel: 0, quietUntil: 0, pendingAt: 0, showing: false, trip: { recorded: true } },
  },
  {
    name: 'a manual Start Drive with no reminder does not reset the streak, but marks the trip recorded',
    kind: 'ops',
    state: on({ missStreak: 2 }, null),
    ops: [{ op: 'captureStarted', now: T0 }],
    expected: { missStreak: 2, trip: { recorded: true, startedAt: T0 } },
  },
  {
    name: 'a post with no drive in 30 min is a miss',
    kind: 'ops',
    state: on(),
    ops: [{ op: 'posted', now: T0 }, { op: 'settle', now: T0 + 30 * M }],
    expected: { missStreak: 1, pendingAt: 0, showing: false },
  },
  {
    name: 'a reminder is taken down after 5 min',
    kind: 'ops',
    state: on(),
    ops: [{ op: 'posted', now: T0 }, { op: 'settle', now: T0 + 5 * M }],
    expected: { showing: false, pendingAt: T0, missStreak: 0 },
  },
  {
    name: 'the 4 h quiet ends',
    kind: 'ops',
    state: on({ quietUntil: T0 + 4 * H }),
    ops: [{ op: 'settle', now: T0 + 4 * H }],
    expected: { quietUntil: 0 },
  },
  {
    name: 'Not driving: withdrawn, a miss, 12 h quiet',
    kind: 'ops',
    state: on({ showing: true, pendingAt: T0, postedAt: T0, posts: [T0] }),
    ops: [{ op: 'resolve', outcome: 'notDriving', now: T0 + M }],
    expected: { showing: false, pendingAt: 0, missStreak: 1, notDrivingUntil: T0 + M + 12 * H },
  },
  {
    name: 'Not driving on a note already counted as a miss: the quiet, no second miss',
    kind: 'ops',
    state: on({ showing: false, pendingAt: T0, postedAt: T0, posts: [T0] }),
    ops: [{ op: 'settle', now: T0 + 2 * H }, { op: 'resolve', outcome: 'notDriving', now: T0 + 2 * H }],
    expected: { pendingAt: 0, missStreak: 1, notDrivingUntil: T0 + 14 * H },
  },
  {
    name: 'a stored pause level out of range reads as the nearest real one',
    kind: 'ops',
    state: on({ missStreak: 2, pauseLevel: -1 }),
    ops: [{ op: 'resolve', outcome: 'missed', now: T0 }],
    expected: { missStreak: 0, pauseLevel: 1, pausedUntil: T0 + 7 * D, enabled: true },
  },
  {
    name: '3 misses in a row pause it 7 days',
    kind: 'ops',
    state: on({ missStreak: 2 }),
    ops: [{ op: 'resolve', outcome: 'missed', now: T0 }],
    expected: { missStreak: 0, pauseLevel: 1, pausedUntil: T0 + 7 * D, enabled: true },
  },
  {
    name: '3 more pause it 28 days',
    kind: 'ops',
    state: on({ missStreak: 2, pauseLevel: 1 }),
    ops: [{ op: 'resolve', outcome: 'missed', now: T0 }],
    expected: { missStreak: 0, pauseLevel: 2, pausedUntil: T0 + 28 * D, enabled: true },
  },
  {
    name: '3 more turn it off',
    kind: 'ops',
    state: on({ missStreak: 2, pauseLevel: 2 }),
    ops: [{ op: 'resolve', outcome: 'missed', now: T0 }],
    expected: { missStreak: 0, enabled: false, autoOff: true, pausedUntil: 0 },
  },
  {
    name: 'a pause ends on its own at the next settle',
    kind: 'ops',
    state: on({ pausedUntil: T0 + 7 * D, pauseLevel: 1 }),
    ops: [{ op: 'settle', now: T0 + 7 * D }],
    expected: { pausedUntil: 0, pauseLevel: 1 },
  },
  {
    name: 'Resume now (turning it on) clears every back-off and quiet',
    kind: 'ops',
    state: { ...on({ missStreak: 1, pauseLevel: 2, pausedUntil: T0 + 20 * D, quietUntil: T0 + H, notDrivingUntil: T0 + H }), enabled: false, autoOff: true },
    ops: [{ op: 'setEnabled', on: true }],
    expected: { enabled: true, autoOff: false, missStreak: 0, pauseLevel: 0, pausedUntil: 0, quietUntil: 0, notDrivingUntil: 0 },
  },
  {
    name: 'turning it off forgets everything',
    kind: 'ops',
    state: on({ missStreak: 2, posts: [T0], showing: true }),
    ops: [{ op: 'setEnabled', on: false }],
    expected: { ...INITIAL },
  },
  {
    name: 'a drive ended: car time ends, 10 min after-drive clock starts',
    kind: 'ops',
    state: on({}, { recorded: true }),
    ops: [{ op: 'captureEnded', now: T0 }],
    expected: { lastCaptureEndAt: T0, trip: { inVehicle: false, lastVehicleAt: T0, recorded: true } },
  },
  {
    name: 'RoadWise opened: the reminder goes, the post still waits for its outcome',
    kind: 'ops',
    state: on({ showing: true, pendingAt: T0, postedAt: T0 }),
    ops: [{ op: 'appForeground' }],
    expected: { showing: false, pendingAt: T0 },
  },
  {
    name: '"in vehicle" with no news for 3 h closes the trip',
    kind: 'ops',
    state: on({}, { lastVehicleAt: T0 - 3 * H }),
    ops: [{ op: 'settle', now: T0 }],
    expected: { trip: null },
  },
  {
    name: 'a session ended starts the spacing clock',
    kind: 'ops',
    state: on({}, { sessions: 1 }),
    ops: [{ op: 'sessionEnded', now: T0 }],
    expected: { trip: { sessions: 1, lastSessionEndAt: T0 } },
  },
  {
    name: 'a clock change: times more than a day ahead become now; untils are capped at their length',
    kind: 'ops',
    state: on({ lastCaptureEndAt: T0 + 2 * D, pausedUntil: T0 + 60 * D, quietUntil: T0 + 30 * H, notDrivingUntil: T0 + 30 * H }, { lastVehicleAt: T0 + 2 * D, startedAt: T0 + 2 * D }),
    ops: [{ op: 'settle', now: T0 }],
    expected: { lastCaptureEndAt: T0, pausedUntil: T0 + 28 * D, quietUntil: T0 + 4 * H, notDrivingUntil: T0 + 12 * H, trip: { lastVehicleAt: T0, startedAt: T0 } },
  },
];
