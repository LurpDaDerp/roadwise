// Road-centre calibration and the driver baselines (plan §M3; spec "Calibration"). Pure: the frame
// clock is the only clock, every window is bounded.
//
// - Stage 1: admitted samples (TRACKING, eyes open, the straight flag, ≥ 20 km/h; weight = frame dt,
//   capped) over a sliding 180 s window; the first evaluation at ≥ 60 s of driving with ≥ 20 s
//   admitted, then every 30 s until a pass. A pass sets one centre per gaze source present plus the
//   head centre (rev1 R-gaze), the radius, the roll offset, the Stage 1 open-eye EAR (frozen for the
//   drive), and the neutral MAR (floored, rev1 I4). 180 s without a pass → provisional (with a seed)
//   or uncalibrated; evaluation continues.
// - Staying calibrated (Task C5; rev1 I1, rev2 §2.3.1, §2.3.3, §2.3.7):
//   - the EMA (τ 180 s, ≤ 0.5°/min) takes admitted samples within the road core, max(3°, radius/2), applied
//     voidS late so a D1/D2/D3 warning can void them; a warning removes the admitted samples within ±voidS
//     from every window (voidAround);
//   - the rolling path, every 30 s over the last 60 s of admission: a small shift (≥ minShiftDeg, from a nearly
//     full window, located to convergence) or a larger one up to radiusMinDeg (relatively vacated twice) is
//     followed at ≤ 3°/min; a pitch-down beyond 2° needs translation evidence;
//   - the slow path: a peaked, vacated, road-scanned candidate beyond the rolling range, up to 12.5°, not in a
//     distraction zone, persisting 5 min enters the dual state; the driver's returns after road-scanning
//     excursions must land nearer it than c₀ (≥ 80 % of ≥ 10), and so for a rolling large shift (≥ 4; C5 round 1);
//   - the fatigue evidence gate (set by the engine): no downward or phone-ward step; a commit lowering the
//     head-centre pitch by ≥ fatigueCommitPitchDeg becomes fatigue evidence (head_slump) with c₀ kept, and a
//     phone-ward commit is refused (C5 round 1).
// - Before a pass: the running median head pitch (rev1 m6) and the provisional EAR.
// - Continuity (rev1 I7, rev2 R1-m2): a signature before every gap (markGap, or ≥ 30 s without
//   TRACKING), compared over the first 5 s after the resume; driver change or camera bump; the EAR
//   re-derived on any mismatch; the openness sanity check after every resume.
// - A camera bump from the step test (m5) or a rotationDeg change (rev2 R1-I1) restarts Stage 1.
// - Warm start from a profile only on a matching mount signature (C-5, C-6); the C2 seed.
//
// Task C4 (design rev2 §2.3.0, §2.3.2; rev4 §2.3.2a; rev5 §3; amendments W1–W3):
// - Posture: a settled rotation-compensated translation (posture.ts) opens the DUAL-CENTRE state: c₀ is kept,
//   c₁ is the mode of the first searchS of admission (peaked, ≤ searchMaxDeg from c₀, within searchMaxS of
//   admissible observed time, capped at searchCapS: Task C5); both classify (the engine); the commit needs commitS of admitted persistence and the relative
//   vacated test (a small shift: unimodality); a relative revert for revertS, or undecidedMaxS, reverts; after
//   a commit, probationS of probation with c₀ as a shadow reverts a commit the samples reverse. A settled pitch
//   drop with no translation is a head_slump candidate (fatigue evidence once held; never posture).
// - C4 round 1 (review-C4): c₁ must be road-like (C4-1: inside c₀'s unwidened on-road zones, not the phone, at
//   most candidateNonDrivingShare of the window in c₀'s distraction zones, never `other`: C4 round 2); the posture
//   widening widens the road-centre circle only (round 2); the revert is measured on the last revertWindowS; the step
//   bump reads the compensated box; a slump candidate becomes head_slump only after slumpHoldS with the head
//   straight and the gaze on the road (C4-3); the interim EAR also needs a near-forward gaze.
// - A step bump enters the dual state with c₀ shifted by the measured head step (no restart); a resume
//   mismatch that is not a driver change enters it too; a rotation bump keeps the full restart.
// - A stop is a gap for posture and the step bump: neither is fed while STOPPED. At the move-off the settled
//   windows either side of the stop are compared, in order: a camera step (W3), a driver change (armed by a LOST
//   run of ≥ swapLostS during the stop), a posture translation. A driver change is checked provisionally at the
//   stop (swapTrackS after the face returns), with an interim EAR (W1: near-forward frames with a blink seen,
//   floored at interimFloor × the old one), and confirmed after the move-off.
// - A confirmed driver change (W2) keeps the old centres as a seed: `seeded`, widened, D1 and D2 on; Stage 1
//   restarts and verifies it.
import { angularDistanceDeg, relative, rollCorrect, toDriverFrame } from './angles';
import type { ConditionerRefs, EarPair, Perceived } from './conditioning';
import type { DmsConfig } from './config';
import { SignatureWindow, StepBump, signatureOf, type MountSample } from './continuity';
import { evaluateCluster, histogramMode, refineMode, type WeightedDir } from './histogram';
import { createPostureDetector, locate, modeOf, peaked, relativelyVacated, relativeRevert, shareNear, unimodal, vacatedRing, type CompSignature } from './posture';
import { compareSignatures, type DmsProfileV1, type LearnedZone, type MountSignature } from './profile';
import { median, quantile, sd } from './stats';
import type { AnglePair, DriverSide, EngineFrame, GazeSource, Rotation, VehicleContext } from './types';
import { RingBuffer } from './windows';
import { cameraRel, isDistractionZone, phoneScreenRadius, zoneAt, zoneClass } from './zones';

export type CalibrationState = 'none' | 'seeded' | 'calibrated' | 'provisional' | 'uncalibrated' | 'recalibrating';

export type CalibrationEventKind =
  | 'calibrated'
  | 'provisional'
  | 'uncalibrated'
  | 'camera_bump'
  | 'driver_change'
  | 'baseline_reset'
  | 'warm_start'
  /** Task C4: the dual-centre state opened (cause: a posture step, a step bump, a resume mismatch, a stop) */
  | 'posture_dual'
  /** Task C4: the dual state committed c₁ (demoteMirrors: a large translation, U-6) */
  | 'posture_commit'
  /** Task C4: the dual state reverted (relative, undecided, no candidate) or probation reverted a commit */
  | 'posture_revert'
  /** Task C4: a settled head-pitch drop with no translation (fatigue evidence) */
  | 'head_slump'
  /** Task C4 (rev5 V2): a driver change seen provisionally at a stop */
  | 'driver_change_provisional'
  /** Task C4 (rev5 V2): the provisional driver change was not confirmed after the move-off */
  | 'driver_change_reverted';

export interface CalibrationEvent {
  kind: CalibrationEventKind;
  tMs: number;
  /** camera_bump: step, resume, rotation, stop; posture_dual: step, bump, resume, stop, slow; posture_revert: relative, undecided, no_candidate, probation, fatigue */
  cause?: 'step' | 'resume' | 'rotation' | 'stop' | 'bump' | 'slow' | 'relative' | 'undecided' | 'no_candidate' | 'probation' | 'fatigue';
  /** posture_commit: the translation was large enough to demote the learned mirrors (U-6) */
  demoteMirrors?: boolean;
}

/** The C2 seed (§M3): medians of the last 3 s of TRACKING with the eyes open, taken while parked. */
export interface CalibrationSeed {
  gazeCentres: { geometric: AnglePair | null; net: AnglePair | null };
  headCentre: AnglePair;
  rollOffsetDeg: number;
  mount: MountSignature;
  orientation: Rotation;
  openEyeEar: EarPair;
}

export type SeedResult = { ok: true; seed: CalibrationSeed } | { ok: false; reason: 'no_tracking' | 'too_short' | 'unsteady' };

export interface Calibrator {
  /** `stopped` (Task C4): the engine's STOPPED state, a gap for posture and the step bump */
  observe(f: EngineFrame, p: Perceived, ctx: VehicleContext | null, stopped?: boolean): void;
  /** Task C4: the dual state's c₁ (driver frame) once found; null outside the dual state or while searching */
  dual(): { gaze: AnglePair | null; head: AnglePair | null } | null;
  /** Task C4: the posture widening is on (an onset, or the dual state) */
  postureWidening(): boolean;
  /** Task C4: recalibrating (a provisional driver change, or a new driver's seed not yet verified) */
  recalibrating(): boolean;
  /** Task C4: the HUD's calibration cause */
  reason(): 'posture' | 'recalibrating' | null;
  /** Task C5 (rev1 I1): a D1/D2/D3 warning at tMs: the admitted samples within ±voidS are removed */
  voidAround(tMs: number): void;
  /** Task C5 (rev2 §2.3.7): the fatigue evidence gate: while set, no downward or phone-ward adaptation */
  setFatigueGate(on: boolean): void;
  /** The camera is about to pause: keep the mount signature for the comparison after the resume. */
  markGap(tMs: number): void;
  applySeed(seed: CalibrationSeed): void;
  /** Runs an evaluation now; true on a pass. */
  evaluate(tMs: number): boolean;
  state(): CalibrationState;
  centre(source: GazeSource | 'head'): AnglePair | null;
  radius(): number | null;
  rollOffset(): number;
  openEyeEar(): EarPair | null;
  neutralMar(): number | null;
  neutralMouthW(): number | null;
  pitchReference(): number | null;
  /** The post-resume comparison is pending: zones widen, D2/D3 stay off (§M3). */
  resumeChecking(): boolean;
  mountSignature(): MountSignature | null;
  refs(): ConditionerRefs;
  /** C4 round 1: postureIgnored counts posture steps and bumps seen before any centre (Stage 1 decides) */
  stats(): { drivingS: number; admittedS: number; postureIgnored: number };
  /** drivingS without building the stats object (final review n1: read per frame) */
  drivingS(): number;
  drainEvents(): CalibrationEvent[];
  toProfile(savedAtMs: number, learnedZones?: LearnedZone[]): DmsProfileV1 | null;
}

interface Sample {
  t: number;
  w: number;
  head: AnglePair;
  roll: number;
  geo: AnglePair | null;
  net: AnglePair | null;
  earR: number | null;
  earL: number | null;
  mar: number | null;
  mouthW: number | null;
}

interface Comparison {
  kind: 'resume' | 'warm';
  before: MountSignature | null;
  samples: MountSample[];
  trackingS: number;
}

const MAX_FPS = 30;
const PITCH_MEDIAN_EVERY_MS = 250;
/** Task C4: σ̂ before any Stage 1 evaluation (the geometric path's per-frame noise) */
const SIGMA_DEFAULT = 4;
/** Task C4 (W1): a blink in the interim window: the mean EAR below this share of its p90, back within BLINK_MAX_MS */
const BLINK_DIP = 0.6;
const BLINK_MAX_MS = 600;
/** Task C5: the rolling path's locator radius floor (2σ̂ above it) */
const LOCATE_MIN_R_DEG = 4;
/** C5 round 1: the excursion returns kept (≥ 10 per 5 min at two a minute) */
const RETURNS_KEPT = 128;
/** C5 round 1: an excursion is the gaze away for at least this long, over at least EXCURSION_MIN_FRAMES frames (not noise) */
const EXCURSION_MIN_MS = 400;
const EXCURSION_MIN_FRAMES = 3;
/** Task C5: the share of the rolling window's weight a small-shift follow needs */
const SMALL_MIN_WINDOW_FRAC = 0.75;
const ORIGIN: AnglePair = Object.freeze({ yaw: 0, pitch: 0 });

type Centres = { geometric: AnglePair | null; net: AnglePair | null; head: AnglePair | null };

interface Dual {
  cause: 'step' | 'bump' | 'resume' | 'stop' | 'slow';
  c0: Centres;
  /** c₁ once found */
  c1: Centres | null;
  enteredT: number;
  observedS: number;
  /** Task C5: the admissible observed time of the candidate search (a straight row, or low turn rates) */
  searchObservedS: number;
  /** the persistence window starts here (the admitted samples since) */
  since: number;
  revertS: number;
  lastEvalT: number;
  /** consecutive evaluations whose mode agreed within max(1°, SE) */
  stable: number;
  /** the step's translation (the mirror demotion) */
  box: number;
  iodFrac: number;
}

/** C4 round 1 (review-C4 C4-3): a slump candidate under watch */
interface SlumpWatch {
  from: { pitch: number; yaw: number };
  /** the head centre's yaw (driver frame) at the start, or null (the pre-level decides) */
  yawRef: number | null;
  observedS: number;
  loweredS: number;
  yawOkS: number;
  gazeS: number;
  onRoadS: number;
}

interface Probation {
  c0: Centres;
  since: number;
  observedS: number;
  reverseS: number;
  lastEvalT: number;
}

interface StopEpisode {
  /** the settled window before the stop */
  before: MountSample[];
  lostSince: number | null;
  /** the settled window before the current LOST run */
  preLost: MountSample[] | null;
  armed: boolean;
  /** the provisional check's frames after the face returned */
  check: { preLost: MountSample[]; samples: MountSample[]; trackingS: number } | null;
}

interface Provisional {
  oldEar: EarPair | null;
  r: number[];
  l: number[];
  trackingS: number;
  blinkSeen: boolean;
  dipSince: number | null;
  done: boolean;
}

export function createCalibrator(cfg: DmsConfig, init: { driverSide: DriverSide; profile?: DmsProfileV1 | null; seed?: CalibrationSeed | null }): Calibrator {
  const c = cfg.calibration;
  const side = init.driverSide;
  const events: CalibrationEvent[] = [];
  const samples = new RingBuffer<Sample>(Math.ceil(c.windowS * MAX_FPS) + 1);
  const pitchRing = new RingBuffer<{ t: number; pitch: number }>(Math.ceil(c.runningMedianS * MAX_FPS) + 1);
  /**
   * The ring's median (a 30 s running median), refreshed at most every PITCH_MEDIAN_EVERY_MS of frame time
   * after the ring changes: it was sorted twice per frame before calibration (Task 12's profile).
   */
  let pitchMedian: number | null = null;
  let pitchMedianStale = true;
  let pitchMedianT = Number.NEGATIVE_INFINITY;
  let pitchNowT = 0;
  const sigWindow = new SignatureWindow(c.signatureS);
  const bump = new StepBump(cfg);
  // Task C4.
  const po = c.posture;
  const posture = createPostureDetector(cfg);
  let sigmaHat = SIGMA_DEFAULT;
  let onsetLeftS = 0;
  let dual: Dual | null = null;
  let probation: Probation | null = null;
  let stopEp: StopEpisode | null = null;
  let postStop: { ep: StopEpisode; samples: MountSample[]; trackingS: number } | null = null;
  let provisional: Provisional | null = null;
  /** a new driver's seed not yet verified by Stage 1 (W2) */
  let seedUnverified = false;
  let wasStopped = false;
  /** C4 round 1 (C4-3) */
  let slumpWatch: SlumpWatch | null = null;
  /** C4 round 1 (review-C4 minor): posture steps and bumps seen before any centre existed */
  let postureIgnored = 0;
  // Task C5.
  const warnings: number[] = [];
  let fatigueGate = false;
  /** admitted samples awaiting the EMA (applied voidS late, so a warning can still void them) */
  const emaQueue = new RingBuffer<{ t: number; w: number; head: AnglePair; geo: AnglePair | null; net: AnglePair | null }>(Math.ceil((c.voidS + 2) * MAX_FPS) + 2);
  let lastRollT = Number.NEGATIVE_INFINITY;
  let prevRoll: { m: AnglePair; vacated: boolean; se: number } | null = null;
  /**
   * C5 round 1: the rolling path's current large candidate: its mode, the centre when it appeared, since when, and
   * whether the returns since then have corroborated it (latched while the candidate persists)
   */
  let largeCand: { m: AnglePair; from: AnglePair; since: number; ok: boolean } | null = null;
  /** the rolling path's follow: targets per source until the next evaluation */
  let follow: Centres | null = null;
  /** the rolling path is engaged: once a shift has been followed, smaller ones keep it following (the drift's pace) */
  let engaged = false;
  let slowCand: { cand: AnglePair; head: AnglePair | null; since: number; admittedS: number; lastT: number } | null = null;
  /** road-scanning excursions per minute of the slow candidate (by minute since its start), and the one in flight */
  /**
   * C5 round 1 (review-C5 C5-1): the road-scanning excursions (≥ excursionMinDeg yaw from the centre, back within
   * excursionReturnS) and where each returned to: the first fixation of returnFixationMs after it (every frame
   * within the radius of the run's mean). A shifted road is returned to every time; a display watched 70 % of the
   * time about 70 %.
   */
  const returns = new RingBuffer<{ t: number; at: AnglePair }>(RETURNS_KEPT);
  let excursion: { leftT: number; backT: number | null; run: { t: number; x: AnglePair }[] } | null = null;
  /** the gaze away from the centre since, and for how many frames (an excursion once long enough) */
  let away: { since: number; frames: number } | null = null;

  let state: CalibrationState = 'none';
  let admittedS = 0;
  let drivingS = 0;
  let lastEvalT: number | null = null;
  let gaveUp = false;
  let hasSeed = false;
  const centres: { geometric: AnglePair | null; net: AnglePair | null; head: AnglePair | null } = { geometric: null, net: null, head: null };
  let radius: number | null = null;
  let roll = 0;
  let ear: EarPair | null = null;
  let earFrozen = false;
  let earCollector: { trackingS: number; r: number[]; l: number[] } | null = { trackingS: 0, r: [], l: [] };
  let mar: number | null = null;
  let mouthW: number | null = null;
  let lastRotation: Rotation | null = null;
  let lastTrackingT: number | null = null;
  let gap: { before: MountSignature | null } | null = null;
  let comparing: Comparison | null = null;
  let sanity: { trackingS: number; values: number[]; r: number[]; l: number[] } | null = null;
  /** a rotation bump since the last gap: that resume's signature comparison is skipped (T6 review m3) */
  let rotationBumpedInGap = false;
  let warmProfile: DmsProfileV1 | null = init.profile && init.profile.driverSide === side ? init.profile : null;
  let tNow = 0;

  const toDrv = (a: AnglePair, r: number) => toDriverFrame(rollCorrect(a, r), side);
  const emit = (kind: CalibrationEventKind, cause?: CalibrationEvent['cause']) => events.push(cause ? { kind, tMs: tNow, cause } : { kind, tMs: tNow });

  function restartStage1(): void {
    samples.clear();
    admittedS = 0;
    drivingS = 0;
    lastEvalT = null;
    gaveUp = false;
    hasSeed = false;
    centres.geometric = null;
    centres.net = null;
    centres.head = null;
    radius = null;
    state = 'recalibrating';
    bump.clear();
    posture.clear();
    dual = null;
    probation = null;
  }

  function rederiveEar(): void {
    earFrozen = false;
    earCollector = { trackingS: 0, r: [], l: [] };
  }

  function cameraBump(cause: 'step' | 'resume' | 'rotation'): void {
    restartStage1();
    if (cause !== 'step') rederiveEar(); // a step bump keeps the baselines (§M3); a resume mismatch re-derives the EAR (rev2 R1-m2)
    emit('camera_bump', cause);
  }

  /**
   * The openness sanity check failed (rev2 R1-m2 as ruled by T6 review I3): the EAR becomes AT ONCE the
   * per-eye p90 of the sanity window's raw EARs (an eye without samples: its old value × the median
   * openness), never null, so closure rules run throughout; the §M3 re-derivation continues from the same
   * samples and replaces it when its 20 s are complete.
   */
  function baselineReset(win: { trackingS: number; r: number[]; l: number[] }, medianOpenness: number): void {
    const old = ear;
    const pick = (xs: number[], prev: number | null | undefined) =>
      xs.length > 0 ? quantile(xs, c.provisionalEarPercentile) : prev != null ? prev * medianOpenness : null;
    ear = { r: pick(win.r, old?.r), l: pick(win.l, old?.l) };
    earFrozen = false;
    earCollector = { trackingS: win.trackingS, r: [...win.r], l: [...win.l] };
    emit('baseline_reset');
  }

  /**
   * A driver change (rev5 V2, amendment W2): the mount has not moved, so the new driver is seeded from the old
   * centres (widened until Stage 1 verifies them; D1 and D2 stay on). Stage 1 restarts; the EAR is re-derived
   * (the interim EAR, or the old one, until the new collector completes); the MAR and the pitch ring are nulled.
   */
  function driverChange(): void {
    const keep: Centres = { ...centres };
    const keepRadius = radius;
    restartStage1();
    centres.geometric = keep.geometric;
    centres.net = keep.net;
    centres.head = keep.head;
    radius = keepRadius;
    if (centres.head !== null || centres[cfg.gazeSource] !== null) {
      hasSeed = true;
      state = 'seeded';
      seedUnverified = true;
    }
    rederiveEar();
    provisional = null;
    mar = null;
    mouthW = null;
    pitchRing.clear();
    pitchMedianStale = true;
    pitchMedian = null;
    emit('driver_change');
  }

  // ——— Task C4: the dual-centre state ———

  const shiftCentre = (a: AnglePair | null, d: AnglePair): AnglePair | null => (a === null ? null : { yaw: a.yaw + d.yaw, pitch: a.pitch + d.pitch });
  /** A camera-frame head step as the driver frame sees it (LHD: yaw flips). */
  const toDrvDelta = (d: AnglePair): AnglePair => ({ yaw: side === 'left' ? -d.yaw : d.yaw, pitch: d.pitch });

  function enterDual(cause: Dual['cause'], shift: AnglePair | null, box = 0, iodFrac = 0): void {
    if (centres.head === null && centres[cfg.gazeSource] === null) {
      postureIgnored++; // nothing to keep: Stage 1 decides (counted, so the summary can tell it from "no posture")
      return;
    }
    const drvShift = shift === null ? null : toDrvDelta(shift);
    if (drvShift !== null) {
      centres.geometric = shiftCentre(centres.geometric, drvShift);
      centres.net = shiftCentre(centres.net, drvShift);
      centres.head = shiftCentre(centres.head, drvShift);
    }
    dual = { cause, c0: { ...centres }, c1: null, enteredT: tNow, observedS: 0, searchObservedS: 0, since: tNow, revertS: 0, lastEvalT: tNow, stable: 0, box, iodFrac };
    probation = null;
    posture.clear();
    posture.resetFit();
    bump.clear();
    emit('posture_dual', cause);
  }

  function exitDual(cause: 'relative' | 'undecided' | 'no_candidate' | 'fatigue'): void {
    if (dual === null) return;
    centres.geometric = dual.c0.geometric;
    centres.net = dual.c0.net;
    centres.head = dual.c0.head;
    dual = null;
    emit('posture_revert', cause);
  }

  /** The admitted samples since `t0` as driver-frame directions of one source. */
  function dirsSince(t0: number, source: 'geometric' | 'net' | 'head'): WeightedDir[] {
    const out: WeightedDir[] = [];
    samples.forEach((sm) => {
      if (sm.t < t0 || !(sm.w > 0)) return;
      const a = source === 'head' ? sm.head : source === 'net' ? sm.net : sm.geo;
      if (a !== null) out.push({ ...toDrv(a, roll), w: sm.w });
    });
    return out;
  }
  const weightOf = (d: readonly WeightedDir[]) => d.reduce((a, x) => a + x.w, 0);
  const primary = (): 'geometric' | 'net' => (cfg.gazeSource === 'net' && centres.net !== null ? 'net' : 'geometric');
  const phoneR = phoneScreenRadius(cfg);
  /** The camera direction relative to a gaze centre (the phone-screen circle), or null without one. */
  const cameraOf = (cs: Centres): AnglePair | null => {
    const g = cs[cfg.gazeSource] ?? cs.geometric;
    return g === null ? null : cameraRel(g, roll, side);
  };
  /**
   * The share of `dirs`' weight in the DISTRACTION zones of c₀'s unwidened map (C4 round 2, R1-A: never `other`,
   * where a raised posture puts the road itself).
   */
  function nonDrivingShare(dirs: readonly WeightedDir[], c0: AnglePair, camera: AnglePair | null): number {
    let total = 0;
    let nd = 0;
    for (const x of dirs) {
      total += x.w;
      if (isDistractionZone(zoneAt(relative(x, c0), radius, camera, cfg), cfg)) nd += x.w;
    }
    return total > 0 ? nd / total : 0;
  }
  /**
   * The camera relative to c₀ for the posture tests, or null when it lies inside c₀'s road-centre circle: a camera
   * there is looked at whenever the road is, and no zone rule can tell the two apart (review-C4 round 1, deviation
   * 1 accepted). C4 round 2: its phone-screen circle then neither makes a raised road `phone_screen` nor counts as
   * distraction.
   */
  function offRoadCamera(cs: Centres): AnglePair | null {
    const cam = cameraOf(cs);
    return cam !== null && angularDistanceDeg(cam, ORIGIN) > (radius ?? c.radiusMinDeg) ? cam : null;
  }
  /**
   * C4 round 1 (review-C4 C4-1 rule 1): a road-like point lies inside c₀'s UNWIDENED on-road zones (the phone
   * circle aside) and is not the phone: more than the phone screen's radius + candidateCameraMarginDeg from an
   * off-road camera, or nearer c₀ than the camera (the road seen from a new posture, as after a bump's pre-shift).
   * C4 round 2: every c₁ update is held to this, not only the first candidate. Task C5 (C5 round 1, C5-1 rule 3):
   * the slow path's candidate is beyond c₀'s on-road zones by design, so that test is waived for it; it must still
   * not be in c₀'s distraction zones (and roadLike's distraction share applies), and road scanning's return points
   * corroborate it.
   */
  function roadLikeAt(m: AnglePair, c0: AnglePair, camera: AnglePair | null, slow = false): boolean {
    const rel = relative(m, c0);
    const z = zoneAt(rel, radius, null, cfg);
    // C5 round 1 (C5-1 rule 3): a slow candidate is beyond c₀'s on-road zones by design, but never in its
    // distraction zones.
    if (slow ? isDistractionZone(z, cfg) : zoneClass(z, cfg) !== 'on_road') return false;
    if (camera === null) return true;
    const toCamera = angularDistanceDeg(rel, camera);
    return !(toCamera <= phoneR + po.candidateCameraMarginDeg && toCamera < angularDistanceDeg(rel, ORIGIN));
  }
  /** A road-like candidate: a road-like point, with at most candidateNonDrivingShare of the window in c₀'s distraction zones. */
  function roadLike(m: AnglePair, dirs: readonly WeightedDir[], c0: AnglePair, camera: AnglePair | null, slow = false): boolean {
    return roadLikeAt(m, c0, camera, slow) && nonDrivingShare(dirs, c0, camera) <= po.candidateNonDrivingShare;
  }

  /** Task C5: a row the candidate search counts (straight, or every known turn rate below searchCurveRateDegS). */
  function searchAdmissible(ctx: VehicleContext | null): boolean {
    if (ctx === null) return false;
    if (ctx.straight === true) return true;
    const rates = [ctx.yawRateDegS, ctx.courseRateDegS].filter((x): x is number => x !== null);
    return rates.length > 0 && rates.every((x) => Math.abs(x) < po.searchCurveRateDegS);
  }

  function evaluateDual(dt: number, ctx: VehicleContext | null): void {
    const d = dual!;
    d.observedS += dt;
    if (searchAdmissible(ctx)) d.searchObservedS += dt;
    if (tNow - d.lastEvalT < po.evalEveryS * 1000) {
      if (d.observedS >= po.undecidedMaxS) exitDual('undecided');
      return;
    }
    const sinceLast = (tNow - d.lastEvalT) / 1000;
    d.lastEvalT = tNow;
    const src = primary();
    const r = radius ?? c.radiusMinDeg;
    const c0 = d.c0[src] ?? d.c0.head;
    if (c0 === null) {
      dual = null;
      return;
    }
    const camera = offRoadCamera(d.c0);
    if (d.c1 === null) {
      // The candidate: the mode of the first searchS of admission, peaked, near c₀, road-like (C4 round 1).
      const found = dirsSince(d.enteredT, src);
      if (weightOf(found) >= po.searchS) {
        const m = modeOf(found, cfg);
        if (m !== null && angularDistanceDeg(m, c0) <= po.searchMaxDeg && peaked(found, m, sigmaHat, cfg) && roadLike(m, found, c0, camera)) {
          const mh = modeOf(dirsSince(d.enteredT, 'head'), cfg);
          const other: 'geometric' | 'net' = src === 'net' ? 'geometric' : 'net';
          const mo = modeOf(dirsSince(d.enteredT, other), cfg);
          d.c1 = { geometric: src === 'geometric' ? m : mo, net: src === 'net' ? m : mo, head: mh };
          d.since = d.enteredT;
        }
      }
      if (d.c1 === null && (d.searchObservedS >= po.searchMaxS || d.observedS >= po.searchCapS)) exitDual('no_candidate');
      return;
    }
    const win = dirsSince(d.since, src);
    const c1 = d.c1[src] ?? d.c1.head!;
    // The revert: back at c₀ for revertS (measurable only when c₁ is a separable cluster, beyond the small-shift
    // bound; a small shift or a bump's pre-shifted c₀ is decided by its commit, or undecided), or undecided too long.
    // C4 round 1 (C4-1 rule 3): measured on the last revertWindowS of admission, so an ended lean reverts promptly.
    // Defence in depth (review-C4 round 1): today c₁ follows the window mode and jumps back to c₀ before this can
    // accrue, but the rolling window keeps a future change to that restart rule from reopening the cumulative hole.
    const separable = angularDistanceDeg(c0, c1) > po.smallShiftSigmas * sigmaHat;
    const recent = dirsSince(Math.max(d.since, tNow - po.revertWindowS * 1000), src);
    if (separable && relativeRevert(recent, c0, c1, r, cfg)) d.revertS += sinceLast;
    else d.revertS = 0;
    if (d.revertS >= po.revertS) {
      exitDual('relative');
      return;
    }
    if (d.observedS >= po.undecidedMaxS) {
      exitDual('undecided');
      return;
    }
    // Stability: c₁ follows the persistence window's mode; it is stable while consecutive evaluations agree within
    // max(1°, SE) (SE: σ̂ over the window's frames). A jump restarts the persistence window.
    const m = modeOf(win, cfg);
    if (m === null) return;
    // C4 round 2 (review-C4 R1-A): c₁ only ever follows a road-like mode. A reading bout makes the short window's
    // mode the phone; c₁ keeps its place (and the persistence its start) instead of jumping onto it, where the
    // limited union would count the phone as c₁'s road centre.
    if (!roadLikeAt(m, c0, camera, d.cause === 'slow')) {
      d.stable = 0;
      return;
    }
    const wSum = weightOf(win);
    const se = sigmaHat / Math.sqrt(Math.max(1, win.length));
    const moved = angularDistanceDeg(m, c1);
    if (moved > Math.max(3, 3 * se) && wSum >= po.searchS) {
      d.since = tNow - 1; // c₁ jumped (a second step): persistence restarts
      d.stable = 0;
    } else d.stable = moved <= Math.max(1, se) ? d.stable + 1 : 0;
    const mh = modeOf(dirsSince(d.since, 'head'), cfg);
    d.c1 = { ...d.c1, [src]: m, head: mh ?? d.c1.head };
    if (wSum < po.commitS || d.stable < 2) return;
    // C4 round 1 (C4-1 rule 1): the persistence window must stay road-like too (never a commit onto a phone).
    if (!roadLike(m, win, c0, camera, d.cause === 'slow')) return;
    const dist = angularDistanceDeg(c0, c1);
    const ok = dist > po.smallShiftSigmas * sigmaHat ? relativelyVacated(win, c0, c1, r, cfg) : unimodal(win, m, r, sigmaHat, cfg);
    if (!ok) return;
    commitDual(d);
  }

  function commitDual(d: Dual): void {
    const pick = (src: 'geometric' | 'net' | 'head', fallback: AnglePair | null) => {
      if (fallback === null) return null;
      return modeOf(dirsSince(d.since, src), cfg) ?? fallback;
    };
    const next: Centres = { geometric: pick('geometric', d.c1!.geometric ?? d.c0.geometric), net: pick('net', d.c1!.net ?? d.c0.net), head: pick('head', d.c1!.head ?? d.c0.head) };
    // Task C5 (review-C4 §5, rev1 K1-C): a commit that lowers the head-centre pitch by fatigueCommitPitchDeg or
    // more needs the fatigue gate clear. A slide down the seat while drowsy is fatigue evidence, and c₀ is kept.
    const src = primary();
    const from = d.c0.head ?? d.c0[src];
    const to = d.c0.head !== null ? next.head : next[src];
    if (fatigueGate && from !== null && to !== null && to.pitch - from.pitch <= -po.fatigueCommitPitchDeg) {
      exitDual('fatigue');
      emit('head_slump');
      return;
    }
    // C5 round 1 (review-C5 §4): a phone-ward commit needs the gate clear too (no adaptation toward the phone while
    // fatigued); it is refused and c₀ kept.
    const g0 = d.c0[src] ?? d.c0.head;
    const g1 = next[src] ?? next.head;
    if (fatigueGate && g0 !== null && g1 !== null && phoneWard(g0, g1)) {
      exitDual('fatigue');
      return;
    }
    centres.geometric = next.geometric;
    centres.net = next.net;
    centres.head = next.head;
    const demote = d.box >= po.demoteBoxC || Math.abs(d.iodFrac) >= po.demoteIodFracC;
    probation = { c0: d.c0, since: tNow, observedS: 0, reverseS: 0, lastEvalT: tNow };
    dual = null;
    events.push({ kind: 'posture_commit', tMs: tNow, demoteMirrors: demote });
  }

  function evaluateProbation(dt: number): void {
    const pr = probation!;
    pr.observedS += dt;
    if (tNow - pr.lastEvalT >= po.evalEveryS * 1000) {
      const sinceLast = (tNow - pr.lastEvalT) / 1000;
      pr.lastEvalT = tNow;
      const src = primary();
      const committed = centres[src] ?? centres.head;
      const shadow = pr.c0[src] ?? pr.c0.head;
      const win = dirsSince(pr.since, src);
      if (committed !== null && shadow !== null && weightOf(win) >= po.evalEveryS * 2 && relativelyVacated(win, committed, shadow, radius ?? c.radiusMinDeg, cfg)) pr.reverseS += sinceLast;
      else pr.reverseS = 0;
      if (pr.reverseS >= po.probationRevertS) {
        centres.geometric = pr.c0.geometric;
        centres.net = pr.c0.net;
        centres.head = pr.c0.head;
        probation = null;
        emit('posture_revert', 'probation');
        return;
      }
    }
    if (pr.observedS >= po.probationS) probation = null;
  }

  // ——— Task C5: the void, the rolling path, the slow path ———

  const voided = (t: number) => warnings.some((w) => Math.abs(t - w) <= c.voidS * 1000);

  /** The camera direction in the driver frame (the phone screen), for the screen exclusion (I7). */
  const cameraDir = (): AnglePair => toDriverFrame(rollCorrect({ yaw: 0, pitch: 0 }, roll), side);

  /** The rolling window's primary directions, the phone screen excluded when the camera is far from the road. */
  function rollingWindow(src: 'geometric' | 'net' | 'head', centre: AnglePair): WeightedDir[] {
    const win = dirsSince(tNow - c.rolling.windowS * 1000, src);
    const cam = cameraDir();
    const r = radius ?? c.radiusMinDeg;
    if (angularDistanceDeg(cam, centre) < r + c.rolling.screenExtraDeg) return win;
    const screen = cfg.zones.table.find((z) => z.id === 'phone_screen')?.region;
    const screenR = screen !== undefined && screen.kind === 'camera' ? screen.radiusDeg : 8;
    return win.filter((d) => angularDistanceDeg(d, cam) > screenR);
  }

  /** A shift the fatigue gate blocks: downward, or toward the phone. */
  function gateBlocks(from: AnglePair, to: AnglePair): boolean {
    if (!fatigueGate) return false;
    return to.pitch < from.pitch - 1e-9 || phoneWard(from, to);
  }
  const phoneWard = (from: AnglePair, to: AnglePair) => {
    const cam = cameraDir();
    return angularDistanceDeg(to, cam) < angularDistanceDeg(from, cam) - 1e-9;
  };

  /**
   * C5 round 1: c₀ is vacated BEYOND NOISE. The share near c₀ above what c₁'s own spread puts there (a Gaussian at
   * σ̂: exp(−d²/2σ̂²) of c₁'s share) is at most slow.excessMax of c₁'s. A shifted road leaves c₀ to the noise; a
   * display watched 70 % of the time leaves the road watched 30 %, an excess of about 0.4. Every admitted sample
   * counts, so a display pattern that phase-locks with the mirror checks cannot fool it (the return test alone can).
   */
  function vacatedBeyondNoise(win: readonly WeightedDir[], c0: AnglePair, c1: AnglePair): boolean {
    const rv = vacatedRing(c0, c1, radius ?? c.radiusMinDeg);
    const s1 = shareNear(win, c1, rv);
    if (!(s1 > 0)) return false;
    const d = angularDistanceDeg(c0, c1);
    const expected = s1 * Math.exp(-(d * d) / (2 * sigmaHat * sigmaHat));
    return (shareNear(win, c0, rv) - expected) / s1 <= c.slow.excessMax;
  }

  /**
   * C5 round 1 (C5-1 rule 2): the excursion returns since `t0` corroborate `cand` against `cur`: at least `minN`
   * of them, and ≥ returnShare landed nearer the candidate than the centre.
   */
  function returnsCorroborate(t0: number, cand: AnglePair, cur: AnglePair, minN: number): boolean {
    let n = 0;
    let near = 0;
    returns.forEach((r) => {
      if (r.t < t0) return;
      n++;
      if (angularDistanceDeg(r.at, cand) < angularDistanceDeg(r.at, cur)) near++;
    });
    return n >= minN && near >= c.slow.returnShare * n;
  }

  /** Every rolling.everyS while calibrated (not dual, not in probation): the rolling path, then the slow path. */
  function evaluateRolling(): void {
    lastRollT = tNow;
    follow = null;
    const wasEngaged = engaged;
    engaged = false;
    const src = primary();
    const cur = centres[src];
    if (cur === null) return;
    const r = radius ?? c.radiusMinDeg;
    const win = rollingWindow(src, cur);
    const w = weightOf(win);
    if (w < c.rolling.windowS / 3) {
      prevRoll = null;
      return;
    }
    const peak = modeOf(win, cfg);
    if (peak === null) return;
    // The cluster's centre, located to convergence (its SE, not the histogram's grid, decides a small shift).
    const m = locate(win, peak, Math.max(LOCATE_MIN_R_DEG, 2 * sigmaHat));
    const d = angularDistanceDeg(m, cur);
    const se = sigmaHat / Math.sqrt(Math.max(1, win.length));
    // Engaged (a drift being followed), the follow continues down to half the minimum shift, so a steady drift is
    // followed at its pace (rev2 §2.3.3: a lag of about 1.5–2° at 1°/min) instead of every other evaluation; below
    // that a follow would chase the locator's noise (about ±0.2° on a full window).
    const minShift = wasEngaged ? c.rolling.minShiftDeg / 2 : c.rolling.minShiftDeg;
    // A small shift is read from a (nearly) full window only: a window the warnings have voided down to 20 s locates
    // the centre to about ±0.5°, and a follow would chase that noise (the S-LEAN-PHONE sweep's no-lean runs).
    const small = d >= minShift && d <= po.smallShiftSigmas * sigmaHat && w >= SMALL_MIN_WINDOW_FRAC * c.rolling.windowS;
    const large = d > po.smallShiftSigmas * sigmaHat && d <= c.radiusMinDeg;
    const vacated = large && relativelyVacated(win, cur, m, r, cfg);
    const agrees = prevRoll !== null && angularDistanceDeg(prevRoll.m, m) <= Math.max(1, se, prevRoll.se);
    const okSmall = small && agrees && unimodal(win, m, r, sigmaHat, cfg) && peaked(win, m, sigmaHat, cfg);
    // C5 round 1 (C5-1 rule 2): a large shift is followed only where the driver returns after an excursion: in the
    // two agreeing windows, ≥ returnMinCountRolling returns, ≥ returnShare of them nearer m (else the follow waits).
    // (The returns count from the candidate's appearance against the centre then, so a landing on c₀ keeps blocking
    // (a 70 % display passes ≥ 12 returns at ≥ 95 % with p ≈ 0.7¹² ≈ 1 %); once corroborated the candidate stays
    // so while it persists, so the follow is not re-qualified at every evaluation.)
    if (!large) largeCand = null;
    else if (largeCand === null || angularDistanceDeg(largeCand.m, m) > Math.max(1.5, 2 * se)) largeCand = { m, from: cur, since: tNow, ok: false };
    if (largeCand !== null && !largeCand.ok) largeCand.ok = returnsCorroborate(largeCand.since, largeCand.m, largeCand.from, c.slow.returnMinCountRolling);
    const okLarge = large && vacated && prevRoll !== null && prevRoll.vacated && agrees && largeCand !== null && largeCand.ok && vacatedBeyondNoise(win, cur, m);
    prevRoll = { m, vacated, se };
    if ((okSmall || okLarge) && m.pitch - cur.pitch >= -c.rolling.maxPitchDownDeg && !gateBlocks(cur, m)) {
      engaged = true;
      // The primary source follows its mode; the other gaze source moves by the same shift; the head by its own mode.
      const shift = { yaw: m.yaw - cur.yaw, pitch: m.pitch - cur.pitch };
      const headMode = centres.head === null ? null : modeOf(rollingWindow('head', centres.head), cfg);
      follow = {
        geometric: src === 'geometric' ? m : shiftCentre(centres.geometric, shift),
        net: src === 'net' ? m : shiftCentre(centres.net, shift),
        head: headMode !== null && angularDistanceDeg(headMode, centres.head!) <= d + 2 ? headMode : shiftCentre(centres.head, shift),
      };
    }
    // The slow uncorroborated path (R3b): beyond the rolling range, up to maxShiftDeg.
    const beyond = d > c.radiusMinDeg && d <= c.slow.maxShiftDeg && peaked(win, m, sigmaHat, cfg) && relativelyVacated(win, cur, m, r, cfg) && vacatedBeyondNoise(win, cur, m) && !gateBlocks(cur, m) && roadLike(m, win, cur, offRoadCamera(centres), true);
    // (C5 round 1, C5-1 rules 1 and 3: capped at maxShiftDeg 12.5°; the candidate not in c₀'s distraction zones and
    // the window's distraction share ≤ candidateNonDrivingShare, via roadLike's slow branch.)
    if (!beyond) {
      slowCand = null;
      return;
    }
    if (slowCand === null || angularDistanceDeg(slowCand.cand, m) > Math.max(1.5, 2 * se)) {
      slowCand = { cand: m, head: modeOf(rollingWindow('head', centres.head ?? cur), cfg), since: tNow, admittedS: 0, lastT: tNow };
      return;
    }
    slowCand.admittedS += weightOf(dirsSince(slowCand.lastT, src));
    slowCand.lastT = tNow;
    slowCand.cand = m;
    if (slowCand.admittedS < c.slow.persistS) return;
    // Road scanning: ≥ scanExcursionsPerMin excursions in each of the last minutes, and (C5 round 1, C5-1 rule 2)
    // ≥ returnShare of ≥ returnMinCount returns in the persistence window nearer the candidate than c₀.
    const minutes = Math.floor(c.slow.persistS / 60);
    const perMinute = new Array<number>(minutes).fill(0);
    returns.forEach((r) => {
      const k = Math.floor((tNow - r.t) / 60_000);
      if (k >= 0 && k < minutes) perMinute[k]!++;
    });
    if (perMinute.some((n) => n < c.slow.scanExcursionsPerMin)) return;
    if (!returnsCorroborate(slowCand.since, m, cur, c.slow.returnMinCount)) return;
    // It enters the dual state with the persisted candidate as c₁ and its data as the persistence window.
    const cand = slowCand;
    slowCand = null;
    enterDual('slow', null, 0, 0);
    if (dual !== null) {
      const c1: Centres = { geometric: null, net: null, head: cand.head };
      c1[src] = cand.cand;
      const shift = { yaw: cand.cand.yaw - cur.yaw, pitch: cand.cand.pitch - cur.pitch };
      const other: 'geometric' | 'net' = src === 'net' ? 'geometric' : 'net';
      c1[other] = shiftCentre(dual.c0[other], shift);
      dual.c1 = c1;
      dual.since = cand.since;
    }
  }

  /**
   * Road scanning (C5 round 1, C5-1): an excursion ≥ excursionMinDeg in yaw from the centre (held EXCURSION_MIN_MS
   * over EXCURSION_MIN_FRAMES frames, so gaze noise is none), back within excursionReturnS; then the first fixation of returnFixationMs (every frame within the radius of the run's
   * mean) is where the driver returned. A new excursion first, or no fixation within excursionReturnS, drops it.
   */
  function trackScanning(p: Perceived): void {
    const cur = centres[primary()];
    if (cur === null || p.eyesClosed) return;
    const g = cfg.gazeSource === 'net' && p.netCam !== null ? p.netCam : p.geoCam;
    if (g === null) return;
    const x = toDrv(g, roll);
    if (Math.abs(x.yaw - cur.yaw) >= c.slow.excursionMinDeg) {
      away = away === null ? { since: tNow, frames: 1 } : { since: away.since, frames: away.frames + 1 };
      if (tNow - away.since >= EXCURSION_MIN_MS && away.frames >= EXCURSION_MIN_FRAMES && (excursion === null || excursion.backT !== null)) {
        excursion = { leftT: away.since, backT: null, run: [] };
      }
      return;
    }
    away = null;
    if (excursion === null) return;
    if (excursion.backT === null) {
      if (tNow - excursion.leftT > c.slow.excursionReturnS * 1000) {
        excursion = null;
        return;
      }
      excursion.backT = tNow;
    }
    if (tNow - excursion.backT > c.slow.excursionReturnS * 1000) {
      excursion = null;
      return;
    }
    const run = excursion.run;
    run.push({ t: tNow, x });
    const r = radius ?? c.radiusMinDeg;
    // The run is the frames since the first one within the radius of the rest's mean.
    while (run.length > 1) {
      let y = 0;
      let pch = 0;
      for (const f of run) {
        y += f.x.yaw;
        pch += f.x.pitch;
      }
      const mean = { yaw: y / run.length, pitch: pch / run.length };
      if (run.every((f) => angularDistanceDeg(f.x, mean) <= r)) {
        if (tNow - run[0]!.t >= c.slow.returnFixationMs) {
          returns.push({ t: tNow, at: mean });
          excursion = null;
        }
        return;
      }
      run.shift();
    }
  }

  /** The rolling follow, per frame: every centre toward its target at ≤ rateDegPerMin. */
  function applyFollow(dt: number): void {
    if (follow === null) return;
    const cap = (c.rolling.rateDegPerMin * dt) / 60;
    let moving = false;
    for (const key of ['geometric', 'net', 'head'] as const) {
      const a = centres[key];
      const b = follow[key];
      if (a === null || b === null) continue;
      const dist = angularDistanceDeg(a, b);
      if (dist < 1e-6) continue;
      const k = Math.min(1, cap / dist);
      centres[key] = { yaw: a.yaw + (b.yaw - a.yaw) * k, pitch: a.pitch + (b.pitch - a.pitch) * k };
      moving = true;
    }
    if (!moving) follow = null;
  }

  /** The EMA from the queue, voidS late: samples near a warning are dropped, the fatigue gate blocks downward steps. */
  function drainEma(): void {
    const cutoff = tNow - c.voidS * 1000;
    emaQueue.dropWhile((e) => {
      if (e.t > cutoff) return false;
      if (!voided(e.t) && state === 'calibrated' && dual === null) ema(e.head, e.geo, e.net, e.w);
      return true;
    });
  }

  // ——— Task C4: the across-stop comparisons ———

  const compSig = (xs: readonly MountSample[]): CompSignature | null => posture.signature(xs);
  /** W3: the IOD unchanged and the box shift within ±tolerance of the field-of-view prediction for the head step. */
  function cameraStep(a: CompSignature, b: CompSignature): AnglePair | null {
    const dHead = { yaw: b.yaw - a.yaw, pitch: b.pitch - a.pitch };
    const mag = Math.hypot(dHead.yaw, dHead.pitch);
    if (mag < c.bumpAngleDeg) return null;
    if (!(a.iodC > 0) || Math.abs(b.iodC - a.iodC) / a.iodC >= c.resumeTolerance.iodFrac) return null;
    const box = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    const predicted = c.stops.cameraStepBoxPerDeg * mag;
    return Math.abs(box - predicted) <= c.stops.cameraStepTolerance * predicted ? dHead : null;
  }
  /** rev5 V2: the driver-change thresholds on the compensated signatures. */
  const driverChanged = (a: CompSignature, b: CompSignature) =>
    (a.iodC > 0 && Math.abs(b.iodC - a.iodC) / a.iodC >= c.driverChange.iodFrac) || Math.hypot(b.cx - a.cx, b.cy - a.cy) >= c.driverChange.box;
  const translated = (a: CompSignature, b: CompSignature) => {
    const box = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    const iod = a.iodC > 0 ? (b.iodC - a.iodC) / a.iodC : 0;
    return box >= po.boxShiftC || Math.abs(iod) >= po.iodFracC ? { box, iod } : null;
  };

  function beginProvisional(): void {
    provisional = { oldEar: ear === null ? null : { ...ear }, r: [], l: [], trackingS: 0, blinkSeen: false, dipSince: null, done: false };
    emit('driver_change_provisional');
  }

  function revertProvisional(): void {
    if (provisional === null) return;
    ear = provisional.oldEar;
    provisional = null;
    emit('driver_change_reverted');
  }

  /** W1: the interim EAR from near-forward frames with a blink seen, floored at interimFloor × the old one. */
  function collectInterim(f: EngineFrame, p: Perceived, dt: number): void {
    const pv = provisional!;
    if (pv.done) return;
    const hc = centres.head;
    const near = p.headDrv !== null && hc !== null && Math.abs(p.headDrv.yaw - hc.yaw) <= c.stops.interimNearDeg && Math.abs(p.headDrv.pitch - hc.pitch) <= c.stops.interimNearDeg;
    // C4 round 1 (review-C4 §5): a near-forward GAZE as well, when a gaze exists (an eye-mover's reading frames).
    const gazeNear = p.gazeRel === null || (Math.abs(p.gazeRel.yaw) <= c.stops.interimNearDeg && Math.abs(p.gazeRel.pitch) <= c.stops.interimNearDeg);
    if (!near || !gazeNear) return;
    const er = p.usableR && f.eyeR !== null ? f.eyeR.ear : null;
    const el = p.usableL && f.eyeL !== null ? f.eyeL.ear : null;
    if (er === null && el === null) return;
    const mean = er !== null && el !== null ? (er + el) / 2 : (er ?? el)!;
    const all = [...pv.r, ...pv.l];
    const ref = all.length >= 10 ? quantile(all, c.provisionalEarPercentile) : null;
    if (ref !== null && mean < BLINK_DIP * ref) pv.dipSince ??= f.tMs;
    else {
      if (pv.dipSince !== null && f.tMs - pv.dipSince <= BLINK_MAX_MS) pv.blinkSeen = true;
      pv.dipSince = null;
    }
    if (er !== null) pv.r.push(er);
    if (el !== null) pv.l.push(el);
    pv.trackingS += dt;
    if (pv.trackingS >= c.stops.swapTrackS && pv.blinkSeen) {
      pv.done = true;
      const old = pv.oldEar;
      const floor = (xs: number[], o: number | null | undefined) => {
        const v = xs.length > 0 ? quantile(xs, c.provisionalEarPercentile) : null;
        if (v === null) return o ?? null;
        return o != null ? Math.max(v, c.stops.interimFloor * o) : v;
      };
      ear = { r: floor(pv.r, old?.r), l: floor(pv.l, old?.l) };
    }
  }

  /** The stop's episode: the LOST runs that arm the driver-change test, and the provisional check. */
  function duringStop(f: EngineFrame, p: Perceived, ms: MountSample | null, dt: number): void {
    const ep = stopEp!;
    if (p.quality === 'lost') {
      if (ep.lostSince === null) {
        ep.lostSince = f.tMs;
        ep.preLost = sigWindow.samples();
        ep.check = null;
      }
      return;
    }
    if (ms === null) return;
    if (ep.lostSince !== null) {
      if (f.tMs - ep.lostSince >= c.stops.swapLostS * 1000) {
        ep.armed = true;
        ep.check = { preLost: ep.preLost ?? ep.before, samples: [], trackingS: 0 };
      }
      ep.lostSince = null;
    }
    if (ep.check !== null) {
      ep.check.samples.push(ms);
      ep.check.trackingS += dt;
      if (ep.check.trackingS >= c.stops.swapTrackS) {
        const chk = ep.check;
        ep.check = null;
        const a = compSig(chk.preLost);
        const b = compSig(chk.samples);
        if (a !== null && b !== null && cameraStep(a, b) === null && driverChanged(a, b) && provisional === null) beginProvisional();
      }
    }
  }

  /** The first settled window after the move-off, against the one before the stop (W3, V2, then posture). */
  function afterStop(ps: { ep: StopEpisode; samples: MountSample[] }): void {
    const a = compSig(ps.ep.before);
    const b = compSig(ps.samples);
    if (a === null || b === null) {
      revertProvisional();
      return;
    }
    const step = cameraStep(a, b);
    if (step !== null) {
      revertProvisional();
      emit('camera_bump', 'stop');
      enterDual('stop', step, Math.hypot(b.cx - a.cx, b.cy - a.cy), 0);
      return;
    }
    if (ps.ep.armed && driverChanged(a, b)) {
      driverChange();
      return;
    }
    revertProvisional();
    const tr = translated(a, b);
    if (tr !== null) enterDual('stop', null, tr.box, tr.iod);
  }

  function applySeed(seed: CalibrationSeed): void {
    centres.geometric = seed.gazeCentres.geometric;
    centres.net = seed.gazeCentres.net;
    centres.head = seed.headCentre;
    // A seed carries no spread: the minimum radius until a pass (T6 review nit).
    radius = radius ?? c.radiusMinDeg;
    roll = seed.rollOffsetDeg;
    if (seed.openEyeEar.r !== null || seed.openEyeEar.l !== null) {
      ear = { ...seed.openEyeEar };
      earCollector = null;
    }
    hasSeed = true;
    if (state === 'none' || state === 'uncalibrated') state = 'seeded';
  }

  function applyProfile(p: DmsProfileV1): void {
    centres.geometric = p.gazeCentres.geometric ?? null;
    centres.net = p.gazeCentres.net ?? null;
    centres.head = p.headCentre;
    radius = p.radiusDeg;
    roll = p.rollOffsetDeg;
    // A profile without any EAR must not stop the provisional collection (T6 review m1).
    if (p.openEyeEar[0] !== null || p.openEyeEar[1] !== null) {
      ear = { r: p.openEyeEar[0], l: p.openEyeEar[1] };
      earCollector = null;
    }
    mar = p.neutralMar;
    mouthW = p.neutralMouthW;
    hasSeed = true;
    state = 'seeded';
    emit('warm_start');
  }

  function pitchReference(): number | null {
    if (centres.head !== null) return centres.head.pitch;
    if (pitchRing.size === 0) return null;
    if (pitchMedian === null || (pitchMedianStale && pitchNowT - pitchMedianT >= PITCH_MEDIAN_EVERY_MS)) {
      pitchMedian = median(pitchRing.toArray().map((x) => x.pitch));
      pitchMedianStale = false;
      pitchMedianT = pitchNowT;
    }
    return pitchMedian;
  }

  function evaluate(t: number): boolean {
    lastEvalT = t;
    samples.dropWhile((s) => s.t < t - c.windowS * 1000);
    const all = samples.toArray().filter((s) => s.w > 0);
    if (all.length === 0) return false;
    const r = median(all.map((s) => s.roll));
    const dirs = (pick: (s: Sample) => AnglePair | null): WeightedDir[] => {
      const out: WeightedDir[] = [];
      for (const s of all) {
        const a = pick(s);
        if (a !== null) out.push({ ...toDrv(a, r), w: s.w });
      }
      return out;
    };
    const primary = cfg.gazeSource;
    const main = evaluateCluster(dirs((s) => (primary === 'net' ? s.net : s.geo)), cfg);
    if (main === null || !main.passed) return false;
    centres[primary] = main.mode;
    const other: GazeSource = primary === 'net' ? 'geometric' : 'net';
    const o = evaluateCluster(dirs((s) => (other === 'net' ? s.net : s.geo)), cfg);
    centres[other] = o !== null && o.passed ? o.mode : null;
    const headDirs = dirs((s) => s.head);
    const headPeak = histogramMode(headDirs, cfg);
    centres.head = headPeak === null ? null : refineMode(headDirs, headPeak, cfg);
    radius = main.radius;
    roll = r;
    // Task C4: σ̂, the within-cluster SD of the primary source (the relative statistics' scale).
    const within = dirs((s) => (primary === 'net' ? s.net : s.geo)).filter((d) => angularDistanceDeg(d, main.mode) <= main.radius);
    if (within.length >= 10) {
      const sdY = sd(within.map((d) => d.yaw));
      const sdP = sd(within.map((d) => d.pitch));
      sigmaHat = Math.max(1, Math.sqrt((sdY * sdY + sdP * sdP) / 2));
    }
    seedUnverified = false;
    dual = null;
    probation = null;
    if (!earFrozen) {
      const er = all.map((s) => s.earR).filter((x): x is number => x !== null);
      const el = all.map((s) => s.earL).filter((x): x is number => x !== null);
      if (er.length > 0 || el.length > 0) {
        ear = { r: er.length > 0 ? quantile(er, c.provisionalEarPercentile) : null, l: el.length > 0 ? quantile(el, c.provisionalEarPercentile) : null };
        earFrozen = true;
        earCollector = null;
      }
    }
    const mars = all.map((s) => s.mar).filter((x): x is number => x !== null);
    if (mars.length > 0) mar = Math.max(median(mars), c.neutralMarFloor);
    const mws = all.map((s) => s.mouthW).filter((x): x is number => x !== null);
    if (mws.length > 0) mouthW = median(mws);
    state = 'calibrated';
    emit('calibrated');
    return true;
  }

  function finishComparison(cmp: Comparison): void {
    const after = signatureOf(cmp.samples);
    if (cmp.kind === 'warm') {
      const p = warmProfile;
      warmProfile = null;
      if (state === 'calibrated') return; // a deferred warm start never overwrites a pass (T6 review m3)
      if (p !== null && after !== null && lastRotation === p.orientation && compareSignatures(p.mount, after, cfg).match) applyProfile(p);
      return;
    }
    if (cmp.before === null || after === null) return;
    const r = compareSignatures(cmp.before, after, cfg);
    if (r.match) return;
    if (r.driverChange) driverChange();
    else {
      // Task C4 (rev2 §2.3.2, R4): a resume mismatch that is not a driver change enters the dual state, D1 on;
      // a camera step (W3) shifts c₀ by the head step.
      const a: CompSignature = { cx: cmp.before.boxCx, cy: cmp.before.boxCy, iodC: cmp.before.iod, yaw: cmp.before.yawDeg, pitch: cmp.before.pitchDeg };
      const b: CompSignature = { cx: after.boxCx, cy: after.boxCy, iodC: after.iod, yaw: after.yawDeg, pitch: after.pitchDeg };
      emit('camera_bump', 'resume');
      enterDual('resume', cameraStep(a, b), Math.hypot(b.cx - a.cx, b.cy - a.cy), a.iodC > 0 ? (b.iodC - a.iodC) / a.iodC : 0);
    }
  }

  /**
   * A gap begins (a pause, or a long SEARCH). A resume comparison still pending, or a gap not yet
   * resumed, keeps its own `before`: the signature from before the FIRST gap, so a driver who swapped at
   * one stop cannot match themselves at the next (T6 review I1). A pending warm start keeps its profile.
   */
  function openGap(): void {
    const pending = comparing !== null && comparing.kind === 'resume' ? comparing.before : undefined;
    const before = pending !== undefined ? pending : gap !== null ? gap.before : sigWindow.signature();
    gap = { before };
    sigWindow.clear();
    bump.clear();
    if (comparing !== null && comparing.kind === 'resume') comparing = null;
    if (comparing !== null && comparing.kind === 'warm') comparing = null; // restarts after the resume
    sanity = null;
  }

  if (init.seed) applySeed(init.seed);

  return {
    markGap(tMs) {
      tNow = tMs;
      openGap();
    },

    applySeed,

    evaluate,

    observe(f, p, ctx, stopped = false) {
      tNow = f.tMs;
      // Final review n4: a gap frame is unobserved time, never driving time.
      const dt = p.gap ? 0 : Math.min(p.dtS, c.admitDtCapS);
      const tracking = p.quality === 'tracking' && p.headCam !== null && f.box !== null && f.iod !== null;

      // Task C4: a stop is a gap for posture and the step bump; the settled windows either side are compared.
      if (stopped && !wasStopped) {
        stopEp = postStop !== null ? { ...postStop.ep, lostSince: null, preLost: null, check: null } : { before: sigWindow.samples(), lostSince: null, preLost: null, armed: false, check: null };
        postStop = null;
        posture.clear();
        bump.clear();
        onsetLeftS = 0;
        slumpWatch = null;
      } else if (!stopped && wasStopped && stopEp !== null) {
        // A LOST run still open at the move-off counts too (the new driver's face first seen while moving).
        if (stopEp.lostSince !== null && f.tMs - stopEp.lostSince >= c.stops.swapLostS * 1000) stopEp.armed = true;
        postStop = { ep: stopEp, samples: [], trackingS: 0 };
        stopEp = null;
      }
      wasStopped = stopped;

      // A long SEARCH opens its gap BEFORE the rotation check, so a rotation change on the first frame
      // after it is seen as a change across the gap (T6 round-1 nit).
      if (
        gap === null &&
        stopEp === null &&
        postStop === null &&
        p.quality === 'tracking' &&
        lastTrackingT !== null &&
        f.tMs - lastTrackingT >= c.longSearchS * 1000
      ) {
        openGap();
      }

      // A rotation change mid-drive is a camera bump (rev2 R1-I1); a pending resume comparison is dropped
      // with it, so one change is one bump (T6 review m3).
      if (p.quality !== 'lost') {
        if (lastRotation !== null && f.rotationDeg !== lastRotation) {
          cameraBump('rotation');
          if (gap !== null) rotationBumpedInGap = true;
          if (comparing !== null && comparing.kind === 'resume') comparing = null;
        }
        lastRotation = f.rotationDeg;
      }

      if (ctx !== null && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh) drivingS += dt;

      if (!tracking) {
        if (stopEp !== null) duringStop(f, p, null, dt);
        evaluateIfDue();
        return;
      }
      const head = p.headCam!;
      const box = f.box!;
      const ms: MountSample = { t: f.tMs, yaw: head.yaw, pitch: head.pitch, roll: head.roll, cx: box.cx, cy: box.cy, iod: f.iod! };
      if (stopEp !== null) duringStop(f, p, ms, dt);
      if (provisional !== null) collectInterim(f, p, dt);
      if (postStop !== null && !stopped && !p.eyesClosed && ctx !== null && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh) {
        postStop.samples.push(ms);
        postStop.trackingS += dt;
        if (postStop.trackingS >= c.resumeCompareS) {
          const ps = postStop;
          postStop = null;
          afterStop(ps);
        }
      }

      lastTrackingT = f.tMs;

      // The first TRACKING frame after a gap starts the comparison and the openness sanity check. After a
      // rotation bump across the gap the comparison is skipped: a bump is already declared (T6 review m3).
      if (gap !== null) {
        comparing = rotationBumpedInGap ? null : { kind: 'resume', before: gap.before, samples: [], trackingS: 0 };
        rotationBumpedInGap = false;
        sanity = ear !== null ? { trackingS: 0, values: [], r: [], l: [] } : null;
        gap = null;
      } else if (warmProfile !== null && comparing === null) {
        comparing = { kind: 'warm', before: warmProfile.mount, samples: [], trackingS: 0 };
      }
      if (comparing !== null) {
        comparing.samples.push(ms);
        comparing.trackingS += dt;
        if (comparing.trackingS >= c.resumeCompareS) {
          const done = comparing;
          comparing = null;
          finishComparison(done);
        }
      }

      sigWindow.push(ms);
      if (p.headDrv !== null) {
        pitchRing.push({ t: f.tMs, pitch: p.headDrv.pitch });
        pitchRing.dropWhile((x) => x.t < f.tMs - c.runningMedianS * 1000);
        pitchMedianStale = true;
        pitchNowT = f.tMs;
      }

      // The openness sanity check after a resume (rev2 R1-m2).
      const ref = pitchReference();
      const relPitch = p.gazeRel?.pitch ?? p.headRel?.pitch ?? (p.headDrv !== null && ref !== null ? p.headDrv.pitch - ref : null);
      if (sanity !== null && p.openness !== null && relPitch !== null && relPitch > c.opennessCheckMinRelPitchDeg) {
        sanity.values.push(p.openness);
        if (p.usableR && f.eyeR !== null) sanity.r.push(f.eyeR.ear);
        if (p.usableL && f.eyeL !== null) sanity.l.push(f.eyeL.ear);
        sanity.trackingS += dt;
        if (sanity.trackingS >= c.opennessCheckS) {
          const done = sanity;
          sanity = null;
          const m = median(done.values);
          if (m < c.opennessRange[0] || m > c.opennessRange[1]) baselineReset(done, m);
        }
      }

      // The provisional EAR: p90 over 20 s of TRACKING within ±15° of the pitch reference.
      if (earCollector !== null && p.headDrv !== null && ref !== null && Math.abs(p.headDrv.pitch - ref) <= c.provisionalEarWithinDeg) {
        if (p.usableR && f.eyeR !== null) earCollector.r.push(f.eyeR.ear);
        if (p.usableL && f.eyeL !== null) earCollector.l.push(f.eyeL.ear);
        earCollector.trackingS += dt;
        if (earCollector.trackingS >= c.provisionalEarS) {
          const col = earCollector;
          earCollector = null;
          if (col.r.length > 0 || col.l.length > 0) {
            ear = {
              r: col.r.length > 0 ? quantile(col.r, c.provisionalEarPercentile) : null,
              l: col.l.length > 0 ? quantile(col.l, c.provisionalEarPercentile) : null,
            };
          }
        }
      }

      // The step-test bump (rev1 m5): Task C4, into the dual state with c₀ shifted by the head step. The posture
      // detector (Task C4): a settled translation opens the dual state; a slump is fatigue evidence. Neither is fed
      // while STOPPED (a stop is a gap).
      if (!stopped) {
        // C4 round 1: the step bump reads the rotation-compensated box and IOD, so a held head turn (whose box
        // moves with the head) is never a bump, whatever the true box-on-head relation.
        const comp = posture.compensate(ms);
        const bumpStep = bump.pushStep({ ...ms, cx: comp.cx, cy: comp.cy, iod: comp.iodC });
        if (bumpStep !== null) {
          emit('camera_bump', 'step');
          enterDual('bump', bumpStep, c.bumpBoxShift, 0);
          slumpWatch = null;
        } else {
          const out = posture.push(ms);
          if (out.step !== null && dual === null) enterDual('step', null, Math.hypot(out.step.dBox.x, out.step.dBox.y), out.step.dIodFrac);
          if (out.slump && out.slumpFrom !== undefined) {
            slumpWatch ??= { from: out.slumpFrom, yawRef: centres.head?.yaw ?? null, observedS: 0, loweredS: 0, yawOkS: 0, gazeS: 0, onRoadS: 0 };
          }
          if (out.onset && dual === null && onsetLeftS <= 0) onsetLeftS = po.onsetWidenMaxS;
        }
        if (slumpWatch !== null) watchSlump(slumpWatch, ms, p, dt);
        if (onsetLeftS > 0) onsetLeftS = dual !== null ? 0 : Math.max(0, onsetLeftS - dt);
        if (dual !== null) evaluateDual(dt, ctx);
        else if (probation !== null) evaluateProbation(dt);
        // Task C5: the rolling and slow paths (calibrated, no dual state, no probation).
        if (state === 'calibrated' && dual === null && probation === null) {
          trackScanning(p);
          if (tNow - lastRollT >= c.rolling.everyS * 1000) evaluateRolling();
          applyFollow(dt);
        } else {
          follow = null;
          slowCand = null;
        }
      }

      // Admission (§M3). Task C5: never within voidS after a warning (the samples before it are removed by voidAround).
      const admitted =
        !p.eyesClosed && ctx !== null && ctx.straight === true && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh && dt > 0 && !voided(f.tMs);
      if (admitted) {
        samples.push({
          t: f.tMs,
          w: dt,
          head,
          roll: head.roll,
          geo: p.geoCam,
          net: p.netFresh ? p.netCam : null,
          earR: p.usableR && f.eyeR !== null ? f.eyeR.ear : null,
          earL: p.usableL && f.eyeL !== null ? f.eyeL.ear : null,
          mar: f.mouth?.mar ?? null,
          mouthW: f.mouth?.widthIod ?? null,
        });
        admittedS += dt;
        const cut = f.tMs - c.windowS * 1000;
        samples.dropWhile((s) => {
          if (s.t >= cut) return false;
          admittedS -= s.w;
          return true;
        });
        if (state === 'calibrated' && dual === null) emaQueue.push({ t: f.tMs, w: dt, head, geo: p.geoCam, net: p.netFresh ? p.netCam : null });
      }
      drainEma();
      evaluateIfDue();
    },

    state: () => state,
    dual: () => (dual === null || dual.c1 === null ? null : { gaze: dual.c1[cfg.gazeSource] ?? dual.c1.geometric, head: dual.c1.head }),
    // C4 round 2 (review-C4 R1-A): the engine applies this to the road-centre circle only. Task C5: a slow candidate too.
    postureWidening: () => dual !== null || onsetLeftS > 0 || slowCand !== null,
    recalibrating: () => provisional !== null || seedUnverified,
    reason: () => (provisional !== null || seedUnverified ? 'recalibrating' : dual !== null || probation !== null || onsetLeftS > 0 || slowCand !== null ? 'posture' : null),
    voidAround(tMs) {
      warnings.push(tMs);
      while (warnings.length > 8) warnings.shift();
      samples.forEach((s) => {
        if (s.w > 0 && Math.abs(s.t - tMs) <= c.voidS * 1000) {
          admittedS -= s.w;
          s.w = 0;
        }
      });
    },
    setFatigueGate(on) {
      fatigueGate = on;
    },
    centre: (s) => centres[s],
    radius: () => radius,
    rollOffset: () => roll,
    openEyeEar: () => (ear === null ? null : { ...ear }),
    neutralMar: () => mar,
    neutralMouthW: () => mouthW,
    pitchReference,
    resumeChecking: () => comparing !== null && comparing.kind === 'resume',
    mountSignature: () => sigWindow.signature(),
    refs: () => ({
      driverSide: side,
      gazeSource: cfg.gazeSource,
      rollOffsetDeg: roll,
      gazeCentre: centres[cfg.gazeSource],
      geoCentre: centres.geometric,
      headCentre: centres.head,
      openEyeEar: ear,
      pitchReference: pitchReference(),
    }),
    stats: () => ({ drivingS, admittedS: Math.max(0, admittedS), postureIgnored }),
    drivingS: () => drivingS,
    drainEvents: () => events.splice(0, events.length),

    toProfile(savedAtMs, learnedZones = []) {
      const mount = sigWindow.signature();
      const primary = centres[cfg.gazeSource];
      if (state !== 'calibrated' || primary === null || centres.head === null || radius === null || mar === null || mouthW === null || mount === null || lastRotation === null) {
        return null;
      }
      const gazeCentres: DmsProfileV1['gazeCentres'] = {};
      if (centres.geometric !== null) gazeCentres.geometric = centres.geometric;
      if (centres.net !== null) gazeCentres.net = centres.net;
      return {
        v: 1,
        driverSide: side,
        orientation: lastRotation,
        mount,
        gazeCentres,
        headCentre: centres.head,
        rollOffsetDeg: roll,
        radiusDeg: radius,
        openEyeEar: [ear?.r ?? null, ear?.l ?? null],
        neutralMar: mar,
        neutralMouthW: mouthW,
        learnedZones,
        savedAtMs,
      };
    },
  };

  /**
   * C4 round 1 (review-C4 C4-3): a slump is a lower head STILL LOOKING AT THE ROAD. The candidate is watched for
   * slumpHoldS of observed (moving, TRACKING) time: the head pitch held below the pre-level by at least half
   * slumpPitchDeg (≥ 80 % of the time), the head yaw within slumpYawDeg of the head centre (≥ 80 %), and the
   * gaze in c₀'s unwidened road_centre or forward_road for ≥ slumpOnRoadShare of the frames with a gaze. A held
   * look or a read is neither, and never sets the fatigue gate.
   */
  function watchSlump(w: SlumpWatch, ms: MountSample, p: Perceived, dt: number): void {
    w.observedS += dt;
    if (ms.pitch <= w.from.pitch - po.slumpPitchDeg / 2) w.loweredS += dt;
    const yawOk = w.yawRef !== null && p.headDrv !== null ? Math.abs(p.headDrv.yaw - w.yawRef) <= po.slumpYawDeg : Math.abs(ms.yaw - w.from.yaw) <= po.slumpYawDeg;
    if (yawOk) w.yawOkS += dt;
    if (p.gazeRel !== null) {
      w.gazeS += dt;
      if (zoneClass(zoneAt(p.gazeRel, radius, cameraOf(centres), cfg), cfg) === 'on_road') w.onRoadS += dt;
    }
    if (w.observedS < po.slumpHoldS) return;
    slumpWatch = null;
    const held = w.loweredS >= 0.8 * w.observedS && w.yawOkS >= 0.8 * w.observedS;
    const onRoad = w.gazeS > 0 ? w.onRoadS >= po.slumpOnRoadShare * w.gazeS : true;
    if (held && onRoad) emit('head_slump');
  }

  /**
   * The drift-capped EMA of every centre present (spec "Staying calibrated"). Task C5: the gate is the road core,
   * max(emaWithinMinDeg, emaWithinFrac × radius); while the fatigue gate is set, no downward or phone-ward step.
   */
  function ema(head: AnglePair, geo: AnglePair | null, net: AnglePair | null, dt: number): void {
    const cap = (c.emaMaxDegPerMin * dt) / 60;
    const k = dt / c.emaTauS;
    const gate = Math.max(c.emaWithinMinDeg, c.emaWithinFrac * (radius ?? c.radiusMinDeg));
    const step = (key: 'geometric' | 'net' | 'head', cam: AnglePair | null) => {
      const centre = centres[key];
      if (centre === null || cam === null) return;
      const x = toDrv(cam, roll);
      const dy = x.yaw - centre.yaw;
      const dp = x.pitch - centre.pitch;
      if (Math.hypot(dy, dp) > gate) return;
      let sy = k * dy;
      let sp = k * dp;
      const n = Math.hypot(sy, sp);
      if (n > cap) {
        sy *= cap / n;
        sp *= cap / n;
      }
      const next = { yaw: centre.yaw + sy, pitch: centre.pitch + sp };
      if (gateBlocks(centre, next)) return;
      centres[key] = next;
    };
    step('geometric', geo);
    step('net', net);
    step('head', head);
  }

  function evaluateIfDue(): void {
    if (state === 'calibrated') return;
    if (drivingS >= c.firstEvalDrivingS && admittedS >= c.firstEvalAdmittedS && (lastEvalT === null || tNow - lastEvalT >= c.reevalEveryS * 1000)) {
      if (evaluate(tNow)) return;
    }
    if (!gaveUp && drivingS >= c.giveUpS) {
      gaveUp = true;
      const outcome = hasSeed ? 'provisional' : 'uncalibrated';
      state = outcome;
      emit(outcome);
    }
  }
}

/** The C2 seed from the last seedWindowS of frames (§M3): TRACKING, eyes open, ≥ 2 s, gaze SD ≤ 3°. */
export function seedFromFrames(pairs: readonly { frame: EngineFrame; p: Perceived }[], cfg: DmsConfig, side: DriverSide): SeedResult {
  const c = cfg.calibration;
  if (pairs.length === 0) return { ok: false, reason: 'no_tracking' };
  const end = pairs[pairs.length - 1]!.frame.tMs;
  const use = pairs.filter(({ frame: f, p }) => f.tMs > end - c.seedWindowS * 1000 && p.quality === 'tracking' && !p.eyesClosed && p.headCam !== null && f.box !== null && f.iod !== null);
  if (use.length === 0) return { ok: false, reason: 'no_tracking' };
  const covered = use.reduce((s, { p }) => s + Math.min(p.dtS, c.admitDtCapS), 0);
  if (covered < c.seedMinS) return { ok: false, reason: 'too_short' };
  const roll = median(use.map(({ p }) => p.headCam!.roll));
  const toDrv = (a: AnglePair) => toDriverFrame(rollCorrect(a, roll), side);
  const primary = use.map(({ p }) => (cfg.gazeSource === 'net' ? p.netCam : p.geoCam)).filter((a): a is AnglePair => a !== null).map(toDrv);
  if (primary.length === 0) return { ok: false, reason: 'no_tracking' };
  if (Math.max(sd(primary.map((a) => a.yaw)), sd(primary.map((a) => a.pitch))) > c.seedMaxSdDeg) return { ok: false, reason: 'unsteady' };
  const med = (xs: AnglePair[]): AnglePair | null => (xs.length === 0 ? null : { yaw: median(xs.map((a) => a.yaw)), pitch: median(xs.map((a) => a.pitch)) });
  const geo = use.map(({ p }) => p.geoCam).filter((a): a is AnglePair => a !== null).map(toDrv);
  const net = use.map(({ p }) => (p.netFresh ? p.netCam : null)).filter((a): a is AnglePair => a !== null).map(toDrv);
  const mount = signatureOf(use.map(({ frame: f, p }) => ({ t: f.tMs, yaw: p.headCam!.yaw, pitch: p.headCam!.pitch, roll: p.headCam!.roll, cx: f.box!.cx, cy: f.box!.cy, iod: f.iod! })))!;
  const er = use.filter(({ frame: f, p }) => p.usableR && f.eyeR !== null).map(({ frame: f }) => f.eyeR!.ear);
  const el = use.filter(({ frame: f, p }) => p.usableL && f.eyeL !== null).map(({ frame: f }) => f.eyeL!.ear);
  return {
    ok: true,
    seed: {
      gazeCentres: { geometric: med(geo), net: med(net) },
      headCentre: med(use.map(({ p }) => toDrv(p.headCam!)))!,
      rollOffsetDeg: roll,
      mount,
      orientation: use[use.length - 1]!.frame.rotationDeg,
      openEyeEar: { r: er.length > 0 ? quantile(er, c.provisionalEarPercentile) : null, l: el.length > 0 ? quantile(el, c.provisionalEarPercentile) : null },
    },
  };
}
