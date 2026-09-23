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
import { rollCorrect, toDriverFrame } from './angles';
import type { ConditionerRefs, EarPair, Perceived } from './conditioning';
import type { DmsConfig } from './config';
import { SignatureWindow, StepBump, signatureOf, type MountSample } from './continuity';
import { evaluateCluster, histogramMode, refineMode, type WeightedDir } from './histogram';
import { compareSignatures, type DmsProfileV1, type LearnedZone, type MountSignature } from './profile';
import { median, quantile, sd } from './stats';
import type { AnglePair, DriverSide, EngineFrame, GazeSource, Rotation, VehicleContext } from './types';
import { RingBuffer } from './windows';

export type CalibrationState = 'none' | 'seeded' | 'calibrated' | 'provisional' | 'uncalibrated' | 'recalibrating';

export type CalibrationEventKind = 'calibrated' | 'provisional' | 'uncalibrated' | 'camera_bump' | 'driver_change' | 'baseline_reset' | 'warm_start';

export interface CalibrationEvent {
  kind: CalibrationEventKind;
  tMs: number;
  /** camera_bump only */
  cause?: 'step' | 'resume' | 'rotation';
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
  observe(f: EngineFrame, p: Perceived, ctx: VehicleContext | null): void;
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
  stats(): { drivingS: number; admittedS: number };
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

export function createCalibrator(cfg: DmsConfig, init: { driverSide: DriverSide; profile?: DmsProfileV1 | null; seed?: CalibrationSeed | null }): Calibrator {
  const c = cfg.calibration;
  const side = init.driverSide;
  const events: CalibrationEvent[] = [];
  const samples = new RingBuffer<Sample>(Math.ceil(c.windowS * MAX_FPS) + 1);
  const pitchRing = new RingBuffer<{ t: number; pitch: number }>(Math.ceil(c.runningMedianS * MAX_FPS) + 1);
  const sigWindow = new SignatureWindow(c.signatureS);
  const bump = new StepBump(cfg);

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
  let sanity: { trackingS: number; values: number[] } | null = null;
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

  function driverChange(): void {
    restartStage1();
    rederiveEar();
    mar = null;
    mouthW = null;
    pitchRing.clear();
    emit('driver_change');
  }

  function applySeed(seed: CalibrationSeed): void {
    centres.geometric = seed.gazeCentres.geometric;
    centres.net = seed.gazeCentres.net;
    centres.head = seed.headCentre;
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
    ear = { r: p.openEyeEar[0], l: p.openEyeEar[1] };
    earCollector = null;
    mar = p.neutralMar;
    mouthW = p.neutralMouthW;
    hasSeed = true;
    state = 'seeded';
    emit('warm_start');
  }

  function pitchReference(): number | null {
    if (centres.head !== null) return centres.head.pitch;
    if (pitchRing.size === 0) return null;
    return median(pitchRing.toArray().map((x) => x.pitch));
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
      if (p !== null && after !== null && lastRotation === p.orientation && compareSignatures(p.mount, after, cfg).match) applyProfile(p);
      return;
    }
    if (cmp.before === null || after === null) return;
    const r = compareSignatures(cmp.before, after, cfg);
    if (r.match) return;
    if (r.driverChange) driverChange();
    else cameraBump('resume');
  }

  if (init.seed) applySeed(init.seed);

  return {
    markGap(tMs) {
      tNow = tMs;
      gap = { before: sigWindow.signature() };
      sigWindow.clear();
      bump.clear();
      comparing = null;
      sanity = null;
    },

    applySeed,

    evaluate,

    observe(f, p, ctx) {
      tNow = f.tMs;
      const dt = Math.min(p.dtS, c.admitDtCapS);
      const tracking = p.quality === 'tracking' && p.headCam !== null && f.box !== null && f.iod !== null;

      // A rotation change mid-drive is a camera bump (rev2 R1-I1).
      if (p.quality !== 'lost') {
        if (lastRotation !== null && f.rotationDeg !== lastRotation) cameraBump('rotation');
        lastRotation = f.rotationDeg;
      }

      if (ctx !== null && ctx.speedKmh !== null && ctx.speedKmh >= c.admitMinSpeedKmh) drivingS += dt;

      if (!tracking) {
        evaluateIfDue();
        return;
      }
      const head = p.headCam!;
      const box = f.box!;
      const ms: MountSample = { t: f.tMs, yaw: head.yaw, pitch: head.pitch, roll: head.roll, cx: box.cx, cy: box.cy, iod: f.iod! };

      // A long SEARCH is a gap too (C-6), without markGap.
      if (gap === null && lastTrackingT !== null && f.tMs - lastTrackingT >= c.longSearchS * 1000) {
        gap = { before: sigWindow.signature() };
        sigWindow.clear();
        bump.clear();
      }
      lastTrackingT = f.tMs;

      // The first TRACKING frame after a gap starts the comparison and the openness sanity check.
      if (gap !== null) {
        comparing = { kind: 'resume', before: gap.before, samples: [], trackingS: 0 };
        sanity = ear !== null ? { trackingS: 0, values: [] } : null;
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
      }

      // The openness sanity check after a resume (rev2 R1-m2).
      const ref = pitchReference();
      const relPitch = p.gazeRel?.pitch ?? p.headRel?.pitch ?? (p.headDrv !== null && ref !== null ? p.headDrv.pitch - ref : null);
      if (sanity !== null && p.openness !== null && relPitch !== null && relPitch > c.opennessCheckMinRelPitchDeg) {
        sanity.values.push(p.openness);
        sanity.trackingS += dt;
        if (sanity.trackingS >= c.opennessCheckS) {
          const m = median(sanity.values);
          sanity = null;
          if (m < c.opennessRange[0] || m > c.opennessRange[1]) {
            ear = null;
            rederiveEar();
            emit('baseline_reset');
          }
        }
      }

      // The provisional EAR: p90 over 20 s of TRACKING within ±15° of the pitch reference.
      if (earCollector !== null && p.headDrv !== null && ref !== null && Math.abs(p.headDrv.pitch - ref) <= c.provisionalEarWithinDeg) {
        if (p.reliableR && f.eyeR !== null) earCollector.r.push(f.eyeR.ear);
        if (p.reliableL && f.eyeL !== null) earCollector.l.push(f.eyeL.ear);
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

      // The step-test bump (rev1 m5).
      if (bump.push(ms)) cameraBump('step');

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
          earR: p.reliableR && f.eyeR !== null ? f.eyeR.ear : null,
          earL: p.reliableL && f.eyeL !== null ? f.eyeL.ear : null,
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
        if (state === 'calibrated') ema(head, p, dt);
      }
      evaluateIfDue();
    },

    state: () => state,
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
      headCentre: centres.head,
      openEyeEar: ear,
      pitchReference: pitchReference(),
    }),
    stats: () => ({ drivingS, admittedS: Math.max(0, admittedS) }),
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
  const er = use.filter(({ frame: f, p }) => p.reliableR && f.eyeR !== null).map(({ frame: f }) => f.eyeR!.ear);
  const el = use.filter(({ frame: f, p }) => p.reliableL && f.eyeL !== null).map(({ frame: f }) => f.eyeL!.ear);
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
