// The drive detector's rules (plan §3.3, §3.4, §3.6, §3.7): the TypeScript reference.
//
// `ios/DetectPolicy.swift` and `ios/DetectEndPolicy.swift` mirror every constant below under the
// same name (the native text test compares them) and every function under the same rule;
// `vectors.ts` is the shared decision table that Jest runs here and the phone runs through the
// Swift policy (`DetectSelfTest.swift`). Android has no native detector: its waiting session (the
// drive host) uses `confirmStep` with the manual trigger and `startOf` from here.
//
// Pure: no platform, no clock. Every time is epoch ms; every speed m/s; every distance metres.

export const MPS_PER_MPH = 0.44704;

/** The detector's numbers. Same names, same values in `DetectPolicy.swift`. */
export const DETECT = {
  /** The auto trigger: 20 mph held 10 s. */
  CONFIRM_MPS_AUTO: 8.9408,
  CONFIRM_HOLD_MS_AUTO: 10_000,
  /** A Start-card session: 10 mph held 15 s. */
  CONFIRM_MPS_MANUAL: 4.4704,
  CONFIRM_HOLD_MS_MANUAL: 15_000,
  /** A dip under the trigger (or an untrusted row) spanning this long or less keeps the hold. */
  CONFIRM_DIP_MAX_MS: 5_000,
  /** A confident cycling, walking or running report this recent holds an auto confirmation back. */
  VETO_FRESH_MS: 30_000,
  /** A row counts only with a fix this accurate… */
  TRUSTED_HACC_M: 30,
  /** …and a speed accuracy this good (or unrated). */
  TRUSTED_SPEED_ACC_MPS: 2,
  /** 3 mph: "at or under 3 mph". */
  STOP_MPS: 1.34112,
  /** 10 mph: driving before a stop (the trace-back). */
  MOVING_MPS: 4.4704,
  /** 5 mph: movement for the still clock (two trusted rows in a row over it). */
  MOVE_MPS: 2.2352,
  MOVE_PACE_ROWS: 2,
  /** Or a trusted fix this far from where the car went still. */
  MOVE_DISPLACEMENT_M: 100,
  /** A stop shorter than this inside the rise is a red light, not the start. */
  TRACE_STOP_SPLIT_MS: 300_000,
  /** The candidate's rolling buffer (iOS). */
  CANDIDATE_BUFFER_MAX_ROWS: 600,
  /** The parked spot is the motion start's place only when reachable at this speed, plus the slack. */
  PLAUSIBLE_MPS_MAX: 40,
  PLAUSIBLE_SLACK_M: 300,
  /** The wake gate: car motion this recent. */
  AUTOMOTIVE_FRESH_MS: 120_000,
  /** The motion history read at a wake and for the back-fill. */
  MOTION_LOOKBACK_MS: 10_800_000,
  /** Only this long without moving car motion starts a new car run. */
  MOTION_RUN_GAP_MS: 1_800_000,
  /** An auto candidate without a confirmation ends after this. */
  CANDIDATE_MAX_MS: 180_000,
  /** After a timed-out candidate, significant-change and visit wakes start none for this long. */
  CANDIDATE_REST_MS: 600_000,
  CANDIDATES_PER_HOUR_MAX: 6,
  HOUR_MS: 3_600_000,
  PARKED_REGION_RADIUS_M: 150,
  /** The cached fix a significant-change start delivers at once is not a wake when older than this. */
  SLC_STALE_MS: 120_000,
  /** A visit is a wake when it was left this recently. */
  VISIT_FRESH_MS: 600_000,
  /** A wake's background task ends once a fix arrives or after this. */
  WAKE_TASK_MAX_MS: 25_000,
  /** A relaunch resumes a journaled drive whose last row is this young. */
  RESUME_MAX_GAP_MS: 300_000,
  /** A resumed drive's rows go on this many seqs past the journal's highest (`resumeSeq`). */
  RESUME_SEQ_GAP: 1_000,
  /** The Start card's wait (reset by every touch). */
  WAIT_MAX_MS: 300_000,
  /** `continues`: a traced start this soon after the last end's decision… */
  CONTINUE_GAP_MS: 300_000,
  /** …and this close to where it ended. */
  CONTINUE_DIST_M: 150,
  /** The JS still end (`IDLE_END_S`); the native safety stop adds the slack. */
  STILL_END_MS: 300_000,
  /** An on-foot report standing this long ends the drive (the JS walking end). */
  WALK_CONFIRM_MS: 20_000,
  /** A fix over 3 mph this recent says the car is still driving: no walking end. */
  WALK_STALE_FIX_MS: 60_000,
  END_CRAWL_MPS: 1.34112,
  /** The native safety stop fires only this long after the JS rule would have. */
  SAFETY_SLACK_MS: 60_000,
  /** A fix-less stretch with car motion pauses the still clock, at most this long. */
  FIXLESS_HOLD_MAX_MS: 3_600_000,
  ROW_MS: 1_000,
  /** 12 h: the cap on a drive. */
  MAX_DRIVE_MS: 43_200_000,
  /** "Not driving?": detection rests at most this long… */
  SUPPRESS_MAX_MS: 10_800_000,
  /** …and ends once nothing has moved over 3 mph for this long. */
  SUPPRESS_STILL_MS: 300_000,
  JOURNAL_SYNC_EVERY_ROWS: 30,
  JOURNAL_MAX_BYTES_PER_DRIVE: 16_777_216,
  JOURNAL_MAX_DRIVES: 4,
  /** `readRows` returns at most this many rows a call. */
  READ_ROWS_MAX: 600,
  /** The detector's clock while it senses. */
  TICK_MS: 5_000,
  /** The "Recording your drive" note goes up only when no Live Activity runs this long after the confirmation. */
  FALLBACK_NOTE_DELAY_MS: 20_000,
  EARTH_RADIUS_M: 6_371_000,
} as const;

export type DetectConstant = keyof typeof DETECT;

/** The auto trigger (U2) and the Start card's, in the words the UI quotes. */
export const AUTO_TRIGGER = { mph: 20, holdMs: 10_000, dipMaxMs: 5_000, maxHAccM: 30 } as const;
export const MANUAL_TRIGGER = { mph: 10, holdMs: 15_000, dipMaxMs: 5_000, maxHAccM: 30 } as const;

export type TriggerKind = 'auto' | 'manual';
export type DetectPhase = 'off' | 'armed' | 'candidate' | 'recording' | 'ending' | 'suppressed';
export type StartSource = 'trace' | 'motion' | 'wake';
export type WakeReason = 'slc' | 'region' | 'visit';

/** The row fields the detector reads (a `FeatureRow` has them all). */
export interface DetectRow {
  ts: number;
  lat: number;
  lng: number;
  hAcc: number;
  speed: number;
  speedAcc: number;
  gnssValid: boolean;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** The last committed end: when it was decided, the cut, the place. */
export interface DetectLastEnd {
  decidedAt: number;
  cut: number;
  lat: number;
  lng: number;
  driveId: string;
}

// ——— Rows ———

/** A fix the detector believes: valid, within 30 m, speed rated 2 m/s or better (or unrated), speed known. */
export function trusted(r: DetectRow): boolean {
  return (
    r.gnssValid &&
    r.hAcc >= 0 &&
    r.hAcc <= DETECT.TRUSTED_HACC_M &&
    (r.speedAcc < 0 || r.speedAcc <= DETECT.TRUSTED_SPEED_ACC_MPS) &&
    r.speed >= 0
  );
}

/** Trusted and at or under 3 mph. */
export const slow = (r: DetectRow): boolean => trusted(r) && r.speed <= DETECT.STOP_MPS;
/** Trusted and at 10 mph or more. */
export const moving = (r: DetectRow): boolean => trusted(r) && r.speed >= DETECT.MOVING_MPS;

/** Great-circle metres (haversine). */
export function distanceM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const sLat = Math.sin(((b.lat - a.lat) * rad) / 2);
  const sLng = Math.sin(((b.lng - a.lng) * rad) / 2);
  const h = sLat * sLat + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sLng * sLng;
  return 2 * DETECT.EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ——— Confirmation ———

export const confirmMps = (k: TriggerKind): number => (k === 'auto' ? DETECT.CONFIRM_MPS_AUTO : DETECT.CONFIRM_MPS_MANUAL);
export const confirmHoldMs = (k: TriggerKind): number => (k === 'auto' ? DETECT.CONFIRM_HOLD_MS_AUTO : DETECT.CONFIRM_HOLD_MS_MANUAL);

/** The hold in progress: when its run of fast rows began, and when the current dip began. */
export interface ConfirmState {
  runStartTs: number | null;
  dipStartTs: number | null;
}

export const CONFIRM_START: ConfirmState = Object.freeze({ runStartTs: null, dipStartTs: null });

/**
 * One row of the hold. A trusted row at the trigger or over it extends the run (and ends any dip);
 * the run confirms once it spans the hold on the row clock, unless `veto` (an auto candidate with a
 * fresh confident cycling, walking or running report) holds it to the next row. A row under the
 * trigger, or untrusted, starts or extends a dip; a dip spanning more than `CONFIRM_DIP_MAX_MS`
 * breaks the run.
 */
export function confirmStep(s: ConfirmState, r: DetectRow, kind: TriggerKind, veto = false): { state: ConfirmState; confirmed: boolean } {
  if (trusted(r) && r.speed >= confirmMps(kind)) {
    const run = s.runStartTs ?? r.ts;
    return { state: { runStartTs: run, dipStartTs: null }, confirmed: r.ts - run >= confirmHoldMs(kind) && !veto };
  }
  if (s.runStartTs === null) return { state: CONFIRM_START, confirmed: false };
  const dip = s.dipStartTs ?? r.ts;
  if (r.ts - dip > DETECT.CONFIRM_DIP_MAX_MS) return { state: CONFIRM_START, confirmed: false };
  return { state: { runStartTs: s.runStartTs, dipStartTs: dip }, confirmed: false };
}

// ——— The start ———

/**
 * The trace-back (native-ios §6.2): from the first row of the confirming run (`h`), the start is
 * the last trusted row at or under 3 mph before it, unless trusted driving at 10 mph or more came
 * before that stop less than `TRACE_STOP_SPLIT_MS` earlier (a red light inside the departure): then
 * the search goes on back from that driving. Null when the rows begin already moving.
 */
export function traceStart(rows: readonly DetectRow[], h: number): number | null {
  let k = Math.min(Math.max(h, 0), rows.length);
  for (;;) {
    let s = -1;
    for (let i = k - 1; i >= 0; i--) {
      if (slow(rows[i]!)) {
        s = i;
        break;
      }
    }
    if (s < 0) return null;
    let j = -1;
    for (let i = s - 1; i >= 0; i--) {
      if (moving(rows[i]!)) {
        j = i;
        break;
      }
    }
    if (j < 0 || rows[s]!.ts - rows[j]!.ts >= DETECT.TRACE_STOP_SPLIT_MS) return s;
    k = j;
  }
}

/** Where a confirmed drive begins, and from which row its rows are kept. */
export interface TracedStart {
  /** The first kept row (an index into the rows given). */
  index: number;
  startedAt: number;
  startSource: StartSource;
  startLat: number | null;
  startLng: number | null;
}

/**
 * The traced start, else the fallbacks: for an auto drive the motion history's car run (`motion`),
 * placed at the last end when the car could have come from there in the time; otherwise the first
 * row (`wake`), placed there when its fix is trusted. A Start-card drive never uses the motion
 * fallback. `rows` must be non-empty.
 */
export function startOf(
  rows: readonly DetectRow[],
  h: number,
  kind: TriggerKind,
  automotiveSince: number,
  lastEnd: DetectLastEnd | null
): TracedStart {
  const s = traceStart(rows, h);
  if (s !== null) {
    const r = rows[s]!;
    return { index: s, startedAt: r.ts, startSource: 'trace', startLat: r.lat, startLng: r.lng };
  }
  const first = rows[0]!;
  if (kind === 'auto' && automotiveSince > 0 && automotiveSince < first.ts) {
    const ref = rows.find(trusted);
    const plausible =
      lastEnd !== null &&
      ref !== undefined &&
      distanceM(lastEnd, ref) <= (DETECT.PLAUSIBLE_MPS_MAX * (ref.ts - automotiveSince)) / 1000 + DETECT.PLAUSIBLE_SLACK_M;
    return {
      index: 0,
      startedAt: automotiveSince,
      startSource: 'motion',
      startLat: plausible ? lastEnd.lat : null,
      startLng: plausible ? lastEnd.lng : null,
    };
  }
  const ok = trusted(first);
  return { index: 0, startedAt: first.ts, startSource: 'wake', startLat: ok ? first.lat : null, startLng: ok ? first.lng : null };
}

/** Native's merge hint: the start is within 5 min of the last end's decision and 150 m of its place. */
export function continuesFrom(lastEnd: DetectLastEnd | null, startedAt: number, lat: number | null, lng: number | null): boolean {
  if (lastEnd === null || lat === null || lng === null) return false;
  return startedAt - lastEnd.decidedAt <= DETECT.CONTINUE_GAP_MS && distanceM(lastEnd, { lat, lng }) <= DETECT.CONTINUE_DIST_M;
}

// ——— Wakes ———

/** One motion-history sample as the wake reads it. */
export interface ActivitySample {
  start: number;
  automotive: boolean;
  /** A car standing still (automotive + stationary) is no car motion. */
  stationary: boolean;
  /** walking, running or cycling */
  onFoot: boolean;
  confident: boolean;
}

export interface MotionSummary {
  /** When the newest moving car motion ended (0: none). */
  lastAutomotiveAt: number;
  /** When the car run it belongs to began (0: none). */
  automotiveSince: number;
  /** The newest sample is a confident walk, run or ride. */
  onFootNow: boolean;
}

/** Each sample lasts until the next starts (the newest until now); only 30 min without car motion starts a new run. */
export function summarize(list: readonly ActivitySample[], now: number): MotionSummary {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: MotionSummary = { lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false };
  sorted.forEach((a, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1]!.start : now;
    out.onFootNow = a.onFoot && a.confident;
    if (a.automotive && !a.stationary && a.confident) {
      if (out.automotiveSince === 0 || a.start - out.lastAutomotiveAt >= DETECT.MOTION_RUN_GAP_MS) out.automotiveSince = a.start;
      out.lastAutomotiveAt = end;
    }
  });
  return out;
}

export type MotionGate = 'ok' | 'notFresh' | 'onFoot';

/** A significant-change or visit wake starts a candidate only on car motion from the last 2 min, the driver not on foot. */
export function motionGate(m: MotionSummary, now: number): MotionGate {
  if (m.lastAutomotiveAt <= 0 || now - m.lastAutomotiveAt > DETECT.AUTOMOTIVE_FRESH_MS) return 'notFresh';
  if (m.onFootNow) return 'onFoot';
  return 'ok';
}

export interface WakeCtx {
  now: number;
  reason: WakeReason;
  phase: DetectPhase;
  /** JS armed it (signed in, onboarded). */
  armed: boolean;
  hasOwner: boolean;
  /** Always, Precise and Motion & Fitness. */
  permissionsOk: boolean;
  candidateRestUntil: number;
  candidateStarts: readonly number[];
}

export type WakeGate = 'ok' | 'off' | 'noOwner' | 'permission' | 'busy' | 'resting' | 'capped';

/** Candidate starts within the last hour. */
export const recentStarts = (starts: readonly number[], now: number): number[] => starts.filter((t) => t <= now && now - t < DETECT.HOUR_MS);

/** The cheap checks a wake passes before any motion query or GPS, in order. A region exit ignores the rest. */
export function wakeGate(c: WakeCtx): WakeGate {
  if (!c.armed) return 'off';
  if (!c.hasOwner) return 'noOwner';
  if (!c.permissionsOk) return 'permission';
  if (c.phase !== 'armed') return 'busy';
  if (c.reason !== 'region' && c.now < c.candidateRestUntil) return 'resting';
  if (recentStarts(c.candidateStarts, c.now).length >= DETECT.CANDIDATES_PER_HOUR_MAX) return 'capped';
  return 'ok';
}

/** A candidate's own clock: an auto one ends at 3 min or on a walk standing 20 s; a Start-card one at its wait. */
export function candidateDue(
  kind: TriggerKind,
  since: number,
  waitUntil: number | null,
  walkSince: number | null,
  now: number
): 'timeout' | 'walking' | 'waitTimeout' | null {
  if (kind === 'manual') return waitUntil !== null && now >= waitUntil ? 'waitTimeout' : null;
  if (now - since >= DETECT.CANDIDATE_MAX_MS) return 'timeout';
  if (walkSince !== null && now - walkSince >= DETECT.WALK_CONFIRM_MS) return 'walking';
  return null;
}

// ——— The native safety stop (R1: JS ends drives; native only after the slack) ———

/** What the still clock and the walking veto know, row by row. */
export interface EndClock {
  /** The last movement (the confirmation to begin with). */
  lastMoveTs: number;
  /** Fix-less car time since then, which the still clock does not count. */
  holdMs: number;
  /** Trusted rows over 5 mph in a row. */
  paceRun: number;
  /** Where the car went still (the first trusted fix since the last movement). */
  anchor: LatLng | null;
  /** The last trusted fix: when, how fast, where. */
  lastFix: { ts: number; mps: number; lat: number; lng: number } | null;
}

export const endClockAt = (ts: number): EndClock => ({ lastMoveTs: ts, holdMs: 0, paceRun: 0, anchor: null, lastFix: null });

/**
 * One recorded row. Two trusted rows over 5 mph in a row, or a trusted fix 100 m from where the car
 * went still, is movement: the clock restarts there. A row with no valid fix while the phone's
 * standing motion report is car motion (`automotiveNow`) adds a second to the hold, up to an hour.
 */
export function endOnRow(c: EndClock, r: DetectRow, automotiveNow: boolean): EndClock {
  if (trusted(r)) {
    const paceRun = r.speed > DETECT.MOVE_MPS ? c.paceRun + 1 : 0;
    const lastFix = { ts: r.ts, mps: r.speed, lat: r.lat, lng: r.lng };
    const far = c.anchor !== null && distanceM(c.anchor, r) >= DETECT.MOVE_DISPLACEMENT_M;
    if (paceRun >= DETECT.MOVE_PACE_ROWS || far) return { lastMoveTs: r.ts, holdMs: 0, paceRun, anchor: { lat: r.lat, lng: r.lng }, lastFix };
    return { ...c, paceRun, anchor: c.anchor ?? { lat: r.lat, lng: r.lng }, lastFix };
  }
  const holdMs = !r.gnssValid && automotiveNow ? Math.min(DETECT.FIXLESS_HOLD_MAX_MS, c.holdMs + DETECT.ROW_MS) : c.holdMs;
  return { ...c, paceRun: 0, holdMs };
}

export type SafetyCause = 'still' | 'walking' | 'limit';

/**
 * `overdue`: a JS end rule would have ended the drive by now (12 h; a walk standing 20 s with no fix
 * over 3 mph in the last minute; 5 min without movement, holds excluded). `due`: the same plus the
 * slack, when native stops sensing on its own. The limit comes first, then walking, then still.
 * `waitUntil`: a Start-card drive still waiting for driving speed (JS ends it unsaved at that
 * deadline, 5 min from the tap or the last touch): no walking end (the walk to the car), and the
 * still end only once the deadline has passed too, so a touch that keeps the wait keeps the drive.
 */
export function endDue(
  c: EndClock,
  startedAt: number,
  now: number,
  walkSince: number | null,
  waitUntil: number | null = null
): { due: SafetyCause | null; overdue: SafetyCause | null } {
  const carDriving = c.lastFix !== null && c.lastFix.mps > DETECT.END_CRAWL_MPS && now - c.lastFix.ts <= DETECT.WALK_STALE_FIX_MS;
  const age = now - startedAt;
  const walked = waitUntil === null && walkSince !== null && !carDriving ? now - walkSince : -1;
  const still = now - c.lastMoveTs - c.holdMs;
  const pick = (slack: number): SafetyCause | null => {
    if (age >= DETECT.MAX_DRIVE_MS + slack) return 'limit';
    if (walked >= DETECT.WALK_CONFIRM_MS + slack) return 'walking';
    if (still >= DETECT.STILL_END_MS + slack && (waitUntil === null || now >= waitUntil + slack)) return 'still';
    return null;
  };
  return { due: pick(DETECT.SAFETY_SLACK_MS), overdue: pick(0) };
}

// ——— "Not driving?" ———

/** Suppression ends at its 3 h cap, on a walk standing 20 s, or after 5 min with nothing over 3 mph. */
export function suppressionDue(
  since: number,
  until: number,
  lastOverStopTs: number | null,
  walkSince: number | null,
  now: number
): 'cap' | 'walking' | 'still' | null {
  if (now >= until) return 'cap';
  if (walkSince !== null && now - walkSince >= DETECT.WALK_CONFIRM_MS) return 'walking';
  if (now - Math.max(since, lastOverStopTs ?? since) >= DETECT.SUPPRESS_STILL_MS) return 'still';
  return null;
}

/**
 * A relaunch while detection rests: the rest goes on until its 3 h cap, still measured from when
 * "Not driving?" began it (`until`), and its still clock starts again at the relaunch. Nothing was
 * sensed while RoadWise was not running, and a relaunch comes from a wake (the phone moved) or from
 * the driver, so the rest ends no sooner than 5 min after it. The still clock's restart (`now`), or
 * null when the rest is over.
 */
export function suppressionResume(until: number | null, now: number): number | null {
  return until !== null && now < until ? now : null;
}

// ——— Launch ———

/** A relaunch resumes a journaled drive whose last row (else its start) is 5 min old or less; older ones end as orphans. */
export function resumeDecision(lastRowTs: number | null, startedAt: number, now: number): 'resume' | 'orphan' {
  return now - (lastRowTs ?? startedAt) <= DETECT.RESUME_MAX_GAP_MS ? 'resume' : 'orphan';
}

/**
 * A resumed drive's rows go on after this seq: the journal's highest (`topSeq`: its last row's, or
 * an earlier resume's reservation) plus `RESUME_SEQ_GAP`. A power loss, or a kill with rows still
 * queued for the file, loses the rows the journal had not synced (at most 30, plus the write queue),
 * and JS may already hold them: resuming right after the durable seq would hand their seqs out
 * again and JS would drop the new rows as repeats. The `gap` line carries it, so a reader goes on
 * from it.
 */
export function resumeSeq(topSeq: number): number {
  return topSeq + DETECT.RESUME_SEQ_GAP;
}

// ——— Status ———

export type DetectMissing = 'locationAlways' | 'locationPrecise' | 'motion' | 'backgroundRefresh' | 'liveActivities';
export type DetectStatus = 'on' | 'needs' | 'unavailable' | 'off';

export interface StatusInputs {
  /** JS armed it (signed in and onboarded). */
  armed: boolean;
  /** Significant-change monitoring and motion activity exist on this phone. */
  hardware: boolean;
  location: 'none' | 'whenInUse' | 'always';
  precise: boolean;
  motion: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  backgroundRefresh: 'available' | 'denied' | 'restricted';
  liveActivities: boolean;
}

/**
 * `off` when JS has not armed it; `unavailable` without the hardware; `needs` when Location Always,
 * Precise Location or Motion & Fitness is missing (detection stays off) or Background App Refresh is
 * off (detection runs, but iOS may not wake RoadWise), with `missing` in that order plus Live
 * Activities when they are off too; else `on`. `requiredOk`: the three that arming needs.
 */
export function statusOf(p: StatusInputs): { status: DetectStatus; missing: DetectMissing[]; requiredOk: boolean } {
  const required: DetectMissing[] = [];
  if (p.location !== 'always') required.push('locationAlways');
  if (!p.precise) required.push('locationPrecise');
  if (p.motion !== 'granted') required.push('motion');
  const requiredOk = p.hardware && required.length === 0;
  if (!p.armed) return { status: 'off', missing: [], requiredOk };
  if (!p.hardware) return { status: 'unavailable', missing: [], requiredOk };
  const refreshOff = p.backgroundRefresh !== 'available';
  if (required.length === 0 && !refreshOff) return { status: 'on', missing: [], requiredOk };
  const missing: DetectMissing[] = [...required];
  if (refreshOff) missing.push('backgroundRefresh');
  if (!p.liveActivities) missing.push('liveActivities');
  return { status: 'needs', missing, requiredOk };
}
