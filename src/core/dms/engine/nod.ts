// The head-nod detector (plan §M6, spec "Head-nod detector", C-15, rev1 I3). Relative head pitch (to the
// head centre, or the running-median reference before calibration): starting within ±5° of it, a drop of
// ≥ 15° within 1.0 s while openness < 0.5 (every frame of the drop with a known openness, T9 review m2),
// then a recovery with an upward pitch speed > 30°/s within 2.0 s of reaching the depth → `nod` (Tier 0,
// a fatigue signal). If openness < 0.15 was held ≥ 0.5 s during it and the car is at ≥ 20 km/h →
// `microsleep_nod` (Critical) instead. "During it" is the drop AND the recovery: C-15 means the closure
// around the nod, and the lids often stay shut until the head is back up (T9 review nit).
//
// C-26 (T9 review I1): the deepest nods lose the face. A gap of LOST or null-pitch frames of at most
// `recoverWithinS` during the drop or after the depth is survived; on reappearance the pitch speed is
// taken across the gap (the last pitch before it to the first after). The gap counts toward the
// openness hold only when the conditioner bridged the closure through it. A nod whose depth is never
// observed (the face lost before the drop reaches 15° and back near level on its return) goes unreported
// by design: the C-26 closure bridge in the conditioner, not this detector, is the Critical path there.
import type { DmsConfig } from './config';
import type { Quality } from './quality';

export interface NodInput {
  tMs: number;
  quality: Quality;
  /** head pitch relative to the reference, degrees; null when unknown */
  relPitchDeg: number | null;
  openness: number | null;
  ruleSpeedKmh: number | null;
  /** Perceived.closureBridged (C-26) */
  closureBridged?: boolean;
  /** Perceived.gap (T12 R1-m1): unobserved time never counts toward the deep-lid hold, unless bridged */
  gap?: boolean;
}

export interface NodEvent {
  kind: 'nod' | 'microsleep_nod';
  tMs: number;
}

interface Drop {
  from: { t: number; pitch: number };
  /** every known openness of the drop so far was < opennessBelow, and at least one was known */
  allLow: boolean;
  anyKnown: boolean;
  deepSince: number | null;
  deepMaxS: number;
  depthT: number | null;
}

export function createNodDetector(cfg: Pick<DmsConfig, 'nod'>) {
  const n = cfg.nod;
  /** the last frame at the level (within ±referenceWithinDeg), and its pitch */
  let level: { t: number; pitch: number } | null = null;
  let drop: Drop | null = null;
  /** the last frame with a pitch (kept across a survivable gap) */
  let prev: { t: number; pitch: number } | null = null;
  let gapSince: number | null = null;

  const clear = () => {
    level = null;
    drop = null;
    prev = null;
    gapSince = null;
  };

  return {
    reset: clear,
    onFrame(x: NodInput): NodEvent[] {
      const out: NodEvent[] = [];
      if (x.quality === 'lost' || x.relPitchDeg === null) {
        gapSince ??= x.tMs;
        if (drop === null || x.tMs - gapSince > n.recoverWithinS * 1000 + 1e-6) {
          clear();
          return out;
        }
        if (x.closureBridged !== true) drop.deepSince = null;
        else if (drop.deepSince !== null) drop.deepMaxS = Math.max(drop.deepMaxS, (x.tMs - drop.deepSince) / 1000);
        return out;
      }
      gapSince = null;
      if (x.gap === true && x.closureBridged !== true && drop !== null) drop.deepSince = null;
      const pitch = x.relPitchDeg;
      const speed = prev !== null && x.tMs > prev.t ? ((pitch - prev.pitch) * 1000) / (x.tMs - prev.t) : 0;
      prev = { t: x.tMs, pitch };

      if (Math.abs(pitch) <= n.referenceWithinDeg && (drop === null || drop.depthT === null)) {
        level = { t: x.tMs, pitch };
        drop = null;
        return out;
      }
      if (level === null) return out;
      drop ??= { from: level, allLow: true, anyKnown: false, deepSince: null, deepMaxS: 0, depthT: null };
      if (x.openness !== null) {
        if (drop.depthT === null) {
          drop.anyKnown = true;
          if (x.openness >= n.opennessBelow) drop.allLow = false;
        }
        if (x.openness < n.closureOpenness) drop.deepSince ??= x.tMs;
        else drop.deepSince = null;
        if (drop.deepSince !== null) drop.deepMaxS = Math.max(drop.deepMaxS, (x.tMs - drop.deepSince) / 1000);
      }
      if (drop.depthT === null) {
        if (drop.from.pitch - pitch >= n.dropDeg) {
          if (x.tMs - drop.from.t <= n.dropWithinS * 1000 && drop.anyKnown && drop.allLow) drop.depthT = x.tMs;
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
