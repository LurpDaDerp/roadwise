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
// A drive owns its own alert manager, summary, fatigue and rule state (T11 r1 carry): `endDrive` stops
// every sound, builds the summary and the profile, then starts the next drive fresh, warm from that
// profile. Commands are merged with concat/spread only: the manager's empty array is frozen.
import { createAlertManager, type AlertRequest, type DmsAlertCommand } from './alerts';
import { createAttention, distractionGates, type AttentionEvent } from './attention';
import { createCalibrator, seedFromFrames, type CalibrationEvent, type CalibrationState, type Calibrator, type SeedResult } from './calibration';
import { createConditioner, type GazeUse, type Perceived } from './conditioning';
import type { DmsConfig, ZoneId } from './config';
import { createContextTracker, type FeatureRowLike, type RowExtras } from './context';
import { createFpsMeter } from './eyes';
import { createFastRules, type FastEvent, type FatigueFloor } from './fastRules';
import { createFatigue, type FatigueLevel, type FatigueMinute } from './fatigue';
import { createNodDetector, type NodEvent } from './nod';
import type { DmsProfileV1, LearnedZone } from './profile';
import { classifyQuality, type Quality } from './quality';
import { createSummary, type DmsTripSummary } from './summary';
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
}

export type DmsEvent =
  | { kind: AttentionEvent['kind']; tMs: number; zone?: ZoneId; durS?: number }
  | { kind: FastEvent['kind']; tMs: number; bridged?: boolean; durMs?: number; long?: boolean }
  | { kind: NodEvent['kind'] | 'yawn'; tMs: number }
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
  /** the last frame's gaze source (gaze, held, head or none) */
  source: GazeUse | null;
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
  sizes(): DmsSizes;
}

const SEED_RING_S = 4;
/** drain() is called at least once per batch; this many undrained events or commands is a host bug */
const PENDING_CAP = 4096;
const MAX_FPS = 30;
const EMPTY_REQ: readonly AlertRequest[] = Object.freeze([]);

export function createDmsEngine(cfg: DmsConfig, init: DmsEngineInit): DmsEngine {
  const host: DmsHostState = { thermalLevel: null, search: false, gazeNetEvery: init.gazeNetEvery ?? 1 };
  const gazeSource: GazeSource = cfg.gazeSource;
  let profile: DmsProfileV1 | null = init.profile ?? null;
  let epochOffset = 0;
  let commands: readonly DmsAlertCommand[] = [];
  let events: DmsEvent[] = [];

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
      lastSource: null as GazeUse | null,
      lastSpeed: null as number | null,
      bufferFraction: 1,
      d2SumS: 0,
      fatigueLevel: 'none' as FatigueLevel,
      warmup: true,
      lastRowSpeed: null as number | null,
    };
  }

  const emit = (e: DmsEvent) => {
    if (events.length >= PENDING_CAP) events.shift(); // an undrained host loses the oldest, never grows
    events.push(e);
    d.summary.onEvent(e.kind);
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
    if (speed !== null && speed >= cfg.distraction.logOnlyBelowKmh) d.drivingAt20S += p.dtS;
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
    d.lastQuality = p.quality;
    d.lastSource = p.source;
    d.lastSpeed = speed;
    d.learner.observe(t, p.gazeRel, zone, calState === 'calibrated');
    d.learner.maybeCluster(d.cal.stats().drivingS);
    const onRoad = zone !== null && zoneClass(zone, cfg) === 'on_road';
    const c8 = p.quality === 'lost' && zone === 'far_lateral';

    const requests: AlertRequest[] = [];
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
      dtS: p.dtS,
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
      emit({ kind: e.kind, tMs: e.tMs, zone: e.zone, durS: e.glance?.durS });
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
    for (const e of d.fast.onFrame({ p, ruleSpeedKmh: speed, onRoadGaze }).events) {
      const bridged = e.bridged === true;
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
    for (const e of d.nod.onFrame({ tMs: t, quality: p.quality, relPitchDeg: relPitch, openness: p.openness, ruleSpeedKmh: speed, closureBridged: p.closureBridged })) {
      emit({ kind: e.kind, tMs: e.tMs });
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
      dtS: p.dtS,
      quality: p.quality,
      closureBridged: p.closureBridged,
      openness: p.openness,
      lookingDown: p.lookingDown,
      gazeRel: p.gazeRel,
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
      })
    );
    d.summary.onFrame({ tMs: t, dtS: p.dtS, ruleSpeedKmh: speed, quality: p.quality, zone, gazeRel: p.gazeRel, fps, thermalLevel: host.thermalLevel });
    d.lastFrameT = t;
  }

  return {
    pushFrame,

    pushRow(row, ex, tMs) {
      epochOffset = row.ts - tMs;
      const ctx = d.ctx.onRow(row, tMs, ex);
      d.extension = d.turn.onRow(ctx);
      // The camera is off (thermal L3, SEARCH without frames): tick the alert manager as LOST, so a
      // running Critical still ends on a known low speed (T11 r1 m1 carry).
      if (d.lastFrameT === null || tMs - d.lastFrameT >= 1000) {
        const cs = d.ctx.at(tMs);
        alertStep(() =>
          d.alerts.onFrame({ tMs, epochMs: tMs + epochOffset, ruleSpeedKmh: cs.ruleSpeedKmh, speedKnown: cs.speedKnown, quality: 'lost', onRoad: false, eyesOpen: false, warmup: d.warmup, requests: EMPTY_REQ })
        );
      }
    },

    setHost(h) {
      Object.assign(host, h);
    },

    drain() {
      const out: DmsOutput = { commands, events };
      commands = [];
      events = [];
      return out;
    },

    snapshot() {
      return {
        tMs: d.lastFrameT,
        quality: d.lastQuality,
        calibration: d.cal.state(),
        zone: d.lastZone,
        source: d.lastSource,
        ruleSpeedKmh: d.lastSpeed,
        fps: d.fps.fps(),
        bufferFraction: d.bufferFraction,
        d2SumS: d.d2SumS,
        fatigueLevel: d.fatigueLevel,
        warmup: d.warmup,
        invariantViolations: d.alerts.stats().invariantViolations,
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
      addCommands(d.alerts.stopAll(tMs, tMs + epochOffset));
      const summary = d.summary.build({ alerts: d.alerts.stats(), fatigue: d.fatigue.stats(), calibrationState: d.cal.state() });
      const learned: LearnedZone[] = d.learner.endDrive();
      const next = d.cal.toProfile(tMs + epochOffset, learned);
      if (next !== null) profile = next;
      d = newDrive();
      return { summary, profile: next };
    },

    sizes() {
      const a = d.alerts.stats();
      const f = d.fatigue.stats();
      const s = d.summary.build({ alerts: a, fatigue: f, calibrationState: d.cal.state() });
      return {
        seedRing: { size: d.seedRing.size, cap: d.seedRing.capacity },
        alertLog: { size: a.log.length, cap: 1024 },
        fatigueTimeline: { size: f.timeline.length, cap: 1440 },
        tier0Minutes: { size: s.tier0.minutes.length, cap: 1440 },
        calibrationEvents: { size: s.calibration.events.length, cap: 64 },
        pendingEvents: { size: events.length, cap: PENDING_CAP },
        pendingCommands: { size: commands.length, cap: PENDING_CAP },
      };
    },
  };
}
