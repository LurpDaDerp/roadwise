// The forgot-to-start reminder's whole decision policy, as one pure reference (README "Forgot-to-start
// reminder"). Native code mirrors it line for line: `android/.../TripReminderPolicy.kt` (the shared
// part and the Android activity-transition part) and `ios/TripReminderPolicy.swift` (the shared part
// and the iOS wake, fix and stop part), each under the SAME constant names with the SAME values
// (`__tests__/native-*.test.ts` compare them). `vectors.ts` is the decision table every rule is
// checked against.
//
// The reminder only ever notifies. Nothing here, or in either mirror, starts a drive: the driver
// taps the notification, RoadWise opens on Home, and the driver taps Start Drive there.
//
// Pure module: no imports. Every time is epoch ms. Functions never mutate their arguments.

export const REMINDER = {
  /** Under 3 mph (`START_MAX_MPH`) = stopped (iOS). */
  STOP_MPS: 1.34,
  /** Above 5 mph while the reminder shows = driving again (iOS). */
  MOVE_MPS: 2.24,
  /** 10 mph must be seen before a stop counts (iOS). */
  IOS_DRIVING_MPS: 4.47,
  /** A fix's speed counts only with a speed accuracy at or under this (m/s). */
  SPEED_ACC_MAX_MPS: 2,
  /** Stopped this long, by fix time, is a stop (iOS). */
  STOP_HOLD_MS: 12_000,
  /** Moved this far from the stop while the reminder shows = moved on (iOS). */
  MOVED_AWAY_M: 30,
  /** How far back the walking check looks when the phone moved away from the stop (iOS). */
  WALK_CHECK_MS: 30_000,
  /** Withdrawn by driving within this = unseen, not a miss (iOS). */
  UNSEEN_MS: 20_000,
  /** Posts a trip may have again after an unseen one. */
  MAX_RETRIES_PER_TRIP: 1,
  /** A STILL ENTER counts only this soon after an IN_VEHICLE EXIT (Android). */
  STILL_AFTER_VEHICLE_MS: 120_000,
  /** A stop older than this when it arrives is not acted on (Android). */
  STALE_EVENT_MS: 45_000,
  /** A trip must be this old before a stop reminds. */
  MIN_IN_VEHICLE_MS: 90_000,
  /** Out of the vehicle this long closes the trip. */
  TRIP_GAP_MS: 600_000,
  /** "In vehicle" with no news for this long closes the trip. */
  MAX_TRIP_IDLE_MS: 10_800_000,
  /** No reminder this soon after a drive ended. */
  AFTER_DRIVE_MS: 600_000,
  /** Quiet after a post, lifted if it led to a drive or went unseen. */
  UNUSED_QUIET_MS: 14_400_000,
  DAY_MS: 86_400_000,
  /** Posts in any rolling 24 h, unseen ones included. */
  DAILY_CAP: 2,
  /** A reminder is withdrawn after this. */
  TTL_MS: 300_000,
  /** A drive started this soon after a post = the reminder helped. */
  CONVERT_WINDOW_MS: 1_800_000,
  /** Unused reminders in a row that take the next back-off step. */
  MISS_LIMIT: 3,
  /** "Not driving" = quiet this long. */
  NOT_DRIVING_QUIET_MS: 43_200_000,
  /** The newest car motion must be this recent to open a trip (iOS). */
  AUTOMOTIVE_FRESH_MS: 120_000,
  /** The motion history a wake reads: at least this far back… (iOS) */
  IOS_MOTION_MIN_LOOKBACK_MS: 600_000,
  /** …and at most this far back (iOS). */
  IOS_MOTION_MAX_LOOKBACK_MS: 10_800_000,
  /** One GPS session looks for a stop for at most this long (iOS). */
  IOS_SESSION_MAX_MS: 600_000,
  /** A session that has not seen 10 mph by then ends (iOS). */
  IOS_SESSION_NO_DRIVE_MS: 180_000,
  /** GPS sessions per trip (iOS). */
  IOS_SESSIONS_PER_TRIP: 2,
  /** A second session only this long after the first ended (iOS). */
  IOS_SESSION_SPACING_MS: 600_000,
  /** A stored time further in the future than this is a clock change: it becomes now. */
  CLOCK_FUTURE_MS: 86_400_000,
} as const;

/** The back-off pauses, in days; the step after the last turns the reminder off. */
export const PAUSE_DAYS = [7, 28] as const;

/** The longest pause, 28 days: a stored pause end later than that is a clock change. */
const MAX_PAUSE_MS = 28 * REMINDER.DAY_MS;

const R = REMINDER;

export interface ReminderTrip {
  startedAt: number;
  /** The last moment the phone was known to be in the car. */
  lastVehicleAt: number;
  inVehicle: boolean;
  /** Android: the last IN_VEHICLE EXIT; 0 for none. */
  vehicleExitAt: number;
  /** A drive was open in this trip. */
  recorded: boolean;
  /** This trip has had its reminder. */
  reminded: boolean;
  retries: number;
  /** iOS GPS sessions used. */
  sessions: number;
  lastSessionEndAt: number;
}

export interface ReminderState {
  v: 2;
  enabled: boolean;
  /** Off because nine reminders in a row went unused. */
  autoOff: boolean;
  trip: ReminderTrip | null;
  lastCaptureEndAt: number;
  /** Post times in the last 24 h. */
  posts: number[];
  /** The post still waiting for its outcome; 0 for none. */
  pendingAt: number;
  postedAt: number;
  /** The notification is up. */
  showing: boolean;
  missStreak: number;
  pauseLevel: number;
  pausedUntil: number;
  quietUntil: number;
  notDrivingUntil: number;
}

export const INITIAL: ReminderState = {
  v: 2,
  enabled: false,
  autoOff: false,
  trip: null,
  lastCaptureEndAt: 0,
  posts: [],
  pendingAt: 0,
  postedAt: 0,
  showing: false,
  missStreak: 0,
  pauseLevel: 0,
  pausedUntil: 0,
  quietUntil: 0,
  notDrivingUntil: 0,
};

/** What the phone says at the moment of a decision. */
export interface ReminderCtx {
  /** Everything the platform needs is granted (motion, notifications; iOS: Always, precise). */
  permissionsOk: boolean;
  capturing: boolean;
  appForeground: boolean;
  inCall: boolean;
  /** iOS Low Power Mode. */
  lowPower: boolean;
  /** How old the stop was when it arrived (Android). */
  eventAgeMs: number;
  /** The driver is on foot after the stop. */
  onFoot: boolean;
  /** How old the newest car motion is (iOS); Infinity for none. */
  automotiveAgeMs: number;
}

export const CALM_CTX: ReminderCtx = {
  permissionsOk: true,
  capturing: false,
  appForeground: false,
  inCall: false,
  lowPower: false,
  eventAgeMs: 0,
  onFoot: false,
  automotiveAgeMs: 0,
};

export type GatePhase = 'wake' | 'session' | 'stop';

export type GateReason =
  | 'ok'
  | 'off'
  | 'paused'
  | 'quiet'
  | 'permission'
  | 'capturing'
  | 'no-trip'
  | 'recorded'
  | 'reminded'
  | 'after-drive'
  | 'daily-cap'
  | 'low-power'
  | 'sessions'
  | 'foreground'
  | 'not-fresh'
  | 'too-soon'
  | 'in-call'
  | 'stale'
  | 'on-foot';

export type Outcome = 'converted' | 'unseen' | 'arrival' | 'notDriving' | 'missed';

const clone = (s: ReminderState): ReminderState => ({ ...s, trip: s.trip ? { ...s.trip } : null, posts: [...s.posts] });

export function newTrip(startedAt: number, lastVehicleAt: number = startedAt): ReminderTrip {
  return {
    startedAt,
    lastVehicleAt,
    inVehicle: true,
    vehicleExitAt: 0,
    recorded: false,
    reminded: false,
    retries: 0,
    sessions: 0,
    lastSessionEndAt: 0,
  };
}

// ——— the shared rules (both mirrors) ———

/** Posts in the 24 h up to `now`. */
export const recentPosts = (s: ReminderState, now: number): number => s.posts.filter((p) => now - p < R.DAY_MS).length;

/**
 * Brings the state up to `now`: clamps clock jumps, drops posts older than a day, ends an expired
 * pause, closes a trip that is over, takes down a reminder past its 5 min, and counts a post with
 * no drive 30 min on as a miss.
 */
export function settle(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  const past = (t: number): number => (t > now + R.CLOCK_FUTURE_MS ? now : t);
  s.lastCaptureEndAt = past(s.lastCaptureEndAt);
  s.pendingAt = past(s.pendingAt);
  s.postedAt = past(s.postedAt);
  s.posts = s.posts.map(past).filter((p) => now - p < R.DAY_MS);
  s.pausedUntil = Math.min(s.pausedUntil, now + MAX_PAUSE_MS);
  s.quietUntil = Math.min(s.quietUntil, now + R.UNUSED_QUIET_MS);
  s.notDrivingUntil = Math.min(s.notDrivingUntil, now + R.NOT_DRIVING_QUIET_MS);
  if (s.pausedUntil !== 0 && now >= s.pausedUntil) s.pausedUntil = 0;
  if (s.quietUntil !== 0 && now >= s.quietUntil) s.quietUntil = 0;
  if (s.notDrivingUntil !== 0 && now >= s.notDrivingUntil) s.notDrivingUntil = 0;
  const t = s.trip;
  if (t) {
    t.startedAt = past(t.startedAt);
    t.lastVehicleAt = past(t.lastVehicleAt);
    t.vehicleExitAt = past(t.vehicleExitAt);
    t.lastSessionEndAt = past(t.lastSessionEndAt);
    const idle = now - t.lastVehicleAt;
    if ((!t.inVehicle && idle >= R.TRIP_GAP_MS) || idle >= R.MAX_TRIP_IDLE_MS) s.trip = null;
  }
  if (s.showing && now - s.postedAt >= R.TTL_MS) s.showing = false;
  if (s.pendingAt > 0 && now - s.pendingAt >= R.CONVERT_WINDOW_MS) resolveIn(s, 'missed', now);
  return s;
}

/**
 * The first reason not to remind now, checked in this order, or `ok`. `wake` is the cheap check
 * before any motion or GPS work (no trip yet); `session` adds the iOS GPS-session rules; `stop`
 * the rules for the stop itself.
 */
export function gate(s: ReminderState, ctx: ReminderCtx, now: number, phase: GatePhase): GateReason {
  if (!s.enabled) return 'off';
  if (now < s.pausedUntil) return 'paused';
  if (now < Math.max(s.quietUntil, s.notDrivingUntil)) return 'quiet';
  if (!ctx.permissionsOk) return 'permission';
  if (ctx.capturing) return 'capturing';
  const t = s.trip;
  if (phase !== 'wake') {
    if (!t) return 'no-trip';
    if (t.recorded) return 'recorded';
    if (t.reminded) return 'reminded';
  }
  if (s.lastCaptureEndAt > 0 && now - s.lastCaptureEndAt < R.AFTER_DRIVE_MS) return 'after-drive';
  if (recentPosts(s, now) >= R.DAILY_CAP) return 'daily-cap';
  if (phase === 'wake') {
    if (ctx.lowPower) return 'low-power';
    if (ctx.appForeground) return 'foreground';
    return 'ok';
  }
  if (!t) return 'no-trip';
  if (phase === 'session') {
    if (ctx.lowPower) return 'low-power';
    if (t.sessions >= R.IOS_SESSIONS_PER_TRIP) return 'sessions';
    if (t.lastSessionEndAt > 0 && now - t.lastSessionEndAt < R.IOS_SESSION_SPACING_MS) return 'sessions';
    if (ctx.appForeground) return 'foreground';
    if (ctx.automotiveAgeMs > R.AUTOMOTIVE_FRESH_MS) return 'not-fresh';
    return 'ok';
  }
  if (now - t.startedAt < R.MIN_IN_VEHICLE_MS) return 'too-soon';
  if (ctx.appForeground) return 'foreground';
  if (ctx.inCall) return 'in-call';
  if (ctx.eventAgeMs > R.STALE_EVENT_MS) return 'stale';
  if (ctx.onFoot) return 'on-foot';
  return 'ok';
}

function postedIn(s: ReminderState, now: number): void {
  s.posts.push(now);
  if (s.trip) s.trip.reminded = true;
  s.pendingAt = now;
  s.postedAt = now;
  s.showing = true;
  s.quietUntil = now + R.UNUSED_QUIET_MS;
}

/** The reminder went up. */
export function posted(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  postedIn(s, now);
  return s;
}

function missIn(s: ReminderState, now: number): void {
  s.missStreak += 1;
  if (s.missStreak < R.MISS_LIMIT) return;
  s.missStreak = 0;
  const days = PAUSE_DAYS[s.pauseLevel];
  if (days !== undefined) {
    s.pausedUntil = now + days * R.DAY_MS;
    s.pauseLevel += 1;
  } else {
    s.enabled = false;
    s.autoOff = true;
    s.pausedUntil = 0;
  }
}

function resolveIn(s: ReminderState, outcome: Outcome, now: number): void {
  s.showing = false;
  s.pendingAt = 0;
  switch (outcome) {
    case 'converted':
      s.missStreak = 0;
      s.pauseLevel = 0;
      s.quietUntil = 0;
      return;
    case 'unseen':
      s.quietUntil = 0;
      if (s.trip && s.trip.retries < R.MAX_RETRIES_PER_TRIP) {
        s.trip.retries += 1;
        s.trip.reminded = false;
      }
      return;
    case 'arrival':
      return;
    case 'notDriving':
      s.notDrivingUntil = now + R.NOT_DRIVING_QUIET_MS;
      missIn(s, now);
      return;
    case 'missed':
      missIn(s, now);
      return;
  }
}

/** What became of a post (§ outcomes); every outcome takes the notification down. */
export function resolve(s0: ReminderState, outcome: Outcome, now: number): ReminderState {
  const s = clone(s0);
  resolveIn(s, outcome, now);
  return s;
}

/** A drive started: this trip is recorded, and a reminder posted in the last 30 min helped. */
export function captureStarted(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  if (!s.trip) s.trip = newTrip(now);
  s.trip.recorded = true;
  if (s.pendingAt > 0 && now - s.pendingAt <= R.CONVERT_WINDOW_MS) resolveIn(s, 'converted', now);
  s.showing = false;
  return s;
}

/** A drive ended: none for 10 min, and the trip's car time ends here. */
export function captureEnded(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  s.lastCaptureEndAt = now;
  if (s.trip) {
    s.trip.inVehicle = false;
    s.trip.lastVehicleAt = now;
  }
  return s;
}

/** RoadWise came to the front: Home is on screen, so the notification goes. */
export function appForeground(s0: ReminderState): ReminderState {
  const s = clone(s0);
  s.showing = false;
  return s;
}

/** On clears every back-off and quiet; off forgets everything. */
export function setEnabled(s0: ReminderState, on: boolean): ReminderState {
  if (!on) return clone(INITIAL);
  return {
    ...clone(s0),
    enabled: true,
    autoOff: false,
    pausedUntil: 0,
    missStreak: 0,
    pauseLevel: 0,
    quietUntil: 0,
    notDrivingUntil: 0,
  };
}

// ——— Android: Activity Recognition transitions ———

/** The Android activity-transition subscription. One PendingIntent; each request replaces the last. */
export type TransitionTier = 'none' | 'capture' | 'idle' | 'trip';

export function tier(s: ReminderState, capturing: boolean, transitionsOk: boolean): TransitionTier {
  if (!transitionsOk) return 'none';
  if (capturing) return 'capture';
  if (!s.enabled) return 'none';
  return s.trip ? 'trip' : 'idle';
}

export type TransitionKind = 'vehicle-enter' | 'vehicle-exit' | 'still-enter' | 'walking-enter' | 'running-enter';

export interface Transition {
  kind: TransitionKind;
  ts: number;
}

export interface TransitionResult {
  state: ReminderState;
  effect: 'none' | 'post' | 'withdraw';
  /** The stop's gate reason, when the batch held a stop. */
  reason?: GateReason;
}

/**
 * One delivered batch, read whole before acting. Events from before the subscription are a replay
 * and are dropped. A stop is a STILL ENTER at most 2 min after an IN_VEHICLE EXIT; it reminds only
 * if nothing after it in the batch says the driver walked off or drove on. Driving on (IN_VEHICLE
 * ENTER) takes a showing reminder down; walking off does too, and that is an arrival, not a miss.
 */
export function onTransitions(
  s0: ReminderState,
  events: readonly Transition[],
  arrival: number,
  subscribedAt: number,
  ctx: ReminderCtx
): TransitionResult {
  const s = settle(s0, arrival);
  let withdrew = false;
  let stop: Transition | null = null;
  let afterStop = false;
  const batch = events.filter((e) => e.ts >= subscribedAt).sort((a, b) => a.ts - b.ts);
  for (const e of batch) {
    const t = s.trip;
    if (e.kind === 'vehicle-enter') {
      if (s.showing) {
        s.showing = false;
        withdrew = true;
      }
      if (!t) {
        s.trip = newTrip(e.ts);
      } else {
        t.inVehicle = true;
        t.lastVehicleAt = Math.max(t.lastVehicleAt, e.ts);
      }
      if (stop) afterStop = true;
    } else if (e.kind === 'vehicle-exit') {
      if (t) {
        if (t.inVehicle) {
          t.inVehicle = false;
          t.lastVehicleAt = Math.max(t.lastVehicleAt, e.ts);
        }
        t.vehicleExitAt = e.ts;
      }
    } else if (e.kind === 'walking-enter' || e.kind === 'running-enter') {
      if (s.showing) {
        resolveIn(s, 'arrival', arrival);
        withdrew = true;
      }
      if (t && t.inVehicle) {
        t.inVehicle = false;
        t.lastVehicleAt = Math.max(t.lastVehicleAt, e.ts);
      }
      if (stop) afterStop = true;
    } else if (e.kind === 'still-enter') {
      if (t && !t.inVehicle && t.vehicleExitAt > 0 && e.ts >= t.vehicleExitAt && e.ts - t.vehicleExitAt <= R.STILL_AFTER_VEHICLE_MS) {
        stop = e;
        afterStop = false;
      }
    }
  }
  const effect = withdrew ? 'withdraw' : 'none';
  if (!stop) return { state: s, effect };
  const reason = gate(s, { ...ctx, eventAgeMs: arrival - stop.ts, onFoot: afterStop }, arrival, 'stop');
  if (reason !== 'ok') return { state: s, effect, reason };
  postedIn(s, arrival);
  return { state: s, effect: 'post', reason };
}

// ——— iOS: significant-location wake, motion check, GPS session ———

/** One CoreMotion activity, reduced to what the reminder reads. */
export interface Activity {
  start: number;
  automotive: boolean;
  /** walking, running or cycling */
  onFoot: boolean;
  /** confidence medium or high */
  confident: boolean;
}

export interface MotionSummary {
  /** End of the newest confident car stretch; 0 for none. */
  lastAutomotiveAt: number;
  /** Start of the current run of confident car stretches; 0 for none. */
  automotiveSince: number;
  /** The newest activity is a confident walk, run or ride. */
  onFootNow: boolean;
}

/** How far back a wake reads the motion history: back to the trip's last car moment, 10 min to 3 h. */
export function motionSince(s: ReminderState, now: number): number {
  const lastVehicleAt = s.trip ? s.trip.lastVehicleAt : now;
  return Math.max(now - R.IOS_MOTION_MAX_LOOKBACK_MS, Math.min(now - R.IOS_MOTION_MIN_LOOKBACK_MS, lastVehicleAt));
}

/** Each activity lasts until the next one starts (the newest until now). */
export function summarizeActivities(list: readonly Activity[], now: number): MotionSummary {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  let lastAutomotiveAt = 0;
  let automotiveSince = 0;
  let onFootNow = false;
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    const end = i + 1 < sorted.length ? sorted[i + 1]!.start : now;
    onFootNow = a.onFoot && a.confident;
    if (a.automotive && a.confident) {
      if (automotiveSince === 0) automotiveSince = a.start;
      lastAutomotiveAt = end;
    } else if (a.onFoot && a.confident) {
      automotiveSince = 0;
    }
  }
  return { lastAutomotiveAt, automotiveSince, onFootNow };
}

export interface WakeResult {
  state: ReminderState;
  effect: 'none' | 'start-session';
  reason: GateReason;
}

/**
 * A significant-location wake, after the motion check. A trip closes only after 10 min with no car
 * motion in the history (not merely a long gap between wakes); a trip opens only on car motion from
 * the last 2 min with the driver not on foot. A GPS session starts only through the session gate.
 */
export function onWake(s0: ReminderState, now: number, motion: MotionSummary, ctx: ReminderCtx): WakeResult {
  const s = settle(s0, now);
  const pre = gate(s, ctx, now, 'wake');
  if (pre !== 'ok') return { state: s, effect: 'none', reason: pre };
  const a = motion.lastAutomotiveAt;
  const fresh = a > 0 && now - a <= R.AUTOMOTIVE_FRESH_MS && !motion.onFootNow;
  const t = s.trip;
  if (t) {
    if (now - Math.max(t.lastVehicleAt, a) >= R.TRIP_GAP_MS) {
      s.trip = null;
    } else {
      t.lastVehicleAt = Math.max(t.lastVehicleAt, a);
      if (fresh) t.inVehicle = true;
    }
  }
  if (!s.trip && fresh) s.trip = newTrip(motion.automotiveSince > 0 ? motion.automotiveSince : a, a);
  const reason = gate(s, { ...ctx, automotiveAgeMs: a > 0 ? now - a : Infinity }, now, 'session');
  if (reason !== 'ok' || !s.trip) return { state: s, effect: 'none', reason };
  s.trip.sessions += 1;
  return { state: s, effect: 'start-session', reason };
}

export interface SessionTracker {
  /** The session began; it looks for a stop until IOS_SESSION_MAX_MS after this. */
  startedAt: number;
  /** Looking for a stop since (the 3 min no-drive rule). */
  seekSince: number;
  sawDriving: boolean;
  /** The first stopped fix's time; 0 = not stopped. */
  stopStart: number;
  stopLat: number;
  stopLng: number;
  /** The reminder is up and the session watches for the car moving on. */
  watching: boolean;
  postedAt: number;
}

export interface Fix {
  t: number;
  /** m/s; negative = unknown */
  speed: number;
  /** m/s; negative = unknown */
  speedAcc: number;
  lat: number;
  lng: number;
}

export type FixVerdict = 'none' | 'stopped' | 'no-drive' | 'session-max' | 'driving' | 'moved' | 'ttl';

export function newTracker(now: number): SessionTracker {
  return { startedAt: now, seekSince: now, sawDriving: false, stopStart: 0, stopLat: 0, stopLng: 0, watching: false, postedAt: 0 };
}

/** Back to looking for the next stop: 10 mph must be seen again first. */
export function seekAgain(tr: SessionTracker, now: number): SessionTracker {
  return { ...tr, seekSince: now, sawDriving: false, stopStart: 0, watching: false, postedAt: 0 };
}

/** The reminder went up: watch for the car moving on. */
export function watchFrom(tr: SessionTracker, now: number): SessionTracker {
  return { ...tr, watching: true, postedAt: now };
}

/** The session's clocks: 5 min while watching; 10 min, or 3 min without 10 mph, while looking. */
export function sessionClock(tr: SessionTracker, now: number): FixVerdict {
  if (tr.watching) return now - tr.postedAt >= R.TTL_MS ? 'ttl' : 'none';
  if (now - tr.startedAt >= R.IOS_SESSION_MAX_MS) return 'session-max';
  if (!tr.sawDriving && now - tr.seekSince >= R.IOS_SESSION_NO_DRIVE_MS) return 'no-drive';
  return 'none';
}

/** Metres between two points (equirectangular; exact enough at tens of metres). */
export function metres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_008.8;
}

/**
 * One GPS fix. Looking: 10 mph first, then under 3 mph held 12 s is a stop (a fix with no usable
 * speed neither makes nor breaks the hold). Watching: over 5 mph, or 30 m from the stop, ends it.
 */
export function onFix(tr0: SessionTracker, fix: Fix, now: number): { tracker: SessionTracker; verdict: FixVerdict } {
  const tr = { ...tr0 };
  const clock = sessionClock(tr, now);
  if (clock !== 'none') return { tracker: tr, verdict: clock };
  const valid = fix.speed >= 0 && fix.speedAcc >= 0 && fix.speedAcc <= R.SPEED_ACC_MAX_MPS;
  if (tr.watching) {
    if (valid && fix.speed > R.MOVE_MPS) return { tracker: tr, verdict: 'driving' };
    if (metres(tr.stopLat, tr.stopLng, fix.lat, fix.lng) > R.MOVED_AWAY_M) return { tracker: tr, verdict: 'moved' };
    return { tracker: tr, verdict: 'none' };
  }
  if (!valid) return { tracker: tr, verdict: 'none' };
  if (fix.speed >= R.IOS_DRIVING_MPS) {
    tr.sawDriving = true;
    tr.stopStart = 0;
    return { tracker: tr, verdict: 'none' };
  }
  if (!tr.sawDriving) return { tracker: tr, verdict: 'none' };
  if (fix.speed >= R.STOP_MPS) {
    tr.stopStart = 0;
    return { tracker: tr, verdict: 'none' };
  }
  if (tr.stopStart === 0) {
    tr.stopStart = fix.t;
    tr.stopLat = fix.lat;
    tr.stopLng = fix.lng;
  }
  return { tracker: tr, verdict: fix.t - tr.stopStart >= R.STOP_HOLD_MS ? 'stopped' : 'none' };
}

export interface StopResult {
  state: ReminderState;
  /** post; arrival (walked off: no post, session ends); seek (look for the next stop); end */
  effect: 'post' | 'arrival' | 'seek' | 'end';
  reason: GateReason;
}

/** A held stop. Walking during the hold is an arrival; a stop too early in the trip or during a call waits for the next one. */
export function onStop(s0: ReminderState, ctx: ReminderCtx, now: number, walked: boolean): StopResult {
  const s = clone(s0);
  if (walked) {
    if (s.trip) {
      s.trip.inVehicle = false;
      s.trip.lastVehicleAt = now;
    }
    return { state: s, effect: 'arrival', reason: 'on-foot' };
  }
  const reason = gate(s, { ...ctx, eventAgeMs: 0, onFoot: false }, now, 'stop');
  if (reason === 'ok') {
    postedIn(s, now);
    return { state: s, effect: 'post', reason };
  }
  return { state: s, effect: reason === 'too-soon' || reason === 'in-call' ? 'seek' : 'end', reason };
}

/** How a showing iOS reminder ended: the car drove on, the driver walked off, 5 min passed, or the session was cut short. */
export type WatchEnd = 'driving' | 'arrival' | 'ttl' | 'ended';

/** Driven on within 20 s is unseen (one retry this trip, and the session looks for the next stop); otherwise the session ends. */
export function onWatchEnd(s0: ReminderState, how: WatchEnd, now: number): { state: ReminderState; effect: 'seek' | 'end' } {
  const s = clone(s0);
  s.showing = false;
  if (how === 'driving' && now - s.postedAt < R.UNSEEN_MS) {
    resolveIn(s, 'unseen', now);
    return { state: s, effect: s.trip && !s.trip.reminded ? 'seek' : 'end' };
  }
  if (how === 'arrival') {
    resolveIn(s, 'arrival', now);
    if (s.trip) {
      s.trip.inVehicle = false;
      s.trip.lastVehicleAt = now;
    }
  }
  return { state: s, effect: 'end' };
}

/** A GPS session ended: the next one waits IOS_SESSION_SPACING_MS. */
export function sessionEnded(s0: ReminderState, now: number): ReminderState {
  const s = clone(s0);
  if (s.trip) s.trip.lastSessionEndAt = now;
  return s;
}

// ——— status (what Settings shows) ———

export type TripReminderMissing = 'motion' | 'notifications' | 'locationAlways' | 'locationPrecise';

export interface TripReminderStatus {
  enabled: boolean;
  state: 'off' | 'on' | 'needs' | 'paused' | 'unavailable';
  /** Off because nine reminders in a row went unused. */
  autoOff: boolean;
  /** What is missing; only for `needs`. */
  missing: TripReminderMissing[];
  /** Only for `paused`. */
  pausedUntil: number | null;
}

export function statusOf(s: ReminderState, now: number, available: boolean, missing: readonly TripReminderMissing[]): TripReminderStatus {
  const base = { enabled: s.enabled, autoOff: s.autoOff, missing: [] as TripReminderMissing[], pausedUntil: null };
  if (!available) return { ...base, state: 'unavailable' };
  if (!s.enabled) return { ...base, state: 'off' };
  if (missing.length > 0) return { ...base, state: 'needs', missing: [...missing] };
  if (now < s.pausedUntil) return { ...base, state: 'paused', pausedUntil: s.pausedUntil };
  return { ...base, state: 'on' };
}
