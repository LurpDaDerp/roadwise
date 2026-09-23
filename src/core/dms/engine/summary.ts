// The trip summary (plan §M9) and the Tier 0 log (§M5 "Logged only"). Derived numbers only, JSON-safe (no
// NaN or Infinity: every ratio with no denominator is null). Pure and bounded.
//
// - Monitored seconds are seconds at a rule speed ≥ 20 km/h, by quality; the TRACKING coverage is their
//   TRACKING share.
// - Eyes-off-road seconds: at ≥ 20 km/h, with a zone that is not on-road (mirrors and the cluster count).
// - attentionScore (U-11, a proposed definition) = round(100 × on-road time / time with a zone), ≥ 20 km/h,
//   with attentionObservedShare = time with a zone / monitored time beside it; the score is null below 50 %
//   observed (T11 review m3: it must not imply it saw the whole trip).
// - cameraSession: `none` with nothing monitored; `good` with ≥ 10 min monitored, TRACKING ≥ 70 % of it
//   and ≥ 1 blink per 2 min of TRACKING (liveness against a photo); otherwise `limited`.
// - The longest non-driving glance, and the Tier 0 count of non-driving glances > 2.0 s (shoulder checks
//   aside: C-18 classes them as driving).
// - Tier 0 per minute: eyes-off-road seconds, the road-centre share and mirror checks; per trip, mirror
//   checks per minute at ≥ 50 km/h and "no scanning" episodes (gaze dispersion < 2° for ≥ 15 s at
//   ≥ 50 km/h, counted once per run).
// - Minutes per thermal level and per capture rate (the nearest allowed fps), the fatigue timeline with
//   its degraded, PERCLOS-dropped and sparse minutes (rev1 R-U4, m9), and the gaze source.
import type { AlertCounts, AlertKind, AlertStats } from './alerts';
import type { CalibrationEvent, CalibrationState } from './calibration';
import { zoneClass } from './zones';
import type { DmsConfig, ZoneId } from './config';
import type { FatigueMinute, FatigueStats, SignalName } from './fatigue';
import type { Glance } from './glances';
import type { Quality } from './quality';
import type { AnglePair, GazeSource } from './types';
import { RingBuffer } from './windows';
import { ALLOWED_FPS } from '../../../../modules/dms-vision/src/constants';

export interface SummaryFrame {
  tMs: number;
  dtS: number;
  ruleSpeedKmh: number | null;
  quality: Quality;
  /** the frame's zone; null without a direction */
  zone: ZoneId | null;
  gazeRel: AnglePair | null;
  /** the measured fps */
  fps: number;
  /** the native thermal level (0–3); null when unknown */
  thermalLevel: 0 | 1 | 2 | 3 | null;
}

export interface Tier0Minute {
  tMs: number;
  eyesOffRoadS: number;
  /** null without gaze time at speed */
  roadCentreShare: number | null;
  mirrorChecks: number;
}

export interface DmsTripSummary {
  v: 1;
  monitoredS: { tracking: number; head_only: number; lost: number; total: number };
  trackingCoverage: number | null;
  events: Record<string, number>;
  alerts: Record<AlertKind, AlertCounts>;
  /** rule 7 tags */
  nuisanceTags: number;
  longestNonDrivingGlance: { durS: number; zone: ZoneId } | null;
  eyesOffRoadS: number;
  tier0: { nonDrivingGlancesOver2s: number; mirrorChecksPerMin: number | null; noScanningEpisodes: number; minutes: Tier0Minute[] };
  fatigue: {
    timeline: Pick<FatigueMinute, 'tMs' | 'status' | 'score' | 'level' | 'degraded' | 'reason' | 'perclosDropped' | 'sparse'>[];
    degradedMinutes: FatigueStats['degradedMinutes'];
    perclosDroppedMinutes: number;
    sparseRowMinutes: Record<SignalName, number>;
  };
  thermalMinutes: Record<'0' | '1' | '2' | '3', number>;
  fpsMinutes: Record<string, number>;
  gazeSource: GazeSource;
  attentionScore: number | null;
  /** time with a zone / monitored time at ≥ 20 km/h; null with nothing monitored */
  attentionObservedShare: number | null;
  cameraSession: 'good' | 'limited' | 'none';
  calibration: { state: CalibrationState; bumps: number; driverChanges: number; events: CalibrationEvent[] };
}

/** attentionScore needs at least this share of monitored time with a zone (T11 review m3) */
const MIN_OBSERVED = 0.5;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function createSummary(cfg: DmsConfig, opts: { gazeSource: GazeSource }) {
  const g = cfg.glances;
  const monitoredMin = cfg.distraction.logOnlyBelowKmh;
  const monitored = { tracking: 0, head_only: 0, lost: 0 };
  let onRoadS = 0;
  let gazeS = 0;
  let offRoadS = 0;
  let blinks = 0;
  let lastSpeed: number | null = null;
  const events: Record<string, number> = {};
  let longest: { durS: number; zone: ZoneId } | null = null;
  let over2s = 0;
  let mirrorChecksFast = 0;
  let fastS = 0;
  let noScanning = 0;
  let inNoScan = false;
  const thermalS = { '0': 0, '1': 0, '2': 0, '3': 0 };
  const fpsS: Record<string, number> = {};
  const calEvents = new RingBuffer<CalibrationEvent>(64);
  let bumps = 0;
  let driverChanges = 0;
  // Tier 0 minutes.
  const minutes = new RingBuffer<Tier0Minute>(1440);
  let nextMinute: number | null = null;
  const cur = { offRoadS: 0, centreS: 0, gazeS: 0, mirrors: 0 };
  // "No scanning": the last noScanningS complete seconds of gaze sums.
  const secs = new RingBuffer<{ k: number; n: number; y: number; p: number; yy: number; pp: number; fast: boolean }>(Math.ceil(g.noScanningS) + 2);
  let sec: { k: number; n: number; y: number; p: number; yy: number; pp: number; fast: boolean } | null = null;

  const isMirror = (z: ZoneId) => z === 'rear_mirror' || z === 'driver_mirror' || z === 'passenger_mirror';

  function closeSecond(): void {
    if (sec === null) return;
    secs.push(sec);
    const need = Math.ceil(g.noScanningS);
    const arr = secs.toArray().slice(-need);
    let ok = arr.length === need && arr.every((s) => s.fast && s.n > 0) && arr[need - 1]!.k - arr[0]!.k === need - 1;
    if (ok) {
      let n = 0, y = 0, p = 0, yy = 0, pp = 0;
      for (const s of arr) {
        n += s.n;
        y += s.y;
        p += s.p;
        yy += s.yy;
        pp += s.pp;
      }
      const disp = Math.sqrt(Math.max(0, yy / n - (y / n) ** 2) + Math.max(0, pp / n - (p / n) ** 2));
      ok = disp < g.noScanningDispersionDeg;
    }
    if (ok && !inNoScan) noScanning++;
    inNoScan = ok;
  }

  return {
    onFrame(x: SummaryFrame): void {
      // A frame gap is unobserved time (T12 review I1): it counts 0.
      const dt = x.dtS > cfg.closure.maxFrameGapS ? 0 : Math.max(0, x.dtS);
      lastSpeed = x.ruleSpeedKmh;
      nextMinute ??= x.tMs + 60_000;
      if (x.tMs >= nextMinute - 1e-6) {
        minutes.push({ tMs: nextMinute, eyesOffRoadS: round3(cur.offRoadS), roadCentreShare: cur.gazeS > 0 ? round3(cur.centreS / cur.gazeS) : null, mirrorChecks: cur.mirrors });
        cur.offRoadS = cur.centreS = cur.gazeS = cur.mirrors = 0;
        nextMinute += 60_000;
      }
      if (x.thermalLevel !== null) thermalS[String(x.thermalLevel) as keyof typeof thermalS] += dt;
      if (x.fps > 0) {
        const nearest = ALLOWED_FPS.reduce((b, f) => (Math.abs(f - x.fps) < Math.abs(b - x.fps) ? f : b), ALLOWED_FPS[0]);
        fpsS[String(nearest)] = (fpsS[String(nearest)] ?? 0) + dt;
      }
      const atSpeed = x.ruleSpeedKmh !== null && x.ruleSpeedKmh >= monitoredMin;
      if (atSpeed) {
        monitored[x.quality] += dt;
        if (x.zone !== null) {
          gazeS += dt;
          cur.gazeS += dt;
          if (x.zone === 'road_centre') cur.centreS += dt;
          if (zoneClass(x.zone, cfg) === 'on_road') onRoadS += dt;
          else {
            offRoadS += dt;
            cur.offRoadS += dt;
          }
        }
      }
      const fast = x.ruleSpeedKmh !== null && x.ruleSpeedKmh >= g.noScanningMinSpeedKmh;
      if (fast) fastS += dt;
      const k = Math.floor(x.tMs / 1000);
      if (sec === null || sec.k !== k) {
        closeSecond();
        sec = { k, n: 0, y: 0, p: 0, yy: 0, pp: 0, fast: true };
      }
      sec.fast &&= fast;
      if (x.gazeRel !== null) {
        sec.n++;
        sec.y += x.gazeRel.yaw;
        sec.p += x.gazeRel.pitch;
        sec.yy += x.gazeRel.yaw ** 2;
        sec.pp += x.gazeRel.pitch ** 2;
      }
    },
    /** A finished glance (attention's glance_end). */
    onGlance(gl: Glance): void {
      if (isMirror(gl.zone)) {
        cur.mirrors++;
        if (lastSpeed !== null && lastSpeed >= g.mirrorRateMinSpeedKmh) mirrorChecksFast++;
      }
      if (gl.shoulderCheck || zoneClass(gl.zone, cfg) !== 'non_driving') return;
      if (gl.durS > g.logNonDrivingS) over2s++;
      if (longest === null || gl.durS > longest.durS) longest = { durS: round3(gl.durS), zone: gl.zone };
    },
    /** A finished blink (any fps): the liveness check; counted at a monitored speed. */
    onBlink(_tMs: number): void {
      if (lastSpeed !== null && lastSpeed >= monitoredMin) blinks++;
    },
    /** A rule or detector event, by name (d1_warning, microsleep, nod, yawn, …). */
    onEvent(kind: string): void {
      events[kind] = (events[kind] ?? 0) + 1;
    },
    onCalibration(e: CalibrationEvent): void {
      calEvents.push({ ...e });
      if (e.kind === 'camera_bump') bumps++;
      if (e.kind === 'driver_change') driverChanges++;
    },
    build(inp: { alerts: AlertStats; fatigue: FatigueStats; calibrationState: CalibrationState }): DmsTripSummary {
      const total = monitored.tracking + monitored.head_only + monitored.lost;
      const s = cfg.summary;
      const livenessOk = blinks >= (monitored.tracking / 120) * s.goodSessionMinBlinksPer2Min;
      const observed = total > 0 ? gazeS / total : null;
      const good = total >= s.goodSessionMinMonitoredS && monitored.tracking / total >= s.goodSessionMinTrackingShare && livenessOk;
      return {
        v: 1,
        monitoredS: { tracking: round3(monitored.tracking), head_only: round3(monitored.head_only), lost: round3(monitored.lost), total: round3(total) },
        trackingCoverage: total > 0 ? round3(monitored.tracking / total) : null,
        events: { ...events },
        alerts: inp.alerts.byKind,
        nuisanceTags: inp.alerts.log.filter((e) => e.tag === 'wrong').length,
        longestNonDrivingGlance: longest,
        eyesOffRoadS: round3(offRoadS),
        tier0: {
          nonDrivingGlancesOver2s: over2s,
          mirrorChecksPerMin: fastS >= 60 ? round3(mirrorChecksFast / (fastS / 60)) : null,
          noScanningEpisodes: noScanning,
          minutes: minutes.toArray(),
        },
        fatigue: {
          timeline: inp.fatigue.timeline.map((m) => ({ tMs: m.tMs, status: m.status, score: m.score, level: m.level, degraded: m.degraded, reason: m.reason, perclosDropped: m.perclosDropped, sparse: [...m.sparse] })),
          degradedMinutes: { ...inp.fatigue.degradedMinutes },
          perclosDroppedMinutes: inp.fatigue.perclosDroppedMinutes,
          sparseRowMinutes: { ...inp.fatigue.sparseRowMinutes },
        },
        thermalMinutes: { '0': round3(thermalS['0'] / 60), '1': round3(thermalS['1'] / 60), '2': round3(thermalS['2'] / 60), '3': round3(thermalS['3'] / 60) },
        fpsMinutes: Object.fromEntries(Object.entries(fpsS).map(([k, v]) => [k, round3(v / 60)])),
        gazeSource: opts.gazeSource,
        attentionScore: gazeS > 0 && observed !== null && observed >= MIN_OBSERVED - 1e-9 ? Math.round((100 * onRoadS) / gazeS) : null,
        attentionObservedShare: observed === null ? null : round3(observed),
        cameraSession: total <= 0 ? 'none' : good ? 'good' : 'limited',
        calibration: { state: inp.calibrationState, bumps, driverChanges, events: calEvents.toArray() },
      };
    },
  };
}
