// The zone map (plan §M4; spec "The zones built from the road centre"). Driver frame, relative to the
// road centre (positive yaw toward the passenger; RHD is handled by the driver frame itself, §M1).
// Classification is the first match in the config table's priority order, with:
// - hysteresis (2.5°): the current zone is kept while the sample is inside it expanded by the
//   hysteresis; a higher-priority zone takes over only once the sample is that far inside it;
// - widening (C-16): +5° per condition on the on-road zones, capped at +10°;
// - the junction and curve extensions of the forward road toward a turn of KNOWN sign (C-18);
// - learned mirror ellipses in place of the default rectangles once promoted (zoneLearning.ts);
// - LOST after a fast turn counts as far lateral for 5 s (C-8); any other LOST frame is occlusion (null).
// Pure.
import { angularDistanceDeg, relative, rollCorrect, toDriverFrame } from './angles';
import type { DmsConfig, ZoneClass, ZoneId, ZoneRegion, ZoneSpec } from './config';
import type { LearnedZone } from './profile';
import type { Quality } from './quality';
import type { AnglePair, DriverSide, VehicleContext } from './types';
import { RingBuffer } from './windows';

export type MirrorId = LearnedZone['id'];

/** A forward-road extension: toward +yaw (1), −yaw (−1) or none (0), by `deg`. */
export interface Extension {
  toward: -1 | 0 | 1;
  deg: number;
}

export interface ZoneContext {
  /** the calibrated road-centre radius; null before a pass or seed (the minimum radius is used) */
  radiusDeg: number | null;
  /** the camera's own direction relative to the centre (the phone-screen circle); null to skip it */
  cameraRel: AnglePair | null;
  /** total on-road widening, from `widening()` */
  widenDeg: number;
  extension: Extension;
  /** promoted learned mirrors */
  learned: Partial<Record<MirrorId, LearnedZone>>;
}

export function zoneClass(id: ZoneId, cfg: Pick<DmsConfig, 'zones'>): ZoneClass {
  return cfg.zones.table.find((z) => z.id === id)!.class;
}

/** C-16: +widenDeg per active condition, capped at widenCapDeg. */
export function widening(c: { uncalibrated: boolean; warmup: boolean; headOnly: boolean; resumeCheck: boolean }, cfg: Pick<DmsConfig, 'zones'>): number {
  const n = [c.uncalibrated, c.warmup, c.headOnly, c.resumeCheck].filter(Boolean).length;
  return Math.min(n * cfg.zones.widenDeg, cfg.zones.widenCapDeg);
}

/** The camera direction (0, 0 in the camera frame) in the driver frame, relative to the centre. */
export function cameraRel(centre: AnglePair, rollOffsetDeg: number, side: DriverSide): AnglePair {
  return relative(toDriverFrame(rollCorrect({ yaw: 0, pitch: 0 }, rollOffsetDeg), side), centre);
}

/**
 * The forward-road extension for this row. A right turn (turnSign +1) is +yaw in LHD and −yaw in RHD.
 * Junction: yaw rate > 8°/s below 40 km/h → 30°. Curve: yaw rate ≥ 2°/s for ≥ 3 rows at ≥ 40 km/h →
 * clamp((rate − 2)/6, 0, 1) × 15°. Both need a known turn sign; the larger applies.
 */
export function forwardExtension(ctx: VehicleContext, sustainedRows: number, side: DriverSide, cfg: Pick<DmsConfig, 'zones'>): Extension {
  const z = cfg.zones;
  if (ctx.turnSign === 0 || ctx.speedKmh === null || ctx.yawRateDegS === null) return { toward: 0, deg: 0 };
  const toward = (side === 'left' ? ctx.turnSign : -ctx.turnSign) as -1 | 1;
  let deg = 0;
  if (ctx.speedKmh < z.junctionMaxSpeedKmh && ctx.yawRateDegS > z.junctionMinYawRateDegS) deg = z.junctionExtendDeg;
  if (ctx.speedKmh >= z.curveMinSpeedKmh && ctx.yawRateDegS >= z.curveMinYawRateDegS && sustainedRows >= z.curveRows) {
    const k = Math.min(1, Math.max(0, (ctx.yawRateDegS - z.curveMinYawRateDegS) / z.curveRampDegS));
    deg = Math.max(deg, k * z.curveMaxExtendDeg);
  } else if (deg === 0) {
    return { toward: 0, deg: 0 };
  }
  return { toward, deg };
}

/** Counts the sustained curve rows (≥ curveMinYawRateDegS at ≥ curveMinSpeedKmh) and gives each row's extension. */
export function createTurnExtender(cfg: Pick<DmsConfig, 'zones'>, side: DriverSide) {
  let rows = 0;
  return {
    onRow(ctx: VehicleContext): Extension {
      const z = cfg.zones;
      const curving = ctx.speedKmh !== null && ctx.speedKmh >= z.curveMinSpeedKmh && ctx.yawRateDegS !== null && ctx.yawRateDegS >= z.curveMinYawRateDegS;
      rows = curving ? rows + 1 : 0;
      return forwardExtension(ctx, rows, side, cfg);
    },
    reset() {
      rows = 0;
    },
  };
}

/** Is `a` inside zone `z`, its region grown by `e` degrees (negative shrinks it)? */
function inside(zone: ZoneSpec, a: AnglePair, e: number, zc: ZoneContext, cfg: Pick<DmsConfig, 'zones' | 'calibration'>): boolean {
  const learned = zone.learnable ? zc.learned[zone.id as MirrorId] : undefined;
  if (learned !== undefined) {
    const hy = learned.halfYawDeg + e;
    const hp = learned.halfPitchDeg + e;
    if (hy <= 0 || hp <= 0) return false;
    const dy = (a.yaw - learned.yawDeg) / hy;
    const dp = (a.pitch - learned.pitchDeg) / hp;
    return dy * dy + dp * dp <= 1;
  }
  const r: ZoneRegion = zone.region;
  const onRoad = zone.class === 'on_road';
  const w = onRoad ? zc.widenDeg : 0;
  switch (r.kind) {
    case 'centre':
      return angularDistanceDeg(a, { yaw: 0, pitch: 0 }) <= (zc.radiusDeg ?? cfg.calibration.radiusMinDeg) + w + e;
    case 'camera':
      return zc.cameraRel !== null && angularDistanceDeg(a, zc.cameraRel) <= r.radiusDeg + e;
    case 'rect': {
      let [y0, y1] = r.yaw;
      if (zone.id === 'forward_road' && zc.extension.deg > 0) {
        if (zc.extension.toward > 0) y1 += zc.extension.deg;
        else if (zc.extension.toward < 0) y0 -= zc.extension.deg;
      }
      return a.yaw >= y0 - w - e && a.yaw <= y1 + w + e && a.pitch >= r.pitch[0] - w - e && a.pitch <= r.pitch[1] + w + e;
    }
    case 'below':
      return a.pitch <= r.maxPitchDeg + e && Math.abs(a.yaw) <= r.maxAbsYawDeg + e;
    case 'lateral':
      return Math.abs(a.yaw) > r.minAbsYawDeg - e;
    case 'rest':
      return true;
  }
}

/** The subset of a perceived frame the classifier needs. */
export interface ZoneInput {
  tMs: number;
  quality: Quality;
  gazeRel: AnglePair | null;
  headRel: AnglePair | null;
  headYawSpeedDegS: number | null;
}

export interface ZoneClassifier {
  /** Classifies an on-screen direction, with hysteresis against the previous result. */
  classify(rel: AnglePair, zc: ZoneContext): ZoneId;
  /** A whole frame: LOST handled per C-8 (far lateral, or null = occlusion); no direction → null. */
  step(p: ZoneInput, zc: ZoneContext): ZoneId | null;
  current(): ZoneId | null;
  reset(): void;
}

export function createZoneClassifier(cfg: Pick<DmsConfig, 'zones' | 'calibration'>): ZoneClassifier {
  const table = cfg.zones.table;
  const h = cfg.zones.hysteresisDeg;
  let current: ZoneId | null = null;
  const speeds = new RingBuffer<{ t: number; v: number }>(32);
  let lastHeadRelYaw: number | null = null;
  let lostSince: number | null = null;
  let lostFar = false;

  function classify(a: AnglePair, zc: ZoneContext): ZoneId {
    const cur = current === null || current === 'other' ? null : table.find((z) => z.id === current)!;
    if (cur !== null && inside(cur, a, h, zc, cfg)) {
      // Kept, unless a higher-priority zone is entered by at least the hysteresis.
      for (const z of table) {
        if (z === cur) break;
        if (inside(z, a, -h, zc, cfg)) return (current = z.id);
      }
      return cur.id;
    }
    for (const z of table) if (inside(z, a, 0, zc, cfg)) return (current = z.id);
    return (current = 'other');
  }

  return {
    classify,
    current: () => current,
    reset() {
      current = null;
      speeds.clear();
      lastHeadRelYaw = null;
      lostSince = null;
      lostFar = false;
    },
    step(p, zc) {
      if (p.quality === 'lost') {
        if (lostSince === null) {
          lostSince = p.tMs;
          let peak = 0;
          speeds.forEach((s) => {
            if (s.t >= p.tMs - cfg.zones.fastTurnWindowMs) peak = Math.max(peak, Math.abs(s.v));
          });
          lostFar = peak > cfg.zones.fastTurnDegS || (lastHeadRelYaw !== null && Math.abs(lastHeadRelYaw) > cfg.zones.lostLateralYawDeg);
        }
        current = null;
        return lostFar && p.tMs - lostSince <= cfg.zones.farLateralAfterTurnS * 1000 ? 'far_lateral' : null;
      }
      lostSince = null;
      lostFar = false;
      if (p.headYawSpeedDegS !== null) speeds.push({ t: p.tMs, v: p.headYawSpeedDegS });
      speeds.dropWhile((s) => s.t < p.tMs - cfg.zones.fastTurnWindowMs);
      lastHeadRelYaw = p.headRel?.yaw ?? lastHeadRelYaw;
      if (p.gazeRel === null) return null;
      return classify(p.gazeRel, zc);
    },
  };
}
