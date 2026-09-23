// The head-nod detector (plan §M6, spec "Head-nod detector", C-15, rev1 I3). Relative head pitch (to the
// head centre, or the running-median reference before calibration): starting within ±5° of it, a drop of
// ≥ 15° within 1.0 s while openness < 0.5, then a recovery with an upward pitch speed > 30°/s within
// 2.0 s of reaching the depth → `nod` (Tier 0, a fatigue signal). If openness < 0.15 was held ≥ 0.5 s
// during it (C-15's gated closure) and the car is at ≥ 20 km/h → `microsleep_nod` (Critical) instead.
import type { DmsConfig } from './config';
import type { Quality } from './quality';

export interface NodInput {
  tMs: number;
  quality: Quality;
  /** head pitch relative to the reference, degrees; null when unknown */
  relPitchDeg: number | null;
  openness: number | null;
  ruleSpeedKmh: number | null;
}

export interface NodEvent {
  kind: 'nod' | 'microsleep_nod';
  tMs: number;
}

export function createNodDetector(cfg: Pick<DmsConfig, 'nod'>) {
  const n = cfg.nod;
  /** the last frame at the level (within ±referenceWithinDeg), and its pitch */
  let level: { t: number; pitch: number } | null = null;
  /** a drop under way from `level`: the lowest openness seen and the gated-closure run */
  let drop: { from: { t: number; pitch: number }; minOpen: number; deepSince: number | null; deepMaxS: number; depthT: number | null } | null = null;
  let prev: { t: number; pitch: number } | null = null;

  return {
    reset() {
      level = null;
      drop = null;
      prev = null;
    },
    onFrame(x: NodInput): NodEvent[] {
      const out: NodEvent[] = [];
      if (x.quality === 'lost' || x.relPitchDeg === null) {
        level = null;
        drop = null;
        prev = null;
        return out;
      }
      const pitch = x.relPitchDeg;
      const speed = prev !== null && x.tMs > prev.t ? ((pitch - prev.pitch) * 1000) / (x.tMs - prev.t) : 0;
      prev = { t: x.tMs, pitch };

      if (Math.abs(pitch) <= n.referenceWithinDeg && (drop === null || drop.depthT === null)) {
        level = { t: x.tMs, pitch };
        drop = null;
        return out;
      }
      if (level === null) return out;
      drop ??= { from: level, minOpen: Number.POSITIVE_INFINITY, deepSince: null, deepMaxS: 0, depthT: null };
      if (x.openness !== null) {
        drop.minOpen = Math.min(drop.minOpen, x.openness);
        if (x.openness < n.closureOpenness) drop.deepSince ??= x.tMs;
        else drop.deepSince = null;
        if (drop.deepSince !== null) drop.deepMaxS = Math.max(drop.deepMaxS, (x.tMs - drop.deepSince) / 1000);
      }
      if (drop.depthT === null) {
        if (drop.from.pitch - pitch >= n.dropDeg) {
          if (x.tMs - drop.from.t <= n.dropWithinS * 1000 && drop.minOpen < n.opennessBelow) drop.depthT = x.tMs;
          else {
            drop = null; // too slow, or the eyes were open: a glance, not a nod
            level = null;
          }
        }
        return out;
      }
      if (x.tMs - drop.depthT > n.recoverWithinS * 1000) {
        drop = null;
        level = null;
        return out;
      }
      if (speed > n.recoverDegS) {
        const micro = drop.deepMaxS >= n.closureHoldS - 1e-6 && (x.ruleSpeedKmh ?? 0) >= n.minSpeedKmh;
        out.push({ kind: micro ? 'microsleep_nod' : 'nod', tMs: x.tMs });
        drop = null;
        level = null;
      }
      return out;
    },
  };
}
