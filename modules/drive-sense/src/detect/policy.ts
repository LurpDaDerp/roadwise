// The drive detector's rules (plan §3.3, §3.4, §3.6, §3.7): the TypeScript reference.
//
// `ios/DetectPolicy.swift`, `ios/DetectStartPolicy.swift` and `ios/DetectEndPolicy.swift` mirror
// every constant below under the same name (the native text test compares them) and every function
// under the same rule; `vectors.ts` is the shared
// decision table that Jest runs here and the phone runs through the
// Swift policy (`DetectSelfTest.swift`). Android has no native detector and uses none of this (its
// Start-card wait is the engine's own).
//
// Pure: no platform, no clock. Every time is epoch ms; every speed m/s; every distance metres.

export const MPS_PER_MPH = 0.44704;

/** The detector's numbers. Same names, same values in `DetectPolicy.swift`. */
export const DETECT = {
  /**
   * The auto trigger (`autoHoldMs`): the hold a speed needs is (5/3)·(30 − mph) s for a speed over
   * 15 mph, 5 s less for every 3 mph faster: 25 s just over 15 mph (`AUTO_HOLD_MS_15`, where the line
   * starts), 20 s at 18, 15 s at 21, 10 s at 24, 5 s at 27 and 0 at 30 mph (`AUTO_INSTANT_MPS`). The
   * hold never falls under `AUTO_HOLD_MIN_MS`, a GPS-spike guard: from about 29.46 mph a drive
   * confirms on the second good reading in a row, never on a single one. The floor sits a little
   * under the 1 s row interval, so two 1 Hz readings confirm whatever the timer's jitter (997 ms
   * apart, say). 15 mph and under earns nothing; under 20 mph only with fresh car motion.
   */
  AUTO_MIN_MPS: 6.7056,
  AUTO_HOLD_MS_15: 25_000,
  AUTO_MPS_20: 8.9408,
  AUTO_INSTANT_MPS: 13.4112,
  AUTO_HOLD_MIN_MS: 900,
  /** Two readings further apart than this earn nothing for the interval between them (what was earned stays). */
  AUTO_ROW_GAP_MAX_MS: 2_000,
  /** The evidence is forgotten after this long with no trusted reading over 3 mph (a stop that long ends a drive). */
  AUTO_FORGET_MS: 300_000,
  /** A Start-card session: 10 mph held 15 s. */
  CONFIRM_MPS_MANUAL: 4.4704,
  CONFIRM_HOLD_MS_MANUAL: 15_000,
  /** A dip under the Start card's trigger (or an untrusted row) spanning this long or less keeps the hold. */
  CONFIRM_DIP_MAX_MS: 5_000,
  /** A confident cycling, walking or running report this recent earns an auto candidate nothing, unless a confident automotive report came after it (`onFootVeto`). */
  VETO_FRESH_MS: 30_000,
  /** A row counts only with a fix this accurate… */
  TRUSTED_HACC_M: 30,
  /** …and a speed accuracy this good (or unrated). */
  TRUSTED_SPEED_ACC_MPS: 2,
  /**
   * The slow-traffic confirmation (`slowTrafficStep`), beside the speed evidence: inside one
   * candidate, confident moving car motion standing 90 s in all, from at least two confident
   * automotive reports 30 s or more apart, with a confident automotive report (moving or standing)
   * standing for 80 % of the time since the first trusted row over 3 mph; a trusted path of 800 m
   * whose last fix is 400 m in a straight line from its first (each step at most 1.5 times what the
   * faster of its two rows could cover, plus 5 m); trusted rows over 3 mph averaging 8 mph; and no
   * confident walking, running or cycling report since the candidate opened.
   */
  SLOW_CAR_MS: 90_000,
  SLOW_CAR_SPAN_MS: 30_000,
  SLOW_CAR_COVER_MIN: 0.8,
  SLOW_PATH_M: 800,
  SLOW_NET_M: 400,
  SLOW_AVG_MPS: 3.57632,
  SLOW_STEP_SLACK: 1.5,
  SLOW_STEP_PAD_M: 5,
  /**
   * The car link start (`linkStep`): with a paired car's audio (or any CarPlay) current, two trusted
   * rows in a row at 5 mph or more, the candidate not marked on foot, each with fresh car motion;
   * with CarPlay current, at 15 mph or more without it too.
   */
  LINK_MIN_MPS: 2.2352,
  LINK_NO_CAR_MPS: 6.7056,
  LINK_PACE_ROWS: 2,
  /** At most this many paired cars (family cars). */
  CARS_MAX: 3,
  /** The outputs current for most of each of this many last drives are kept (JS's "Is <name> your car?"). */
  CAR_DRIVES_KEPT: 3,
  /** "Most of a drive": current for more than this share of the drive's rows… */
  CAR_DRIVE_SHARE_MIN: 0.5,
  /** …of a drive with at least this many rows (2 min) that reached driving speed. */
  CAR_DRIVE_MIN_ROWS: 120,
  /** At most this many uids are remembered as "Not my car" (the oldest goes first). */
  CAR_NOT_MINE_MAX: 20,
  /** 3 mph: "at or under 3 mph". */
  STOP_MPS: 1.34112,
  /** 10 mph: a vehicle sign that keeps an auto candidate open. */
  MOVING_MPS: 4.4704,
  /** 5 mph: movement for the still clock (two trusted rows in a row over it), and rolling before a stop (the trace-back). */
  MOVE_MPS: 2.2352,
  MOVE_PACE_ROWS: 2,
  /** Or a trusted fix this far from where the car went still. */
  MOVE_DISPLACEMENT_M: 100,
  /** A stop shorter than this inside the rise is a red light, not the start. */
  TRACE_STOP_SPLIT_MS: 300_000,
  /** The candidate's rolling buffer (iOS): 30 min at 1 Hz, the whole of the longest candidate. */
  CANDIDATE_BUFFER_MAX_ROWS: 1_800,
  /** The parked spot is the motion start's place only when reachable at this speed, plus the slack. */
  PLAUSIBLE_MPS_MAX: 40,
  PLAUSIBLE_SLACK_M: 300,
  /** The wake gate: car motion this recent. */
  AUTOMOTIVE_FRESH_MS: 120_000,
  /** The motion history read at a wake and for the back-fill. */
  MOTION_LOOKBACK_MS: 10_800_000,
  /** Only this long without moving car motion starts a new car run. */
  MOTION_RUN_GAP_MS: 1_800_000,
  /** An auto candidate ends after this long without a vehicle sign (`AUTO_FORGET_MS` once it holds evidence). */
  CANDIDATE_MAX_MS: 180_000,
  /** An auto candidate ends after this long whatever it sees. */
  CANDIDATE_CAP_MS: 1_800_000,
  /** After a candidate that saw no vehicle (or reached its cap), significant-change and visit wakes start none for this long. */
  CANDIDATE_REST_MS: 600_000,
  /** At most this many candidates that saw no vehicle start in an hour. */
  CANDIDATES_PER_HOUR_MAX: 6,
  HOUR_MS: 3_600_000,
  /** The parked car's region (exit only), set where a drive ended: leaving it is a wake. */
  PARKED_REGION_RADIUS_M: 100,
  /** The cached fix a significant-change start delivers at once is not a wake when older than this. */
  SLC_STALE_MS: 120_000,
  /** A visit is a wake when it was left this recently. */
  VISIT_FRESH_MS: 600_000,
  /** A wake's background task ends once a fix arrives or after this. */
  WAKE_TASK_MAX_MS: 25_000,
  /** A drive's end runs inside a background task this long, so JS can store it and post its recap. */
  END_TASK_MAX_MS: 25_000,
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
  /** An on-foot report standing this long stops an auto candidate and ends the "Not driving?" rest. */
  WALK_CONFIRM_MS: 20_000,
  /** The JS walking end (`WALK_END_S`, from when the walk began); native's walk standing this long. */
  WALK_END_MS: 10_000,
  /** The JS walking end never fires before the report has stood this long (`WALK_STAND_MIN_S`). */
  WALK_STAND_MIN_MS: 3_000,
  /** A fix over 3 mph this recent says the car is still driving: no walking end. */
  WALK_STALE_FIX_MS: 15_000,
  END_CRAWL_MPS: 1.34112,
  /** 5 mph: a walker's own pace tops out here (JS's walking end lets a carried phone this slow end a drive). */
  WALKER_PACE_MAX_MPS: 2.2352,
  /** The native safety stop fires only this long after the JS still end or 12 h cap would have (`END_NATIVE_SLACK_S`)… */
  SAFETY_SLACK_MS: 60_000,
  /** …and this long after the JS walking end would have (`END_NATIVE_WALK_SLACK_S`). */
  WALK_SAFETY_SLACK_MS: 10_000,
  /** The JS step walk (`motion.ts`): this many steps on the pedometer… */
  STEP_WALK_MIN: 15,
  /** …within this long… */
  STEP_WINDOW_MS: 20_000,
  /** …with no trusted fix over 3 mph in this long. */
  STEP_CALM_MS: 15_000,
  /** The JS car-link end: the paired car or CarPlay gone this long, continuously, with no trusted fix over 3 mph since. */
  CAR_GONE_MS: 15_000,
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
  /** A drive's file: 12 h and a minute of rows (about 650 bytes each as native writes them) fit with room. */
  JOURNAL_MAX_BYTES_PER_DRIVE: 33_554_432,
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

/**
 * The auto trigger and the Start card's, in the words the UI quotes. Auto: over `minMph` the hold is
 * `maxHoldS` and `stepS` shorter for every `stepMph` faster, reaching nothing at `instantMph` (from
 * there, the second good reading in a row).
 */
export const AUTO_TRIGGER = { minMph: 15, maxHoldS: 25, stepS: 5, stepMph: 3, instantMph: 30, maxHAccM: 30 } as const;
export const MANUAL_TRIGGER = { mph: 10, holdMs: 15_000, dipMaxMs: 5_000, maxHAccM: 30 } as const;

export type TriggerKind = 'auto' | 'manual';
export type DetectPhase = 'off' | 'armed' | 'candidate' | 'recording' | 'ending' | 'suppressed';
export type StartSource = 'trace' | 'motion' | 'wake';
/** `app`: RoadWise came to the front. */
export type WakeReason = 'slc' | 'region' | 'visit' | 'app';

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
/** Trusted and at 5 mph or more: the car rolling before a stop (the trace-back). */
export const rolling = (r: DetectRow): boolean => trusted(r) && r.speed >= DETECT.MOVE_MPS;

/** Great-circle metres (haversine). */
export function distanceM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const sLat = Math.sin(((b.lat - a.lat) * rad) / 2);
  const sLng = Math.sin(((b.lng - a.lng) * rad) / 2);
  const h = sLat * sLat + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sLng * sLng;
  return 2 * DETECT.EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ——— Confirmation ———

/**
 * The confirmation in progress. The Start card's hold: when its run of fast rows began, and when the
 * current dip began. The auto evidence: how much has built (1 confirms), when the first interval that
 * earned since the last forget began (`runStartTs`, where the trace-back starts), the previous row's
 * time and earning rate, and the last trusted row over 3 mph.
 */
export interface ConfirmState {
  runStartTs: number | null;
  dipStartTs: number | null;
  evidence: number;
  prevTs: number | null;
  prevRate: number;
  lastMoveTs: number | null;
}

export const CONFIRM_START: ConfirmState = Object.freeze({ runStartTs: null, dipStartTs: null, evidence: 0, prevTs: null, prevRate: 0, lastMoveTs: null });

/** The evidence is a float sum, which may land a hair under 1 (`evidenceEps` in Swift). */
const EVIDENCE_EPS = 0.000000001;

/**
 * The hold (ms) a speed (m/s) needs to confirm an auto drive on its own: (5/3)·(30 − mph) s, the
 * line from `AUTO_HOLD_MS_15` at 15 mph down to 0 at `AUTO_INSTANT_MPS` (30 mph), never under
 * `AUTO_HOLD_MIN_MS` (the GPS-spike guard, a little under the 1 s row interval: at 30 mph and over
 * a drive confirms on the second good reading in a row despite timer jitter, never on one);
 * infinite at 15 mph and under.
 */
export function autoHoldMs(mps: number): number {
  if (!(mps > DETECT.AUTO_MIN_MPS)) return Infinity;
  return Math.max(DETECT.AUTO_HOLD_MIN_MS, (DETECT.AUTO_HOLD_MS_15 * (DETECT.AUTO_INSTANT_MPS - mps)) / (DETECT.AUTO_INSTANT_MPS - DETECT.AUTO_MIN_MPS));
}

/**
 * One row of the auto evidence. A trusted row over 15 mph earns at `1 / autoHoldMs(speed)` per ms,
 * unless `veto` (a fresh confident cycling, walking or running report) or it is under 20 mph
 * without fresh car motion (`carFresh`). The interval between two rows that both earn adds its
 * length at the slower one's rate, so a lone fast reading earns nothing; a gap over
 * `AUTO_ROW_GAP_MAX_MS` adds nothing. Crawling and stops keep the evidence; 5 min with no trusted
 * row over 3 mph forgets it. It confirms once the evidence reaches 1.
 */
function autoStep(s: ConfirmState, r: DetectRow, veto: boolean, carFresh: boolean): { state: ConfirmState; confirmed: boolean } {
  const ok = trusted(r);
  const earns = ok && !veto && r.speed > DETECT.AUTO_MIN_MPS && (r.speed >= DETECT.AUTO_MPS_20 || carFresh);
  const rate = earns ? 1 / autoHoldMs(r.speed) : 0;
  let e = s.evidence;
  let first = s.runStartTs;
  if (s.prevTs !== null && rate > 0 && s.prevRate > 0 && r.ts - s.prevTs > 0 && r.ts - s.prevTs <= DETECT.AUTO_ROW_GAP_MAX_MS) {
    e += (r.ts - s.prevTs) * Math.min(rate, s.prevRate);
    if (first === null) first = s.prevTs;
  }
  const lastMove = ok && r.speed > DETECT.STOP_MPS ? r.ts : s.lastMoveTs;
  if (e > 0 && lastMove !== null && r.ts - lastMove >= DETECT.AUTO_FORGET_MS) {
    e = 0;
    first = null;
  }
  const state: ConfirmState = { runStartTs: first, dipStartTs: null, evidence: e, prevTs: r.ts, prevRate: rate, lastMoveTs: lastMove };
  return { state, confirmed: e >= 1 - EVIDENCE_EPS && !veto };
}

/**
 * One row of the confirmation. Auto: the evidence (`autoStep`; `carFresh`: confident car motion in
 * the last 2 min). The Start card: a trusted row at 10 mph or over extends the run (and ends any
 * dip), and the run confirms once it spans 15 s on the row clock; a row under it, or untrusted,
 * starts or extends a dip, and a dip spanning more than `CONFIRM_DIP_MAX_MS` breaks the run.
 */
export function confirmStep(s: ConfirmState, r: DetectRow, kind: TriggerKind, veto = false, carFresh = false): { state: ConfirmState; confirmed: boolean } {
  if (kind === 'auto') return autoStep(s, r, veto, carFresh);
  if (trusted(r) && r.speed >= DETECT.CONFIRM_MPS_MANUAL) {
    const run = s.runStartTs ?? r.ts;
    return { state: { ...CONFIRM_START, runStartTs: run, dipStartTs: null }, confirmed: r.ts - run >= DETECT.CONFIRM_HOLD_MS_MANUAL && !veto };
  }
  if (s.runStartTs === null) return { state: CONFIRM_START, confirmed: false };
  const dip = s.dipStartTs ?? r.ts;
  if (r.ts - dip > DETECT.CONFIRM_DIP_MAX_MS) return { state: CONFIRM_START, confirmed: false };
  return { state: { ...CONFIRM_START, runStartTs: s.runStartTs, dipStartTs: dip }, confirmed: false };
}

/**
 * A live motion report as the on-foot veto reads it: when it arrived, whether it says on foot
 * (walking, running or cycling) or in a vehicle (automotive, a car standing at a light too), and
 * whether it is confident (medium or high).
 */
export interface VetoReport {
  at: number;
  onFoot: boolean;
  automotive: boolean;
  confident: boolean;
}

/** The on-foot veto's memory: when the last confident on-foot report arrived, and the last confident automotive one (null: none). */
export interface VetoState {
  onFootAt: number | null;
  automotiveAt: number | null;
}

export const VETO_START: VetoState = Object.freeze({ onFootAt: null, automotiveAt: null });

/** One live report into the veto's memory. A low-confidence report changes nothing, and neither does a stationary or unknown one. */
export function noteVeto(s: VetoState, r: VetoReport): VetoState {
  if (!r.confident) return s;
  return { onFootAt: r.onFoot ? r.at : s.onFootAt, automotiveAt: r.automotive ? r.at : s.automotiveAt };
}

/**
 * The on-foot veto at `now` (the auto trigger's `veto`): a confident walking, running or cycling
 * report that arrived in the last `VETO_FRESH_MS` holds an auto confirmation, unless a confident
 * automotive report arrived after it. Only the car lifts it early: a low-confidence, stationary or
 * unknown report after it never does.
 */
export function onFootVeto(s: VetoState, now: number): boolean {
  if (s.onFootAt === null || now - s.onFootAt > DETECT.VETO_FRESH_MS) return false;
  return s.automotiveAt === null || s.automotiveAt <= s.onFootAt;
}

// ——— Slow traffic (a second auto path beside the speed evidence) ———

/** A live motion report as the slow-traffic path reads it (`at`: its arrival). */
export interface SlowReport {
  at: number;
  automotive: boolean;
  /** A car standing at a light is no car motion. */
  stationary: boolean;
  /** walking, running or cycling */
  onFoot: boolean;
  confident: boolean;
}

/**
 * The slow-traffic path's accumulators for one candidate: the confident moving car motion banked
 * (`carMs`) and the standing report's arrival when it is car motion (`carSince`); the automotive
 * coverage (any confident automotive report, a car standing at a light too) banked since the first
 * trusted row over 3 mph (`vehMs`, `moveStartTs`) and the standing report's arrival when it is one
 * (`vehSince`); the first and last confident automotive report's arrival; whether a confident
 * on-foot report arrived since the candidate opened (for good); the first and last trusted fix (with
 * its speed), the trusted path between them; the sum and count of the trusted rows over 3 mph (the
 * average); the first trusted row at 5 mph or more (`runStartTs`, where the trace-back starts) and
 * the last trusted row over 3 mph.
 */
export interface SlowTrafficState {
  carMs: number;
  carSince: number | null;
  vehMs: number;
  vehSince: number | null;
  firstCarAt: number | null;
  lastCarAt: number | null;
  onFoot: boolean;
  first: LatLng | null;
  last: { ts: number; lat: number; lng: number; mps: number } | null;
  pathM: number;
  sumMps: number;
  movingRows: number;
  moveStartTs: number | null;
  runStartTs: number | null;
  lastMoveTs: number | null;
}

export const SLOW_TRAFFIC_START: SlowTrafficState = Object.freeze({
  carMs: 0,
  carSince: null,
  vehMs: 0,
  vehSince: null,
  firstCarAt: null,
  lastCarAt: null,
  onFoot: false,
  first: null,
  last: null,
  pathM: 0,
  sumMps: 0,
  movingRows: 0,
  moveStartTs: null,
  runStartTs: null,
  lastMoveTs: null,
});

/** The car motion the candidate has seen by `now`: what is banked plus the standing car report's stretch. */
export function slowTrafficCarMs(s: SlowTrafficState, now: number): number {
  return s.carSince !== null && now > s.carSince ? s.carMs + (now - s.carSince) : s.carMs;
}

/** The automotive coverage by `now` since the first trusted row over 3 mph: banked plus the standing automotive report's stretch since then. */
export function slowTrafficVehMs(s: SlowTrafficState, now: number): number {
  if (s.moveStartTs === null || s.vehSince === null) return s.vehMs;
  const from = Math.max(s.vehSince, s.moveStartTs);
  return now > from ? s.vehMs + (now - from) : s.vehMs;
}

/** The slow-traffic path holds evidence: some car motion and not on foot (the candidate then waits 5 min, not 3). */
export const slowTrafficHeld = (s: SlowTrafficState, now: number): boolean => !s.onFoot && slowTrafficCarMs(s, now) > 0;

/**
 * One live report. A report stands until the next replaces it: the car motion and the automotive
 * coverage standing until now are banked; a confident automotive report starts a new coverage
 * stretch (a car standing at a light too) and, when not stationary, a new car motion stretch
 * (anything else, a low-confidence one too, stands as neither), and dates the first and last
 * automotive report. A confident walking, running or cycling report marks the candidate on foot
 * for good.
 */
export function slowTrafficReport(s: SlowTrafficState, r: SlowReport): SlowTrafficState {
  const carMs = s.carSince !== null && r.at > s.carSince ? s.carMs + (r.at - s.carSince) : s.carMs;
  const car = r.confident && r.automotive && !r.stationary;
  const veh = r.confident && r.automotive;
  return {
    ...s,
    carMs,
    carSince: car ? r.at : null,
    vehMs: slowTrafficVehMs(s, r.at),
    vehSince: veh ? r.at : null,
    firstCarAt: veh ? (s.firstCarAt ?? r.at) : s.firstCarAt,
    lastCarAt: veh ? r.at : s.lastCarAt,
    onFoot: s.onFoot || (r.confident && r.onFoot),
  };
}

/**
 * Whether the slow-traffic path confirms: never on foot; 90 s of car motion, from automotive reports
 * 30 s or more apart, with automotive coverage for 80 % of the time since the first trusted row over
 * 3 mph; an 800 m trusted path, the last trusted fix 400 m in a straight line from the first, and an
 * 8 mph average over the trusted rows over 3 mph.
 */
export function slowTrafficConfirmed(s: SlowTrafficState, now: number): boolean {
  if (s.onFoot || s.first === null || s.last === null || s.movingRows === 0) return false;
  if (s.firstCarAt === null || s.lastCarAt === null || s.moveStartTs === null) return false;
  return (
    slowTrafficCarMs(s, now) >= DETECT.SLOW_CAR_MS &&
    s.lastCarAt - s.firstCarAt >= DETECT.SLOW_CAR_SPAN_MS &&
    slowTrafficVehMs(s, now) >= DETECT.SLOW_CAR_COVER_MIN * (now - s.moveStartTs) &&
    s.pathM >= DETECT.SLOW_PATH_M &&
    distanceM(s.first, s.last) >= DETECT.SLOW_NET_M &&
    s.sumMps / s.movingRows >= DETECT.SLOW_AVG_MPS
  );
}

/**
 * One row of the slow-traffic path. As the speed evidence, 5 min with no trusted row over 3 mph
 * forgets it all (not the on-foot mark; a standing car or automotive report starts its stretch
 * again here, and two new reports 30 s apart are needed). A trusted row over 3 mph adds the step
 * from the last trusted fix to the path when that fix is at most `AUTO_ROW_GAP_MAX_MS` older (a
 * stopped car's GPS jitter, and a jump across a gap, add nothing), never more than 1.5 times what the
 * faster of the two rows covers in the time plus 5 m (a GPS jump inside the gap adds no more), and
 * its speed to the average; the first one starts the coverage clock; every trusted row is the last
 * fix (and the first, when none is yet).
 */
export function slowTrafficStep(s: SlowTrafficState, r: DetectRow): { state: SlowTrafficState; confirmed: boolean } {
  const n: SlowTrafficState =
    s.lastMoveTs !== null && r.ts - s.lastMoveTs >= DETECT.AUTO_FORGET_MS
      ? { ...SLOW_TRAFFIC_START, onFoot: s.onFoot, carSince: s.carSince === null ? null : r.ts, vehSince: s.vehSince === null ? null : r.ts }
      : s;
  const ok = trusted(r);
  const moved = ok && r.speed > DETECT.STOP_MPS;
  const gap = n.last === null ? -1 : r.ts - n.last.ts;
  let pathM = n.pathM;
  if (moved && n.last !== null && gap > 0 && gap <= DETECT.AUTO_ROW_GAP_MAX_MS) {
    const cap = (Math.max(r.speed, n.last.mps) * gap * DETECT.SLOW_STEP_SLACK) / 1000 + DETECT.SLOW_STEP_PAD_M;
    pathM += Math.min(distanceM(n.last, r), cap);
  }
  const state: SlowTrafficState = {
    ...n,
    first: ok && n.first === null ? { lat: r.lat, lng: r.lng } : n.first,
    last: ok ? { ts: r.ts, lat: r.lat, lng: r.lng, mps: r.speed } : n.last,
    pathM,
    sumMps: moved ? n.sumMps + r.speed : n.sumMps,
    movingRows: moved ? n.movingRows + 1 : n.movingRows,
    moveStartTs: n.moveStartTs ?? (moved ? r.ts : null),
    runStartTs: n.runStartTs ?? (ok && r.speed >= DETECT.MOVE_MPS ? r.ts : null),
    lastMoveTs: moved ? r.ts : n.lastMoveTs,
  };
  return { state, confirmed: slowTrafficConfirmed(state, r.ts) };
}

// ——— The car link ———

/** One Bluetooth or CarPlay output of the audio route as the link reads it (the type is AVAudioSession's port). */
export interface CarPort {
  uid: string;
  type: string;
}

/** Linked: any current output is a paired car (matched on its uid, whatever its name now), or CarPlay (`carAudio`). */
export function carLinked(current: readonly CarPort[], paired: readonly string[]): boolean {
  return current.some((o) => o.type === 'carAudio' || paired.includes(o.uid));
}

/** CarPlay (`carAudio`) is among the current outputs: a car for certain, which a paired Bluetooth output is not. */
export function carPlayOn(current: readonly CarPort[]): boolean {
  return current.some((o) => o.type === 'carAudio');
}

/** "Most of the drive": an output current for more than half the rows of a drive of 2 min or more. */
export function carMostOfDrive(withRows: number, rows: number): boolean {
  return rows >= DETECT.CAR_DRIVE_MIN_ROWS && withRows > rows * DETECT.CAR_DRIVE_SHARE_MIN;
}

/**
 * The car link start in progress: the run of link rows, when it began, the last one's time, and the
 * candidate's on-foot mark (a confident walking, running or cycling report since it opened, lifted
 * only by a later confident automotive report).
 */
export interface LinkState {
  run: number;
  runStartTs: number | null;
  prevTs: number | null;
  onFoot: boolean;
}

export const LINK_START: LinkState = Object.freeze({ run: 0, runStartTs: null, prevTs: null, onFoot: false });

/** One live report into the link's on-foot mark: a confident on-foot report sets it, a later confident automotive one lifts it; anything else changes nothing. */
export function linkReport(s: LinkState, r: SlowReport): LinkState {
  if (!r.confident) return s;
  if (r.onFoot) return { ...s, onFoot: true };
  if (r.automotive) return { ...s, onFoot: false };
  return s;
}

/**
 * One row of the car link start: with the link up (`linked`) and the candidate not on foot, a
 * trusted row at 5 mph or more with fresh car motion (with CarPlay current, `carPlay`, at 15 mph or
 * more without it too; a paired Bluetooth output alone could be headphones on a bike), extends the
 * run when it follows the last one within `AUTO_ROW_GAP_MAX_MS`, else begins one; any other row
 * ends it (the on-foot mark stays). Two in a row confirm.
 */
export function linkStep(s: LinkState, r: DetectRow, linked: boolean, carPlay: boolean, carFresh: boolean): { state: LinkState; confirmed: boolean } {
  const ok = linked && !s.onFoot && trusted(r) && r.speed >= DETECT.LINK_MIN_MPS && (carFresh || (carPlay && r.speed >= DETECT.LINK_NO_CAR_MPS));
  if (!ok) return { state: { ...LINK_START, onFoot: s.onFoot }, confirmed: false };
  const goesOn = s.run > 0 && s.prevTs !== null && r.ts - s.prevTs > 0 && r.ts - s.prevTs <= DETECT.AUTO_ROW_GAP_MAX_MS;
  const state: LinkState = goesOn
    ? { run: s.run + 1, runStartTs: s.runStartTs ?? r.ts, prevTs: r.ts, onFoot: s.onFoot }
    : { run: 1, runStartTs: r.ts, prevTs: r.ts, onFoot: s.onFoot };
  return { state, confirmed: state.run >= DETECT.LINK_PACE_ROWS };
}

// ——— The start ———

/**
 * The trace-back (native-ios §6.2): from the first row of the confirming run (`h`), the start is
 * the last trusted row at or under 3 mph before it, unless the car was rolling (trusted, 5 mph or
 * more) before that stop less than `TRACE_STOP_SPLIT_MS` earlier (a red light inside the departure,
 * a crawl out of a jam included): then the search goes on back from there. Null when the rows begin
 * already moving.
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
      if (rolling(rows[i]!)) {
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

/** Native's warm-up hint: the start is within 5 min of the last end's decision and 150 m of its place. */
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

/**
 * The cheap checks a wake passes before any motion query or GPS, in order. A region exit and
 * RoadWise coming to the front ignore the rest.
 */
export function wakeGate(c: WakeCtx): WakeGate {
  if (!c.armed) return 'off';
  if (!c.hasOwner) return 'noOwner';
  if (!c.permissionsOk) return 'permission';
  if (c.phase !== 'armed') return 'busy';
  if (c.reason !== 'region' && c.reason !== 'app' && c.now < c.candidateRestUntil) return 'resting';
  if (recentStarts(c.candidateStarts, c.now).length >= DETECT.CANDIDATES_PER_HOUR_MAX) return 'capped';
  return 'ok';
}

export type CandidateCause = 'cap' | 'timeout' | 'walking' | 'waitTimeout';

/**
 * A candidate's own clock. An auto one ends at its 30 min cap; 3 min after its last vehicle sign
 * (a trusted row at 10 mph or more with no fresh veto, or a confident automotive report), or after
 * it opened when it has seen none, 5 min once it holds evidence (speed evidence, or slow-traffic car
 * motion: `slowTrafficHeld`; a long light in a jam keeps it); or on a walk standing 20 s. A
 * Start-card one ends at its wait.
 */
export function candidateDue(
  kind: TriggerKind,
  since: number,
  waitUntil: number | null,
  walkSince: number | null,
  now: number,
  lastVehicleTs: number | null = null,
  hasEvidence = false
): CandidateCause | null {
  if (kind === 'manual') return waitUntil !== null && now >= waitUntil ? 'waitTimeout' : null;
  if (now - since >= DETECT.CANDIDATE_CAP_MS) return 'cap';
  if (now - Math.max(since, lastVehicleTs ?? since) >= (hasEvidence ? DETECT.AUTO_FORGET_MS : DETECT.CANDIDATE_MAX_MS)) return 'timeout';
  if (walkSince !== null && now - walkSince >= DETECT.WALK_CONFIRM_MS) return 'walking';
  return null;
}

/**
 * The hourly cap's record once a candidate is over: one that saw a vehicle (it confirmed, or it
 * watched a vehicle and did not) leaves it, its start (`since`) dropped; only empty ones count.
 */
export function startsAfter(starts: readonly number[], since: number, sawVehicle: boolean): number[] {
  return sawVehicle ? starts.filter((t) => t !== since) : [...starts];
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
  /** The last row was a trusted one at 10 mph or more. */
  prevDrive: boolean;
  /** The second of the last two trusted rows in a row at 10 mph or more (JS's `lastDroveAt`). */
  lastDroveTs: number | null;
  /** The last trusted row over 3 mph (`END_CRAWL_MPS`). */
  lastFastTs: number | null;
  /** The rows' pedometer counts in the last `STEP_WINDOW_MS`, oldest first (`endOnSteps`). */
  steps: { ts: number; steps: number }[];
  /** When the step walk was first due (JS's row clock: the row's end), until the car next goes over 3 mph. */
  stepWalkTs: number | null;
}

export const endClockAt = (ts: number): EndClock => ({
  lastMoveTs: ts,
  holdMs: 0,
  paceRun: 0,
  anchor: null,
  lastFix: null,
  prevDrive: false,
  lastDroveTs: null,
  lastFastTs: null,
  steps: [],
  stepWalkTs: null,
});

/**
 * One recorded row. Two trusted rows over 5 mph in a row, or a trusted fix 100 m from where the car
 * went still, is movement: the clock restarts there. A row with no valid fix while the phone's
 * standing motion report is car motion (`automotiveNow`) adds a second to the hold, up to an hour.
 * Two trusted rows at 10 mph or more in a row are driving (`lastDroveTs` at the second), which
 * voids a walk that arrived at or before it (`walkStanding`).
 */
export function endOnRow(c: EndClock, r: DetectRow, automotiveNow: boolean): EndClock {
  if (trusted(r)) {
    const paceRun = r.speed > DETECT.MOVE_MPS ? c.paceRun + 1 : 0;
    const prevDrive = r.speed >= DETECT.MOVING_MPS;
    const lastDroveTs = prevDrive && c.prevDrive ? r.ts : c.lastDroveTs;
    const lastFix = { ts: r.ts, mps: r.speed, lat: r.lat, lng: r.lng };
    // Over 3 mph the car may be moving: a step walk due before it is void.
    const fast = r.speed > DETECT.END_CRAWL_MPS;
    const lastFastTs = fast ? r.ts : c.lastFastTs;
    const stepWalkTs = fast ? null : c.stepWalkTs;
    const far = c.anchor !== null && distanceM(c.anchor, r) >= DETECT.MOVE_DISPLACEMENT_M;
    if (paceRun >= DETECT.MOVE_PACE_ROWS || far) {
      return { ...c, lastMoveTs: r.ts, holdMs: 0, paceRun, anchor: { lat: r.lat, lng: r.lng }, lastFix, prevDrive, lastDroveTs, lastFastTs, stepWalkTs };
    }
    return { ...c, paceRun, anchor: c.anchor ?? { lat: r.lat, lng: r.lng }, lastFix, prevDrive, lastDroveTs, lastFastTs, stepWalkTs };
  }
  const holdMs = !r.gnssValid && automotiveNow ? Math.min(DETECT.FIXLESS_HOLD_MAX_MS, c.holdMs + DETECT.ROW_MS) : c.holdMs;
  return { ...c, paceRun: 0, holdMs, prevDrive: false };
}

/**
 * A row's pedometer count (`steps`, after `endOnRow` for the same row), as JS's step walk reads it
 * (`motion.ts` `noteSteps`, `stepWalk`): the counts of the last `STEP_WINDOW_MS` (a lower count is
 * a pedometer that started again, and starts the log again), and the step walk due at the row's end
 * once they span `STEP_WALK_MIN` steps or more with no trusted fix over 3 mph in the
 * `STEP_CALM_MS` before it. Once due it stays due (`stepWalkTs`) until the car goes over 3 mph.
 */
export function endOnSteps(c: EndClock, ts: number, steps: number): EndClock {
  const last = c.steps[c.steps.length - 1];
  let log: { ts: number; steps: number }[];
  if (last !== undefined && steps < last.steps) log = [{ ts, steps }];
  else if (last !== undefined && ts <= last.ts) log = c.steps;
  else log = [...c.steps.filter((m) => m.ts >= ts - DETECT.STEP_WINDOW_MS), { ts, steps }];
  const first = log[0];
  const newest = log[log.length - 1];
  const t = ts + DETECT.ROW_MS;
  const calm = c.lastFastTs === null || t - c.lastFastTs > DETECT.STEP_CALM_MS;
  const walked = first !== undefined && newest !== undefined && newest.steps - first.steps >= DETECT.STEP_WALK_MIN;
  return { ...c, steps: log, stepWalkTs: c.stepWalkTs ?? (walked && calm ? t : null) };
}

/**
 * The standing walk's arrival, or null once the car has driven at or after it (`lastDroveTs` at or
 * after `walkSince`): as JS voids a walk the car drove after (`checkFoot`), only a walk that
 * arrived after the car was last at driving speed counts toward the walking end or the linger.
 */
export function walkStanding(c: EndClock, walkSince: number | null): number | null {
  return walkSince !== null && (c.lastDroveTs === null || c.lastDroveTs < walkSince) ? walkSince : null;
}

export type SafetyCause = 'still' | 'walking' | 'limit';

/**
 * `overdue`: a JS end rule would have ended the drive by now (12 h; a walk standing 10 s that the
 * car has not driven since, with no fix over 3 mph in the last 15 s; a step walk (`endOnSteps`);
 * 5 min without movement, holds excluded; the paired car or CarPlay gone `CAR_GONE_MS` with no
 * trusted fix over 3 mph since, `carGoneSince` being the car link's debounced "gone since").
 * `due`: the same plus the slack (10 s on either walk, a minute on the others), when native stops
 * sensing on its own. The limit comes first, then walking, then still (the car link's end is a
 * still one). `waitUntil`: a Start-card drive still waiting for driving speed (JS ends it unsaved
 * at that deadline, 5 min from the tap or the last touch): no walking or car-link end (the walk to
 * the car), and the still end only once the deadline has passed too, so a touch that keeps the
 * wait keeps the drive.
 */
export function endDue(
  c: EndClock,
  startedAt: number,
  now: number,
  walkSince: number | null,
  waitUntil: number | null = null,
  carGoneSince: number | null = null
): { due: SafetyCause | null; overdue: SafetyCause | null } {
  const carDriving = c.lastFix !== null && c.lastFix.mps > DETECT.END_CRAWL_MPS && now - c.lastFix.ts <= DETECT.WALK_STALE_FIX_MS;
  const age = now - startedAt;
  const walk = walkStanding(c, walkSince);
  const walked = waitUntil === null && walk !== null && !carDriving ? now - walk : -1;
  const stepped = waitUntil === null && c.stepWalkTs !== null ? now - c.stepWalkTs : -1;
  const still = now - c.lastMoveTs - c.holdMs;
  const gone = waitUntil === null && carGoneSince !== null && (c.lastFastTs === null || c.lastFastTs < carGoneSince) ? now - carGoneSince : -1;
  const pick = (slack: number, walkSlack: number): SafetyCause | null => {
    if (age >= DETECT.MAX_DRIVE_MS + slack) return 'limit';
    if (walked >= DETECT.WALK_END_MS + walkSlack || stepped >= walkSlack) return 'walking';
    if (still >= DETECT.STILL_END_MS + slack && (waitUntil === null || now >= waitUntil + slack)) return 'still';
    if (gone >= DETECT.CAR_GONE_MS + slack) return 'still';
    return null;
  };
  return { due: pick(DETECT.SAFETY_SLACK_MS, DETECT.WALK_SAFETY_SLACK_MS), overdue: pick(0, 0) };
}

/**
 * Whether JS's end (`stopCapture`) was an automatic one, so the linger watches on after it: a JS
 * end rule would have made it by now (`endDue` overdue 'still' or 'walking'), or a walk the car has
 * not driven since (`walkStanding`) has stood `WALK_STAND_MIN_MS` less a row (JS counts its walking
 * end on the row clock, which runs a row ahead of the wall clock native reads here) while the last
 * trusted fix was at a walker's pace or under (`WALKER_PACE_MAX_MPS`), more than
 * `WALK_STALE_FIX_MS` old, or missing. JS's walking end
 * fires 10 s after the walk began as the phone dates it, so as soon as 3 s after the report
 * arrived, where native counts from the arrival and is not yet overdue. It also lets a carried
 * phone at 5 mph or under end the drive where `endDue` still reads the car as driving; native keeps
 * no carried state, so any fix that slow counts here. A spare linger is harmless: a 20 s walk ends
 * it, and it takes no hourly cap entry, rest or parked spot. Like the walking end, never on a walk
 * while a Start-card drive still waits for driving speed.
 */
export function lingerAfterJsEnd(
  c: EndClock,
  startedAt: number,
  now: number,
  walkSince: number | null,
  waitUntil: number | null = null,
  carGoneSince: number | null = null
): boolean {
  const o = endDue(c, startedAt, now, walkSince, waitUntil, carGoneSince).overdue;
  if (o === 'still' || o === 'walking') return true;
  // A step walk JS ended on the row native just recorded (its row clock runs a row ahead).
  if (waitUntil === null && c.stepWalkTs !== null) return true;
  const walk = walkStanding(c, walkSince);
  if (waitUntil !== null || walk === null || now - walk < DETECT.WALK_STAND_MIN_MS - DETECT.ROW_MS) return false;
  return c.lastFix === null || c.lastFix.mps <= DETECT.WALKER_PACE_MAX_MPS || now - c.lastFix.ts > DETECT.WALK_STALE_FIX_MS;
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
