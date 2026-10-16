// The forgot-to-start reminder's decision table: every rule in `policy.ts` as an input and the
// answer it must give. `__tests__/reminderPolicy.test.ts` runs each row against the reference, and
// the on-device self-test runs each row its platform has through the Kotlin or Swift mirror
// (`selfTest.ts`). No row holds Infinity: a row crosses the bridge as JSON.
import {
  CALM_CTX,
  INITIAL,
  newLook,
  newSession,
  REMINDER as R,
  setEnabled,
  type Activity,
  type Fix,
  type FixVerdict,
  type GatePhase,
  type GateReason,
  type LookEnd,
  type LookTracker,
  type MotionSummary,
  type ReminderCtx,
  type ReminderSession,
  type ReminderState,
  type Transition,
  type TransitionEffect,
} from './policy';

/** A fixed afternoon, so every row reads in plain offsets from it. */
export const T0 = 1_760_000_000_000;
const S = 1_000;
const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

/** The fields a row checks; `session` is matched field by field, or null for no session. */
export type StateMatch = Omit<Partial<ReminderState>, 'session'> & { session?: Partial<ReminderSession> | null };

export type ReminderOp =
  | { op: 'settle'; now: number; capturing: boolean }
  | { op: 'posted'; now: number; token: string }
  | { op: 'unposted'; token: string }
  | { op: 'noteGone' }
  | { op: 'captureStarted'; now: number }
  /** `drivingEndedAt` left out = now; null = a drive that was not kept. */
  | { op: 'captureEnded'; now: number; drivingEndedAt?: number | null }
  /** Android only: a capture batch folded as state. */
  | { op: 'captureTransitions'; events: Transition[]; subscribedAt: number }
  | { op: 'setEnabled'; on: boolean }
  /** iOS only: a GPS look ended. */
  | { op: 'lookEnded'; now: number; lastFastAt: number; verdict: LookEnd };

export type ReminderVector =
  | { name: string; kind: 'gate'; state: ReminderState; ctx: ReminderCtx; now: number; phase: GatePhase; expected: GateReason }
  | { name: string; kind: 'ops'; state: ReminderState; ops: ReminderOp[]; expected: StateMatch }
  /** Android: taps read from intents, in order. */
  | { name: string; kind: 'tap'; state: ReminderState; taps: { token: string; now: number }[]; expected: { delivered: boolean[]; state: StateMatch } }
  /** `requireDelivery` true runs on Android, false on iOS; `motion` (iOS) is folded in first, as the iOS claim does. */
  | {
      name: string;
      kind: 'claim';
      state: ReminderState;
      token: string;
      now: number;
      capturing: boolean;
      requireDelivery: boolean;
      motion: MotionSummary | null;
      expected: { ok: boolean; state?: StateMatch };
    }
  | {
      name: string;
      kind: 'transitions';
      state: ReminderState;
      events: Transition[];
      arrival: number;
      subscribedAt: number;
      ctx: ReminderCtx;
      newToken: string;
      expected: { effect: TransitionEffect; reason?: GateReason; expiresAt?: number; state?: StateMatch };
    }
  /** Android: when the note's system timeout must fall. */
  | { name: string; kind: 'expires'; state: ReminderState; now: number; expected: number }
  | {
      name: string;
      kind: 'wake';
      state: ReminderState;
      now: number;
      motion: MotionSummary;
      ctx: ReminderCtx;
      expected: { effect: 'none' | 'start-look'; reason: GateReason; dropped?: boolean; state?: StateMatch };
    }
  | { name: string; kind: 'summary'; activities: Activity[]; now: number; expected: MotionSummary }
  | { name: string; kind: 'fixes'; tracker: LookTracker; fixes: { fix: Fix; now: number }[]; expected: { verdicts: FixVerdict[]; lastFastAt?: number } }
  | {
      name: string;
      kind: 'stop';
      state: ReminderState;
      ctx: ReminderCtx;
      now: number;
      walked: boolean;
      token: string;
      lastFastAt: number;
      expected: { effect: 'post' | 'arrival' | 'end'; reason: GateReason; state?: StateMatch };
    }
  /** What a stored value reads as (the v2 migration included). */
  | { name: string; kind: 'stored'; stored: unknown; expected: StateMatch };

// ——— builders ———

const ON = setEnabled(INITIAL, true);
/** A session 10 min old whose last driving moment was 30 s ago, out of the vehicle, not driven, not reminded. */
const sess = (over: Partial<ReminderSession> = {}): ReminderSession => ({ ...newSession(T0 - 10 * M, T0 - 30 * S, false), ...over });
const on = (over: Partial<ReminderState> = {}, x: Partial<ReminderSession> | null = {}): ReminderState => ({
  ...ON,
  session: x === null ? null : sess(x),
  ...over,
});
const ctx = (over: Partial<ReminderCtx> = {}): ReminderCtx => ({ ...CALM_CTX, ...over });
const ev = (kind: Transition['kind'], ts: number): Transition => ({ kind, ts });
const fix = (t: number, speed: number, speedAcc = 1): { fix: Fix; now: number } => ({ fix: { t, speed, speedAcc }, now: t });
const act = (start: number, over: Partial<Activity> = {}): Activity => ({ start, automotive: true, stationary: false, onFoot: false, confident: true, ...over });
const motion = (lastAutomotiveAt: number, automotiveSince = lastAutomotiveAt - 5 * M, onFootNow = false): MotionSummary => ({
  lastAutomotiveAt,
  automotiveSince,
  onFootNow,
});
const NO_MOTION: MotionSummary = { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false };
/** Android: in the vehicle, driven since the last drive, last report 2 min ago. */
const inCar = (over: Partial<ReminderSession> = {}): Partial<ReminderSession> => ({ inVehicle: true, drove: true, lastDrivingAt: T0 - 2 * M, lastNewsAt: T0 - 2 * M, ...over });
/** Android: the session's car stretch ended at T0 − 30 s with an IN_VEHICLE EXIT. */
const exited = (over: Partial<ReminderSession> = {}): Partial<ReminderSession> => ({
  inVehicle: false,
  drove: true,
  vehicleExitAt: T0 - 30 * S,
  lastDrivingAt: T0 - 30 * S,
  lastNewsAt: T0 - 30 * S,
  ...over,
});
/** A posted note in a reminded session. */
const noted = (over: Partial<ReminderState> = {}, x: Partial<ReminderSession> = {}): ReminderState =>
  on({ token: 'tok-a', postedAt: T0 - 5 * M, ...over }, { reminded: true, drove: true, ...x });
const looking = (over: Partial<LookTracker> = {}): LookTracker => ({ ...newLook(T0), ...over });
const HOUR_AGO = T0 - H;

export const REMINDER_VECTORS: ReminderVector[] = [
  // ——— the stop gate, each reason in order ———
  { name: 'gate: off', kind: 'gate', state: INITIAL, ctx: ctx(), now: T0, phase: 'stop', expected: 'off' },
  { name: 'gate: off beats a drive open', kind: 'gate', state: INITIAL, ctx: ctx({ capturing: true, permissionsOk: false }), now: T0, phase: 'stop', expected: 'off' },
  { name: 'gate: permission', kind: 'gate', state: on({}, { drove: true }), ctx: ctx({ permissionsOk: false }), now: T0, phase: 'stop', expected: 'permission' },
  { name: 'gate: permission beats a drive open', kind: 'gate', state: on({}, { drove: true }), ctx: ctx({ permissionsOk: false, capturing: true }), now: T0, phase: 'stop', expected: 'permission' },
  { name: 'gate: a drive is open', kind: 'gate', state: on({}, { drove: true }), ctx: ctx({ capturing: true }), now: T0, phase: 'stop', expected: 'capturing' },
  { name: 'gate: no session', kind: 'gate', state: on({}, null), ctx: ctx(), now: T0, phase: 'stop', expected: 'no-session' },
  { name: 'gate: once a session', kind: 'gate', state: on({}, { drove: true, reminded: true }), ctx: ctx(), now: T0, phase: 'stop', expected: 'reminded' },
  { name: 'gate: reminded beats not driven', kind: 'gate', state: on({}, { drove: false, reminded: true }), ctx: ctx(), now: T0, phase: 'stop', expected: 'reminded' },
  { name: 'gate: no driving speed with no drive open since the last drive', kind: 'gate', state: on({}, { drove: false }), ctx: ctx(), now: T0, phase: 'stop', expected: 'not-driven' },
  { name: 'gate: driven and not reminded posts', kind: 'gate', state: on({}, { drove: true }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: a stop just after the session opened posts (no minimum trip time)', kind: 'gate', state: on({}, { drove: true, startedAt: T0 - 20 * S }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: a stop just after a drive ended posts once driven again (no after-drive wait)', kind: 'gate', state: on({ lastDriveEndAt: T0 - M }, { drove: true }), ctx: ctx(), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: a stop 46 s old is stale', kind: 'gate', state: on({}, { drove: true }), ctx: ctx({ eventAgeMs: 46 * S }), now: T0, phase: 'stop', expected: 'stale' },
  { name: 'gate: a stop 45 s old is not stale', kind: 'gate', state: on({}, { drove: true }), ctx: ctx({ eventAgeMs: 45 * S }), now: T0, phase: 'stop', expected: 'ok' },
  { name: 'gate: on foot after the stop', kind: 'gate', state: on({}, { drove: true }), ctx: ctx({ onFoot: true }), now: T0, phase: 'stop', expected: 'on-foot' },
  // ——— the wake and look gates (iOS) ———
  { name: 'gate: wake needs no session', kind: 'gate', state: on({}, null), ctx: ctx(), now: T0, phase: 'wake', expected: 'ok' },
  { name: 'gate: wake while a drive is open', kind: 'gate', state: on({}, null), ctx: ctx({ capturing: true }), now: T0, phase: 'wake', expected: 'capturing' },
  { name: 'gate: wake while off', kind: 'gate', state: INITIAL, ctx: ctx(), now: T0, phase: 'wake', expected: 'off' },
  { name: 'gate: wake without a permission', kind: 'gate', state: on({}, null), ctx: ctx({ permissionsOk: false }), now: T0, phase: 'wake', expected: 'permission' },
  { name: 'gate: look with no session', kind: 'gate', state: on({}, null), ctx: ctx(), now: T0, phase: 'look', expected: 'no-session' },
  { name: 'gate: look in a reminded session', kind: 'gate', state: on({}, { reminded: true }), ctx: ctx(), now: T0, phase: 'look', expected: 'reminded' },
  { name: 'gate: look resting 1 ms more', kind: 'gate', state: on({ lookRestUntil: T0 + 1 }, {}), ctx: ctx(), now: T0, phase: 'look', expected: 'resting' },
  { name: 'gate: look at the end of the rest', kind: 'gate', state: on({ lookRestUntil: T0 }, {}), ctx: ctx(), now: T0, phase: 'look', expected: 'ok' },
  { name: 'gate: look with car motion 121 s old', kind: 'gate', state: on(), ctx: ctx({ automotiveAgeMs: 121 * S }), now: T0, phase: 'look', expected: 'not-fresh' },
  { name: 'gate: look with car motion 120 s old', kind: 'gate', state: on(), ctx: ctx({ automotiveAgeMs: 120 * S }), now: T0, phase: 'look', expected: 'ok' },
  { name: 'gate: look with the driver on foot now', kind: 'gate', state: on(), ctx: ctx({ onFoot: true }), now: T0, phase: 'look', expected: 'not-fresh' },
  { name: 'gate: look needs no driving speed yet', kind: 'gate', state: on({}, { drove: false }), ctx: ctx(), now: T0, phase: 'look', expected: 'ok' },

  // ——— the shared state steps ———
  {
    name: 'ops: out of the vehicle 29:59 keeps the session',
    kind: 'ops',
    state: on({ token: 'tok-a' }, { lastDrivingAt: T0 - 30 * M + 1 }),
    ops: [{ op: 'settle', now: T0, capturing: false }],
    expected: { token: 'tok-a', session: { lastDrivingAt: T0 - 30 * M + 1 } },
  },
  {
    name: 'ops: out of the vehicle 30:00 ends the session and drops the token',
    kind: 'ops',
    state: on({ token: 'tok-a', tapAt: T0 - M }, { lastDrivingAt: T0 - 30 * M, reminded: true }),
    ops: [{ op: 'settle', now: T0, capturing: false }],
    expected: { session: null, token: '', tapAt: 0, enabled: true },
  },
  {
    name: 'ops: in the vehicle 5 h with no report keeps the session (no time guard)',
    kind: 'ops',
    state: on({}, { inVehicle: true, lastDrivingAt: T0 - 5 * H, lastNewsAt: T0 - 5 * H }),
    ops: [{ op: 'settle', now: T0, capturing: false }],
    expected: { session: { inVehicle: true, lastDrivingAt: T0 - 5 * H } },
  },
  {
    name: 'ops: a session a wake opened (never in the vehicle) ends 30:00 after its car motion',
    kind: 'ops',
    state: on({}, { inVehicle: false, startedAt: T0 - 50 * M, lastDrivingAt: T0 - 30 * M }),
    ops: [{ op: 'settle', now: T0, capturing: false }],
    expected: { session: null },
  },
  {
    name: 'ops: a drive open keeps a session 5 h past its last driving moment',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 5 * H }),
    ops: [{ op: 'settle', now: T0, capturing: true }],
    expected: { session: { lastDrivingAt: T0 - 5 * H } },
  },
  {
    name: 'ops: a time more than a day ahead becomes now',
    kind: 'ops',
    state: on({ lastDriveEndAt: T0 + 2 * D, postedAt: T0 + 2 * D }, { lastDrivingAt: T0 + 2 * D, startedAt: T0 + 2 * D }),
    ops: [{ op: 'settle', now: T0, capturing: false }],
    expected: { lastDriveEndAt: T0, postedAt: T0, session: { lastDrivingAt: T0, startedAt: T0 } },
  },
  {
    name: 'ops: a time up to a day ahead stays',
    kind: 'ops',
    state: on({ lookRestUntil: T0 + D }, {}),
    ops: [{ op: 'settle', now: T0, capturing: false }],
    expected: { lookRestUntil: T0 + D },
  },
  {
    name: 'ops: posted marks the session reminded and keeps the token',
    kind: 'ops',
    state: on({ tapAt: 5 }, { drove: true }),
    ops: [{ op: 'posted', now: T0, token: 'tok-b' }],
    expected: { token: 'tok-b', postedAt: T0, tapAt: 0, session: { reminded: true } },
  },
  {
    name: 'ops: unposted with the same token takes the post back',
    kind: 'ops',
    state: noted(),
    ops: [{ op: 'unposted', token: 'tok-a' }],
    expected: { token: '', session: { reminded: false } },
  },
  {
    name: 'ops: unposted with another token changes nothing',
    kind: 'ops',
    state: noted(),
    ops: [{ op: 'unposted', token: 'tok-z' }],
    expected: { token: 'tok-a', session: { reminded: true } },
  },
  {
    name: 'ops: noteGone drops the token and the session stays reminded',
    kind: 'ops',
    state: noted({ tapAt: T0 }),
    ops: [{ op: 'noteGone' }],
    expected: { token: '', tapAt: 0, session: { reminded: true } },
  },
  {
    name: 'ops: captureStarted takes the note down and clears driving speed',
    kind: 'ops',
    state: noted({ tapAt: T0 - M }, { drove: true, lastDrivingAt: T0 - M, lastNewsAt: T0 - M }),
    ops: [{ op: 'captureStarted', now: T0 }],
    expected: { token: '', tapAt: 0, session: { drove: false, reminded: true, lastDrivingAt: T0, lastNewsAt: T0 } },
  },
  {
    name: 'ops: captureStarted with no session opens none',
    kind: 'ops',
    state: on({}, null),
    ops: [{ op: 'captureStarted', now: T0 }],
    expected: { session: null },
  },
  {
    name: 'ops: captureEnded with no driving end given: now, in the vehicle stays in',
    kind: 'ops',
    state: on({}, { inVehicle: true, drove: true, lastDrivingAt: T0 - H, lastNewsAt: T0 - H }),
    ops: [{ op: 'captureEnded', now: T0 }],
    expected: { lastDriveEndAt: T0, session: { drove: false, inVehicle: true, lastDrivingAt: T0, lastNewsAt: T0 } },
  },
  {
    name: 'ops: captureEnded leaves out of the vehicle out',
    kind: 'ops',
    state: on({}, { inVehicle: false, drove: true }),
    ops: [{ op: 'captureEnded', now: T0 }],
    expected: { session: { inVehicle: false, drove: false } },
  },
  {
    name: 'ops: a drive that ended by itself 15 min after its last movement: the session clock starts at the movement',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 40 * M }),
    ops: [
      { op: 'captureEnded', now: T0, drivingEndedAt: T0 - 15 * M },
      { op: 'settle', now: T0 + 15 * M - 1, capturing: false },
    ],
    expected: { lastDriveEndAt: T0, session: { lastDrivingAt: T0 - 15 * M } },
  },
  {
    name: 'ops: a trip 30 min after that movement finds the session over',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 40 * M }),
    ops: [
      { op: 'captureEnded', now: T0, drivingEndedAt: T0 - 15 * M },
      { op: 'settle', now: T0 + 15 * M, capturing: false },
    ],
    expected: { session: null },
  },
  {
    name: 'ops: a drive that was not kept leaves the session clock alone',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 20 * M, drove: true }),
    ops: [{ op: 'captureEnded', now: T0, drivingEndedAt: null }],
    expected: { lastDriveEndAt: T0, session: { lastDrivingAt: T0 - 20 * M, drove: false, lastNewsAt: T0 } },
  },
  {
    name: 'ops: a driving end after now is read as now',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 20 * M }),
    ops: [{ op: 'captureEnded', now: T0, drivingEndedAt: T0 + 5 * M }],
    expected: { session: { lastDrivingAt: T0 } },
  },
  {
    name: 'ops: a driving end before the last driving moment leaves it',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 5 * M }),
    ops: [{ op: 'captureEnded', now: T0, drivingEndedAt: T0 - 10 * M }],
    expected: { session: { lastDrivingAt: T0 - 5 * M } },
  },
  {
    name: 'ops: a reminded session stays reminded through a drive',
    kind: 'ops',
    state: noted(),
    ops: [
      { op: 'captureStarted', now: T0 },
      { op: 'settle', now: T0 + 4 * H, capturing: true },
      { op: 'captureEnded', now: T0 + 4 * H },
      { op: 'settle', now: T0 + 4 * H + 10 * M, capturing: false },
    ],
    expected: { token: '', lastDriveEndAt: T0 + 4 * H, session: { reminded: true, drove: false, lastDrivingAt: T0 + 4 * H } },
  },
  {
    name: 'ops: on keeps the session; off forgets everything',
    kind: 'ops',
    state: noted(),
    ops: [{ op: 'setEnabled', on: true }],
    expected: { enabled: true, token: 'tok-a', session: { reminded: true } },
  },
  {
    name: 'ops: off forgets everything',
    kind: 'ops',
    state: noted({ tapSeen: ['tok-q'], tapAt: T0, lastDriveEndAt: T0 - H, lookRestUntil: T0 + M }),
    ops: [{ op: 'setEnabled', on: false }],
    expected: { v: 3, enabled: false, session: null, token: '', tapSeen: [], tapAt: 0, lastDriveEndAt: 0, postedAt: 0, lookRestUntil: 0 },
  },
  {
    name: 'ops: a capture batch says the phone left the vehicle: state only',
    kind: 'ops',
    state: noted({}, { inVehicle: true, lastNewsAt: T0 - 10 * M, drove: false }),
    ops: [{ op: 'captureTransitions', events: [ev('vehicle-exit', T0 - S)], subscribedAt: HOUR_AGO }],
    expected: { token: 'tok-a', session: { inVehicle: false, lastNewsAt: T0 - S, drove: false, reminded: true } },
  },
  {
    name: 'ops: a capture batch says the phone is in the vehicle',
    kind: 'ops',
    state: on({}, { inVehicle: false }),
    ops: [{ op: 'captureTransitions', events: [ev('vehicle-enter', T0 - S)], subscribedAt: HOUR_AGO }],
    expected: { session: { inVehicle: true, lastNewsAt: T0 - S, drove: false } },
  },
  {
    name: 'ops: a walk in a capture batch leaves the vehicle',
    kind: 'ops',
    state: on({}, { inVehicle: true }),
    ops: [{ op: 'captureTransitions', events: [ev('walking-enter', T0 - S)], subscribedAt: HOUR_AGO }],
    expected: { session: { inVehicle: false } },
  },
  {
    name: 'ops: a capture re-subscribe replays STILL: out of the vehicle at the subscribe',
    kind: 'ops',
    state: on({}, { inVehicle: true, lastNewsAt: T0 - H }),
    ops: [{ op: 'captureTransitions', events: [ev('still-enter', T0 - 30 * M)], subscribedAt: T0 - 10 * S }],
    expected: { session: { inVehicle: false, lastNewsAt: T0 - 10 * S } },
  },
  {
    name: 'ops: a capture batch never ends a session nor opens one',
    kind: 'ops',
    state: on({}, null),
    ops: [{ op: 'captureTransitions', events: [ev('vehicle-enter', T0 - S)], subscribedAt: HOUR_AGO }],
    expected: { session: null },
  },
  {
    name: 'ops: a capture batch on a session 5 h past its last driving moment keeps it',
    kind: 'ops',
    state: on({}, { inVehicle: false, lastDrivingAt: T0 - 5 * H }),
    ops: [{ op: 'captureTransitions', events: [ev('vehicle-exit', T0 - S)], subscribedAt: HOUR_AGO }],
    expected: { session: { lastDrivingAt: T0 - 5 * H, inVehicle: false } },
  },
  {
    name: 'ops: a look ended folds its last 10 mph fix (later only)',
    kind: 'ops',
    state: on({}, { lastDrivingAt: T0 - 5 * M }),
    ops: [
      { op: 'lookEnded', now: T0, lastFastAt: T0 - 2 * M, verdict: 'stopped' },
      { op: 'lookEnded', now: T0, lastFastAt: T0 - 9 * M, verdict: 'no-drive' },
    ],
    expected: { lookRestUntil: 0, session: { lastDrivingAt: T0 - 2 * M } },
  },
  {
    name: 'ops: a look that ran its full 10 min rests the next for 10 min',
    kind: 'ops',
    state: on(),
    ops: [{ op: 'lookEnded', now: T0, lastFastAt: 0, verdict: 'look-max' }],
    expected: { lookRestUntil: T0 + R.IOS_LOOK_REST_MS },
  },
  {
    name: 'ops: a look cut short rests nothing',
    kind: 'ops',
    state: on(),
    ops: [{ op: 'lookEnded', now: T0, lastFastAt: 0, verdict: 'ended' }],
    expected: { lookRestUntil: 0 },
  },

  // ——— the tap's hand-over (Android) ———
  {
    name: 'tap: the live token is handed over once, with its time',
    kind: 'tap',
    state: noted(),
    taps: [
      { token: 'tok-a', now: T0 },
      { token: 'tok-a', now: T0 + 5 * S },
    ],
    expected: { delivered: [true, false], state: { tapSeen: ['tok-a'], tapAt: T0, token: 'tok-a' } },
  },
  {
    name: 'tap: a foreign token is handed over (the claim refuses it) and sets no tap time',
    kind: 'tap',
    state: noted(),
    taps: [{ token: 'tok-x', now: T0 }],
    expected: { delivered: [true], state: { tapSeen: ['tok-x'], tapAt: 0, token: 'tok-a' } },
  },
  {
    name: 'tap: a token seen before a process death is not handed over again',
    kind: 'tap',
    state: noted({ tapSeen: ['tok-a'], tapAt: T0 - M }),
    taps: [{ token: 'tok-a', now: T0 }],
    expected: { delivered: [false], state: { tapAt: T0 - M } },
  },

  // ——— the claim ———
  {
    name: 'claim (android): the note token, handed over 1 min ago, starts a drive once',
    kind: 'claim',
    state: noted({ tapSeen: ['tok-a'], tapAt: T0 - M }),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: true,
    motion: null,
    expected: { ok: true, state: { token: '', tapAt: 0, session: { reminded: true } } },
  },
  {
    name: 'claim (ios): the note token starts a drive once',
    kind: 'claim',
    state: noted(),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: false,
    motion: null,
    expected: { ok: true, state: { token: '', session: { reminded: true } } },
  },
  ...([true, false] as const).flatMap((requireDelivery): ReminderVector[] => {
    const p = requireDelivery ? 'android' : 'ios';
    const tapped = requireDelivery ? { tapSeen: ['tok-a'], tapAt: T0 - M } : {};
    const row = (name: string, state: ReminderState, token: string, expected: { ok: boolean; state?: StateMatch }, capturing = false): ReminderVector => ({
      name: `claim (${p}): ${name}`,
      kind: 'claim',
      state,
      token,
      now: T0,
      capturing,
      requireDelivery,
      motion: null,
      expected,
    });
    return [
      row('a token already used is refused', noted({ token: '', ...tapped }), 'tok-a', { ok: false }),
      row('a wrong token is refused and the note stays', noted(tapped), 'tok-z', { ok: false, state: { token: 'tok-a' } }),
      row('no note and an empty token is refused', on({ token: '' }, { reminded: true }), '', { ok: false }),
      row('a session over is refused, its token dropped', noted(tapped, { lastDrivingAt: T0 - 30 * M }), 'tok-a', { ok: false, state: { token: '', session: null } }),
      row('a drive open is refused', noted(tapped), 'tok-a', { ok: false }, true),
      row('switched off is refused', noted({ enabled: false, ...tapped }), 'tok-a', { ok: false }),
    ];
  }),
  {
    name: 'claim (android): the note token never handed over is refused and the note stays',
    kind: 'claim',
    state: noted({ tapAt: 0 }),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: true,
    motion: null,
    expected: { ok: false, state: { token: 'tok-a' } },
  },
  {
    name: 'claim (android): handed over 2:01 ago is refused',
    kind: 'claim',
    state: noted({ tapSeen: ['tok-a'], tapAt: T0 - R.TAP_FRESH_MS - 1 }),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: true,
    motion: null,
    expected: { ok: false },
  },
  {
    name: 'claim (android): handed over 2:00 ago starts',
    kind: 'claim',
    state: noted({ tapSeen: ['tok-a'], tapAt: T0 - R.TAP_FRESH_MS }),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: true,
    motion: null,
    expected: { ok: true },
  },
  {
    name: 'claim (ios): a session a wake opened, claimed 31 min after its car motion with none since, is refused',
    kind: 'claim',
    state: noted({}, { lastDrivingAt: T0 - 31 * M, startedAt: T0 - 40 * M }),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: false,
    motion: NO_MOTION,
    expected: { ok: false, state: { token: '', session: null } },
  },
  {
    name: 'claim (ios): car motion until now keeps a 2 h old session alive for the claim',
    kind: 'claim',
    state: noted({}, { lastDrivingAt: T0 - 2 * H, startedAt: T0 - 2 * H - 10 * M }),
    token: 'tok-a',
    now: T0,
    capturing: false,
    requireDelivery: false,
    motion: motion(T0, T0 - 2 * H - 10 * M),
    expected: { ok: true, state: { token: '', session: { lastDrivingAt: T0 } } },
  },

  // ——— Android: the activity-transition batch ———
  {
    name: 'android: an IN_VEHICLE ENTER with no session opens a driven one',
    kind: 'transitions',
    state: on({ lastDriveEndAt: T0 - H }, null),
    events: [ev('vehicle-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: {
      effect: 'none',
      expiresAt: T0 + R.IN_VEHICLE_NOTE_MS,
      state: { token: '', session: { startedAt: T0 - 10 * S, lastDrivingAt: T0 - 10 * S, lastNewsAt: T0 - 10 * S, inVehicle: true, drove: true, reminded: false } },
    },
  },
  {
    name: 'android: [EXIT, STILL] in a driven session posts, the note timing out at the session end',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: {
      effect: 'post',
      reason: 'ok',
      expiresAt: T0 - 40 * S + R.SESSION_GAP_MS,
      state: { token: 'tok-new', postedAt: T0, session: { reminded: true, inVehicle: false, vehicleExitAt: T0 - 40 * S, lastDrivingAt: T0 - 40 * S } },
    },
  },
  {
    name: 'android: ENTER then [EXIT, STILL] 20 s into the trip posts (no minimum trip time)',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('vehicle-enter', T0 - 30 * S), ev('vehicle-exit', T0 - 15 * S), ev('still-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'post', reason: 'ok', state: { token: 'tok-new', session: { startedAt: T0 - 30 * S, reminded: true } } },
  },
  {
    name: 'android: a STILL after an EXIT from the batch before posts',
    kind: 'transitions',
    state: on({}, exited()),
    events: [ev('still-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'post', reason: 'ok' },
  },
  {
    name: 'android: a STILL 2:01 after the EXIT is not a stop',
    kind: 'transitions',
    state: on({}, exited({ vehicleExitAt: T0 - 3 * M, lastDrivingAt: T0 - 3 * M })),
    events: [ev('still-enter', T0 - 3 * M + R.STILL_AFTER_VEHICLE_MS + 1)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { token: '' } },
  },
  {
    name: 'android: a STILL 2:00 after the EXIT is a stop',
    kind: 'transitions',
    state: on({}, exited({ vehicleExitAt: T0 - 2 * M - 10 * S, lastDrivingAt: T0 - 2 * M - 10 * S })),
    events: [ev('still-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'post', reason: 'ok' },
  },
  {
    name: 'android: [EXIT, STILL, WALKING] walked off, no post',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S), ev('walking-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'on-foot', state: { token: '', session: { inVehicle: false, reminded: false } } },
  },
  {
    name: 'android: [EXIT, STILL, RUNNING] walked off, no post',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S), ev('running-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'on-foot' },
  },
  {
    name: 'android: [EXIT, STILL, ENTER] drove on, no post',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S), ev('vehicle-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'on-foot', state: { session: { inVehicle: true, reminded: false } } },
  },
  {
    name: 'android: a STILL listed before its EXIT at the same time counts (EXIT is read first)',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('still-enter', T0 - 20 * S), ev('vehicle-exit', T0 - 20 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'post', reason: 'ok', state: { session: { inVehicle: false, reminded: true } } },
  },
  {
    name: 'android: a lone STILL with no session (phone on a desk) is nothing',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('still-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', expiresAt: 0, state: { session: null } },
  },
  {
    name: 'android: an EXIT with no session opens nothing',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('vehicle-exit', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { session: null } },
  },
  {
    name: 'android: a replay never opens a session, posts or marks driving speed',
    kind: 'transitions',
    state: on({}, null),
    events: [ev('vehicle-enter', T0 - 2 * M), ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: T0 - 20 * S,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { session: null, token: '' } },
  },
  {
    name: 'android: a replayed STILL says out of the vehicle at the subscribe, and is no stop',
    kind: 'transitions',
    state: on({}, inCar({ lastDrivingAt: T0 - 10 * M, lastNewsAt: T0 - 10 * M })),
    events: [ev('still-enter', T0 - M)],
    arrival: T0,
    subscribedAt: T0 - 20 * S,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { token: '', session: { inVehicle: false, lastDrivingAt: T0 - 10 * M, vehicleExitAt: 0, lastNewsAt: T0 - 20 * S } } },
  },
  {
    name: 'android: a replayed ENTER says in the vehicle at the subscribe, and is no driving speed',
    kind: 'transitions',
    state: on({}, { inVehicle: false, drove: false, lastDrivingAt: T0 - 10 * M }),
    events: [ev('vehicle-enter', T0 - H)],
    arrival: T0,
    subscribedAt: T0 - 20 * S,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { session: { inVehicle: true, drove: false, lastDrivingAt: T0 - 20 * S, startedAt: T0 - 10 * M } } },
  },
  {
    name: 'android: an EXIT and STILL replayed after a re-subscribe are no stop',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: T0 - 20 * S,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { token: '', session: { inVehicle: false, reminded: false } } },
  },
  {
    name: 'android: a second stop in a reminded session: no post, the note refreshed',
    kind: 'transitions',
    state: noted({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'refresh', reason: 'reminded', expiresAt: T0 - 40 * S + R.SESSION_GAP_MS, state: { token: 'tok-a' } },
  },
  {
    name: 'android: back in the car 29 min after the exit: same session, the note refreshed for 3 h',
    kind: 'transitions',
    state: noted({}, exited({ vehicleExitAt: T0 - 29 * M, lastDrivingAt: T0 - 29 * M, lastNewsAt: T0 - 29 * M })),
    events: [ev('vehicle-enter', T0 - 5 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'refresh', expiresAt: T0 + R.IN_VEHICLE_NOTE_MS, state: { token: 'tok-a', session: { inVehicle: true, reminded: true, startedAt: T0 - 10 * M } } },
  },
  {
    name: 'android: back in the car 31 min after the exit: the old session ends, its note goes, a new one opens',
    kind: 'transitions',
    state: noted({}, exited({ vehicleExitAt: T0 - 31 * M, lastDrivingAt: T0 - 31 * M, lastNewsAt: T0 - 31 * M })),
    events: [ev('vehicle-enter', T0)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'withdraw', state: { token: '', session: { startedAt: T0, reminded: false, drove: true, inVehicle: true } } },
  },
  {
    name: 'android: an ENTER that happened 29 min after the exit but arrived at 31 keeps the session (event time decides)',
    kind: 'transitions',
    state: noted({}, exited({ vehicleExitAt: T0 - 31 * M, lastDrivingAt: T0 - 31 * M, lastNewsAt: T0 - 31 * M })),
    events: [ev('vehicle-enter', T0 - 2 * M)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'refresh', state: { token: 'tok-a', session: { reminded: true, startedAt: T0 - 10 * M, inVehicle: true } } },
  },
  {
    name: 'android: a lost exit (an ENTER while in the vehicle, 31 min after the last report) ends the session and opens a new one',
    kind: 'transitions',
    state: noted({}, inCar({ lastDrivingAt: T0 - 31 * M, lastNewsAt: T0 - 31 * M })),
    events: [ev('vehicle-enter', T0)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'withdraw', state: { token: '', session: { startedAt: T0, reminded: false, drove: true } } },
  },
  {
    name: 'android: an ENTER while in the vehicle 29 min after the last report is the same session',
    kind: 'transitions',
    state: noted({}, inCar({ lastDrivingAt: T0 - 29 * M, lastNewsAt: T0 - 29 * M })),
    events: [ev('vehicle-enter', T0)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'refresh', state: { token: 'tok-a', session: { startedAt: T0 - 10 * M, reminded: true, lastNewsAt: T0 } } },
  },
  {
    name: 'android: 3.5 h in the vehicle with no report, then [EXIT, STILL]: the same reminded session',
    kind: 'transitions',
    state: noted({}, inCar({ lastDrivingAt: T0 - 3.5 * H, lastNewsAt: T0 - 3.5 * H })),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'refresh', reason: 'reminded', state: { token: 'tok-a', session: { startedAt: T0 - 10 * M } } },
  },
  {
    name: 'android: after a drive ended, [EXIT, STILL] with no new ENTER is not driven',
    kind: 'transitions',
    state: on({ lastDriveEndAt: T0 - 5 * M }, { inVehicle: true, drove: false, lastDrivingAt: T0 - 5 * M, lastNewsAt: T0 - 5 * M }),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'not-driven' },
  },
  {
    name: 'android: after a drive ended, a new ENTER then [EXIT, STILL] posts',
    kind: 'transitions',
    state: on({ lastDriveEndAt: T0 - 20 * M }, { inVehicle: false, drove: false, lastDrivingAt: T0 - 20 * M, lastNewsAt: T0 - 20 * M }),
    events: [ev('vehicle-enter', T0 - 5 * M), ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'post', reason: 'ok', state: { session: { drove: true, reminded: true } } },
  },
  {
    name: 'android: a session reminded before a drive stays reminded after it, at the next stop',
    kind: 'transitions',
    state: on({ lastDriveEndAt: T0 - 20 * M }, { reminded: true, drove: false, inVehicle: false, lastDrivingAt: T0 - 20 * M, lastNewsAt: T0 - 20 * M }),
    events: [ev('vehicle-enter', T0 - 10 * M), ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'reminded', state: { token: '', session: { reminded: true, drove: true } } },
  },
  {
    name: 'android: an ENTER from before the last drive ended is no driving speed',
    kind: 'transitions',
    state: on({ lastDriveEndAt: T0 - M }, { inVehicle: false, drove: false, lastDrivingAt: T0 - M, lastNewsAt: T0 - M }),
    events: [ev('vehicle-enter', T0 - 2 * M), ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'not-driven' },
  },
  {
    name: 'android: a stop 46 s old on arrival is stale',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 60 * S), ev('still-enter', T0 - 46 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'stale' },
  },
  {
    name: 'android: a stop 45 s old on arrival posts',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 60 * S), ev('still-enter', T0 - 45 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'post', reason: 'ok' },
  },
  {
    name: 'android: a stop without the permissions does not post',
    kind: 'transitions',
    state: on({}, inCar()),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx({ permissionsOk: false }),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'permission', state: { session: { reminded: false } } },
  },
  {
    name: 'android: a WALKING ENTER in the car ends the car time but not the session',
    kind: 'transitions',
    state: on({}, inCar({ startedAt: T0 - 30 * M })),
    events: [ev('walking-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', state: { session: { startedAt: T0 - 30 * M, inVehicle: false, lastDrivingAt: T0 - 10 * S } } },
  },
  {
    name: 'android: a batch with a note up while in the vehicle re-arms its 3 h timeout',
    kind: 'transitions',
    state: noted({}, inCar()),
    events: [ev('walking-enter', T0 - 10 * M), ev('vehicle-enter', T0 - 10 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'refresh', expiresAt: T0 + R.IN_VEHICLE_NOTE_MS },
  },
  {
    name: 'android: a drive ended in the car, 40 min with no report, then [EXIT, STILL]: the session lived on, not driven',
    kind: 'transitions',
    state: on({ lastDriveEndAt: T0 - 41 * M }, { inVehicle: true, drove: false, startedAt: T0 - 2 * H, lastDrivingAt: T0 - 41 * M, lastNewsAt: T0 - 41 * M }),
    events: [ev('vehicle-exit', T0 - 40 * S), ev('still-enter', T0 - 30 * S)],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'none', reason: 'not-driven', state: { session: { startedAt: T0 - 2 * H } } },
  },
  {
    name: 'android: a batch 31 min after the exit ends the session at arrival; its note goes',
    kind: 'transitions',
    state: noted({}, exited({ vehicleExitAt: T0 - 31 * M, lastDrivingAt: T0 - 31 * M, lastNewsAt: T0 - 31 * M })),
    events: [],
    arrival: T0,
    subscribedAt: HOUR_AGO,
    ctx: ctx(),
    newToken: 'tok-new',
    expected: { effect: 'withdraw', expiresAt: 0, state: { token: '', session: null } },
  },
  { name: 'expires: no session = gone', kind: 'expires', state: on({}, null), now: T0, expected: 0 },
  { name: 'expires: in the vehicle, 3 h on', kind: 'expires', state: noted({}, inCar()), now: T0, expected: T0 + R.IN_VEHICLE_NOTE_MS },
  { name: 'expires: out of the vehicle, at the session end', kind: 'expires', state: noted({}, exited({ lastDrivingAt: T0 - 10 * M })), now: T0, expected: T0 + 20 * M },
  { name: 'expires: out of the vehicle at the session end = now (cancel, never a post without a timeout)', kind: 'expires', state: noted({}, exited({ lastDrivingAt: T0 - 30 * M })), now: T0, expected: T0 },

  // ——— iOS: the motion history ———
  {
    name: 'summary: the newest car stretch ends where the next activity starts',
    kind: 'summary',
    activities: [act(T0 - 20 * M), act(T0 - 5 * M, { automotive: false })],
    now: T0,
    expected: { lastAutomotiveAt: T0 - 5 * M, automotiveSince: T0 - 20 * M, onFootNow: false },
  },
  {
    name: 'summary: walking now',
    kind: 'summary',
    activities: [act(T0 - 20 * M), act(T0 - 2 * M, { automotive: false, onFoot: true })],
    now: T0,
    expected: { lastAutomotiveAt: T0 - 2 * M, automotiveSince: T0 - 20 * M, onFootNow: true },
  },
  {
    name: 'summary: a walk between two car stretches does not start a new run (only 30 min without car motion does)',
    kind: 'summary',
    activities: [act(T0 - 50 * M), act(T0 - 40 * M, { automotive: false, onFoot: true }), act(T0 - 15 * M, { automotive: false, stationary: true }), act(T0 - 12 * M)],
    now: T0,
    expected: { lastAutomotiveAt: T0, automotiveSince: T0 - 50 * M, onFootNow: false },
  },
  { name: 'summary: nothing', kind: 'summary', activities: [], now: T0, expected: { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false } },
  {
    name: 'summary: 30 min without moving car motion starts a new run',
    kind: 'summary',
    activities: [act(T0 - 60 * M), act(T0 - 55 * M, { automotive: false }), act(T0 - 25 * M)],
    now: T0,
    expected: { lastAutomotiveAt: T0, automotiveSince: T0 - 25 * M, onFootNow: false },
  },
  {
    name: 'summary: 29 min without moving car motion keeps the run',
    kind: 'summary',
    activities: [act(T0 - 60 * M), act(T0 - 55 * M, { automotive: false }), act(T0 - 26 * M)],
    now: T0,
    expected: { lastAutomotiveAt: T0, automotiveSince: T0 - 60 * M, onFootNow: false },
  },
  {
    name: 'summary: a car standing still is not car motion',
    kind: 'summary',
    activities: [act(T0 - 45 * M), act(T0 - 35 * M, { stationary: true })],
    now: T0,
    expected: { lastAutomotiveAt: T0 - 35 * M, automotiveSince: T0 - 45 * M, onFootNow: false },
  },
  {
    name: 'summary: one moving car record from 2 h ago lasts until now',
    kind: 'summary',
    activities: [act(T0 - 2 * H)],
    now: T0,
    expected: { lastAutomotiveAt: T0, automotiveSince: T0 - 2 * H, onFootNow: false },
  },
  {
    name: 'summary: low-confidence car motion and a low-confidence walk count for nothing',
    kind: 'summary',
    activities: [act(T0 - 20 * M), act(T0 - 10 * M, { confident: false }), act(T0 - 5 * M, { automotive: false, onFoot: true, confident: false })],
    now: T0,
    expected: { lastAutomotiveAt: T0 - 10 * M, automotiveSince: T0 - 20 * M, onFootNow: false },
  },

  // ——— iOS: the wake ———
  {
    name: 'wake: fresh car motion opens a session and starts a look',
    kind: 'wake',
    state: on({ lookRestUntil: T0 + 5 * M }, null),
    now: T0,
    motion: motion(T0 - 10 * S, T0 - 8 * M),
    ctx: ctx(),
    expected: {
      effect: 'start-look',
      reason: 'ok',
      dropped: false,
      state: { lookRestUntil: 0, session: { startedAt: T0 - 8 * M, lastDrivingAt: T0 - 10 * S, inVehicle: false, drove: false, reminded: false } },
    },
  },
  {
    name: 'wake: car motion 121 s old opens nothing',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 121 * S),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-session', state: { session: null } },
  },
  {
    name: 'wake: walking now opens nothing',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 10 * S, T0 - 8 * M, true),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-session', state: { session: null } },
  },
  {
    name: 'wake: a reminded session looks no more; its car motion moves the clock on',
    kind: 'wake',
    state: noted({}, { lastDrivingAt: T0 - 20 * M }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 30 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'reminded', dropped: false, state: { token: 'tok-a', session: { lastDrivingAt: T0 - 5 * S, reminded: true } } },
  },
  {
    name: 'wake: a session whose car motion ended 30 min ago ends, and its note goes',
    kind: 'wake',
    state: noted({}, { lastDrivingAt: T0 - 30 * M }),
    now: T0,
    motion: NO_MOTION,
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-session', dropped: true, state: { token: '', session: null } },
  },
  {
    name: 'wake: a car standing still for 30 min since the session opened ends it',
    kind: 'wake',
    state: on({}, { lastDrivingAt: T0 - 30 * M, startedAt: T0 - 40 * M }),
    now: T0,
    motion: motion(T0 - 30 * M, T0 - 40 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'no-session', state: { session: null } },
  },
  {
    name: 'wake: a car run that began 30 min after the last driving moment is a new session, and looks',
    kind: 'wake',
    state: noted({}, { lastDrivingAt: T0 - 40 * M }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx(),
    expected: { effect: 'start-look', reason: 'ok', dropped: true, state: { token: '', session: { startedAt: T0 - 10 * M, reminded: false, lastDrivingAt: T0 - 5 * S } } },
  },
  {
    name: 'wake: a car run that began 29 min after is the same session, reminded',
    kind: 'wake',
    state: noted({}, { lastDrivingAt: T0 - 39 * M }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'reminded', dropped: false, state: { token: 'tok-a', session: { startedAt: T0 - 10 * M, reminded: true, lastDrivingAt: T0 - 5 * S } } },
  },
  {
    name: 'wake: after a look that ended for lack of 10 mph, another look (no cap a trip)',
    kind: 'wake',
    state: on({ lookRestUntil: 0 }, { lastDrivingAt: T0 - M }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx(),
    expected: { effect: 'start-look', reason: 'ok' },
  },
  {
    name: 'wake: within 10 min of a full look, no look',
    kind: 'wake',
    state: on({ lookRestUntil: T0 + 9 * M }, { lastDrivingAt: T0 - M }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx(),
    expected: { effect: 'none', reason: 'resting' },
  },
  {
    name: 'wake: 10 min after a full look, a look',
    kind: 'wake',
    state: on({ lookRestUntil: T0 }, { lastDrivingAt: T0 - M }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx(),
    expected: { effect: 'start-look', reason: 'ok' },
  },
  {
    name: 'wake: a drive open does nothing',
    kind: 'wake',
    state: on({}, { lastDrivingAt: T0 - 2 * H }),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx({ capturing: true }),
    expected: { effect: 'none', reason: 'capturing', state: { session: { lastDrivingAt: T0 - 2 * H } } },
  },
  {
    name: 'wake: a missing permission does nothing',
    kind: 'wake',
    state: on({}, null),
    now: T0,
    motion: motion(T0 - 5 * S, T0 - 10 * M),
    ctx: ctx({ permissionsOk: false }),
    expected: { effect: 'none', reason: 'permission', state: { session: null } },
  },

  // ——— iOS: the look's fixes ———
  {
    name: 'fixes: under 3 mph held 11.9 s is not a stop; 12 s is',
    kind: 'fixes',
    tracker: looking(),
    fixes: [fix(T0 + S, 6), fix(T0 + 2 * S, 1), fix(T0 + 2 * S + 11_900, 0.5), fix(T0 + 14 * S, 0.2)],
    expected: { verdicts: ['none', 'none', 'none', 'stopped'], lastFastAt: T0 + S },
  },
  {
    name: 'fixes: no stop before 10 mph',
    kind: 'fixes',
    tracker: looking(),
    fixes: [fix(T0 + S, 3), fix(T0 + 2 * S, 0), fix(T0 + 20 * S, 0)],
    expected: { verdicts: ['none', 'none', 'none'], lastFastAt: 0 },
  },
  {
    name: 'fixes: an unusable speed neither makes nor breaks the hold; 3 mph breaks it',
    kind: 'fixes',
    tracker: looking(),
    fixes: [fix(T0 + S, 6), fix(T0 + 2 * S, 0), fix(T0 + 8 * S, -1), fix(T0 + 10 * S, 0.5, 5), fix(T0 + 14 * S, 0), fix(T0 + 15 * S, 1.34), fix(T0 + 27 * S, 0)],
    expected: { verdicts: ['none', 'none', 'none', 'none', 'stopped', 'none', 'none'] },
  },
  {
    name: 'fixes: 3 min without 10 mph ends the look',
    kind: 'fixes',
    tracker: looking(),
    fixes: [fix(T0 + R.IOS_LOOK_NO_DRIVE_MS - 1, 3), fix(T0 + R.IOS_LOOK_NO_DRIVE_MS, 3)],
    expected: { verdicts: ['none', 'no-drive'] },
  },
  {
    name: 'fixes: a look lasts 10 min at most',
    kind: 'fixes',
    tracker: looking({ sawDriving: true, lastFastAt: T0 + 9 * M }),
    fixes: [fix(T0 + R.IOS_LOOK_MAX_MS - 1, 10), fix(T0 + R.IOS_LOOK_MAX_MS, 10)],
    expected: { verdicts: ['none', 'look-max'], lastFastAt: T0 + R.IOS_LOOK_MAX_MS - 1 },
  },
  {
    name: 'fixes: the last 10 mph fix is kept, never moved back',
    kind: 'fixes',
    tracker: looking(),
    fixes: [fix(T0 + 3 * S, 9), fix(T0 + 2 * S, 9), fix(T0 + 4 * S, 4.4)],
    expected: { verdicts: ['none', 'none', 'none'], lastFastAt: T0 + 3 * S },
  },

  // ——— iOS: the held stop ———
  {
    name: 'stop: a stop after 10 mph posts',
    kind: 'stop',
    state: on({ lastDriveEndAt: T0 - H }, { drove: false, lastDrivingAt: T0 - 2 * M }),
    ctx: ctx(),
    now: T0,
    walked: false,
    token: 'tok-new',
    lastFastAt: T0 - 30 * S,
    expected: { effect: 'post', reason: 'ok', state: { token: 'tok-new', postedAt: T0, session: { drove: true, reminded: true, lastDrivingAt: T0 - 30 * S } } },
  },
  {
    name: 'stop: walked during the hold is an arrival, no post, the session goes on',
    kind: 'stop',
    state: on({}, { lastDrivingAt: T0 - 2 * M }),
    ctx: ctx(),
    now: T0,
    walked: true,
    token: 'tok-new',
    lastFastAt: T0 - 30 * S,
    expected: { effect: 'arrival', reason: 'on-foot', state: { token: '', session: { reminded: false, lastDrivingAt: T0 - 30 * S } } },
  },
  {
    name: 'stop: a reminded session gets no second',
    kind: 'stop',
    state: noted(),
    ctx: ctx(),
    now: T0,
    walked: false,
    token: 'tok-new',
    lastFastAt: T0 - 30 * S,
    expected: { effect: 'end', reason: 'reminded', state: { token: 'tok-a' } },
  },
  {
    name: 'stop: a drive open posts nothing',
    kind: 'stop',
    state: on(),
    ctx: ctx({ capturing: true }),
    now: T0,
    walked: false,
    token: 'tok-new',
    lastFastAt: T0 - 30 * S,
    expected: { effect: 'end', reason: 'capturing' },
  },
  {
    name: 'stop: a missing permission posts nothing',
    kind: 'stop',
    state: on(),
    ctx: ctx({ permissionsOk: false }),
    now: T0,
    walked: false,
    token: 'tok-new',
    lastFastAt: T0 - 30 * S,
    expected: { effect: 'end', reason: 'permission' },
  },
  {
    name: 'stop: 10 mph seen only before the last drive ended is no driving speed',
    kind: 'stop',
    state: on({ lastDriveEndAt: T0 - 20 * S }, { drove: false }),
    ctx: ctx(),
    now: T0,
    walked: false,
    token: 'tok-new',
    lastFastAt: T0 - 30 * S,
    expected: { effect: 'end', reason: 'not-driven' },
  },
  {
    name: 'stop: a session that ended while the look ran posts nothing',
    kind: 'stop',
    state: on({}, { lastDrivingAt: T0 - 40 * M }),
    ctx: ctx(),
    now: T0,
    walked: false,
    token: 'tok-new',
    lastFastAt: 0,
    expected: { effect: 'end', reason: 'no-session', state: { session: null } },
  },

  // ——— the stored state ———
  { name: 'stored: v2 on reads as on, with no session and no note', kind: 'stored', stored: { v: 2, enabled: true, autoOff: false, trip: null, posts: [T0], showing: true }, expected: { v: 3, enabled: true, session: null, token: '', tapSeen: [], tapAt: 0, lookRestUntil: 0 } },
  { name: 'stored: v2 paused reads as on', kind: 'stored', stored: { v: 2, enabled: true, autoOff: false, pausedUntil: T0 + 7 * D, pauseLevel: 1 }, expected: { enabled: true, session: null } },
  { name: 'stored: v2 turned off after unused reminders reads as off', kind: 'stored', stored: { v: 2, enabled: false, autoOff: true }, expected: { enabled: false } },
  {
    name: 'stored: v3 reads back as it was',
    kind: 'stored',
    stored: noted({ tapSeen: ['tok-a'], tapAt: T0 - S, lookRestUntil: T0 + M, lastDriveEndAt: T0 - H }, inCar()),
    expected: {
      v: 3,
      enabled: true,
      token: 'tok-a',
      tapSeen: ['tok-a'],
      tapAt: T0 - S,
      lookRestUntil: T0 + M,
      lastDriveEndAt: T0 - H,
      postedAt: T0 - 5 * M,
      session: { ...sess(inCar()), reminded: true },
    },
  },
  { name: 'stored: garbage is off', kind: 'stored', stored: 'nope', expected: { v: 3, enabled: false, session: null } },
  { name: 'stored: another version is off', kind: 'stored', stored: { ...noted(), v: 4 }, expected: { enabled: false, session: null, token: '' } },
  { name: 'stored: a v3 with a broken session is off', kind: 'stored', stored: { ...noted(), session: { startedAt: 'x' } }, expected: { enabled: false, session: null } },
];
