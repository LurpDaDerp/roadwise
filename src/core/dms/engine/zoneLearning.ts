// Zone learning (plan §M4; spec "Zone learning"). Off-road fixations while calibrated (≤ 2° dispersion
// for ≥ 200 ms, at most 600 per drive), DBSCAN over their centroids every 5 min of driving (ε 3°,
// minPts 5), mirror candidates (median fixation < 1 s, centroid within 10° of a default mirror), and a
// per-mount record across drives (the profile's `learnedZones`; profiles are per mount signature): a
// candidate seen in ≥ 3 drives replaces that mirror's rectangle with an ellipse, centroid ± 2σ per axis,
// half-widths ≥ 4°. Pure; every buffer is bounded.
import type { DmsConfig, ZoneId } from './config';
import type { LearnedZone } from './profile';
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

/** DBSCAN on directions (planar degrees). Labels: cluster index ≥ 0, or −1 for noise. */
export function dbscan(points: readonly AnglePair[], eps: number, minPts: number): number[] {
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
    const queue = [...nb];
    while (queue.length > 0) {
      const j = queue.shift()!;
      if (labels[j] === -1) labels[j] = cluster;
      if (labels[j] !== -2) continue;
      labels[j] = cluster;
      const nb2 = near(j);
      if (nb2.length >= minPts) queue.push(...nb2);
    }
    cluster += 1;
  }
  return labels;
}

export function createZoneLearner(cfg: Pick<DmsConfig, 'zones'>, prior: readonly LearnedZone[]) {
  const z = cfg.zones;
  const fixations: Fixation[] = [];
  let window: { t: number; yaw: number; pitch: number }[] = [];
  let candidates: MirrorCandidate[] = [];
  let clusteredAt = 0;
  let nextClusterS = z.learnEveryS;

  const offRoad = (id: ZoneId | null) => id !== null && z.table.find((x) => x.id === id)!.class !== 'on_road';

  function closeWindow(): void {
    if (window.length >= 2) {
      const durMs = window[window.length - 1]!.t - window[0]!.t;
      if (durMs >= z.fixationMinMs && fixations.length < z.fixationsPerDrive) {
        fixations.push({
          yaw: window.reduce((s, x) => s + x.yaw, 0) / window.length,
          pitch: window.reduce((s, x) => s + x.pitch, 0) / window.length,
          durMs,
        });
      }
    }
    window = [];
  }

  const dispersion = (w: { yaw: number; pitch: number }[]) => {
    let y0 = Infinity;
    let y1 = -Infinity;
    let p0 = Infinity;
    let p1 = -Infinity;
    for (const x of w) {
      y0 = Math.min(y0, x.yaw);
      y1 = Math.max(y1, x.yaw);
      p0 = Math.min(p0, x.pitch);
      p1 = Math.max(p1, x.pitch);
    }
    return y1 - y0 + (p1 - p0);
  };

  /** Distance from a point to a mirror's default rectangle (0 inside). */
  const toMirror = (id: MirrorId, a: AnglePair) => {
    const r = z.table.find((x) => x.id === id)!.region;
    if (r.kind !== 'rect') return Infinity;
    const dy = Math.max(r.yaw[0] - a.yaw, 0, a.yaw - r.yaw[1]);
    const dp = Math.max(r.pitch[0] - a.pitch, 0, a.pitch - r.pitch[1]);
    return Math.hypot(dy, dp);
  };

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
      const cand: MirrorCandidate = {
        id: best,
        yaw: centroid.yaw,
        pitch: centroid.pitch,
        halfYawDeg: Math.max(z.ellipseSigmas * sd(members.map((f) => f.yaw)), z.ellipseMinHalfWidthDeg),
        halfPitchDeg: Math.max(z.ellipseSigmas * sd(members.map((f) => f.pitch)), z.ellipseMinHalfWidthDeg),
        count: members.length,
      };
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
      const next = [...window, { t: tMs, yaw: rel.yaw, pitch: rel.pitch }];
      if (dispersion(next) > z.fixationMaxDispersionDeg) {
        closeWindow();
        window = [{ t: tMs, yaw: rel.yaw, pitch: rel.pitch }];
      } else {
        window = next;
      }
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
        const n = old.drives;
        const mix = (a: number, b: number) => (a * n + b) / (n + 1);
        out.push({
          id: m,
          yawDeg: mix(old.yawDeg, cur.yaw),
          pitchDeg: mix(old.pitchDeg, cur.pitch),
          halfYawDeg: mix(old.halfYawDeg, cur.halfYawDeg),
          halfPitchDeg: mix(old.halfPitchDeg, cur.halfPitchDeg),
          drives: n + 1,
        });
      }
      return out;
    },
  };
}
