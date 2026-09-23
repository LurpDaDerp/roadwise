// The engine façade (plan Task 12): one frame in, every module stepped in order, commands and events out.
// Pure: the frame clock (`tMs`) and the epoch offset (from the 1 Hz rows) are the caller's.
//
// Per frame: quality → the conditioner (eye tiers, openness, closure, C-26 bridging; `Perceived` is the
// ONLY view the rules get, T6 r2 carry 1) → calibration (warm_start sets the zone learner's prior, T7 m4)
// → zones (widening, the turn extension, promoted mirrors) → zone learning → attention (D1–D4, glances)
// → the fast rules (F1–F4, blinks) → nods and yawns → fatigue → the alert manager → the summary.
//
// The request flags the alert manager requires (T11 I1/I2 and round 2) are set here from the events:
// F1/F2/microsleep_nod `bridged`; `unresponsive` from F3 (`closure` for its closure clause, `escalation`
// from the event) and from D4 (`escalation: true`); `c8` when a LOST frame's zone is C-8's far lateral.
//
// A frame gap (T12 review I1: `p.gap`, more than closure.maxFrameGapS since the last frame) is unobserved
// time: the dt given to attention (D1–D4, glances), the warm-up, fatigue and the summary is 0 on it, the
// yawn detector restarts, and the conditioner has already ended an unbridged closure.
//
// A drive owns its own alert manager, summary, fatigue and rule state (T11 r1 carry): `endDrive` stops
// every sound, builds the summary and the profile, then starts the next drive fresh, warm from that
// profile. Commands are merged with concat/spread only: the manager's empty array is frozen.
import { createAlertManager, LOG_CAP, type AlertLogEntry, type AlertRequest, type CameraOffCause, type DmsAlertCommand } from './alerts';
import { createAttention, distractionGates, type AttentionEvent } from './attention';
import { createCalibrator, seedFromFrames, type CalibrationEvent, type CalibrationState, type Calibrator, type SeedResult } from './calibration';
import { createConditioner, type GazeUse, type Perceived } from './conditioning';
import { validateDmsConfig, type DmsConfig, type ZoneId } from './config';
import { createContextTracker, type FeatureRowLike, type RowExtras } from './context';
import { createFpsMeter } from './eyes';
import { createFastRules, type FastEvent, type FatigueFloor } from './fastRules';
import { createFatigue, type FatigueLevel, type FatigueMinute } from './fatigue';
import { createNodDetector } from './nod';
import type { DmsProfileV1, LearnedZone } from './profile';
import { classifyQuality, type Quality } from './quality';
import { createSummary, type DmsTripSummary, type UnobservedCause } from './summary';
import type { DriverSide, EngineFrame, GazeSource, Sensitivity } from './types';
import { RingBuffer } from './windows';
import { createYawnDetector } from './yawn';
import { cameraRel, createTurnExtender, createZoneClassifier, widening, zoneClass, type Extension } from './zones';
import { createZoneLearner } from './zoneLearning';

export interface DmsEngineInit {
  driverSide: DriverSide;
  sensitivity: Sensitivity;
  alerts: 'live' | 'shadow';
  /** a stored profile (the controller loads it uid-bound); the calibrator warm-starts on a mount match */
  profile?: DmsProfileV1 | null;
  /** the capture policy's gazeNetEvery (1 or 2; T6 r1 carry) */
  gazeNetEvery?: 1 | 2;
}

/** What the host reports about the capture, read on every frame. */
export interface DmsHostState {
  /** the native thermal level (0–3); null when unknown */
  thermalLevel: 0 | 1 | 2 | 3 | null;
  /** the capture policy's SEARCH state (a face lost for long): D1 and D2 freeze */
  search: boolean;
  gazeNetEvery: 1 | 2;
  /**
   * final review I5: why the camera is off, as the host knows it (a policy pause, the gate closed). The
   * engine's own cameraOff / stopAlerts causes win for the stretch they start; with none, a stall.
   */
  offCause?: UnobservedCause | null;
}

/**
 * Final review m3 (and T16 r3 m1): the gaze a zone may be learned from, and fatigue's dispersion summed over:
 * a `gaze` source from the configured path only. Never a head, held or fallback direction.
 */
export function learnableGaze(p: Pick<Perceived, 'source' | 'gazeFrom' | 'gazeRel'>, gazeSource: GazeSource): Perceived['gazeRel'] {
  return p.source === 'gaze' && p.gazeFrom === gazeSource ? p.gazeRel : null;
}

export type DmsEvent =
  | { kind: AttentionEvent['kind']; tMs: number; zone?: ZoneId; durS?: number; shoulderCheck?: boolean }
  | { kind: Exclude<FastEvent['kind'], 'episode_end'>; tMs: number; bridged?: boolean; durMs?: number; long?: boolean }
  /** T14 r1 m2: a closure episode that reached F1–F3 ended; its measured length (not counted in the summary) */
  | { kind: 'episode_end'; tMs: number; durMs: number; bridged: boolean }
  | { kind: 'nod' | 'yawn'; tMs: number }
  /** T14 r2 R1-m2: the nod's deep-lid hold, seconds (its drowsiness sample) */
  | { kind: 'microsleep_nod'; tMs: number; deepMaxS: number }
  | { kind: CalibrationEvent['kind']; tMs: number }
  | { kind: 'fatigue_minute'; tMs: number; status: FatigueMinute['status']; score: number | null; level: FatigueLevel };

export interface DmsOutput {
  commands: readonly DmsAlertCommand[];
  events: readonly DmsEvent[];
}

export interface DmsSnapshot {
  tMs: number | null;
  quality: Quality | null;
  calibration: CalibrationState;
  zone: ZoneId | null;
  /** the last frame came after a frame gap (T12 review I1) */
  gap: boolean;
  /** the last frame is LOST because it is too dark (the policy's low-light suspend input, T13 r1 m1) */
  lostLowLight: boolean;
  /** the last frame's gaze source (gaze, held, head or none) */
  source: GazeUse | null;
  /** with a `gaze` source, which path gave it (the net, or the geometric path); null otherwise */
  gazeFrom: 'net' | 'geometric' | null;
  /** the last frame's closure time, ms (0 when the eyes are open): observed time only (final review round 2) */
  closedMs: number;
  /** the last frame's gaze relative to the road centre, degrees (the diagnostics agreement); null without one */
  gazeRel: { yaw: number; pitch: number } | null;
  /** the last frame's rule speed (known, or held under the tunnel rules) */
  ruleSpeedKmh: number | null;
  fps: number;
  bufferFraction: number;
  d2SumS: number;
  fatigueLevel: FatigueLevel;
  warmup: boolean;
  invariantViolations: number;
}

/** The lengths of the engine's growing buffers against their caps (the bounded-memory checks). */
export type DmsSizes = Record<'seedRing' | 'alertLog' | 'fatigueTimeline' | 'tier0Minutes' | 'calibrationEvents' | 'pendingEvents' | 'pendingCommands', { size: number; cap: number }>;

export interface DmsEngine {
  pushFrame(f: EngineFrame): void;
  /** A 1 Hz drive-sense row, applied at the frame-clock time `tMs` (the host maps its clocks). */
  pushRow(row: FeatureRowLike, ex: RowExtras, tMs: number): void;
  setHost(h: Partial<DmsHostState>): void;
  drain(): DmsOutput;
  snapshot(): DmsSnapshot;
  /** C2: seed from the last seconds of setup frames. */
  seedFromSetup(): SeedResult;
  tagLastAlert(tag: 'wrong'): boolean;
  summary(): DmsTripSummary;
  /** Ends the drive: stops every sound (the commands go to drain), returns its summary and profile, starts a fresh drive. */
  endDrive(tMs: number): { summary: DmsTripSummary; profile: DmsProfileV1 | null };
  /** For tests and diagnostics only: it builds a whole summary, so never call it per frame. */
  sizes(): DmsSizes;
  /** The drive's alert log (each request with the quality of the frame that raised it). */
  alertLog(): AlertLogEntry[];
  /**
   * The capture policy's cameraOff edge (thermal L3 or the low-light suspend at speed; T13 r1 I1): a
   * running distraction stops, a running Critical is kept (bounded by alerts.criticalBlindMaxS). Not a
   * session end: `endDrive` is.
   */
  cameraOff(tMs: number, cause: CameraOffCause): void;
  /**
   * T14 r1 I1: the privacy gate closed mid-drive (opt-out, a revoked permission, the role, the mode, the app
   * backgrounded): monitoring ended, so every sound stops now (`stopAll`). The drive goes on, and its history
   * (the summary, the alert log, the rule state) is kept. Not for the policy's own pauses: `stopped` ends a
   * Critical by its known speed, and heat or dark go through cameraOff.
   */
  stopAlerts(tMs: number): void;
}

const SEED_RING_S = 4;
/** drain() is called at least once per batch; this many undrained events or commands is a host bug */
const PENDING_CAP = 4096;
const MAX_FPS = 30;
const EMPTY_REQ: readonly AlertRequest[] = Object.freeze([]);

export function createDmsEngine(cfg: DmsConfig, init: DmsEngineInit): DmsEngine {
  // Final review m7: no caller (a test, the replay, a future host path) can run on an invalid config.
  const problems = validateDmsConfig(cfg);
  if (problems.length > 0) throw new Error(`DMS config: ${problems.join('; ')}`);
  const host: DmsHostState = { thermalLevel: null, search: false, gazeNetEvery: init.gazeNetEvery ?? 1 };
  const gazeSource: GazeSource = cfg.gazeSource;
  let profile: DmsProfileV1 | null = init.profile ?? null;
  let epochOffset = 0;
  let commands: readonly DmsAlertCommand[] = [];
  // An undrained host loses the oldest events, never grows (a ring: O(1) per event, T12 review nit).
  const events = new RingBuffer<DmsEvent>(PENDING_CAP);
  /** reused every frame (T12 review nit): the alert manager reads it synchronously and keeps no reference */
  const requests: AlertRequest[] = [];

  // The per-drive state.
  let d = newDrive();

  function newDrive() {
    const cal: Calibrator = createCalibrator(cfg, { driverSide: init.driverSide, profile });
    return {
      cal,
      cond: createConditioner(cfg),
      ctx: createContextTracker(cfg),
      turn: createTurnExtender(cfg, init.driverSide),
      extension: { toward: 0, deg: 0 } as Extension,
      zones: createZoneClassifier(cfg),
      learner: createZoneLearner(cfg, []),
      attention: createAttention(cfg, init.sensitivity),
      fast: createFastRules(cfg),
      nod: createNodDetector(cfg),
      yawn: createYawnDetector(cfg),
      fatigue: createFatigue(cfg),
      alerts: createAlertManager(cfg, { mode: init.alerts }),
      summary: createSummary(cfg, { gazeSource }),
      fps: createFpsMeter(cfg),
      seedRing: new RingBuffer<{ frame: EngineFrame; p: Perceived }>(SEED_RING_S * MAX_FPS + 2),
      drivingAt20S: 0,
      lastFrameT: null as number | null,
      lastQuality: null as Quality | null,
      lastZone: null as ZoneId | null,
      lastGap: false,
      lastLowLight: false,
      lastSource: null as GazeUse | null,
      lastGazeFrom: null as 'net' | 'geometric' | null,
      lastGazeRel: null as { yaw: number; pitch: number } | null,
      lastClosedMs: 0,
      lastSpeed: null as number | null,
      bufferFraction: 1,
      d2SumS: 0,
      fatigueLevel: 'none' as FatigueLevel,
      warmup: true,
      lastRowSpeed: null as number | null,
      /** the cause of the current frameless stretch, from cameraOff/stopAlerts (final review I5) */
      offCause: null as UnobservedCause | null,
      /** the last blind row tick (final review I5) */
      lastTickT: null as number | null,
    };
  }

  const emit = (e: DmsEvent) => {
    events.push(e);
    // episode_end restates an F event's episode for the scoring seam; the summary counts the F events.
    if (e.kind !== 'episode_end') d.summary.onEvent(e.kind);
  };
  const emitFast = (e: FastEvent) => {
    if (e.kind === 'episode_end') emit({ kind: 'episode_end', tMs: e.tMs, durMs: e.durMs ?? 0, bridged: e.bridged === true });
  };
  const addCommands = (c: readonly DmsAlertCommand[]) => {
    if (c.length > 0) commands = commands.concat(c).slice(-PENDING_CAP);
  };
  /** Runs an alert-manager step; if it ended the running Critical, F3's no-on-road watch ends with it. */
  const alertStep = (step: () => readonly DmsAlertCommand[]) => {
    const before = d.alerts.critical();
    addCommands(step());
    if (before !== null && d.alerts.critical() === null) d.fast.criticalEnded();
  };

  function onCalibrationEvents(): void {
    for (const e of d.cal.drainEvents()) {
      if (e.kind === 'warm_start' && profile !== null) d.learner.setPrior(profile.learnedZones);
      d.summary.onCalibration(e);
      emit({ kind: e.kind, tMs: e.tMs });
    }
  }

  function pushFrame(f: EngineFrame): void {
    const t = f.tMs;
    const epochMs = t + epochOffset;
    // Quality and the conditioner: `p` is the only view of quality the rules read (T6 r2 carry 1).
    const refs = { ...d.cal.refs(), gazeNetEvery: host.gazeNetEvery };
    const p = d.cond.step(f, classifyQuality(f, cfg), refs);
    // Unobserved time counts 0 (T12 review I1).
    const obsDt = p.gap ? 0 : p.dtS;
    if (p.gap) d.yawn.reset();
    d.seedRing.push({ frame: f, p });
    d.seedRing.dropWhile((x) => x.frame.tMs < t - SEED_RING_S * 1000);
    d.fps.push(t);
    const fps = d.fps.fps();
    const cs = d.ctx.at(t);
    const speed = cs.ruleSpeedKmh;
    d.cal.observe(f, p, cs.ctx);
    onCalibrationEvents();
    const calState = d.cal.state();
    // Warm-up (anti-annoyance 6): the first warmupS of driving at ≥ 20 km/h.
    if (speed !== null && speed >= cfg.distraction.logOnlyBelowKmh) d.drivingAt20S += obsDt;
    d.warmup = d.drivingAt20S < cfg.calibration.warmupS;

    // Zones.
    const centre = refs.gazeCentre ?? refs.headCentre;
    const zc = {
      radiusDeg: d.cal.radius(),
      cameraRel: centre === null ? null : cameraRel(centre, d.cal.rollOffset(), init.driverSide),
      widenDeg: widening({ uncalibrated: calState !== 'calibrated' && calState !== 'seeded', warmup: d.warmup, headOnly: p.quality === 'head_only' || p.marginDeg > 0, resumeCheck: d.cal.resumeChecking() }, cfg),
      extension: d.extension,
      learned: d.learner.promoted(),
    };
    const zone = d.zones.step(p, zc);
    d.lastZone = zone;
    d.lastGap = p.gap;
    d.lastLowLight = p.quality === 'lost' && p.reasons.includes('low_light');
    d.lastQuality = p.quality;
    d.lastSource = p.source;
    d.lastGazeFrom = p.gazeFrom;
    d.lastClosedMs = p.closedMs;
    d.lastGazeRel = p.gazeRel === null ? null : { yaw: p.gazeRel.yaw, pitch: p.gazeRel.pitch };
    d.lastSpeed = speed;
    // Zones are learned in the configured path's coordinates only (T16 r3 m1): a net configuration's geometric
    // fallback frames (another gain, another centre) would blur the mirror clusters. Held and head frames are
    // unchanged; the geometric configuration never has a fallback.
    const learnRel = learnableGaze(p, gazeSource);
    d.learner.observe(t, learnRel, zone, calState === 'calibrated');
    d.learner.maybeCluster(d.cal.drivingS());
    const onRoad = zone !== null && zoneClass(zone, cfg) === 'on_road';
    const c8 = p.quality === 'lost' && zone === 'far_lateral';

    requests.length = 0;
    // Attention (D1–D4, glances).
    const gates = distractionGates({
      hasCentre: refs.headCentre !== null,
      warmup: d.warmup,
      calibState: calState,
      resumeCheck: d.cal.resumeChecking(),
      fpsOk: fps >= cfg.distraction.gazeRulesMinFps,
      imuAbsentHold: cs.imuAbsentHold,
    });
    const att = d.attention.onFrame({
      tMs: t,
      dtS: obsDt,
      zone,
      headYawSpeedDegS: p.headYawSpeedDegS,
      ruleSpeedKmh: speed,
      speedKnown: cs.speedKnown,
      freeze: host.search || (cs.ctx?.handling ?? false),
      gates,
    });
    d.bufferFraction = att.bufferFraction;
    d.d2SumS = att.d2SumS;
    for (const e of att.events) {
      if (e.kind === 'glance_end' && e.glance !== undefined) d.summary.onGlance(e.glance);
      emit({ kind: e.kind, tMs: e.tMs, zone: e.zone, durS: e.glance?.durS, shoulderCheck: e.glance?.shoulderCheck });
      if (e.kind === 'd1_warning') requests.push({ kind: 'distraction', c8 });
      else if (e.kind === 'd2_warning') requests.push({ kind: 'cumulative', c8 });
      else if (e.kind === 'd3_phone_pattern') requests.push({ kind: 'phone_pattern' });
      else if (e.kind === 'd4_unresponsive') {
        requests.push({ kind: 'unresponsive', closure: false, bridged: false, c8, escalation: true });
        d.fast.criticalStarted();
      }
    }

    // The fast rules (F1–F4, blinks). With no zone (before calibration, or occluded) the direction is
    // unknown: null neither clears nor feeds F3's no-on-road watch.
    const onRoadGaze = zone === null ? null : onRoad && !p.eyesClosed;
    for (const e of d.fast.onFrame({ p, ruleSpeedKmh: speed, onRoadGaze, fps }).events) {
      const bridged = e.bridged === true;
      if (e.kind === 'episode_end') {
        emitFast(e);
        continue;
      }
      if (e.kind === 'blink') {
        d.fatigue.onBlink({ tMs: e.tMs, durMs: e.durMs ?? 0, long: e.long === true, counted: e.counted === true });
        d.summary.onBlink(e.tMs);
        emit({ kind: 'blink', tMs: e.tMs, durMs: e.durMs, long: e.long });
        continue;
      }
      emit({ kind: e.kind, tMs: e.tMs, bridged });
      if (e.kind === 'microsleep' || e.kind === 'sleep') requests.push({ kind: e.kind, bridged });
      else requests.push({ kind: 'unresponsive', closure: e.clause === 'closure', bridged, c8, escalation: e.escalation === true });
    }

    // Nods (relative pitch as the conditioner defines it) and yawns.
    const relPitch = p.headRel !== null ? p.headRel.pitch : p.headDrv !== null && refs.pitchReference !== null ? p.headDrv.pitch - refs.pitchReference : null;
    for (const e of d.nod.onFrame({ tMs: t, quality: p.quality, relPitchDeg: relPitch, openness: p.openness, ruleSpeedKmh: speed, closureBridged: p.closureBridged, gap: p.gap })) {
      emit(e.kind === 'microsleep_nod' ? { kind: 'microsleep_nod', tMs: e.tMs, deepMaxS: e.deepMaxS ?? 0 } : { kind: 'nod', tMs: e.tMs });
      d.fatigue.onNod(e.tMs);
      if (e.kind === 'microsleep_nod') {
        requests.push({ kind: 'microsleep_nod', bridged: p.closureBridged });
        d.fast.criticalStarted();
      }
    }
    for (const e of d.yawn.onFrame({ tMs: t, quality: p.quality, mar: f.mouth?.mar ?? null, mouthW: f.mouth?.widthIod ?? null, neutralMar: d.cal.neutralMar(), neutralMouthW: d.cal.neutralMouthW(), fps })) {
      emit({ kind: 'yawn', tMs: e.tMs });
      d.fatigue.onYawn(e.tMs);
    }

    // Fatigue (T10 feeds).
    const floor: FatigueFloor = d.fast.fatigueFloor(t);
    const minute = d.fatigue.onFrame({
      tMs: t,
      dtS: obsDt,
      quality: p.quality,
      closureBridged: p.closureBridged,
      openness: p.openness,
      lookingDown: p.lookingDown,
      gazeRel: learnRel,
      gazeFrom: p.gazeFrom,
      speedKmh: speed,
      fps,
      hot: host.thermalLevel !== null && host.thermalLevel >= 1,
      tripElapsedS: cs.ctx?.tripElapsedS ?? 0,
      localMinutes: cs.ctx?.localMinutes ?? null,
      floor,
    });
    if (minute !== null) {
      d.fatigueLevel = minute.level;
      emit({ kind: 'fatigue_minute', tMs: minute.tMs, status: minute.status, score: minute.score, level: minute.level });
      for (const a of minute.actions) requests.push({ kind: a.kind });
    }

    // The alert manager, then the summary.
    alertStep(() =>
      d.alerts.onFrame({
        tMs: t,
        epochMs,
        ruleSpeedKmh: speed,
        speedKnown: cs.speedKnown,
        quality: p.quality,
        onRoad,
        eyesOpen: p.quality === 'tracking' && !p.eyesClosed,
        warmup: d.warmup,
        requests: requests.length > 0 ? requests : EMPTY_REQ,
        gap: p.gap,
      })
    );
    d.summary.onFrame({ tMs: t, dtS: obsDt, ruleSpeedKmh: speed, quality: p.quality, zone, gazeRel: p.gazeRel, fps, thermalLevel: host.thermalLevel, gazeFrom: p.gazeFrom });
    d.lastFrameT = t;
    d.offCause = null;
    d.lastTickT = null;
  }

  return {
    pushFrame,

    pushRow(row, ex, tMs) {
      epochOffset = row.ts - tMs;
      const ctx = d.ctx.onRow(row, tMs, ex);
      d.extension = d.turn.onRow(ctx);
      // No frame for a row period (the camera off, stalled or paused): tick the alert manager as LOST, so a
      // running Critical still ends on a known low speed (T11 r1 m1 carry), and is capped from the LAST FRAME
      // (final review I2: blindSinceMs). The stretch also reaches the summary (final review I5) and D4's
      // known-low clear (final review m5).
      if (d.lastFrameT === null || tMs - d.lastFrameT >= cfg.context.rowTickMs) {
        const cs = d.ctx.at(tMs);
        alertStep(() =>
          d.alerts.onFrame({
            tMs,
            epochMs: tMs + epochOffset,
            ruleSpeedKmh: cs.ruleSpeedKmh,
            speedKnown: cs.speedKnown,
            quality: 'lost',
            onRoad: false,
            eyesOpen: false,
            warmup: d.warmup,
            requests: EMPTY_REQ,
            blind: true,
            ...(d.lastFrameT === null ? {} : { blindSinceMs: d.lastFrameT }),
          })
        );
        d.attention.rowTick(tMs, cs.speedKnown, cs.ruleSpeedKmh);
        const from = Math.max(d.lastFrameT ?? Number.NEGATIVE_INFINITY, d.lastTickT ?? Number.NEGATIVE_INFINITY);
        if (Number.isFinite(from) && tMs > from) d.summary.onUnobserved((tMs - from) / 1000, d.offCause ?? host.offCause ?? 'stall', host.thermalLevel, cs.ruleSpeedKmh);
        d.lastTickT = tMs;
      }
    },

    setHost(h) {
      Object.assign(host, h);
    },

    drain() {
      const out: DmsOutput = { commands, events: events.toArray() };
      commands = [];
      events.clear();
      return out;
    },

    snapshot() {
      return {
        tMs: d.lastFrameT,
        quality: d.lastQuality,
        calibration: d.cal.state(),
        zone: d.lastZone,
        gap: d.lastGap,
        lostLowLight: d.lastLowLight,
        source: d.lastSource,
        gazeFrom: d.lastGazeFrom,
        gazeRel: d.lastGazeRel,
        closedMs: d.lastClosedMs,
        ruleSpeedKmh: d.lastSpeed,
        fps: d.fps.fps(),
        bufferFraction: d.bufferFraction,
        d2SumS: d.d2SumS,
        fatigueLevel: d.fatigueLevel,
        warmup: d.warmup,
        invariantViolations: d.alerts.violations(),
      };
    },

    seedFromSetup() {
      const r = seedFromFrames(d.seedRing.toArray(), cfg, init.driverSide);
      if (r.ok) {
        d.cal.applySeed(r.seed);
        onCalibrationEvents();
      }
      return r;
    },

    tagLastAlert(tag) {
      return d.alerts.tagLastAlert(tag);
    },

    summary() {
      return d.summary.build({ alerts: d.alerts.stats(), fatigue: d.fatigue.stats(), calibrationState: d.cal.state() });
    },

    endDrive(tMs) {
      for (const e of d.fast.flush()) emitFast(e); // an F episode still open ends with the drive
      addCommands(d.alerts.stopAll(tMs, tMs + epochOffset));
      const summary = d.summary.build({ alerts: d.alerts.stats(), fatigue: d.fatigue.stats(), calibrationState: d.cal.state() });
      const learned: LearnedZone[] = d.learner.endDrive();
      const next = d.cal.toProfile(tMs + epochOffset, learned);
      if (next !== null) profile = next;
      d = newDrive();
      return { summary, profile: next };
    },

    cameraOff(tMs, cause) {
      alertStep(() => d.alerts.cameraOff(tMs, tMs + epochOffset, cause));
      d.attention.clearEscalation(); // final review m5
      d.offCause = cause;
    },

    stopAlerts(tMs) {
      alertStep(() => d.alerts.stopAll(tMs, tMs + epochOffset));
      d.attention.clearEscalation(); // final review m5
      d.offCause = 'gate';
    },

    alertLog() {
      return d.alerts.stats().log;
    },

    sizes() {
      const a = d.alerts.stats();
      const f = d.fatigue.stats();
      const s = d.summary.build({ alerts: a, fatigue: f, calibrationState: d.cal.state() });
      return {
        seedRing: { size: d.seedRing.size, cap: d.seedRing.capacity },
        alertLog: { size: a.log.length, cap: LOG_CAP },
        fatigueTimeline: { size: f.timeline.length, cap: 1440 },
        tier0Minutes: { size: s.tier0.minutes.length, cap: 1440 },
        calibrationEvents: { size: s.calibration.events.length, cap: 64 },
        pendingEvents: { size: events.size, cap: PENDING_CAP },
        pendingCommands: { size: commands.length, cap: PENDING_CAP },
      };
    },
  };
}
