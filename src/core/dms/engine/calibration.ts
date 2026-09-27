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
//     excursions must land nearer it than c₀ (≥ slow.returnShare 0.8 of ≥ slow.returnMinCount 12 since it appeared),
//     and so for a rolling large shift (≥ slow.returnMinCountRolling 12, latched per candidate), and c₀ must be
//     vacated beyond noise (≤ slow.excessMax 0.15; C5 rounds 1 and 2);
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
import { bestShift, DirTemplate, templateShare, windowCells, type TemplateSnapshot } from './template';
import { createBaselines, type EyeSample, type RefSnapshot } from './baselines';
import { createPostureDetector, locate, modeOf, peaked, peakedLocal, relativelyVacated, relativeRevert, shareNear, sigmaEffOf, unimodal, vacatedBeyondNoise as vacatedBeyondNoiseOf, vacatedRing, type CompSignature } from './posture';
import { compareSignatures, type DmsProfileV1, type LearnedZone, type MountSignature } from './profile';
import { median, quantile, sd } from './stats';
import { correctedRef, noiseOfSeries } from './earNoise';
import type { AnglePair, DriverSide, EngineFrame, GazeSource, Rotation, VehicleContext } from './types';
import { RingBuffer } from './windows';
import { cameraRel, isDistractionZone, phoneScreenRadius, zoneAt, zoneClass } from './zones';
import { chooseRoad, clusterRho, findClusters, fixationMedians, roadConfidence, roadSide, type RoadChoice } from './stage1';

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
  | 'driver_change_reverted'
  /** Task C8 (rev2 §2.2): a seed (a profile, a C2 seed, a new driver's W2 seed) verified against fresh evidence */
  | 'seed_verified'
  /**
   * Task C9 (T9-3): a corroborated posture step did not resolve (no candidate, or undecided): c₀ is kept but suspect,
   * widened and re-verified, with a background Stage 1
   */
  | 'posture_suspect';

export interface CalibrationEvent {
  kind: CalibrationEventKind;
  tMs: number;
  /** camera_bump: step, resume, rotation, stop; posture_dual: step, bump, resume, stop, slow; posture_revert: relative, undecided, no_candidate, probation, fatigue */
  cause?: 'step' | 'resume' | 'rotation' | 'stop' | 'bump' | 'slow' | 'seed' | 'relative' | 'undecided' | 'no_candidate' | 'probation' | 'fatigue';
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
  /** Task C4: the HUD's calibration cause. Task C8: an unverified profile or C2 seed is 'seed_check'. */
  reason(): 'posture' | 'recalibrating' | 'seed_check' | null;
  /** Task C8: the seed is verified (or there was none): the EMA runs in `seeded` too */
  seedVerified(): boolean;
  /**
   * Task C8 (rev2 §2.7): the profile may be saved: calibrated or seed-verified, and no dual state, probation or
   * provisional driver change pending (the engine adds health and the fatigue gate).
   */
  saveable(): boolean;
  /** Task C5 (rev1 I1): a D1/D2/D3 warning at tMs: the admitted samples within ±voidS are removed */
  voidAround(tMs: number): void;
  /** Task C5 (rev2 §2.3.7): the fatigue evidence gate: while set, no downward or phone-ward adaptation */
  setFatigueGate(on: boolean): void;
  /** Task C6 (rev2 §2.3.4, §2.3.7): fatigue evidence from the EAR baseline: an unexplained drop, or a low q/b */
  earEvidence(): boolean;
  /** Task C6: a yawn (the MAR baseline never rises within yawnBlockS of one) */
  onYawn(tMs: number): void;
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
  /** Task C7: σ̂, the primary source's within-cluster SD (Stage 1), for the health monitor */
  sigma(): number;
  /** Task C7 (H5): the eye baseline is degraded (corroborated; never on a downward ratio alone) */
  eyesDegraded(): boolean;
  /** Task C7: the frozen gate references (null before the pass, a seed or a profile) */
  gateRefs(): { geometric: AnglePair | null; net: AnglePair | null; head: AnglePair | null } | null;
  /** C4 round 1: postureIgnored counts posture steps and bumps seen before any centre (Stage 1 decides) */
  stats(): {
    drivingS: number;
    admittedS: number;
    postureIgnored: number;
    /** Task C6: the EAR baseline's changes (derived, raised, lowered by an explained event, an unexplained drop, a low q/b) */
    baselines: { derived: number; raised: number; lowered: number; unexplained: number; lowUnexplained: number };
  };
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
/** Task C9 (S1-1 (d)): the pre-pass scanning reference's refresh period and minimum sample count */
const STAGE_REF_EVERY_MS = 5000;
const STAGE_REF_MIN_N = 30;
/** Task C9 (S1-1, deviation): the fixation block for the two-cluster detection */
const FIXATION_BLOCK_MS = 500;
const FIXATION_KERNEL_DEG = 1;
/** C9 round 3 (R2-C): the rolling road-side mode's block-scale ρ floor, and the fewest blocks (and side frames) it reads */
const ROLL_SIDE_RHO_MIN_DEG = 1.5;
const ROLL_SIDE_MIN_BLOCKS = 10;
/** the blocks must cover this share of the window's weight, else the frames are used */
const FIXATION_MIN_COVER = 0.5;
/** C5 round 1: an excursion is the gaze away for at least this long, over at least EXCURSION_MIN_FRAMES frames (not noise) */
const EXCURSION_MIN_MS = 400;
const EXCURSION_MIN_FRAMES = 3;
/** Task C5: the share of the rolling window's weight a small-shift follow needs */
const SMALL_MIN_WINDOW_FRAC = 0.75;
const ORIGIN: AnglePair = Object.freeze({ yaw: 0, pitch: 0 });
/** Task C6 (rev4 S4): the moving-time pitch samples before the running median is a reference */
const PITCH_MIN_MOVING_S = 10;

type Centres = { geometric: AnglePair | null; net: AnglePair | null; head: AnglePair | null };

interface Dual {
  cause: 'step' | 'bump' | 'resume' | 'stop' | 'slow' | 'seed';
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
  /**
   * Task C9 (T9-2): the templates (primary source and head) snapshotted at entry, for the translation search; null
   * when the cause is not a corroborated physical step, or the template is too thin (the mode search then)
   */
  tmpl: { src: TemplateSnapshot; head: TemplateSnapshot | null } | null;
  /** T9-2: the current translation of the candidate (primary source and head), once found by the template */
  delta: { src: AnglePair; head: AnglePair | null } | null;
  /** T9-2: a step bump's pre-shift of c₀ (driver frame); the template's translation is measured from before it */
  pre: AnglePair | null;
  /** T9-2: test (c)'s outcomes over the candidate's evaluations (passed, evaluated): a majority decides at the margin */
  vac: { ok: number; n: number };
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
  /** Task C7: the gate references' shift at the commit (undone by a probation revert) */
  gateShift: AnglePair | null;
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
  /** C8 round 2 (review-C8 minor 1): the baselines' reference state before the check, restored on revert */
  oldRef: RefSnapshot;
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
  /** a seed not yet verified: a new driver's (W2), a profile's or a C2 seed's (Task C8) */
  let seedUnverified = false;
  /**
   * Task C8 (rev2 §2.2): the verification windows. Samples are seed-admitted frames (driver frame, the primary
   * source and the head, weight dt); `prev` is the last window's mode when it was peaked and beyond the agree bound.
   */
  /**
   * The seed verification windows. C8 round 2 (review-C8 R1-P): kind 'dispute' is a Stage 1 pass that disagreed with
   * a VERIFIED seed: `pass` is its primary centre, `agreeN` the consecutive peaked windows that agree with it.
   */
  let seedCheck: {
    kind: 'profile' | 'seed' | 'driver' | 'dispute' | 'posture';
    win: { w: number; g: AnglePair | null; h: AnglePair }[];
    winW: number;
    winObsS: number;
    prev: AnglePair | null;
    pass?: AnglePair;
    agreeN?: number;
    /** a peaked window has disagreed with the seed (it is refuted, or being refuted) */
    disagreed?: boolean;
    /** C8 round 3 (R2-D): the dispute is against an UNVERIFIED profile, and its seed-admitted time so far */
    unverifiedProfile?: boolean;
    admS?: number;
  } | null = null;
  /** σ̂ for the verification: the profile's, else the default (Task C8) */
  let seedSigma = SIGMA_DEFAULT;
  /** σ̂ was measured by a Stage 1 pass in this drive (saved to the profile) */
  let sigmaMeasured = false;
  /** the adopted profile's σ̂, kept when no pass measures a new one */
  let warmSigma: number | null = null;
  /** Task C8 (rev2 §2.7): the verified MAR reference (the pass's, the profile's, or the start check's), never the adapted one */
  let marVerified: number | null = null;
  const startSeedCheck = (kind: 'profile' | 'seed' | 'driver' | 'posture') => {
    seedUnverified = true;
    seedCheck = { kind, win: [], winW: 0, winObsS: 0, prev: null };
  };
  /**
   * Task C9 (T9-3): a corroborated step that did not resolve leaves the centres suspect: a background Stage 1 runs
   * (its pass replaces the centres) while the posture seed check verifies c₀.
   */
  let bgStage1 = false;
  /** Task C9 (T9-2): the gaze templates (decayed histograms of the admitted directions, calibrated and non-dual) */
  const tmpl = { geometric: new DirTemplate(po.templateTauS), net: new DirTemplate(po.templateTauS), head: new DirTemplate(po.templateTauS) };
  const clearTemplates = () => {
    tmpl.geometric.clear();
    tmpl.net.clear();
    tmpl.head.clear();
  };
  let wasStopped = false;
  /**
   * Task C7 (rev2 §2.3.6): the frozen gate references (per gaze source, and the head). Set at the Stage 1 pass
   * and from a seed or profile; moved only by a committed translation step (by the head-centre change) and by a
   * step bump's (or a camera step's) head step; never by the EMA, rolling, slow or health paths.
   */
  let gate: Centres | null = null;
  const shiftGate = (d: AnglePair) => {
    if (gate !== null) gate = { geometric: shiftCentre(gate.geometric, d), net: shiftCentre(gate.net, d), head: shiftCentre(gate.head, d) };
  };
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
  let prevRoll: { m: AnglePair; vacated: boolean; se: number; side?: boolean } | null = null;
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
  let excursion: { leftT: number; backT: number | null; run: { t: number; x: AnglePair }[]; sy: number; sp: number } | null = null;
  /** the gaze away from the centre since, and for how many frames (an excursion once long enough) */
  let away: { since: number; frames: number } | null = null;
  /** Task C9 (S1-1 (d)): road scanning's reference before any centre (the Stage 1 window's median direction) */
  let stageRef: AnglePair | null = null;
  let stageRefT = Number.NEGATIVE_INFINITY;

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
  /** C7 round 4 (B): a legacy profile's EAR, until the drive's first pass (which may lower it ≤ 8 %) */
  let legacyEar: EarPair | null = null;
  let earCollector: { trackingS: number; r: number[]; l: number[] } | null = { trackingS: 0, r: [], l: [] };
  let mar: number | null = null;
  let mouthW: number | null = null;
  let lastRotation: Rotation | null = null;
  let lastTrackingT: number | null = null;
  let gap: { before: MountSignature | null } | null = null;
  let comparing: Comparison | null = null;
  /** the openness check: after a resume (opennessRange), or at the start of a drive with a profile or seed EAR (Task C8) */
  let sanity: { trackingS: number; values: number[]; r: number[]; l: number[]; mar: number[]; range: readonly [number, number]; start: boolean } | null = null;
  /** a rotation bump since the last gap: that resume's signature comparison is skipped (T6 review m3) */
  let rotationBumpedInGap = false;
  let warmProfile: DmsProfileV1 | null = init.profile && init.profile.driverSide === side ? init.profile : null;
  /**
   * Task C6 (rev2 §2.3.4): the EAR and MAR baselines during the drive, anchored to the profile's EAR (the floor).
   * Every derivation goes through `setEar`: a new reference (Stage 1, a seed, a profile, a new driver) or an
   * offer (the resume paths, R4: up freely; down only with the fatigue gate clear, by the explained factor).
   */
  const profileAppearance = (pr: DmsProfileV1 | null) => (pr?.earAppearance === undefined ? null : { luma: pr.earAppearance.faceLuma, iodC: pr.earAppearance.iodC });
  const baselines = createBaselines(cfg, {
    profileEar: warmProfile !== null ? { r: warmProfile.openEyeEar[0], l: warmProfile.openEyeEar[1] } : null,
    profileAppearance: profileAppearance(warmProfile),
  });
  /** the next derivation is a new person's (a driver change): a new reference, not an offer */
  let earFresh = false;
  /** Task C6 (rev4 S4): the moving-time seconds in the pitch ring (the running median is used from 10 s) */
  let pitchMovingS = 0;
  /** Task C6: moving seconds with a face but no usable eye (sunglasses) since the last EAR; enough allows a 10 s derivation */
  let eyesUnseenS = 0;
  let tNow = 0;

  const toDrv = (a: AnglePair, r: number) => toDriverFrame(rollCorrect(a, r), side);
  const emit = (kind: CalibrationEventKind, cause?: CalibrationEvent['cause']) => events.push(cause ? { kind, tMs: tNow, cause } : { kind, tMs: tNow });

  /**
   * Task C8 (rev2 §2.2): one verification window. For the primary source and the head: the mode m (a mean shift in
   * ρ = max(ringMinDeg, ringSigmas·σ̂) from the medians), the peakedness P (the weight share within ρ) against one
   * cluster's P₁ = 1 − exp(−ρ²/2σ̂²), and SE (the SD within ρ ÷ √n_eff). Both agree → verified. The primary peaked and
   * beyond the agree bound in two consecutive windows that agree with each other → the dual state (cause 'seed').
   */
  /** Task C9 (S1-2): a seed window's road choice (S1-1 on its frames; the camera off the road by the window's head). */
  function seedWindowRoad(gd: readonly WeightedDir[], win: readonly { h: AnglePair }[]): RoadChoice | 'wait' | null {
    const camera = toDrv({ yaw: 0, pitch: 0 }, roll);
    const head = { yaw: median(win.map((x) => x.h.yaw)), pitch: median(win.map((x) => x.h.pitch)) };
    const back: AnglePair[] = [];
    returns.forEach((x) => {
      if (x.t >= tNow - c.windowS * 1000) back.push(x.at);
    });
    return chooseRoad(gd, { sigma: seedSigma, camera, cameraOffRoad: angularDistanceDeg(camera, head) >= c.radiusMinDeg, returns: back }, cfg);
  }

  function evaluateSeedWindow(sc: NonNullable<typeof seedCheck>): void {
    const sv = c.seed;
    const sig = seedSigma;
    const rho = Math.max(sv.ringMinDeg, sv.ringSigmas * sig);
    const p1 = 1 - Math.exp(-(rho * rho) / (2 * sig * sig));
    const stat = (pts: { w: number; a: AnglePair }[], start: AnglePair | null = null) => {
      if (pts.length < 5) return null;
      const ys = pts.map((x) => x.a.yaw).sort((a, b) => a - b);
      const ps = pts.map((x) => x.a.pitch).sort((a, b) => a - b);
      let m: AnglePair = start ?? { yaw: ys[ys.length >> 1]!, pitch: ps[ps.length >> 1]! };
      for (let it = 0; it < 20; it++) {
        let sw = 0;
        let sy = 0;
        let sp = 0;
        for (const x of pts) {
          if (angularDistanceDeg(x.a, m) <= rho) {
            sw += x.w;
            sy += x.w * x.a.yaw;
            sp += x.w * x.a.pitch;
          }
        }
        if (!(sw > 0)) break;
        const next = { yaw: sy / sw, pitch: sp / sw };
        const moved = angularDistanceDeg(next, m);
        m = next;
        if (moved < 0.05) break;
      }
      let inW = 0;
      let inW2 = 0;
      let vy = 0;
      let vp = 0;
      for (const x of pts) {
        if (angularDistanceDeg(x.a, m) <= rho) {
          inW += x.w;
          inW2 += x.w * x.w;
          vy += x.w * (x.a.yaw - m.yaw) ** 2;
          vp += x.w * (x.a.pitch - m.pitch) ** 2;
        }
      }
      if (!(inW > 0)) return null;
      const sdIn = Math.sqrt((vy + vp) / (2 * inW));
      const nEff = (inW * inW) / inW2;
      // Task C9 (T9-1): LOCAL peakedness, W(ρ) ÷ W(2ρ) against a single cluster's P₁(ρ) ÷ P₁(2ρ): a display watched
      // part of the time no longer keeps a good seed unverified.
      let in2 = 0;
      for (const x of pts) if (angularDistanceDeg(x.a, m) <= 2 * rho) in2 += x.w;
      const p2 = 1 - Math.exp(-(4 * rho * rho) / (2 * sig * sig));
      return { m, peaked: in2 > 0 && inW / in2 >= sv.peakFrac * (p1 / p2), se: sdIn / Math.sqrt(Math.max(1, nEff)) };
    };
    const src = cfg.gazeSource;
    const seedG = centres[src];
    const seedH = centres.head;
    // Task C9 (review-C9 S1-2): the window's cluster choice follows S1-1: with a second cluster the mode is the road's
    // (its mean shift starts there) and the head takes the frames on the road's side; undecided ('wait'), the window
    // is neutral.
    const gd: WeightedDir[] = [];
    for (const x of sc.win) if (x.g !== null) gd.push({ yaw: x.g.yaw, pitch: x.g.pitch, w: x.w });
    const ch = gd.length >= 5 ? seedWindowRoad(gd, sc.win) : null;
    const neutral = ch === 'wait';
    const two = ch !== null && ch !== 'wait' && ch.other !== null ? ch : null;
    const g = neutral ? null : stat(sc.win.filter((x) => x.g !== null).map((x) => ({ w: x.w, a: x.g! })), two === null ? null : two.road);
    const h = neutral ? null : stat((two === null ? sc.win : sc.win.filter((x) => x.g === null || roadSide(x.g, two))).map((x) => ({ w: x.w, a: x.h })));
    // S1-2: a window disagrees only when the seed is vacated beyond noise there (sigma_eff as health's H2): a display
    // watched 60-85 % of the time with the road still at the seed leaves an excess of about 0.2-0.5.
    // Deviation (measured): an 8 s window can fall entirely in an 85 % display's time (1.5 s of road in 10 s), and two
    // such windows are a vacated pair. A window whose mode sits on the Stage 1 window's OTHER cluster (S1-1 on the
    // admitted samples: a display the driver keeps returning from) is neutral too.
    let known: RoadChoice | null | undefined;
    const onOther = (m: AnglePair) => {
      if (known === undefined) known = stage1Choice(samples.toArray().filter((x) => x.w > 0), roll, tNow);
      return known !== null && known.other !== null && !roadSide(m, known);
    };
    const vacatedSeed = (dd: NonNullable<ReturnType<typeof stat>>, seed: AnglePair, useG: boolean) => {
      const dirs = useG ? gd : sc.win.map((x) => ({ yaw: x.h.yaw, pitch: x.h.pitch, w: x.w }));
      if (useG && onOther(dd.m)) return false;
      return vacatedBeyondNoiseOf(dirs, seed, dd.m, radius ?? c.radiusMinDeg, sigmaEffOf(dirs, seed, dd.m, sig), c.slow.excessMax);
    };
    const bound = (s: { se: number }) => Math.max(sv.agreeMinDeg, sv.agreeSE * s.se);
    const agrees = (s: ReturnType<typeof stat>, seed: AnglePair | null) => seed === null || (s !== null && s.peaked && angularDistanceDeg(s.m, seed) <= bound(s));
    // C8 round 2 (review-C8 R1-P): a disputed pass. A window that agrees with the verified seed discards the pass
    // (Stage 1 restarts); two consecutive peaked windows that agree with the pass centre (the pair bound) and not
    // with the seed open the dual state (cause 'seed'), which commits by the dual rules: a real move is followed.
    if (sc.kind === 'dispute') {
      if (!neutral && agrees(g, seedG) && agrees(h, seedH) && (seedG !== null ? g !== null : h !== null)) {
        seedCheck = null;
        restartPassWindow();
        // C8 round 3: the seed wins a dispute against an unverified profile: the profile is verified by that window.
        if (sc.unverifiedProfile === true) {
          seedUnverified = false;
          emit('seed_verified');
        }
        return;
      }
      // C8 round 3 (review-C8 R2-D): against an UNVERIFIED profile, the dispute resolves for the pass unless the seed
      // wins within disputeMaxS of seed-admitted time: the profile is marked refuted and Stage 1 evaluates again at
      // once (its pass then replaces the centres). A display that keeps the windows un-peaked cannot hold it open.
      if (sc.unverifiedProfile === true && (sc.admS ?? 0) >= sv.disputeMaxS) {
        seedCheck = { kind: 'profile', win: [], winW: 0, winObsS: 0, prev: null, disagreed: true };
        lastEvalT = null;
        return;
      }
      if (neutral) return;
      const dd = seedG !== null ? g : h;
      const seedC = seedG ?? seedH;
      const withPass = dd !== null && dd.peaked && sc.pass !== undefined && angularDistanceDeg(dd.m, sc.pass) <= Math.max(sv.pairMinDeg, sv.pairSE * dd.se);
      const offSeed = dd !== null && seedC !== null && angularDistanceDeg(dd.m, seedC) > bound(dd) && vacatedSeed(dd, seedC, seedG !== null);
      sc.agreeN = withPass && offSeed ? (sc.agreeN ?? 0) + 1 : 0;
      if ((sc.agreeN ?? 0) >= 2) {
        seedCheck = null;
        enterDual('seed', null, 0, 0);
      }
      return;
    }
    if (neutral) return;
    if (agrees(g, seedG) && agrees(h, seedH) && (seedG !== null ? g !== null : h !== null)) {
      // C8 round 2 (review-C8 minor): a verified C2 seed ends the warm start's retries.
      if (sc.kind === 'seed') warmProfile = null;
      // Task C9 (T9-3): a verified c₀ ends the suspicion (and its background Stage 1).
      if (sc.kind === 'posture') bgStage1 = false;
      seedUnverified = false;
      seedCheck = null;
      emit('seed_verified');
      return;
    }
    // The primary source decides a disagreement (the head when the source has no seed centre).
    const d = seedG !== null ? g : h;
    const seed = seedG ?? seedH;
    if (d !== null && seed !== null && d.peaked && angularDistanceDeg(d.m, seed) > bound(d)) {
      // S1-2: not vacated beyond noise: neutral (the pair's prev is kept).
      if (!vacatedSeed(d, seed, seedG !== null)) return;
      sc.disagreed = true;
      if (sc.prev !== null && angularDistanceDeg(d.m, sc.prev) <= Math.max(sv.pairMinDeg, sv.pairSE * d.se)) {
        sc.prev = null;
        enterDual('seed', null, 0, 0);
      } else sc.prev = d.m;
    } else sc.prev = null;
  }

  function saveableNow(): boolean {
    return (state === 'calibrated' || (state === 'seeded' && !seedUnverified)) && dual === null && probation === null && provisional === null;
  }

  /** Task C8 (rev2 §2.6): the EMA runs when calibrated, or seeded and verified */
  function tracked(): boolean {
    return state === 'calibrated' || (state === 'seeded' && !seedUnverified);
  }

  function restartStage1(): void {
    clearTemplates();
    bgStage1 = false;
    gate = null;
    samples.clear();
    admittedS = 0;
    drivingS = 0;
    lastEvalT = null;
    gaveUp = false;
    hasSeed = false;
    stageRef = null;
    stageRefT = Number.NEGATIVE_INFINITY;
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

  /** Task C6: the EAR set by a derivation (a new reference) or offered by a resume path (the downward rule). */
  /** C7 round 4 (review-C7 Round 4 ruling, B): an open-eye reference from a window: the noise-corrected P90. */
  function refOf(xs: number[], side: 'r' | 'l'): number | null {
    return correctedRef(xs, baselines.noiseSigma(side));
  }

  function setEar(next: EarPair | null, how: 'derive' | 'offer', appearance: { luma: number; iodC: number } | null = null): void {
    if (next === null || (next.r === null && next.l === null)) {
      ear = next;
      return;
    }
    if (how === 'offer' && ear !== null && !earFresh) ear = baselines.offer(next, baselines.appearance(), fatigueGate);
    else {
      ear = baselines.setReference(next, mar, tNow, appearance);
      earFresh = false;
    }
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
    // C7 round 4 (B): the noise-corrected P90.
    const pick = (xs: number[], prev: number | null | undefined, side: 'r' | 'l') =>
      xs.length > 0 ? refOf(xs, side) : prev != null ? prev * medianOpenness : null;
    // Task C6 (R4): offered, so it may rise at once but falls only with the fatigue gate clear and by the factor
    // the appearance explains (a drowsy driver's low openness never lowers the reference).
    setEar({ r: pick(win.r, old?.r, 'r'), l: pick(win.l, old?.l, 'l') }, 'offer');
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
    legacyEar = null; // C7 round 4: a new driver's pass is not bounded by the old driver's legacy profile
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
      startSeedCheck('driver');
    }
    marVerified = null;
    rederiveEar();
    earFresh = true; // a new person: the next EAR is a new reference, not an offer (Task C6)
    baselines.reset();
    provisional = null;
    mar = null;
    mouthW = null;
    pitchRing.clear();
    pitchMovingS = 0;
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
      shiftGate(drvShift); // Task C7: a step bump's (a camera step's) head step moves the gate references too
    }
    // T9-2: the translation search for a corroborated physical step (not a seed dispute, not the slow path).
    const src0 = primary();
    const corroborated = cause === 'step' || cause === 'bump' || cause === 'resume' || cause === 'stop';
    const snap = corroborated && tmpl[src0].weight(tNow) >= po.templateMinS ? tmpl[src0].snapshot(tNow) : null;
    const snapHead = snap !== null ? tmpl.head.snapshot(tNow) : null;
    dual = { cause, c0: { ...centres }, c1: null, enteredT: tNow, observedS: 0, searchObservedS: 0, since: tNow, revertS: 0, lastEvalT: tNow, stable: 0, box, iodFrac, tmpl: snap === null ? null : { src: snap, head: snapHead }, delta: null, pre: drvShift, vac: { ok: 0, n: 0 } };
    probation = null;
    posture.clear();
    posture.resetFit();
    bump.clear();
    emit('posture_dual', cause);
  }

  function exitDual(cause: 'relative' | 'undecided' | 'no_candidate' | 'fatigue'): void {
    if (dual === null) return;
    const was = dual;
    centres.geometric = dual.c0.geometric;
    centres.net = dual.c0.net;
    centres.head = dual.c0.head;
    dual = null;
    emit('posture_revert', cause);
    // Task C9 (T9-3): a step on corroborated evidence that did not resolve keeps c₀ but marks it suspect: widened
    // (+5°, D2 on, HUD recalibrating), verified by the seed windows (a disagreeing pair opens a 'seed' dual), and a
    // background Stage 1 whose pass replaces the centres. A false alarm verifies within about 60 s.
    const corroborated = was.cause === 'step' || was.cause === 'bump' || was.cause === 'resume' || was.cause === 'stop';
    if (corroborated && (cause === 'no_candidate' || cause === 'undecided') && state === 'calibrated') {
      startSeedCheck('posture');
      bgStage1 = true;
      restartPassWindow();
      emit('posture_suspect');
    }
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

  /** Task C9 (T9-2): a centre before a step bump's pre-shift (the template's frame). */
  function unshift<T extends AnglePair | null>(a: T, pre: AnglePair | null): T {
    if (a === null || pre === null) return a;
    return { yaw: a.yaw - pre.yaw, pitch: a.pitch - pre.pitch } as T;
  }

  /**
   * Task C9 (T9-2): c₀ vacated beyond the SHIFTED TEMPLATE. W's share within r_v of c₀, less R shifted by Δ's share
   * there, is at most slow.excessMax × W's share within r_v of c₀ + Δ: a display the step moved onto c₀ is predicted.
   */
  function vacatedBeyondTemplate(win: readonly WeightedDir[], R: TemplateSnapshot, c0: AnglePair, delta: AnglePair): boolean {
    const c1 = { yaw: c0.yaw + delta.yaw, pitch: c0.pitch + delta.pitch };
    const rv = vacatedRing(c0, c1, radius ?? c.radiusMinDeg);
    const w1 = shareNear(win, c1, rv);
    if (!(w1 > 0)) return false;
    const predicted = templateShare(R.grid, { yaw: c0.yaw - delta.yaw, pitch: c0.pitch - delta.pitch }, rv);
    return shareNear(win, c0, rv) - predicted <= c.slow.excessMax * w1;
  }

  /**
   * Task C9 (T9-2, deviation): test (b)'s gain. A shift within the small-shift range (≤ smallShiftSigmas σ̂, where the
   * σ 4° clusters overlap most) moves s(Δ) − s(0) only about 0.1 at 3°: it needs templateSmallGainMin there (the
   * match (a) and the persistence still apply; (c) applies only to separable shifts, as the commit's own test does).
   */
  const gainMin = (delta: AnglePair) => (Math.hypot(delta.yaw, delta.pitch) <= po.smallShiftSigmas * sigmaHat ? po.templateSmallGainMin : po.templateGainMin);

  /** Task C9 (T9-2): the template candidate (a), (b), (c), (d); null when any test fails. */
  function templateCandidate(d: Dual, found: readonly WeightedDir[], c0s: AnglePair, camera: AnglePair | null, src: 'geometric' | 'net'): { c1: Centres; delta: { src: AnglePair; head: AnglePair | null } } | null {
    const t = d.tmpl!;
    const c0 = unshift(c0s, d.pre);
    const W = windowCells(found);
    const b = bestShift(W, t.src.grid, po.searchMaxDeg);
    if (!(b.s >= po.templateMatchMin) || !(b.s - b.s0 >= gainMin(b.delta))) return null;
    const separable = Math.hypot(b.delta.yaw, b.delta.pitch) > po.smallShiftSigmas * sigmaHat;
    if (separable && !vacatedBeyondTemplate(found, t.src, c0, b.delta)) return null;
    const c1 = { yaw: c0.yaw + b.delta.yaw, pitch: c0.pitch + b.delta.pitch };
    // Road-like against the dual's own c₀ (a step bump's c₀ is already pre-shifted; the camera is relative to it): the
    // point test only. The window's distraction share (C4 round 2's guard for a MODE candidate, which a phone read
    // most of the time could become) does not apply: the translation moves the whole distribution, and test (c) above
    // already refuses a window whose road is still watched at c₀ (a lean to read a phone); a 40 % display partly in
    // the centre-stack zone would otherwise block every real step.
    if (!roadLikeAt(c1, c0s, camera)) return null;
    let hd: AnglePair | null = null;
    if (t.head !== null && d.c0.head !== null) hd = bestShift(windowCells(dirsSince(d.enteredT, 'head')), t.head.grid, po.searchMaxDeg).delta;
    const other: 'geometric' | 'net' = src === 'net' ? 'geometric' : 'net';
    const sh = (a: AnglePair | null, dl: AnglePair | null) => (a === null || dl === null ? a : { yaw: a.yaw + dl.yaw, pitch: a.pitch + dl.pitch });
    const next: Centres = { geometric: null, net: null, head: sh(unshift(d.c0.head, d.pre), hd ?? b.delta) };
    next[src] = c1;
    next[other] = sh(unshift(d.c0[other], d.pre), b.delta);
    return { c1: next, delta: { src: b.delta, head: hd } };
  }

  /**
   * Task C9 (T9-2): a template candidate's persistence and commit. Δ follows the persistence window's best
   * translation near the current one (±2°); stable while consecutive evaluations agree within max(1°, SE); the
   * revert as before; the commit needs commitS of persistence, the match and the gain, and c₀ vacated beyond the
   * shifted template (when separable).
   */
  function evaluateTemplateDual(d: Dual, win: readonly WeightedDir[], c0s: AnglePair, camera: AnglePair | null, src: 'geometric' | 'net', r: number, sinceLast: number): void {
    const t = d.tmpl!;
    const c0 = unshift(c0s, d.pre);
    const cur = d.delta!;
    const c1 = { yaw: c0.yaw + cur.src.yaw, pitch: c0.pitch + cur.src.pitch };
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
    const W = windowCells(win);
    const b = bestShift(W, t.src.grid, po.searchMaxDeg, cur.src, 2);
    const se = sigmaHat / Math.sqrt(Math.max(1, win.length));
    const moved = Math.hypot(b.delta.yaw - cur.src.yaw, b.delta.pitch - cur.src.pitch);
    d.stable = moved <= Math.max(1, se) ? d.stable + 1 : 0;
    let hd = cur.head;
    if (t.head !== null && cur.head !== null) hd = bestShift(windowCells(dirsSince(d.since, 'head')), t.head.grid, po.searchMaxDeg, cur.head, 2).delta;
    d.delta = { src: b.delta, head: hd };
    const other: 'geometric' | 'net' = src === 'net' ? 'geometric' : 'net';
    const sh = (a: AnglePair | null, dl: AnglePair | null) => (a === null || dl === null ? a : { yaw: a.yaw + dl.yaw, pitch: a.pitch + dl.pitch });
    const next: Centres = { geometric: null, net: null, head: sh(unshift(d.c0.head, d.pre), hd ?? b.delta) };
    next[src] = { yaw: c0.yaw + b.delta.yaw, pitch: c0.pitch + b.delta.pitch };
    next[other] = sh(unshift(d.c0[other], d.pre), b.delta);
    d.c1 = next;
    // (c) is tallied at every evaluation of the candidate (the commit below takes the majority at the margin).
    const vacNow = vacatedBeyondTemplate(win, t.src, c0, b.delta);
    d.vac.n++;
    if (vacNow) d.vac.ok++;
    if (weightOf(win) < po.commitS || d.stable < 2) return;
    if (!(b.s >= po.templateMatchMin) || !(b.s - b.s0 >= gainMin(b.delta))) return;
    const c1n = next[src]!;
    if (!roadLikeAt(c1n, c0s, camera)) return;
    const sepNow = angularDistanceDeg(c0, c1n) > po.smallShiftSigmas * sigmaHat;
    // Test (c) at the margin (a shift just past the small-shift range, where c₀ still holds the cluster's tail) flips
    // from one evaluation to the next with the window's sampling: the commit takes the majority of the candidate's
    // evaluations (at least 3), or the test passing now.
    if (sepNow && !vacNow && !(d.vac.n >= 3 && d.vac.ok * 2 >= d.vac.n)) return;
    // The committed centres: the translation places them (a display cannot pull it); the window's own samples near
    // c₀ + Δ fix them (a mean shift within ρ, as the mode's refinement), finer than the template's 2° cells.
    const rho = Math.max(4, 1.3 * sigmaHat);
    const fixAt = (dirs: readonly WeightedDir[], at: AnglePair | null) => (at === null || weightOf(dirs) < po.searchS ? at : locate(dirs, at, rho));
    const done: Centres = { geometric: null, net: null, head: fixAt(dirsSince(d.since, 'head'), next.head) };
    done[src] = fixAt(win, next[src]);
    done[other] = fixAt(dirsSince(d.since, other), next[other]);
    commitDual(d, done);
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
      const found = dirsSince(d.enteredT, src);
      if (weightOf(found) >= po.searchS && d.tmpl !== null) {
        // Task C9 (T9-2): the translation that maps the pre-step template onto the window.
        const t = templateCandidate(d, found, c0, camera, src);
        if (t !== null) {
          d.c1 = t.c1;
          d.delta = t.delta;
          d.since = d.enteredT;
        }
      } else if (weightOf(found) >= po.searchS) {
        // The candidate: the mode of the first searchS of admission, peaked (T9-1: locally), near c₀, road-like.
        const m = dualMode(d, found, d.enteredT);
        // Task C9 (S1-2): a 'seed' dual whose road (S1-1) is the seed itself was opened by windows wholly on a display
        // (an 85 % start, before Stage 1 knows its two clusters): the seed stands, and its verification resumes.
        if (d.cause === 'seed' && m !== null && angularDistanceDeg(m, c0) <= c.seed.agreeMinDeg) {
          exitDual('relative');
          if (seedCheck !== null) {
            seedCheck.prev = null;
            seedCheck.disagreed = false;
          }
          return;
        }
        if (m !== null && angularDistanceDeg(m, c0) <= po.searchMaxDeg && peakedLocal(found, m, sigmaHat, po.peakedRatio) && roadLike(m, found, c0, camera)) {
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
    // Task C9 (T9-2): a template candidate follows the window's best translation near its own, and commits on the
    // template's tests (a display near c₀ is predicted by the shifted template, not counted against the commit).
    if (d.delta !== null && d.tmpl !== null) {
      evaluateTemplateDual(d, win, c0, camera, src, r, sinceLast);
      return;
    }
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
    const m = dualMode(d, win, d.since);
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
    // Task C9 (review-C9 S1-2): a seed's replacement commits only with the seed vacated beyond noise (no template
    // exists before a pass: the prediction is c1's own spread, C5-1's test) as well as road-like (above).
    if (d.cause === 'seed' && !vacatedBeyondNoise(win, c0, c1)) return;
    commitDual(d);
  }

  /**
   * The dual state's mode of a window. Task C9 (review-C9 S1-2): a 'seed' dual's follows S1-1's road choice (on the
   * samples since `t0`), so a display watched more than the road is never its candidate; undecided, none.
   */
  function dualMode(d: Dual, dirs: readonly WeightedDir[], t0: number): AnglePair | null {
    if (d.cause !== 'seed') return modeOf(dirs, cfg);
    const ch = stage1Choice(samples.toArray().filter((x) => x.t >= t0 && x.w > 0), roll, tNow);
    return ch === null ? null : refineMode(dirs, ch.road, cfg);
  }

  function commitDual(d: Dual, given: Centres | null = null): void {
    const pick = (src: 'geometric' | 'net' | 'head', fallback: AnglePair | null) => {
      if (fallback === null) return null;
      return modeOf(dirsSince(d.since, src), cfg) ?? fallback;
    };
    // Task C9 (T9-2): a template commit takes c₀ + Δ (the whole distribution's translation), not the window's modes.
    const next: Centres = given ?? { geometric: pick('geometric', d.c1!.geometric ?? d.c0.geometric), net: pick('net', d.c1!.net ?? d.c0.net), head: pick('head', d.c1!.head ?? d.c0.head) };
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
    clearTemplates(); // T9-2: the old posture's directions are no longer the road's
    // Task C7: a committed TRANSLATION step moves the gate references by the head-centre change (the slow path's
    // uncorroborated commit does not: it is no translation step).
    const h0 = d.c0.head ?? d.c0[src];
    const h1 = next.head ?? next[src];
    const gateShift = d.cause !== 'slow' && h0 !== null && h1 !== null ? { yaw: h1.yaw - h0.yaw, pitch: h1.pitch - h0.pitch } : null;
    if (gateShift !== null) shiftGate(gateShift);
    const demote = d.box >= po.demoteBoxC || Math.abs(d.iodFrac) >= po.demoteIodFracC;
    probation = { c0: d.c0, since: tNow, observedS: 0, reverseS: 0, lastEvalT: tNow, gateShift };
    dual = null;
    // Task C8: a seed's replacement committed: the seed is resolved (replaced, not verified).
    if (d.cause === 'seed') {
      seedUnverified = false;
      seedCheck = null;
    }
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
        if (pr.gateShift !== null) shiftGate({ yaw: -pr.gateShift.yaw, pitch: -pr.gateShift.pitch });
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

  /**
   * C9 round 3 (R2-C): the rolling window's road-side mode. The clusters come from `findClusters` on the window's
   * half-second fixation medians at the block scale (σ_b = σ̂/√n, ρ_b = max(1.5°, 1.3σ_b), a 1° kernel); the road is the
   * cluster nearest `cur`; the mode is `locate` on the per-frame frames nearer it than any other cluster, from it, within
   * min(max(4°, 2σ̂), half the nearest separation).
   * - null (the per-frame mode `m0` stands): too few blocks or side frames, or ONE block cluster within ρ_b of `m0`.
   * - 'hold' (no follow on this window; deviation, measured): ONE block cluster farther than ρ_b from `m0` (the frame
   *   mode is a blend of two masses the blocks resolved only one of: the review's 2.8° outlier, (0°, 7°) 60 % seed 1,
   *   where the one cluster was the DISPLAY and the blend follow ran), or two clusters about equally near `cur` (within
   *   ρ_b: a centre already between them cannot tell which is the road).
   */
  function roadSideMode(win: readonly WeightedDir[], cur: AnglePair, m0: AnglePair): AnglePair | 'hold' | null {
    const xs: { t: number; a: AnglePair | null; w: number }[] = [];
    samples.forEach((sm) => {
      if (sm.t < tNow - c.rolling.windowS * 1000 || !(sm.w > 0)) return;
      const a = cfg.gazeSource === 'net' ? sm.net : sm.geo;
      xs.push({ t: sm.t, a: a === null ? null : toDrv(a, roll), w: sm.w });
    });
    const fm = fixationMedians(xs, FIXATION_BLOCK_MS);
    if (fm.dirs.length < ROLL_SIDE_MIN_BLOCKS) return null;
    const sigmaB = sigmaHat / Math.sqrt(Math.max(1, fm.perBlock));
    const rhoB = Math.max(ROLL_SIDE_RHO_MIN_DEG, 1.3 * sigmaB);
    const cl = findClusters(fm.dirs, { sigma: sigmaB, rho: rhoB, kernelDeg: FIXATION_KERNEL_DEG }, cfg);
    if (cl.length === 0) return null;
    if (cl.length < 2) return angularDistanceDeg(cl[0]!, m0) > rhoB ? 'hold' : null;
    const byCur = [...cl].sort((p, q) => angularDistanceDeg(p, cur) - angularDistanceDeg(q, cur));
    const road = byCur[0]!;
    if (angularDistanceDeg(byCur[1]!, cur) - angularDistanceDeg(road, cur) < rhoB) return 'hold';
    const others = cl.filter((q) => q !== road);
    const side = win.filter((d) => others.every((o) => angularDistanceDeg(d, road) <= angularDistanceDeg(d, o)));
    if (side.length < ROLL_SIDE_MIN_BLOCKS) return null;
    const half = Math.min(...others.map((o) => angularDistanceDeg(o, road) / 2));
    return locate(side, road, Math.min(Math.max(LOCATE_MIN_R_DEG, 2 * sigmaHat), half));
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
    return vacatedBeyondNoiseOf(win, c0, c1, radius ?? c.radiusMinDeg, sigmaHat, c.slow.excessMax);
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
  function evaluateRolling(smallOnly = false): void {
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
    let m = locate(win, peak, Math.max(LOCATE_MIN_R_DEG, 2 * sigmaHat));
    // C9 round 3 (review-C9 R2-C; the user's "no drift over time"): a display 7–9° from the road merges with it into ONE
    // per-frame mode, and the locate from the window's peak lands between them: the small follow walked the centre
    // toward a display (3.5–5° in 15 min). When a small follow is possible, the window's clusters are found on its
    // half-second fixation medians at the BLOCK scale (ρ_b = max(1.5°, 1.3σ̂/√n): a display 7° away is about 4σ there);
    // with two or more, the follow reads the per-frame frames on the side of the cluster nearest the centre.
    // A road-side mode agrees only with a road-side mode (deviation, measured: S-DISPLAY-70 (7°, −1°) seed 13): the
    // window a display first appears in has a road cluster pulled toward it by the transition blocks and the display's
    // per-frame tail; agreeing with the display-free window before it, it made a 0.9° follow toward the display, the EMA
    // carried it on, and health read c₀ as vacated. Two road-side windows in a row are the steady two-cluster case.
    // Not in probation (smallOnly; deviation, measured: S-2H-MANY-DISPLAY (7°, −1°) 20 %, plan 1, 8 fps): after a
    // posture commit the rolling path settles the new centre, and the road-side locate (its radius capped at half the
    // separation) is noisier than the window's: it followed a 1.2° low reading and the segment took 228 s to settle
    // (75 s before). The creep it cures is a steady drive's, never a probation's.
    let side = false;
    if (!smallOnly && angularDistanceDeg(m, cur) <= po.smallShiftSigmas * sigmaHat + 1) {
      const rs = roadSideMode(win, cur, m);
      if (rs === 'hold') m = cur;
      else if (rs !== null) {
        m = rs;
        side = true;
      }
    }
    const d = angularDistanceDeg(m, cur);
    const se = sigmaHat / Math.sqrt(Math.max(1, win.length));
    // Engaged (a drift being followed), the follow continues down to half the minimum shift, so a steady drift is
    // followed at its pace (rev2 §2.3.3: a lag of about 1.5–2° at 1°/min) instead of every other evaluation; below
    // that a follow would chase the locator's noise (about ±0.2° on a full window).
    const minShift = wasEngaged ? c.rolling.minShiftDeg / 2 : c.rolling.minShiftDeg;
    // A small shift is read from a (nearly) full window only: a window the warnings have voided down to 20 s locates
    // the centre to about ±0.5°, and a follow would chase that noise (the S-LEAN-PHONE sweep's no-lean runs).
    // Task C9 (T9): "full" counts the admitted, unvoided weight before the phone-screen exclusion (a display near the
    // phone, excluded from the rolling window, is no voided window: the road's frames locate the centre as well).
    const wAdmitted = weightOf(dirsSince(tNow - c.rolling.windowS * 1000, src));
    const small = d >= minShift && d <= po.smallShiftSigmas * sigmaHat && wAdmitted >= SMALL_MIN_WINDOW_FRAC * c.rolling.windowS;
    const large = d > po.smallShiftSigmas * sigmaHat && d <= c.radiusMinDeg;
    const vacated = large && relativelyVacated(win, cur, m, r, cfg);
    const agrees = prevRoll !== null && angularDistanceDeg(prevRoll.m, m) <= Math.max(1, se, prevRoll.se) && (!side || prevRoll.side === true);
    // Task C9 (T9, deviation): a road cluster with a display watched far from it (no second peak within 2ρ, locally
    // peaked, T9-1) is followed too, so a slow drift under a display is not left unfollowed (S-2H-MANY-DISPLAY). A
    // display within 2ρ (a broad mode between it and the road, S-40-DISPLAY's case) keeps C5 (c)'s relative test.
    const rhoS = Math.max(4, 1.3 * sigmaHat);
    const separatedDisplay = () => unimodal(win, m, r, sigmaHat, cfg, 2 * rhoS) && peakedLocal(win, m, sigmaHat, po.peakedRatio);
    const okSmall = small && agrees && ((unimodal(win, m, r, sigmaHat, cfg) && peaked(win, m, sigmaHat, cfg)) || separatedDisplay());
    // C5 round 1 (C5-1 rule 2): a large shift is followed only where the driver returns after an excursion: in the
    // two agreeing windows, ≥ returnMinCountRolling returns, ≥ returnShare of them nearer m (else the follow waits).
    // (The returns count from the candidate's appearance against the centre then; once corroborated the candidate
    // stays so while it persists, so the follow is not re-qualified at every evaluation. C5 round 2: at 0.8 a display
    // watched 70 % of the time can pass the return test; vacatedBeyondNoise holds it.)
    if (!large) largeCand = null;
    else if (largeCand === null || angularDistanceDeg(largeCand.m, m) > Math.max(1.5, 2 * se)) largeCand = { m, from: cur, since: tNow, ok: false };
    if (largeCand !== null && !largeCand.ok) largeCand.ok = returnsCorroborate(largeCand.since, largeCand.m, largeCand.from, c.slow.returnMinCountRolling);
    const okLarge = !smallOnly && large && vacated && prevRoll !== null && prevRoll.vacated && agrees && largeCand !== null && largeCand.ok && vacatedBeyondNoise(win, cur, m);
    prevRoll = { m, vacated, se, side };
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
    // The slow uncorroborated path (R3b): beyond the rolling range, up to maxShiftDeg (not during probation).
    const beyond = !smallOnly && d > c.radiusMinDeg && d <= c.slow.maxShiftDeg && peaked(win, m, sigmaHat, cfg) && relativelyVacated(win, cur, m, r, cfg) && vacatedBeyondNoise(win, cur, m) && !gateBlocks(cur, m) && roadLike(m, win, cur, offRoadCamera(centres), true);
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
  /**
   * Task C9 (S1-1 (d)): before any centre, road scanning's reference is the admitted window's median direction
   * (refreshed every STAGE_REF_EVERY_MS): a display beside the road and the road both lie within excursionMinDeg of it,
   * the mirrors beyond.
   */
  function stageRefNow(): AnglePair | null {
    if (tNow - stageRefT < STAGE_REF_EVERY_MS) return stageRef;
    stageRefT = tNow;
    const ys: number[] = [];
    const ps: number[] = [];
    samples.forEach((s) => {
      const a = cfg.gazeSource === 'net' && s.net !== null ? s.net : s.geo;
      if (a === null || !(s.w > 0)) return;
      const d = toDrv(a, roll);
      ys.push(d.yaw);
      ps.push(d.pitch);
    });
    stageRef = ys.length >= STAGE_REF_MIN_N ? { yaw: median(ys), pitch: median(ps) } : null;
    return stageRef;
  }

  function trackScanning(p: Perceived, ref: AnglePair | null = null): void {
    const cur = ref ?? centres[primary()];
    if (cur === null || p.eyesClosed) return;
    const g = cfg.gazeSource === 'net' && p.netCam !== null ? p.netCam : p.geoCam;
    if (g === null) return;
    const x = toDrv(g, roll);
    if (Math.abs(x.yaw - cur.yaw) >= c.slow.excursionMinDeg) {
      away = away === null ? { since: tNow, frames: 1 } : { since: away.since, frames: away.frames + 1 };
      if (tNow - away.since >= EXCURSION_MIN_MS && away.frames >= EXCURSION_MIN_FRAMES && (excursion === null || excursion.backT !== null)) {
        excursion = { leftT: away.since, backT: null, run: [], sy: 0, sp: 0 };
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
    const ex = excursion;
    const run = ex.run;
    run.push({ t: tNow, x });
    ex.sy += x.yaw;
    ex.sp += x.pitch;
    const r = radius ?? c.radiusMinDeg;
    // The run is the frames since the first one within the radius of the rest's mean (running sums: each frame
    // leaves the run once, so this is amortised O(run) per frame; review-C5 round 1 minor).
    while (run.length > 1) {
      const mean = { yaw: ex.sy / run.length, pitch: ex.sp / run.length };
      if (run.every((f) => angularDistanceDeg(f.x, mean) <= r)) {
        if (tNow - run[0]!.t >= c.slow.returnFixationMs) {
          returns.push({ t: tNow, at: mean });
          excursion = null;
        }
        return;
      }
      const gone = run.shift()!;
      ex.sy -= gone.x.yaw;
      ex.sp -= gone.x.pitch;
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
      if (!voided(e.t) && tracked() && dual === null) ema(e.head, e.geo, e.net, e.w);
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
    provisional = { oldEar: ear === null ? null : { ...ear }, oldRef: baselines.snapshotRef(), r: [], l: [], trackingS: 0, blinkSeen: false, dipSince: null, done: false };
    emit('driver_change_provisional');
  }

  function revertProvisional(): void {
    if (provisional === null) return;
    // C8 round 2 (review-C8 minor 1): the reference state as it was, labels included (not re-set at revert time).
    baselines.restoreRef(provisional.oldRef);
    ear = provisional.oldEar === null ? null : { ...provisional.oldEar };
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
      const floor = (xs: number[], o: number | null | undefined, side: 'r' | 'l') => {
        const v = xs.length > 0 ? refOf(xs, side) : null;
        if (v === null) return o ?? null;
        return o != null ? Math.max(v, c.stops.interimFloor * o) : v;
      };
      setEar({ r: floor(pv.r, old?.r, 'r'), l: floor(pv.l, old?.l, 'l') }, 'derive');
      earFresh = true; // the confirmed collector replaces it as a new person's reference
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
      setEar({ ...seed.openEyeEar }, 'derive');
      earCollector = null;
    }
    hasSeed = true;
    if (state === 'none' || state === 'uncalibrated') {
      state = 'seeded';
      // Task C8 (rev2 §2.2): verified against fresh evidence, widened until then; the start check on its EAR.
      startSeedCheck('seed');
      seedSigma = SIGMA_DEFAULT;
      if (ear !== null) startOpennessCheck();
    }
    gate = { ...centres }; // Task C7: the seed's references, until the pass
  }

  /** Task C8 (rev2 §2.2 item 3): the start check on a profile's or seed's EAR and MAR (10 s of moving frames). */
  function startOpennessCheck(): void {
    sanity = { trackingS: 0, values: [], r: [], l: [], mar: [], range: c.startOpennessRange, start: true };
  }

  function applyProfile(p: DmsProfileV1): void {
    centres.geometric = p.gazeCentres.geometric ?? null;
    centres.net = p.gazeCentres.net ?? null;
    centres.head = p.headCentre;
    radius = p.radiusDeg;
    roll = p.rollOffsetDeg;
    // A profile without any EAR must not stop the provisional collection (T6 review m1).
    mar = p.neutralMar;
    marVerified = p.neutralMar;
    // C7 round 4 (B): a legacy profile's EAR (the inflated P90) may be lowered once, by the first pass, ≤ 8 %.
    legacyEar = p.earNoiseCorrected === true ? null : { r: p.openEyeEar[0], l: p.openEyeEar[1] };
    if (p.openEyeEar[0] !== null || p.openEyeEar[1] !== null) {
      // Task C8 (the review-C6 T8 carry): the reference comes with the appearance it was taken under.
      setEar({ r: p.openEyeEar[0], l: p.openEyeEar[1] }, 'derive', profileAppearance(p));
      earCollector = null;
    }
    mouthW = p.neutralMouthW;
    hasSeed = true;
    state = 'seeded';
    gate = { ...centres }; // Task C7: the profile's references, until the pass
    // Task C8 (rev2 §2.2): verified against fresh evidence (widened, HUD seed_check); the start check.
    startSeedCheck('profile');
    seedSigma = p.sigmaDeg ?? SIGMA_DEFAULT;
    warmSigma = p.sigmaDeg ?? null;
    startOpennessCheck();
    emit('warm_start');
  }

  function pitchReference(): number | null {
    if (centres.head !== null) return centres.head.pitch;
    // Task C6 (rev4 S4): the moving-time running median once it has PITCH_MIN_MOVING_S; before that none (the
    // looking-down gate then uses the gaze term only). A profile or seed gives the head centre above.
    if (pitchRing.size === 0 || pitchMovingS < PITCH_MIN_MOVING_S) return null;
    if (pitchMedian === null || (pitchMedianStale && pitchNowT - pitchMedianT >= PITCH_MEDIAN_EVERY_MS)) {
      pitchMedian = median(pitchRing.toArray().map((x) => x.pitch));
      pitchMedianStale = false;
      pitchMedianT = pitchNowT;
    }
    return pitchMedian;
  }

  /**
   * Task C9 (review-C9 S1-1): the road cluster of a Stage 1 window (null: no pass yet). The camera is off the road when
   * the head's forward (the window's median head direction) is ≥ radiusMinDeg from it; the returns are the mirror
   * checks' landing points in the window (tracked from the window's median direction before any centre exists).
   */
  function stage1Choice(all: readonly Sample[], r: number, t: number): RoadChoice | null {
    const camera = toDrv({ yaw: 0, pitch: 0 }, r);
    const hy: number[] = [];
    const hp: number[] = [];
    for (const s of all) {
      const h = toDrv(s.head, r);
      hy.push(h.yaw);
      hp.push(h.pitch);
    }
    const headFwd = { yaw: median(hy), pitch: median(hp) };
    const back: AnglePair[] = [];
    returns.forEach((x) => {
      if (x.t >= t - c.windowS * 1000) back.push(x.at);
    });
    // The clusters are detected on half-second fixation medians (σ̂ ÷ √frames per block for ρ), not single frames;
    // on the frames themselves when the source is too sparse for blocks (a net run every few frames).
    const xs = all.map((s) => {
      const a = cfg.gazeSource === 'net' ? s.net : s.geo;
      return { t: s.t, a: a === null ? null : toDrv(a, r), w: s.w };
    });
    const fx = fixationMedians(xs, FIXATION_BLOCK_MS);
    let wAll = 0;
    for (const x of xs) if (x.a !== null) wAll += x.w;
    const opts = { sigma: sigmaHat, camera, cameraOffRoad: angularDistanceDeg(camera, headFwd) >= c.radiusMinDeg, returns: back };
    const ch =
      weightOf(fx.dirs) >= FIXATION_MIN_COVER * wAll
        ? chooseRoad(fx.dirs, { ...opts, rho: clusterRho(sigmaHat / Math.sqrt(fx.perBlock)), kernelDeg: FIXATION_KERNEL_DEG }, cfg)
        : chooseRoad(xs.filter((x) => x.a !== null).map((x) => ({ yaw: x.a!.yaw, pitch: x.a!.pitch, w: x.w })), opts, cfg);
    return ch === null || ch === 'wait' ? null : ch;
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
    const pickP = (s: Sample) => (primary === 'net' ? s.net : s.geo);
    // Task C9 (review-C9 S1-1): the two-cluster Stage 1. With a second cluster the road is chosen (the camera, the
    // mirrors, the higher pitch, the returns), its confidence excludes the other cluster's core, and everything the
    // pass takes (radius, σ̂, the other source, the head, EAR and MAR) comes from the frames on the road's side.
    const ch = stage1Choice(all, r, t);
    if (ch === null) return false;
    const onSide = (s: Sample) => {
      const a = pickP(s);
      return a === null || roadSide(toDrv(a, r), ch);
    };
    const road = ch.other === null ? all : all.filter(onSide);
    const roadDirs = (pick: (s: Sample) => AnglePair | null): WeightedDir[] => {
      const out: WeightedDir[] = [];
      for (const s of road) {
        const a = pick(s);
        if (a !== null) out.push({ ...toDrv(a, r), w: s.w });
      }
      return out;
    };
    const main1 = evaluateCluster(roadDirs(pickP), cfg);
    if (main1 === null) return false;
    // With a second cluster the road holds less of the window (40 % at a 60 % display) and the histogram mode's noise
    // grows (1.7° in S-WARM-NAV seed 33): the centre is located to convergence (C5's locate at max(4°, 2σ̂)) on the
    // road's side, its radius at most half the clusters' separation (on all the frames an 85 % display's tail pulls a
    // mean shift onto it).
    const main0 = ch.other === null ? main1 : { ...main1, mode: locate(roadDirs(pickP), main1.mode, Math.min(Math.max(LOCATE_MIN_R_DEG, 2 * sigmaHat), angularDistanceDeg(ch.road, ch.other) / 2)) };
    const share = ch.other === null ? main0.share : roadConfidence(dirs(pickP), { ...ch, road: main0.mode }, c.confidenceWithinDeg, clusterRho(sigmaHat));
    const main = { ...main0, share, passed: share >= c.confidenceMinShare };
    if (!main.passed) return false;
    // C8 round 2 (review-C8 R1-P): a pass that disagrees with a VERIFIED seed does not replace the centres (a first
    // minute spent on a display must not overwrite a profile fresh road evidence verified). Its EAR and MAR are taken
    // by the existing rules; the verification windows restart as a dispute against the pass centre.
    const seedNow = centres[primary];
    // Deviation (C8 round 2): an adopted profile still being verified, with no disagreeing window yet (not refuted),
    // is protected too: a navigation start ends at 40 s, the warm start matches at 45 s, and the first pass (60 s)
    // may come before the first agreeing window (S-WARM-NAV seed 34). A refuted (prev set) or other seed is replaced.
    const unrefutedProfile = seedUnverified && dual === null && seedCheck !== null && seedCheck.kind === 'profile' && seedCheck.disagreed !== true;
    if (state === 'seeded' && (!seedUnverified || unrefutedProfile) && seedNow !== null) {
      const pts = roadDirs(pickP).filter((d) => angularDistanceDeg(d, main.mode) <= main.radius);
      const my = pts.reduce((a, d) => a + d.yaw, 0) / Math.max(1, pts.length);
      const mp = pts.reduce((a, d) => a + d.pitch, 0) / Math.max(1, pts.length);
      const sdIn = pts.length > 1 ? Math.sqrt(pts.reduce((a, d) => a + (d.yaw - my) ** 2 + (d.pitch - mp) ** 2, 0) / (2 * pts.length)) : 0;
      const se = sdIn / Math.sqrt(Math.max(1, pts.length));
      if (angularDistanceDeg(main.mode, seedNow) > Math.max(c.seed.agreeMinDeg, c.seed.agreeSE * se)) {
        takePassEarMar(road);
        seedCheck = { kind: 'dispute', win: [], winW: 0, winObsS: 0, prev: null, pass: main.mode, agreeN: 0, unverifiedProfile: seedUnverified, admS: 0 };
        return false;
      }
    }
    centres[primary] = main.mode;
    const other: GazeSource = primary === 'net' ? 'geometric' : 'net';
    const o = evaluateCluster(roadDirs((s) => (other === 'net' ? s.net : s.geo)), cfg);
    centres[other] = o !== null && o.passed ? o.mode : null;
    const headDirs = roadDirs((s) => s.head);
    const headPeak = histogramMode(headDirs, cfg);
    centres.head = headPeak === null ? null : refineMode(headDirs, headPeak, cfg);
    radius = main.radius;
    roll = r;
    // Task C4: σ̂, the within-cluster SD of the primary source (the relative statistics' scale).
    const within = roadDirs(pickP).filter((d) => angularDistanceDeg(d, main.mode) <= main.radius);
    if (within.length >= 10) {
      const sdY = sd(within.map((d) => d.yaw));
      const sdP = sd(within.map((d) => d.pitch));
      sigmaHat = Math.max(1, Math.sqrt((sdY * sdY + sdP * sdP) / 2));
      sigmaMeasured = true;
    }
    seedUnverified = false;
    seedCheck = null;
    bgStage1 = false;
    dual = null;
    probation = null;
    takePassEarMar(road);
    state = 'calibrated';
    gate = { ...centres }; // Task C7: the gate references freeze at the pass
    emit('calibrated');
    return true;
  }

  /** A pass's EAR, MAR and mouth width (C8 round 2: also taken by a pass disputed against a verified seed). */
  function takePassEarMar(all: readonly Sample[]): void {
    let passEar: EarPair | null = null;
    if (!earFrozen) {
      const er = all.map((s) => s.earR).filter((x): x is number => x !== null);
      const el = all.map((s) => s.earL).filter((x): x is number => x !== null);
      if (er.length > 0 || el.length > 0) {
        passEar = { r: er.length > 0 ? refOf(er, 'r') : null, l: el.length > 0 ? refOf(el, 'l') : null };
        earFrozen = true;
        earCollector = null;
      }
    }
    const mars = all.map((s) => s.mar).filter((x): x is number => x !== null);
    if (mars.length > 0) {
      mar = Math.max(median(mars), c.neutralMarFloor);
      marVerified = mar;
    }
    // C7 round 4 (B): the first pass after a legacy profile lowers its EAR by at most legacyEarMaxLowerFrac.
    if (passEar !== null && legacyEar !== null) {
      const lg = legacyEar;
      const lim = (v: number | null, o: number | null) => (v === null || o === null ? v : Math.max(v, (1 - c.legacyEarMaxLowerFrac) * o));
      passEar = { r: lim(passEar.r, lg.r), l: lim(passEar.l, lg.l) };
    }
    legacyEar = null;
    // Task C6: the pass is a new reference for the baselines (the profile floor applies).
    if (passEar !== null) setEar(passEar, 'derive');
    const mws = all.map((s) => s.mouthW).filter((x): x is number => x !== null);
    if (mws.length > 0) mouthW = median(mws);
  }

  /** C8 round 2 (R1-P): a disputed pass discarded: Stage 1 collects a fresh window (the verified centres kept). */
  function restartPassWindow(): void {
    samples.clear();
    admittedS = 0;
    lastEvalT = null;
  }

  function finishComparison(cmp: Comparison): void {
    const after = signatureOf(cmp.samples);
    if (cmp.kind === 'warm') {
      const p = warmProfile;
      if (state === 'calibrated') {
        warmProfile = null;
        return; // a deferred warm start never overwrites a pass (T6 review m3)
      }
      if (p !== null && after !== null && lastRotation === p.orientation && compareSignatures(p.mount, after, cfg).match) {
        // C8 round 2 (review-C8 minor): a late match while a dual state, probation or provisional driver change is
        // running (a C2-seeded drive) waits until it ends: the retry continues, and matches again then.
        if (dual !== null || probation !== null || provisional !== null) return;
        warmProfile = null;
        applyProfile(p);
        return;
      }
      // C8 round 1 (review-C8 C8-1): a failed comparison retries on the next resumeCompareS of TRACKING (a driver
      // texting at the start fails the head-pose signature), until warmRetryS of moving time. A Stage 1 pass ends it
      // (above); a real mount change keeps failing and is never adopted.
      if (drivingS >= c.warmRetryS) warmProfile = null;
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

      if (p.quality === 'head_only' && !stopped && ctx !== null && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh && ear === null) eyesUnseenS += dt;
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
        sanity = ear !== null ? { trackingS: 0, values: [], r: [], l: [], mar: [], range: c.opennessRange, start: false } : null;
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

      // Task C6 (rev4 S4): the collectors take moving frames only (not STOPPED, at the admission speed).
      const moving = !stopped && ctx !== null && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh;
      if (moving) sigWindow.push(ms);
      if (p.headDrv !== null && moving) {
        pitchMovingS += dt;
        pitchRing.push({ t: f.tMs, pitch: p.headDrv.pitch });
        pitchRing.dropWhile((x) => x.t < f.tMs - c.runningMedianS * 1000);
        pitchMedianStale = true;
        pitchNowT = f.tMs;
      }

      // The openness sanity check after a resume (rev2 R1-m2).
      const ref = pitchReference();
      const relPitch = p.gazeRel?.pitch ?? p.headRel?.pitch ?? (p.headDrv !== null && ref !== null ? p.headDrv.pitch - ref : null);
      if (sanity !== null && moving && p.openness !== null && relPitch !== null && relPitch > c.opennessCheckMinRelPitchDeg) {
        sanity.values.push(p.openness);
        if (p.usableR && f.eyeR !== null) sanity.r.push(f.eyeR.ear);
        if (p.usableL && f.eyeL !== null) sanity.l.push(f.eyeL.ear);
        if (f.mouth != null && f.mouth.mar !== null) sanity.mar.push(f.mouth.mar);
        sanity.trackingS += dt;
        if (sanity.trackingS >= c.opennessCheckS) {
          const done = sanity;
          sanity = null;
          const m = median(done.values);
          if (m < done.range[0] || m > done.range[1]) baselineReset(done, m);
          // Task C8 (rev2 §2.2 item 3): at the start, the MAR is checked against startMarRange too.
          if (done.start && mar !== null && done.mar.length >= 10) {
            const mm = median(done.mar);
            const ratio = mm / mar;
            if (ratio < c.startMarRange[0] || ratio > c.startMarRange[1]) {
              mar = Math.max(mm, c.neutralMarFloor);
              marVerified = mar;
              baselines.setMar(mar, f.tMs);
              emit('baseline_reset');
            }
          }
        }
      }

      // The provisional EAR: p90 over 20 s of TRACKING within ±15° of the pitch reference.
      // Task C6: moving frames only (S4), and only frames with a usable eye count toward its 20 s (a lens that
      // hides the irises no longer completes it empty).
      const usableEye = (p.usableR && f.eyeR !== null) || (p.usableL && f.eyeL !== null);
      // (Its pitch filter uses the ring's median from the first moving sample: the 10 s rule is the gate's.)
      const earRef = ref ?? (pitchRing.size > 0 ? median(pitchRing.toArray().map((x) => x.pitch)) : null);
      if (earCollector !== null && moving && usableEye && p.headDrv !== null && earRef !== null && Math.abs(p.headDrv.pitch - earRef) <= c.provisionalEarWithinDeg) {
        if (p.usableR && f.eyeR !== null) earCollector.r.push(f.eyeR.ear);
        if (p.usableL && f.eyeL !== null) earCollector.l.push(f.eyeL.ear);
        earCollector.trackingS += dt;
        if (earCollector.trackingS >= c.provisionalEarS) {
          const col = earCollector;
          earCollector = null;
          if (col.r.length > 0 || col.l.length > 0) {
            setEar(
              {
                r: col.r.length > 0 ? refOf(col.r, 'r') : null,
                l: col.l.length > 0 ? refOf(col.l, 'l') : null,
              },
              'offer'
            );
          }
        }
      }

      // Task C6 (rev2 §2.3.4): the baselines. Moving, no episode; the reference follows up, and down only on an
      // explained appearance event; with no reference, eyes becoming usable give one (sunglasses off).
      const eyeIn = (e: EngineFrame['eyeR'], usable: boolean, reliable: boolean): EyeSample | null =>
        e === null ? null : { ear: e.ear, contrast: e.irisContrast, usable, reliable };
      const bo = baselines.step({
        tMs: f.tMs,
        dtS: dt,
        moving,
        tracking: true,
        hold: p.eyesClosed || p.closureBridged || stopped,
        headYaw: head.yaw,
        headPitchRel: p.headDrv !== null && ref !== null ? p.headDrv.pitch - ref : null,
        r: eyeIn(f.eyeR, p.usableR, p.reliableR),
        l: eyeIn(f.eyeL, p.usableL, p.reliableL),
        iodC: posture.compensate(ms).iodC,
        faceLuma: f.faceLuma,
        mar: f.mouth?.mar ?? null,
        fatigueGate,
        mayDerive: eyesUnseenS >= c.baselines.checkS,
      });
      if (provisional === null && bo.ear !== null && (earCollector === null || ear === null)) {
        if (ear === null) earCollector = null;
        ear = bo.ear;
      }
      if (bo.mar !== null) mar = bo.mar;

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
          if (out.step !== null && dual === null) {
            enterDual('step', null, Math.hypot(out.step.dBox.x, out.step.dBox.y), out.step.dIodFrac);
            slumpWatch = null; // Task C9: the translation explains the head's drop; it is no slump
          }
          if (out.slump && out.slumpFrom !== undefined) {
            slumpWatch ??= { from: out.slumpFrom, yawRef: centres.head?.yaw ?? null, observedS: 0, loweredS: 0, yawOkS: 0, gazeS: 0, onRoadS: 0 };
          }
          if (out.onset && dual === null && onsetLeftS <= 0) onsetLeftS = po.onsetWidenMaxS;
        }
        if (slumpWatch !== null) watchSlump(slumpWatch, ms, p, dt);
        if (onsetLeftS > 0) onsetLeftS = dual !== null ? 0 : Math.max(0, onsetLeftS - dt);
        if (dual !== null) evaluateDual(dt, ctx);
        else if (probation !== null) evaluateProbation(dt);
        // Task C5: the rolling and slow paths (calibrated, no dual state, no probation). Task C9 (T9, the display-free
        // S-2H-MANY's root cause): during probation the rolling path's SMALL follow runs too, so a slow drift is not left
        // unfollowed for the 300 s after every commit (the EMA barely moves at the geometric path's σ 4°); the large
        // follow and the slow path still wait for the probation's end.
        if (state === 'calibrated' && dual === null) {
          trackScanning(p);
          if (tNow - lastRollT >= c.rolling.everyS * 1000) evaluateRolling(probation !== null);
          applyFollow(dt);
        } else {
          follow = null;
          slowCand = null;
          // Task C9 (review-C9 S1-1 (d)): the mirror-check returns are tracked before the pass too (from the seed's
          // centre, or from the Stage 1 window's median direction), for the two-cluster return test.
          if (dual === null) trackScanning(p, centres[primary()] ?? stageRefNow());
        }
      }

      // Task C8 (rev2 §2.2): the seed verification windows (seed admission: ≥ 30 km/h, eyes open, straight or
      // gentle turn rates), while no dual state or probation is running.
      if (seedCheck !== null && !stopped && dt > 0) {
        if (dual !== null || probation !== null) {
          seedCheck.win = [];
          seedCheck.winW = 0;
          seedCheck.winObsS = 0;
        } else {
          seedCheck.winObsS += dt;
          const sv = c.seed;
          const rates = ctx === null ? [] : [ctx.yawRateDegS, ctx.courseRateDegS].filter((x): x is number => x !== null);
          const calm = ctx !== null && (ctx.straight === true || (rates.length > 0 && rates.every((x) => Math.abs(x) < sv.curveRateDegS)));
          const srcCam = cfg.gazeSource === 'net' ? (p.netFresh ? p.netCam : null) : p.geoCam;
          if (!p.eyesClosed && calm && ctx!.speedKmh !== null && ctx!.speedKmh >= sv.admitMinSpeedKmh) {
            seedCheck.win.push({ w: dt, g: srcCam === null ? null : toDrv(srcCam, roll), h: toDrv(head, roll) });
            seedCheck.winW += dt;
            if (seedCheck.kind === 'dispute') seedCheck.admS = (seedCheck.admS ?? 0) + dt;
          }
          if (seedCheck.winW >= sv.windowS) {
            evaluateSeedWindow(seedCheck);
            if (seedCheck !== null) {
              seedCheck.win = [];
              seedCheck.winW = 0;
              seedCheck.winObsS = 0;
            }
          } else if (seedCheck.winObsS >= sv.windowMaxObservedS) {
            // No window within the observed time: start again, and a pair of windows is no longer consecutive.
            seedCheck.win = [];
            seedCheck.winW = 0;
            seedCheck.winObsS = 0;
            seedCheck.prev = null;
          }
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
        if (tracked() && dual === null) emaQueue.push({ t: f.tMs, w: dt, head, geo: p.geoCam, net: p.netFresh ? p.netCam : null });
        // Task C9 (T9-2): the templates take the admitted directions in calibrated, non-dual time.
        if (state === 'calibrated' && dual === null) {
          if (p.geoCam !== null) tmpl.geometric.add(toDrv(p.geoCam, roll), dt, f.tMs);
          if (p.netFresh && p.netCam !== null) tmpl.net.add(toDrv(p.netCam, roll), dt, f.tMs);
          tmpl.head.add(toDrv(head, roll), dt, f.tMs);
        }
      }
      drainEma();
      evaluateIfDue();
    },

    state: () => state,
    dual: () => (dual === null || dual.c1 === null ? null : { gaze: dual.c1[cfg.gazeSource] ?? dual.c1.geometric, head: dual.c1.head }),
    // C4 round 2 (review-C4 R1-A): the engine applies this to the road-centre circle only. Task C5: a slow candidate too.
    // Task C9 (T9-3): a suspect centre widens the road-centre circle only (C4 round 2's posture widening), so a phone
    // read during a lean still warns.
    postureWidening: () => dual !== null || onsetLeftS > 0 || slowCand !== null || (seedUnverified && seedCheck?.kind === 'posture'),
    sigma: () => sigmaHat,
    eyesDegraded: () => baselines.eyesDegraded(),
    recalibrating: () => provisional !== null || (seedUnverified && seedCheck?.kind !== 'posture'),
    reason: () =>
      provisional !== null || (seedUnverified && (seedCheck?.kind === 'driver' || seedCheck?.kind === 'posture'))
        ? 'recalibrating'
        : seedUnverified
          ? 'seed_check'
          : dual !== null || probation !== null || onsetLeftS > 0 || slowCand !== null
            ? 'posture'
            : null,
    seedVerified: () => !seedUnverified,
    saveable: () => saveableNow(),
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
    earEvidence: () => baselines.lowUnexplained(),
    onYawn(tMs) {
      baselines.onYawn(tMs);
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
      gateGazeRef: gate?.[cfg.gazeSource] ?? null,
      gateGeoRef: gate?.geometric ?? null,
      gateHeadRef: gate?.head ?? null,
      // Task C7: the raw path is geometric; its σ̂ is Stage 1's when the primary source is geometric, else the default.
      rawSigmaDeg: cfg.gazeSource === 'geometric' ? sigmaHat : SIGMA_DEFAULT,
    }),
    gateRefs: () => (gate === null ? null : { ...gate }),
    stats: () => ({ drivingS, admittedS: Math.max(0, admittedS), postureIgnored, baselines: baselines.stats() }),
    drivingS: () => drivingS,
    drainEvents: () => events.splice(0, events.length),

    toProfile(savedAtMs, learnedZones = []) {
      const mount = sigWindow.signature();
      const primary = centres[cfg.gazeSource];
      // Task C8 (rev2 §2.7): calibrated or seed-verified, no dual state, probation or provisional driver change.
      const savedMar = marVerified ?? mar;
      if (!saveableNow() || primary === null || centres.head === null || radius === null || savedMar === null || mouthW === null || mount === null || lastRotation === null) {
        return null;
      }
      // The verified reference (the drive's as set, never a downward adaptation) and its appearance. C8 round 1
      // (C8-2): a reference only ever raised since it was set is saved as raised (a drowsy start's Stage 1 EAR).
      const r0 = baselines.savedReference();
      const savedEar = r0?.ear ?? ear;
      const app = r0?.appearance ?? null;
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
        openEyeEar: [savedEar?.r ?? null, savedEar?.l ?? null],
        neutralMar: savedMar,
        neutralMouthW: mouthW,
        learnedZones,
        savedAtMs,
        ...(app !== null && app.luma > 0 && app.iodC > 0 ? { earAppearance: { faceLuma: app.luma, iodC: app.iodC } } : {}),
        ...(sigmaMeasured ? { sigmaDeg: sigmaHat } : warmSigma !== null ? { sigmaDeg: warmSigma } : {}),
        earNoiseCorrected: true,
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
    if (state === 'calibrated' && !bgStage1) return;
    if (seedCheck !== null && seedCheck.kind === 'dispute') return; // C8 round 2: one dispute at a time
    if (drivingS >= c.firstEvalDrivingS && admittedS >= c.firstEvalAdmittedS && (lastEvalT === null || tNow - lastEvalT >= c.reevalEveryS * 1000)) {
      if (evaluate(tNow)) return;
    }
    // T9-3: a background Stage 1 (the centres suspect, still calibrated) never gives up the calibration.
    if (!gaveUp && state !== 'calibrated' && drivingS >= c.giveUpS) {
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
  // C7 round 4 (B): the noise-corrected P90, its noise from the window's own consecutive frames.
  const cap = c.baselines.earNoiseMaxSd;
  const tr = use.filter(({ frame: f, p }) => p.usableR && f.eyeR !== null).map(({ frame: f }) => f.tMs);
  const tl = use.filter(({ frame: f, p }) => p.usableL && f.eyeL !== null).map(({ frame: f }) => f.tMs);
  return {
    ok: true,
    seed: {
      gazeCentres: { geometric: med(geo), net: med(net) },
      headCentre: med(use.map(({ p }) => toDrv(p.headCam!)))!,
      rollOffsetDeg: roll,
      mount,
      orientation: use[use.length - 1]!.frame.rotationDeg,
      openEyeEar: { r: correctedRef(er, noiseOfSeries(tr, er, cap)), l: correctedRef(el, noiseOfSeries(tl, el, cap)) },
    },
  };
}
