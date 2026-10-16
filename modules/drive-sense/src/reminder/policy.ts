// The forgot-to-start reminder's whole decision policy, as one pure reference (README "Forgot-to-start
// reminder"). Native code mirrors it line for line: `android/.../TripReminderPolicy.kt` (the shared
// part and the Android activity-transition part) and `ios/TripReminderPolicy.swift` with
// `ios/TripReminderWakePolicy.swift` (the shared part and the iOS wake, look and stop part), each
// under the SAME constant names with the SAME values (`__tests__/native-*.test.ts` compare them).
// `vectors.ts` is the decision table: Jest runs every row against this reference, and the on-device
// self-test runs each row its platform has through the native mirror (`src/reminder/selfTest.ts`).
//
// The rule is the SESSION: a stretch of driving that ends 30 min after its last driving moment
// (every driving moment restarts the 30 min; an open drive counts as driving). A session gets at
// most one reminder, posted only at a stop, only after the car reached driving speed with no drive
// open (and after the last drive ended), and never while a drive is open. Nothing else limits it.
//
// The reminder never starts a drive by itself. Its note carries a one-use token; a tap that JS
// claims (`claim`) is the only way the reminder leads to a drive, and JS then starts it through
// the same path as the Start Drive tap.
//
// Pure module: no imports. Every time is epoch ms. Functions never mutate their arguments.

export const REMINDER = {
  /** Under 3 mph = stopped (iOS). */
  STOP_MPS: 1.34,
  /** 10 mph = driving speed (iOS). */
  IOS_DRIVING_MPS: 4.47,
  /** A fix's speed counts only with a speed accuracy at or under this (m/s). */
  SPEED_ACC_MAX_MPS: 2,
  /** Stopped this long, by fix time, is a stop (iOS). */
  STOP_HOLD_MS: 12_000,
  /** 30 min without driving ends a session; also the lost-exit gap (Android). */
  SESSION_GAP_MS: 1_800_000,
  /** An Android note's timeout while the phone is in the vehicle, re-armed at each batch. */
  IN_VEHICLE_NOTE_MS: 10_800_000,
  /** A STILL ENTER counts as a stop only this soon after an IN_VEHICLE EXIT (Android). */
  STILL_AFTER_VEHICLE_MS: 120_000,
  /** A stop older than this when it arrives is not acted on (Android). */
  STALE_EVENT_MS: 45_000,
  /** Moving car motion this recent opens a session and starts a look (iOS). */
  AUTOMOTIVE_FRESH_MS: 120_000,
  /** Every motion history read covers the last 3 h (iOS). */
  IOS_MOTION_LOOKBACK_MS: 10_800_000,
  /** One GPS look lasts at most this long (iOS). */
  IOS_LOOK_MAX_MS: 600_000,
  /** A look that has not seen 10 mph for this long ends (iOS). */
  IOS_LOOK_NO_DRIVE_MS: 180_000,
  /** After a look that ran its full 10 min with no stop, no look for this long (battery; iOS). */
  IOS_LOOK_REST_MS: 600_000,
  /** A tap is claimed and its drive started within this of its hand-over to RoadWise. */
  TAP_FRESH_MS: 120_000,
  /** Android: how many handed-over tokens are remembered, so none is handed over twice. */
  TAP_SEEN_MAX: 8,
  /** A stored time further in the future than this is a clock change: it becomes now. */
  CLOCK_FUTURE_MS: 86_400_000,
} as const;

const R = REMINDER;

/** One stretch of driving. `inVehicle`, `vehicleExitAt` and `lastNewsAt` are Android's; iOS keeps them false and 0. */
export interface ReminderSession {
  startedAt: number;
  /** The last driving moment. */
  lastDrivingAt: number;
  /** Android: the newest report of any kind (the lost-exit rule). */
  lastNewsAt: number;
  /** Android: the phone reports being in a vehicle; the 30 min clock does not run meanwhile. */
  inVehicle: boolean;
  /** Android: the last IN_VEHICLE EXIT; 0 for none. */
  vehicleExitAt: number;
  /** Driving speed was reached with no drive open, after the last drive ended. */
  drove: boolean;
  /** This session has had its reminder. Never cleared inside the session. */
  reminded: boolean;
}

export interface ReminderState {
  v: 3;
  enabled: boolean;
  session: ReminderSession | null;
  lastDriveEndAt: number;
  /** The one-use token of the note that is up; '' = no note. */
  token: string;
  postedAt: number;
  /** Android: the tokens last handed to JS from a tap (newest last, at most TAP_SEEN_MAX). A token is handed over at most once. */
  tapSeen: string[];
  /** Android: when the live token's tap was handed over (0 = not yet). */
  tapAt: number;
  /** iOS: no GPS look before this (after a look that ran its full 10 min). */
  lookRestUntil: number;
}

export const INITIAL: ReminderState = {
  v: 3,
  enabled: false,
  session: null,
  lastDriveEndAt: 0,
  token: '',
  postedAt: 0,
  tapSeen: [],
  tapAt: 0,
  lookRestUntil: 0,
};

/** What the phone says at the moment of a decision. */
export interface ReminderCtx {
  /** Everything the platform needs is granted (Android: motion, Play services, notifications; iOS: Always, precise, motion, notifications). */
  permissionsOk: boolean;
  capturing: boolean;
  /** How old the stop was when it arrived (Android). */
  eventAgeMs: number;
  /** The driver is on foot (Android: walked or drove on after the stop; iOS: on foot now, at the look gate). */
  onFoot: boolean;
  /** How old the newest moving car motion is (iOS look gate); Infinity for none. */
  automotiveAgeMs: number;
}

export const CALM_CTX: ReminderCtx = {
  permissionsOk: true,
  capturing: false,
  eventAgeMs: 0,
  onFoot: false,
  automotiveAgeMs: 0,
};

export type GatePhase = 'wake' | 'look' | 'stop';

export type GateReason =
  | 'ok'
  | 'off'
  | 'permission'
  | 'capturing'
  | 'no-session'
  | 'reminded'
  | 'not-driven'
  | 'resting'
  | 'not-fresh'
  | 'stale'
  | 'on-foot';

const cloneSession = (x: ReminderSession | null): ReminderSession | null => (x ? { ...x } : null);
const clone = (s: ReminderState): ReminderState => ({ ...s, session: cloneSession(s.session), tapSeen: [...s.tapSeen] });

export function newSession(startedAt: number, lastDrivingAt: number, inVehicle: boolean): ReminderSession {
  return { startedAt, lastDrivingAt, lastNewsAt: lastDrivingAt, inVehicle, vehicleExitAt: 0, drove: false, reminded: false };
}

// ——— the shared rules (both mirrors) ———

/** A stored time more than a day ahead of `now` is a clock change: it becomes `now`. */
export function clampTimes(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  const past = (t: number): number => (t > now + R.CLOCK_FUTURE_MS ? now : t);
  s.lastDriveEndAt = past(s.lastDriveEndAt);
  s.postedAt = past(s.postedAt);
  s.tapAt = past(s.tapAt);
  s.lookRestUntil = past(s.lookRestUntil);
  const x = s.session;
  if (x) {
    x.startedAt = past(x.startedAt);
    x.lastDrivingAt = past(x.lastDrivingAt);
    x.lastNewsAt = past(x.lastNewsAt);
    x.vehicleExitAt = past(x.vehicleExitAt);
  }
  return s;
}

/**
 * The session ends at `t` once it is 30 min past its last driving moment, out of the vehicle, with
 * no drive open. Ending it drops the note's token (the caller takes the note down).
 */
export function endIfOver(s0: ReminderState, t: number, capturing: boolean): ReminderState {
  const x = s0.session;
  if (!x || capturing || x.inVehicle || t - x.lastDrivingAt < R.SESSION_GAP_MS) return s0;
  return { ...clone(s0), session: null, token: '', tapAt: 0 };
}

/** Brings the state up to `now`: clock jumps clamped, a session that is over ended. */
export function settle(s0: ReminderState, now: number, capturing: boolean): ReminderState {
  return endIfOver(clampTimes(s0, now), now, capturing);
}

/**
 * The first reason not to go on, in this order, or `ok`. `wake` is the cheap check before any
 * motion or GPS work; `look` decides whether a GPS look may start (iOS); `stop` whether a stop
 * reminds.
 */
export function gate(s: ReminderState, ctx: ReminderCtx, now: number, phase: GatePhase): GateReason {
  if (!s.enabled) return 'off';
  if (!ctx.permissionsOk) return 'permission';
  if (ctx.capturing) return 'capturing';
  if (phase === 'wake') return 'ok';
  const x = s.session;
  if (!x) return 'no-session';
  if (x.reminded) return 'reminded';
  if (phase === 'look') {
    if (now < s.lookRestUntil) return 'resting';
    if (ctx.automotiveAgeMs > R.AUTOMOTIVE_FRESH_MS || ctx.onFoot) return 'not-fresh';
    return 'ok';
  }
  if (!x.drove) return 'not-driven';
  if (ctx.eventAgeMs > R.STALE_EVENT_MS) return 'stale';
  if (ctx.onFoot) return 'on-foot';
  return 'ok';
}

/** The reminder went up with `token`: the session is reminded. */
export function posted(s0: ReminderState, now: number, token: string): ReminderState {
  const s = clone(s0);
  if (s.session) s.session.reminded = true;
  s.token = token;
  s.postedAt = now;
  s.tapAt = 0;
  return s;
}

/** The note with `token` never showed: the post is taken back, and the session may remind at its next stop. */
export function unposted(s0: ReminderState, token: string): ReminderState {
  if (token === '' || s0.token !== token) return s0;
  const s = clone(s0);
  s.token = '';
  s.tapAt = 0;
  if (s.session) s.session.reminded = false;
  return s;
}

/** The note is gone (iOS: the reminder lost a permission it needs): its token goes; the session stays reminded. */
export function noteGone(s0: ReminderState): ReminderState {
  return { ...clone(s0), token: '', tapAt: 0 };
}

/**
 * Android: a tap's token read from an intent. A token handed over before (`tapSeen`) is not handed
 * over again, whatever happened to the process. The live token's hand-over time is kept for the claim.
 */
export function tapDelivered(s0: ReminderState, token: string, now: number): { state: ReminderState; delivered: boolean } {
  if (s0.tapSeen.includes(token)) return { state: s0, delivered: false };
  const s = clone(s0);
  s.tapSeen = [...s.tapSeen, token].slice(-R.TAP_SEEN_MAX);
  if (token !== '' && token === s.token) s.tapAt = now;
  return { state: s, delivered: true };
}

/**
 * A tap JS asks to start a drive from. True only once, with the note's own token, while the reminder
 * is on, its session lasts and no drive is open, and (Android, `requireDelivery`) within 2 min of the
 * tap's hand-over. True consumes the token.
 */
export function claim(
  s0: ReminderState,
  token: string,
  now: number,
  capturing: boolean,
  requireDelivery: boolean
): { state: ReminderState; ok: boolean } {
  const s = settle(s0, now, capturing);
  const fresh = !requireDelivery || (s.tapAt > 0 && now - s.tapAt <= R.TAP_FRESH_MS);
  const ok = s.enabled && token !== '' && token === s.token && s.session !== null && !capturing && fresh;
  if (!ok) return { state: s, ok: false };
  return { state: { ...clone(s), token: '', tapAt: 0 }, ok: true };
}

/** A drive started (any way): the note goes, and driving speed must be seen again after the drive. */
export function captureStarted(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  s.token = '';
  s.tapAt = 0;
  const x = s.session;
  if (x) {
    x.drove = false;
    x.lastDrivingAt = Math.max(x.lastDrivingAt, now);
    x.lastNewsAt = Math.max(x.lastNewsAt, now);
  }
  return s;
}

/**
 * A drive ended. Its driving end is the session's last driving moment: `drivingEndedAt` omitted =
 * now; null (a drive that was not kept) = the session's clock is left as it was; a time = that time
 * (never later than now). The vehicle state is left to the reports.
 */
export function captureEnded(s0: ReminderState, now: number, drivingEndedAt?: number | null): ReminderState {
  const s = clone(s0);
  s.lastDriveEndAt = now;
  const x = s.session;
  if (x) {
    x.drove = false;
    x.lastNewsAt = Math.max(x.lastNewsAt, now);
    if (drivingEndedAt !== null) x.lastDrivingAt = Math.max(x.lastDrivingAt, Math.min(now, drivingEndedAt ?? now));
  }
  return s;
}

/** On keeps the session; off forgets everything. */
export function setEnabled(s0: ReminderState, on: boolean): ReminderState {
  if (!on) return clone(INITIAL);
  return { ...clone(s0), enabled: true };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStr = (v: unknown): v is string => typeof v === 'string';

function sessionOf(v: unknown): ReminderSession | null | undefined {
  if (v === null) return null;
  if (!isRec(v)) return undefined;
  const { startedAt, lastDrivingAt, lastNewsAt, inVehicle, vehicleExitAt, drove, reminded } = v;
  if (!isNum(startedAt) || !isNum(lastDrivingAt) || !isNum(lastNewsAt) || !isBool(inVehicle) || !isNum(vehicleExitAt) || !isBool(drove) || !isBool(reminded)) {
    return undefined;
  }
  return { startedAt, lastDrivingAt, lastNewsAt, inVehicle, vehicleExitAt, drove, reminded };
}

/**
 * The stored state: v3 as it is; v2 (the reminder before sessions) keeps only its switch; anything
 * else (nothing, garbage, another version) is off.
 */
export function fromStored(json: unknown): ReminderState {
  if (!isRec(json)) return clone(INITIAL);
  if (json.v === 2) return { ...clone(INITIAL), enabled: json.enabled === true };
  if (json.v !== 3) return clone(INITIAL);
  const session = sessionOf(json.session);
  const { enabled, lastDriveEndAt, token, postedAt, tapSeen, tapAt, lookRestUntil } = json;
  if (session === undefined || !isBool(enabled) || !isNum(lastDriveEndAt) || !isStr(token) || !isNum(postedAt) || !Array.isArray(tapSeen) || !tapSeen.every(isStr) || !isNum(tapAt) || !isNum(lookRestUntil)) {
    return clone(INITIAL);
  }
  return { v: 3, enabled, session, lastDriveEndAt, token, postedAt, tapSeen: (tapSeen as string[]).slice(-R.TAP_SEEN_MAX), tapAt, lookRestUntil };
}

// ——— Android: Activity Recognition transitions ———

/** The Android activity-transition subscription. One PendingIntent; each request replaces the last. */
export type TransitionTier = 'none' | 'capture' | 'idle' | 'session';

export function tier(s: ReminderState, capturing: boolean, transitionsOk: boolean): TransitionTier {
  if (!transitionsOk) return 'none';
  if (capturing) return 'capture';
  if (!s.enabled) return 'none';
  return s.session ? 'session' : 'idle';
}

export type TransitionKind = 'vehicle-enter' | 'vehicle-exit' | 'still-enter' | 'walking-enter' | 'running-enter';

export interface Transition {
  kind: TransitionKind;
  ts: number;
}

export type TransitionEffect = 'none' | 'post' | 'refresh' | 'withdraw';

export interface TransitionResult {
  state: ReminderState;
  /** post: a new note (replacing any); withdraw: the batch dropped the note's token; refresh: a note is up (re-arm its timeout). */
  effect: TransitionEffect;
  /** The stop's gate reason, when the batch held a stop. */
  reason?: GateReason;
  /** When the note must be gone by (its system timeout); 0 or less than now = cancel instead. */
  expiresAt: number;
}

/**
 * An Android note's timeout: 3 h after `now` while the phone is in the vehicle, else the session's
 * end. 0 with no session.
 */
export function noteExpiresAt(s: ReminderState, now: number): number {
  const x = s.session;
  if (!x) return 0;
  return x.inVehicle ? now + R.IN_VEHICLE_NOTE_MS : x.lastDrivingAt + R.SESSION_GAP_MS;
}

const exitFirst = (e: Transition): number => (e.kind === 'vehicle-exit' ? 0 : 1);
const byTime = (a: Transition, b: Transition): number => a.ts - b.ts || exitFirst(a) - exitFirst(b);

/**
 * The current activity Play services replays at each (re)subscribe, read as the state at
 * `subscribedAt`: it never opens a session, never posts and never marks driving speed.
 */
function applyReplay(s: ReminderState, e: Transition, subscribedAt: number): void {
  const x = s.session;
  if (!x) return;
  x.lastNewsAt = Math.max(x.lastNewsAt, subscribedAt);
  if (e.kind === 'vehicle-enter') {
    x.inVehicle = true;
    x.lastDrivingAt = Math.max(x.lastDrivingAt, subscribedAt);
  } else if (x.inVehicle) {
    x.inVehicle = false;
  }
}

/** The newest replayed event, or null. */
function newestReplay(events: readonly Transition[], subscribedAt: number): Transition | null {
  const replays = events.filter((e) => e.ts < subscribedAt).sort(byTime);
  return replays.length > 0 ? replays[replays.length - 1]! : null;
}

/**
 * One delivered batch with no drive open, read whole before acting. Events before `subscribedAt`
 * are the replay (state only). Live events are read in time order, EXIT first at the same time,
 * each after deciding the session's end on its own time. A stop is a STILL ENTER at most 2 min
 * after an IN_VEHICLE EXIT; it reminds only if nothing later in the batch says the driver walked off
 * or drove on, and only through the stop gate.
 */
export function onTransitions(
  s0: ReminderState,
  events: readonly Transition[],
  arrival: number,
  subscribedAt: number,
  ctx: ReminderCtx,
  newToken: string
): TransitionResult {
  let s = clampTimes(s0, arrival);
  const tokenBefore = s.token;
  const cap = ctx.capturing;
  const replay = newestReplay(events, subscribedAt);
  if (replay) {
    s = clone(endIfOver(s, subscribedAt, cap));
    applyReplay(s, replay, subscribedAt);
  }
  let stop: Transition | null = null;
  let stopSession = 0;
  let afterStop = false;
  for (const e of events.filter((x) => x.ts >= subscribedAt).sort(byTime)) {
    s = clone(endIfOver(s, e.ts, cap));
    const x = s.session;
    if (e.kind === 'vehicle-enter') {
      const drove = e.ts > s.lastDriveEndAt;
      if (!x) {
        s.session = { ...newSession(e.ts, e.ts, true), drove };
      } else if (x.inVehicle && e.ts - x.lastNewsAt >= R.SESSION_GAP_MS) {
        // A lost EXIT: the old session ends here and a new one opens.
        s = { ...s, session: { ...newSession(e.ts, e.ts, true), drove }, token: '', tapAt: 0 };
      } else {
        x.inVehicle = true;
        x.lastDrivingAt = Math.max(x.lastDrivingAt, e.ts);
        x.lastNewsAt = Math.max(x.lastNewsAt, e.ts);
        x.drove = x.drove || drove;
      }
      if (stop) afterStop = true;
    } else if (e.kind === 'vehicle-exit') {
      if (x) {
        x.inVehicle = false;
        x.lastDrivingAt = Math.max(x.lastDrivingAt, e.ts);
        x.lastNewsAt = Math.max(x.lastNewsAt, e.ts);
        x.vehicleExitAt = e.ts;
      }
    } else if (e.kind === 'walking-enter' || e.kind === 'running-enter') {
      if (x) {
        if (x.inVehicle) {
          x.inVehicle = false;
          x.lastDrivingAt = Math.max(x.lastDrivingAt, e.ts);
        }
        x.lastNewsAt = Math.max(x.lastNewsAt, e.ts);
      }
      if (stop) afterStop = true;
    } else if (x) {
      x.lastNewsAt = Math.max(x.lastNewsAt, e.ts);
      if (!x.inVehicle && x.vehicleExitAt > 0 && e.ts >= x.vehicleExitAt && e.ts - x.vehicleExitAt <= R.STILL_AFTER_VEHICLE_MS) {
        stop = e;
        stopSession = x.startedAt;
        afterStop = false;
      }
    }
  }
  s = endIfOver(s, arrival, cap);
  let effect: TransitionEffect = tokenBefore !== '' && s.token === '' ? 'withdraw' : s.token !== '' ? 'refresh' : 'none';
  let reason: GateReason | undefined;
  if (stop && s.session && s.session.startedAt === stopSession) {
    reason = gate(s, { ...ctx, eventAgeMs: arrival - stop.ts, onFoot: afterStop }, arrival, 'stop');
    if (reason === 'ok') {
      s = posted(s, arrival, newToken);
      effect = 'post';
    }
  }
  const out: TransitionResult = { state: s, effect, expiresAt: noteExpiresAt(s, arrival) };
  if (reason !== undefined) out.reason = reason;
  return out;
}

/**
 * A batch the capture's feed got while a drive is open: the vehicle state only. It never ends a
 * session (a drive is open), never posts, never marks driving speed and never touches the token.
 */
export function foldCaptureTransitions(s0: ReminderState, events: readonly Transition[], subscribedAt: number): ReminderState {
  if (!s0.session) return s0;
  const s = clone(s0);
  const x = s.session!;
  const replay = newestReplay(events, subscribedAt);
  if (replay) applyReplay(s, replay, subscribedAt);
  for (const e of events.filter((v) => v.ts >= subscribedAt).sort(byTime)) {
    x.lastNewsAt = Math.max(x.lastNewsAt, e.ts);
    if (e.kind === 'vehicle-enter') x.inVehicle = true;
    else if (e.kind === 'vehicle-exit' || e.kind === 'walking-enter' || e.kind === 'running-enter') x.inVehicle = false;
  }
  return s;
}

// ——— iOS: significant-location wake, motion history, GPS look ———

/** One CoreMotion activity, reduced to what the reminder reads. */
export interface Activity {
  start: number;
  automotive: boolean;
  /** A car standing still (automotive + stationary) is not driving. */
  stationary: boolean;
  /** walking, running or cycling */
  onFoot: boolean;
  /** confidence medium or high */
  confident: boolean;
}

export interface MotionSummary {
  /** End of the newest confident moving car stretch; 0 for none. */
  lastAutomotiveAt: number;
  /**
   * Start of the current run of moving car stretches; 0 for none. Only 30 min without moving car
   * motion ends a run (a walk between two stretches does not: a session ends only by time).
   */
  automotiveSince: number;
  /** The newest activity is a confident walk, run or ride. */
  onFootNow: boolean;
}

/** Each activity lasts until the next one starts (the newest until now). A car standing still is neither driving nor a break. */
export function summarizeActivities(list: readonly Activity[], now: number): MotionSummary {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  let lastAutomotiveAt = 0;
  let automotiveSince = 0;
  let onFootNow = false;
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    const end = i + 1 < sorted.length ? sorted[i + 1]!.start : now;
    onFootNow = a.onFoot && a.confident;
    if (a.automotive && !a.stationary && a.confident) {
      if (automotiveSince === 0 || a.start - lastAutomotiveAt >= R.SESSION_GAP_MS) automotiveSince = a.start;
      lastAutomotiveAt = end;
    }
  }
  return { lastAutomotiveAt, automotiveSince, onFootNow };
}

/**
 * The motion history folded into the session: a moving car run that began 30 min or more after
 * the session's last driving moment ends it (a new trip after a park with no wake between);
 * otherwise the newest moving car motion is a driving moment. Then the time rule.
 */
export function foldMotion(s0: ReminderState, now: number, m: MotionSummary, capturing: boolean): ReminderState {
  let s = s0;
  const x = s.session;
  if (x) {
    if (!capturing && m.automotiveSince > 0 && m.automotiveSince - x.lastDrivingAt >= R.SESSION_GAP_MS) {
      s = { ...clone(s), session: null, token: '', tapAt: 0 };
    } else if (m.lastAutomotiveAt > x.lastDrivingAt) {
      s = clone(s);
      s.session!.lastDrivingAt = m.lastAutomotiveAt;
    }
  }
  return endIfOver(s, now, capturing);
}

export interface WakeResult {
  state: ReminderState;
  effect: 'none' | 'start-look';
  reason: GateReason;
  /** The note's token went (its session ended): the caller takes the note down. */
  dropped: boolean;
}

/**
 * A significant-location wake, after its motion history read. A session opens only on moving car
 * motion from the last 2 min with the driver not on foot; a GPS look starts only through the look gate.
 */
export function onWake(s0: ReminderState, now: number, motion: MotionSummary, ctx: ReminderCtx): WakeResult {
  const c0 = clampTimes(s0, now);
  const pre = gate(c0, ctx, now, 'wake');
  if (pre !== 'ok') {
    const s = endIfOver(c0, now, ctx.capturing);
    return { state: s, effect: 'none', reason: pre, dropped: c0.token !== '' && s.token === '' };
  }
  let s = foldMotion(c0, now, motion, ctx.capturing);
  const a = motion.lastAutomotiveAt;
  const fresh = a > 0 && now - a <= R.AUTOMOTIVE_FRESH_MS && !motion.onFootNow;
  if (!s.session && fresh) {
    s = { ...clone(s), session: newSession(motion.automotiveSince > 0 ? motion.automotiveSince : a, a, false), lookRestUntil: 0 };
  }
  const reason = gate(s, { ...ctx, automotiveAgeMs: a > 0 ? now - a : Infinity, onFoot: motion.onFootNow }, now, 'look');
  return { state: s, effect: reason === 'ok' ? 'start-look' : 'none', reason, dropped: c0.token !== '' && s.token === '' };
}

/** A bounded GPS look for a stop (iOS). */
export interface LookTracker {
  /** The look began; it lasts until IOS_LOOK_MAX_MS after this. */
  startedAt: number;
  /** Looking for a stop since (the 3 min no-drive rule). */
  seekSince: number;
  sawDriving: boolean;
  /** The last fix at 10 mph or more; 0 for none. */
  lastFastAt: number;
  /** The first stopped fix's time; 0 = not stopped. */
  stopStart: number;
}

export interface Fix {
  t: number;
  /** m/s; negative = unknown */
  speed: number;
  /** m/s; negative = unknown */
  speedAcc: number;
}

export type FixVerdict = 'none' | 'stopped' | 'no-drive' | 'look-max';

export function newLook(now: number): LookTracker {
  return { startedAt: now, seekSince: now, sawDriving: false, lastFastAt: 0, stopStart: 0 };
}

/** Back to looking for the next stop: 10 mph must be seen again first. */
export function seekAgain(tr: LookTracker, now: number): LookTracker {
  return { ...tr, seekSince: now, sawDriving: false, stopStart: 0 };
}

/** The look's clocks: 10 min at most; 3 min without 10 mph ends it. */
export function lookClock(tr: LookTracker, now: number): FixVerdict {
  if (now - tr.startedAt >= R.IOS_LOOK_MAX_MS) return 'look-max';
  if (!tr.sawDriving && now - tr.seekSince >= R.IOS_LOOK_NO_DRIVE_MS) return 'no-drive';
  return 'none';
}

/** One GPS fix: 10 mph first, then under 3 mph held 12 s is a stop (a fix with no usable speed neither makes nor breaks the hold). */
export function onFix(tr0: LookTracker, fix: Fix, now: number): { tracker: LookTracker; verdict: FixVerdict } {
  const tr = { ...tr0 };
  const clock = lookClock(tr, now);
  if (clock !== 'none') return { tracker: tr, verdict: clock };
  const valid = fix.speed >= 0 && fix.speedAcc >= 0 && fix.speedAcc <= R.SPEED_ACC_MAX_MPS;
  if (!valid) return { tracker: tr, verdict: 'none' };
  if (fix.speed >= R.IOS_DRIVING_MPS) {
    tr.sawDriving = true;
    tr.stopStart = 0;
    tr.lastFastAt = Math.max(tr.lastFastAt, fix.t);
    return { tracker: tr, verdict: 'none' };
  }
  if (!tr.sawDriving) return { tracker: tr, verdict: 'none' };
  if (fix.speed >= R.STOP_MPS) {
    tr.stopStart = 0;
    return { tracker: tr, verdict: 'none' };
  }
  if (tr.stopStart === 0) tr.stopStart = fix.t;
  return { tracker: tr, verdict: fix.t - tr.stopStart >= R.STOP_HOLD_MS ? 'stopped' : 'none' };
}

/** A look's last 10 mph fix is a driving moment. */
function foldFast(s: ReminderState, lastFastAt: number): ReminderState {
  const x = s.session;
  if (!x || lastFastAt <= x.lastDrivingAt) return s;
  const c = clone(s);
  c.session!.lastDrivingAt = lastFastAt;
  return c;
}

export interface StopResult {
  state: ReminderState;
  /** post; arrival (walked off: no post, the session goes on); end (no post). Every outcome ends the look. */
  effect: 'post' | 'arrival' | 'end';
  reason: GateReason;
}

/** A held stop after its checks. The look saw 10 mph (`lastFastAt`), with no drive open: driving speed. */
export function onStop(s0: ReminderState, ctx: ReminderCtx, now: number, walked: boolean, token: string, lastFastAt: number): StopResult {
  let s = endIfOver(foldFast(s0, lastFastAt), now, ctx.capturing);
  if (walked) return { state: s, effect: 'arrival', reason: 'on-foot' };
  if (s.session && lastFastAt > s.lastDriveEndAt && !ctx.capturing) {
    s = clone(s);
    s.session!.drove = true;
  }
  const reason = gate(s, { ...ctx, eventAgeMs: 0, onFoot: false }, now, 'stop');
  if (reason === 'ok') return { state: posted(s, now, token), effect: 'post', reason };
  return { state: s, effect: 'end', reason };
}

export type LookEnd = FixVerdict | 'ended';

/** A look ended: its last 10 mph fix folds in; one that ran its full 10 min rests the next for 10 min. */
export function lookEnded(s0: ReminderState, now: number, lastFastAt: number, verdict: LookEnd): ReminderState {
  const s = clone(foldFast(s0, lastFastAt));
  if (verdict === 'look-max') s.lookRestUntil = now + R.IOS_LOOK_REST_MS;
  return s;
}

// ——— status (what Settings shows) ———

export type TripReminderMissing = 'motion' | 'notifications' | 'locationAlways' | 'locationPrecise';

export interface TripReminderStatus {
  enabled: boolean;
  state: 'off' | 'on' | 'needs' | 'unavailable';
  /** What is missing; only for `needs`. */
  missing: TripReminderMissing[];
}

export function statusOf(s: ReminderState, available: boolean, missing: readonly TripReminderMissing[]): TripReminderStatus {
  const base = { enabled: s.enabled, missing: [] as TripReminderMissing[] };
  if (!available) return { ...base, state: 'unavailable' };
  if (!s.enabled) return { ...base, state: 'off' };
  if (missing.length > 0) return { ...base, state: 'needs', missing: [...missing] };
  return { ...base, state: 'on' };
}
