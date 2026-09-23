// Zone learning (plan §M4; spec "Zone learning"). Off-road fixations while calibrated (≤ 2° dispersion
// for ≥ 200 ms, at most 600 per drive), DBSCAN over their centroids every 5 min of driving (ε 3°,
// minPts 5), mirror candidates (median fixation < 1 s, centroid within 10° of a default mirror), and a
// per-mount record across drives (the profile's `learnedZones`; profiles are per mount signature): a
// candidate seen in ≥ 3 drives replaces that mirror's rectangle with an ellipse, centroid ± 2σ per axis,
// half-widths ≥ 4°. Pure; every buffer is bounded.
import type { DmsConfig, ZoneId } from './config';
import { distanceToDefault, learnedZoneWithinBounds, type LearnedZone } from './profile';
import { median, sd } from './stats';
import type { AnglePair } from './types';
import type { MirrorId } from './zones';

interface Fixation {
  yaw: number;
  pitch: number;
  durMs: number;
}

export interface MirrorCandidate {
  id: MirrorId;
  yaw: number;
  pitch: number;
  halfYawDeg: number;
  halfPitchDeg: number;
  count: number;
}

const MIRRORS: MirrorId[] = ['rear_mirror', 'driver_mirror', 'passenger_mirror'];

/**
 * DBSCAN on directions (planar degrees). Labels: cluster index ≥ 0, or −1 for noise. The expansion
 * queue is walked with a head index, and a point is labelled when it is enqueued, so none is queued
 * twice: memory ≤ n and CPU ≤ n² distance tests (T7 review I1; Hermes' `shift` is O(length)).
 */
export function dbscan(points: readonly AnglePair[], eps: number, minPts: number, stats?: { maxQueue: number }): number[] {
  const n = points.length;
  const labels = new Array<number>(n).fill(-2); // −2 unvisited
  const near = (i: number) => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) if (Math.hypot(points[i]!.yaw - points[j]!.yaw, points[i]!.pitch - points[j]!.pitch) <= eps) out.push(j);
    return out;
  };
  let cluster = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = near(i);
    if (nb.length < minPts) {
      labels[i] = -1;
      continue;
    }
    labels[i] = cluster;
    const queue: number[] = [];
    const enqueue = (j: number) => {
      if (labels[j] === -2) {
        labels[j] = cluster;
        queue.push(j);
      } else if (labels[j] === -1) {
        labels[j] = cluster; // a border point: labelled, never expanded (it was not a core point)
      }
    };
    for (const j of nb) enqueue(j);
    for (let qi = 0; qi < queue.length; qi++) {
      const nb2 = near(queue[qi]!);
      if (nb2.length >= minPts) for (const j of nb2) enqueue(j);
    }
    if (stats !== undefined) stats.maxQueue = Math.max(stats.maxQueue, queue.length);
    cluster += 1;
  }
  return labels;
}

/**
 * One more drive of a recurring candidate: the running mean over drives (drives + 1). If the merged
 * zone would leave the bounds, the old zone is kept as it was (T7 review R1-m1).
 */
export function mergeLearnedZone(old: LearnedZone, cur: MirrorCandidate, cfg: Pick<DmsConfig, 'zones' | 'calibration'>): LearnedZone {
  const n = old.drives;
  const mix = (a: number, b: number) => (a * n + b) / (n + 1);
  const merged: LearnedZone = {
    id: old.id,
    yawDeg: mix(old.yawDeg, cur.yaw),
    pitchDeg: mix(old.pitchDeg, cur.pitch),
    halfYawDeg: mix(old.halfYawDeg, cur.halfYawDeg),
    halfPitchDeg: mix(old.halfPitchDeg, cur.halfPitchDeg),
    drives: n + 1,
  };
  return learnedZoneWithinBounds(merged, cfg) ? merged : old;
}

/**
 * `prior` is the learned zones of a profile whose mount has ALREADY matched; the engine façade starts
 * with [] and calls `setPrior` only on the calibrator's `warm_start` (T7 review m4, Task 12/14).
 */
export function createZoneLearner(cfg: Pick<DmsConfig, 'zones' | 'calibration'>, initialPrior: readonly LearnedZone[] = []) {
  const z = cfg.zones;
  const fixations: Fixation[] = [];
  let prior: readonly LearnedZone[] = initialPrior;
  // The I-DT window, O(1) per frame (T7 review m2): running extremes, sums, count and start time.
  let w = { n: 0, t0: 0, t1: 0, sy: 0, sp: 0, y0: 0, y1: 0, p0: 0, p1: 0 };
  let candidates: MirrorCandidate[] = [];
  let clusteredAt = 0;
  let nextClusterS = z.learnEveryS;

  // Off-road, and never the phone screen: brief phone glances must not become a "mirror" (T7 review I2).
  const offRoad = (id: ZoneId | null) => id !== null && id !== 'phone_screen' && z.table.find((x) => x.id === id)!.class !== 'on_road';

  /**
   * Closes the window. The duration is last − first sample time, one frame interval short of the
   * fixation's true length (T7 review nit): at 15 fps 4 frames read 200 ms, at 8 fps 3 frames 250 ms.
   * Accepted: it biases the "median < 1 s" mirror test very slightly toward mirrors.
   */
  function closeWindow(): void {
    if (w.n >= 2) {
      const durMs = w.t1 - w.t0;
      if (durMs >= z.fixationMinMs && fixations.length < z.fixationsPerDrive) fixations.push({ yaw: w.sy / w.n, pitch: w.sp / w.n, durMs });
    }
    w.n = 0;
  }

  function startWindow(t: number, a: AnglePair): void {
    w = { n: 1, t0: t, t1: t, sy: a.yaw, sp: a.pitch, y0: a.yaw, y1: a.yaw, p0: a.pitch, p1: a.pitch };
  }

  const toMirror = (id: MirrorId, a: AnglePair) => distanceToDefault(id, a.yaw, a.pitch, cfg);

  function cluster(): void {
    clusteredAt = fixations.length;
    const labels = dbscan(fixations, z.dbscanEpsDeg, z.dbscanMinPts);
    const byMirror = new Map<MirrorId, MirrorCandidate>();
    const k = Math.max(-1, ...labels);
    for (let c = 0; c <= k; c++) {
      const members = fixations.filter((_, i) => labels[i] === c);
      if (median(members.map((f) => f.durMs)) >= z.mirrorMedianMaxS * 1000) continue;
      const centroid = { yaw: members.reduce((s, f) => s + f.yaw, 0) / members.length, pitch: members.reduce((s, f) => s + f.pitch, 0) / members.length };
      let best: MirrorId | null = null;
      let bestD = Infinity;
      for (const m of MIRRORS) {
        const d = toMirror(m, centroid);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      if (best === null || bestD > z.mirrorNearDeg) continue;
      const half = (xs: number[]) => Math.min(z.learnedMaxHalfWidthDeg, Math.max(z.ellipseSigmas * sd(xs), z.ellipseMinHalfWidthDeg));
      const cand: MirrorCandidate = {
        id: best,
        yaw: centroid.yaw,
        pitch: centroid.pitch,
        halfYawDeg: half(members.map((f) => f.yaw)),
        halfPitchDeg: half(members.map((f) => f.pitch)),
        count: members.length,
      };
      if (!learnedZoneWithinBounds({ id: best, yawDeg: cand.yaw, pitchDeg: cand.pitch, halfYawDeg: cand.halfYawDeg, halfPitchDeg: cand.halfPitchDeg }, cfg)) continue;
      const prev = byMirror.get(best);
      if (prev === undefined || cand.count > prev.count) byMirror.set(best, cand);
    }
    candidates = MIRRORS.map((m) => byMirror.get(m)).filter((c): c is MirrorCandidate => c !== undefined);
  }

  return {
    /** One frame: the rules' relative direction, its zone, and whether calibration has passed. */
    observe(tMs: number, rel: AnglePair | null, zone: ZoneId | null, calibrated: boolean): void {
      if (rel === null || !calibrated || !offRoad(zone)) {
        closeWindow();
        return;
      }
      if (w.n === 0) {
        startWindow(tMs, rel);
        return;
      }
      const y0 = Math.min(w.y0, rel.yaw);
      const y1 = Math.max(w.y1, rel.yaw);
      const p0 = Math.min(w.p0, rel.pitch);
      const p1 = Math.max(w.p1, rel.pitch);
      if (y1 - y0 + (p1 - p0) > z.fixationMaxDispersionDeg) {
        closeWindow();
        startWindow(tMs, rel);
        return;
      }
      w.n += 1;
      w.t1 = tMs;
      w.sy += rel.yaw;
      w.sp += rel.pitch;
      w.y0 = y0;
      w.y1 = y1;
      w.p0 = p0;
      w.p1 = p1;
    },
    /** The matched profile's learned zones (on warm_start only). */
    setPrior(zones: readonly LearnedZone[]): void {
      prior = zones;
    },
    fixationCount: () => fixations.length,
    cluster,
    /** Clusters once per learnEveryS of driving; true when it ran. */
    maybeCluster(drivingS: number): boolean {
      if (drivingS < nextClusterS) return false;
      nextClusterS = (Math.floor(drivingS / z.learnEveryS) + 1) * z.learnEveryS;
      cluster();
      return true;
    },
    candidates: () => [...candidates],
    /** The prior's mirrors seen in ≥ drivesToAdopt drives (the classifier's ellipses). */
    promoted(): Partial<Record<MirrorId, LearnedZone>> {
      const out: Partial<Record<MirrorId, LearnedZone>> = {};
      for (const lz of prior) if (lz.drives >= z.drivesToAdopt) out[lz.id] = lz;
      return out;
    },
    /** The prior merged with this drive's candidates (a running mean over drives; drives + 1). */
    endDrive(): LearnedZone[] {
      closeWindow();
      if (fixations.length !== clusteredAt) cluster();
      const out: LearnedZone[] = [];
      for (const m of MIRRORS) {
        const old = prior.find((x) => x.id === m);
        const cur = candidates.find((c) => c.id === m);
        if (cur === undefined) {
          if (old !== undefined) out.push(old);
          continue;
        }
        if (old === undefined) {
          out.push({ id: m, yawDeg: cur.yaw, pitchDeg: cur.pitch, halfYawDeg: cur.halfYawDeg, halfPitchDeg: cur.halfPitchDeg, drives: 1 });
          continue;
        }
        // Recurrence in the same place (T7 review I2): merge only when this drive's centroid lies in the
        // prior ellipse grown by ε; otherwise the new candidate replaces it and counts from one.
        const e = z.dbscanEpsDeg;
        const dy = (cur.yaw - old.yawDeg) / (old.halfYawDeg + e);
        const dp = (cur.pitch - old.pitchDeg) / (old.halfPitchDeg + e);
        if (dy * dy + dp * dp > 1) {
          out.push({ id: m, yawDeg: cur.yaw, pitchDeg: cur.pitch, halfYawDeg: cur.halfYawDeg, halfPitchDeg: cur.halfPitchDeg, drives: 1 });
          continue;
        }
        out.push(mergeLearnedZone(old, cur, cfg));
      }
      return out;
    },
  };
}
