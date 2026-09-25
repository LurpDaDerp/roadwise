// Road-centre calibration and the driver baselines (plan §M3; spec "Calibration"). Pure: the frame
// clock is the only clock, every window is bounded.
//
// - Stage 1: admitted samples (TRACKING, eyes open, the straight flag, ≥ 20 km/h; weight = frame dt,
//   capped) over a sliding 180 s window; the first evaluation at ≥ 60 s of driving with ≥ 20 s
//   admitted, then every 30 s until a pass. A pass sets one centre per gaze source present plus the
//   head centre (rev1 R-gaze), the radius, the roll offset, the Stage 1 open-eye EAR (frozen for the
//   drive), and the neutral MAR (floored, rev1 I4). 180 s without a pass → provisional (with a seed)
//   or uncalibrated; evaluation continues.
// - Staying calibrated: an EMA (τ 180 s) on admitted samples within radius + 5°, capped at
//   0.5°/min, so a long distraction cannot pull the centre.
// - Before a pass: the running median head pitch (rev1 m6) and the provisional EAR.
// - Continuity (rev1 I7, rev2 R1-m2): a signature before every gap (markGap, or ≥ 30 s without
//   TRACKING), compared over the first 5 s after the resume; driver change or camera bump; the EAR
//   re-derived on any mismatch; the openness sanity check after every resume.
// - A camera bump from the step test (m5) or a rotationDeg change (rev2 R1-I1) restarts Stage 1.
// - Warm start from a profile only on a matching mount signature (C-5, C-6); the C2 seed.
//
// Task C4 (design rev2 §2.3.0, §2.3.2; rev4 §2.3.2a; rev5 §3; amendments W1–W3):
// - Posture: a settled rotation-compensated translation (posture.ts) opens the DUAL-CENTRE state: c₀ is kept,
//   c₁ is the mode of the first searchS of admission (peaked, ≤ searchMaxDeg from c₀, within searchMaxS
//   observed); both classify (the engine); the commit needs commitS of admitted persistence and the relative
//   vacated test (a small shift: unimodality); a relative revert for revertS, or undecidedMaxS, reverts; after
//   a commit, probationS of probation with c₀ as a shadow reverts a commit the samples reverse. A settled pitch
//   drop with no translation is a head_slump candidate (fatigue evidence once held; never posture).
// - C4 round 1 (review-C4): c₁ must be road-like (C4-1: inside c₀'s unwidened on-road zones, not the phone, at
//   most candidateNonDrivingShare of the window in c₀'s non-driving zones); the posture widening is withheld while
//   the window or the last 5 s reads as distraction; the revert is measured on the last revertWindowS; the step
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
import { createPostureDetector, modeOf, peaked, relativelyVacated, relativeRevert, unimodal, type CompSignature } from './posture';
import { compareSignatures, type DmsProfileV1, type LearnedZone, type MountSignature } from './profile';
import { median, quantile, sd } from './stats';
import type { AnglePair, DriverSide, EngineFrame, GazeSource, Rotation, VehicleContext } from './types';
import { RingBuffer } from './windows';
import { cameraRel, phoneScreenRadius, zoneAt, zoneClass } from './zones';

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
  /** camera_bump: step, resume, rotation, stop; posture_dual: step, bump, resume, stop; posture_revert: relative, undecided, no_candidate, probation */
  cause?: 'step' | 'resume' | 'rotation' | 'stop' | 'bump' | 'relative' | 'undecided' | 'no_candidate' | 'probation';
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
/** C4 round 1 (C4-1): the recent window the posture widening is withheld on */
const RECENT_ND_MS = 5000;
const ORIGIN: AnglePair = Object.freeze({ yaw: 0, pitch: 0 });

type Centres = { geometric: AnglePair | null; net: AnglePair | null; head: AnglePair | null };

interface Dual {
  cause: 'step' | 'bump' | 'resume' | 'stop';
  c0: Centres;
  /** c₁ once found */
  c1: Centres | null;
  enteredT: number;
  observedS: number;
  /** the persistence window starts here (the admitted samples since) */
  since: number;
  revertS: number;
  lastEvalT: number;
  /** consecutive evaluations whose mode agreed within max(1°, SE) */
  stable: number;
  /** the step's translation (the mirror demotion) */
  box: number;
  iodFrac: number;
  /**
   * C4 round 1 (C4-1): the last evaluated window held more than candidateNonDrivingShare in c₀'s non-driving
   * zones (a lean to read, not a seat change): the posture widening is off while it does
   */
  nonRoad: boolean;
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
  /**
   * C4 round 1 (C4-1): the last RECENT_ND_MS of moving TRACKING frames with a gaze, and the weight of those in
   * the current centre's unwidened non-driving zones: the posture widening is withheld while that share is above
   * candidateNonDrivingShare (a driver reading a phone is not looking at a shifted road).
   */
  const recentNd = new RingBuffer<{ t: number; w: number; nd: boolean }>(Math.ceil((RECENT_ND_MS / 1000) * MAX_FPS) + 2);
  let recentW = 0;
  let recentNdW = 0;

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
    dual = { cause, c0: { ...centres }, c1: null, enteredT: tNow, observedS: 0, since: tNow, revertS: 0, lastEvalT: tNow, stable: 0, box, iodFrac, nonRoad: false };
    probation = null;
    posture.clear();
    posture.resetFit();
    bump.clear();
    emit('posture_dual', cause);
  }

  function exitDual(cause: 'relative' | 'undecided' | 'no_candidate'): void {
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
  /** The share of `dirs`' weight in the non-driving zones of c₀'s unwidened map. */
  function nonDrivingShare(dirs: readonly WeightedDir[], c0: AnglePair, camera: AnglePair | null): number {
    let total = 0;
    let nd = 0;
    for (const x of dirs) {
      total += x.w;
      if (zoneClass(zoneAt(relative(x, c0), radius, camera, cfg), cfg) === 'non_driving') nd += x.w;
    }
    return total > 0 ? nd / total : 0;
  }
  /**
   * C4 round 1 (review-C4 C4-1 rule 1): a road-like candidate lies inside c₀'s UNWIDENED on-road zones, more than
   * the phone screen's radius + candidateCameraMarginDeg from the camera, with at most candidateNonDrivingShare of
   * the window in c₀'s non-driving zones. A lean to read or tap a phone is never a road.
   */
  function roadLike(m: AnglePair, dirs: readonly WeightedDir[], c0: AnglePair, camera: AnglePair | null): boolean {
    const rel = relative(m, c0);
    if (zoneClass(zoneAt(rel, radius, camera, cfg), cfg) !== 'on_road') return false;
    // (A camera inside c₀'s road-centre circle is looked at whenever the road is: the zone map gives the road
    // priority there, and so does this rule. A candidate nearer c₀ than the camera is the road seen from a new
    // posture, not the phone: a mount near the road, or a bump's pre-shifted c₀, still commits.)
    if (camera !== null && angularDistanceDeg(camera, ORIGIN) > (radius ?? c.radiusMinDeg)) {
      const toCamera = angularDistanceDeg(rel, camera);
      if (toCamera <= phoneR + po.candidateCameraMarginDeg && toCamera < angularDistanceDeg(rel, ORIGIN)) return false;
    }
    return nonDrivingShare(dirs, c0, camera) <= po.candidateNonDrivingShare;
  }

  function evaluateDual(dt: number): void {
    const d = dual!;
    d.observedS += dt;
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
    const camera = cameraOf(d.c0);
    if (d.c1 === null) {
      // The candidate: the mode of the first searchS of admission, peaked, near c₀, road-like (C4 round 1).
      const found = dirsSince(d.enteredT, src);
      if (weightOf(found) >= po.searchS) {
        d.nonRoad = nonDrivingShare(found, c0, camera) > po.candidateNonDrivingShare;
        const m = modeOf(found, cfg);
        if (m !== null && angularDistanceDeg(m, c0) <= po.searchMaxDeg && peaked(found, m, sigmaHat, cfg) && roadLike(m, found, c0, camera)) {
          const mh = modeOf(dirsSince(d.enteredT, 'head'), cfg);
          const other: 'geometric' | 'net' = src === 'net' ? 'geometric' : 'net';
          const mo = modeOf(dirsSince(d.enteredT, other), cfg);
          d.c1 = { geometric: src === 'geometric' ? m : mo, net: src === 'net' ? m : mo, head: mh };
          d.since = d.enteredT;
        }
      }
      if (d.c1 === null && d.observedS >= po.searchMaxS) exitDual('no_candidate');
      return;
    }
    const win = dirsSince(d.since, src);
    const c1 = d.c1[src] ?? d.c1.head!;
    d.nonRoad = nonDrivingShare(win, c0, camera) > po.candidateNonDrivingShare;
    // The revert: back at c₀ for revertS (measurable only when c₁ is a separable cluster, beyond the small-shift
    // bound; a small shift or a bump's pre-shifted c₀ is decided by its commit, or undecided), or undecided too long.
    // C4 round 1 (C4-1 rule 3): measured on the last revertWindowS of admission, so an ended lean reverts promptly.
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
    if (!roadLike(m, win, c0, camera)) return;
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
        recentNd.clear();
        recentW = 0;
        recentNdW = 0;
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
        if (p.gazeRel !== null && dt > 0) {
          const nd = zoneClass(zoneAt(p.gazeRel, radius, cameraOf(centres), cfg), cfg) === 'non_driving';
          recentNd.push({ t: f.tMs, w: dt, nd });
          recentW += dt;
          if (nd) recentNdW += dt;
        }
        recentNd.dropWhile((x) => {
          if (x.t >= f.tMs - RECENT_ND_MS) return false;
          recentW -= x.w;
          if (x.nd) recentNdW -= x.w;
          return true;
        });
        if (onsetLeftS > 0) onsetLeftS = dual !== null ? 0 : Math.max(0, onsetLeftS - dt);
        if (dual !== null) evaluateDual(dt);
        else if (probation !== null) evaluateProbation(dt);
      }

      // Admission (§M3).
      const admitted =
        !p.eyesClosed && ctx !== null && ctx.straight === true && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh && dt > 0;
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
        if (state === 'calibrated' && dual === null) ema(head, p, dt);
      }
      evaluateIfDue();
    },

    state: () => state,
    dual: () => (dual === null || dual.c1 === null ? null : { gaze: dual.c1[cfg.gazeSource] ?? dual.c1.geometric, head: dual.c1.head }),
    // C4 round 1 (C4-1): no posture widening while the dual state's window, or the last 5 s, reads as distraction
    // relative to c₀ (a lean to read a phone is not a shifted road).
    postureWidening: () => ((dual !== null && !dual.nonRoad) || onsetLeftS > 0) && !(recentW > 0 && recentNdW > po.candidateNonDrivingShare * recentW),
    recalibrating: () => provisional !== null || seedUnverified,
    reason: () => (provisional !== null || seedUnverified ? 'recalibrating' : dual !== null || probation !== null || onsetLeftS > 0 ? 'posture' : null),
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

  /** The drift-capped EMA of every centre present (spec "Staying calibrated"). */
  function ema(head: AnglePair, p: Perceived, dt: number): void {
    const cap = (c.emaMaxDegPerMin * dt) / 60;
    const k = dt / c.emaTauS;
    const gate = (radius ?? c.radiusMinDeg) + c.emaWithinExtraDeg;
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
      centres[key] = { yaw: centre.yaw + sy, pitch: centre.pitch + sp };
    };
    step('geometric', p.geoCam);
    step('net', p.netFresh ? p.netCam : null);
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
