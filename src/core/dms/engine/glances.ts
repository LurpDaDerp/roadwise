// Glances (plan §M5; spec "Smoothing"): a run of off-road samples that ends only after ≥ 100 ms back on
// road (shorter returns are absorbed, ADDW "in-out-back-in"); per-zone time; the glance's zone is the
// zone with the most time. A shoulder check (C-18, rev1 m3: no yaw pulse) is a glance that starts with
// the head turning > 100°/s, or within 2 s after a mirror glance ended. Occlusion (no zone) freezes
// everything. Time is attributed per frame: the interval ending at a frame belongs to that frame's zone.
// Occlusion also BRIDGES an on-road run: 1 s on road, 5 s occluded, 1 s on road counts as a 2 s run
// (so it can reset VATS). That errs toward fewer warnings; accepted (T8 review nit).
import type { DmsConfig, ZoneId } from './config';

export interface Glance {
  startT: number;
  /** when the road run that ended it began */
  endT: number;
  /** off-road seconds */
  durS: number;
  zone: ZoneId;
  perZone: Partial<Record<ZoneId, number>>;
  shoulderCheck: boolean;
}

export interface GlanceFrame {
  /** a glance is running (off-road, or an absorbed return) */
  active: boolean;
  /** the running glance's state */
  current: Glance | null;
  /** a glance that ended on this frame */
  ended: Glance | null;
  /** continuous on-road seconds so far (0 while off-road) */
  onRoadRunS: number;
}

export function createGlanceTracker(cfg: Pick<DmsConfig, 'zones' | 'glances' | 'distraction'>) {
  const cls = new Map(cfg.zones.table.map((z) => [z.id, z.class]));
  let current: Glance | null = null;
  let onRoadRunS = 0;
  let lastMirrorEndT = Number.NEGATIVE_INFINITY;
  const mirror = (z: ZoneId) => z === 'rear_mirror' || z === 'driver_mirror' || z === 'passenger_mirror';

  return {
    reset() {
      current = null;
      onRoadRunS = 0;
      lastMirrorEndT = Number.NEGATIVE_INFINITY;
    },
    onFrame(tMs: number, dtS: number, zone: ZoneId | null, headYawSpeedDegS: number | null): GlanceFrame {
      let ended: Glance | null = null;
      if (zone === null) return { active: current !== null, current, ended, onRoadRunS };
      if (cls.get(zone) === 'on_road') {
        onRoadRunS += dtS;
        if (current !== null && onRoadRunS * 1000 >= cfg.glances.endOnRoadMs - 1e-6) {
          current.endT = tMs - onRoadRunS * 1000;
          ended = current;
          if (mirror(ended.zone)) lastMirrorEndT = ended.endT;
          current = null;
        }
        return { active: current !== null, current, ended, onRoadRunS };
      }
      onRoadRunS = 0;
      if (current === null) {
        current = {
          startT: tMs,
          endT: tMs,
          durS: 0,
          zone,
          perZone: {},
          shoulderCheck:
            (headYawSpeedDegS !== null && Math.abs(headYawSpeedDegS) > cfg.zones.fastTurnDegS) ||
            tMs - lastMirrorEndT <= cfg.distraction.shoulderAfterMirrorS * 1000,
        };
      }
      current.durS += dtS;
      current.perZone[zone] = (current.perZone[zone] ?? 0) + dtS;
      let best = current.zone;
      for (const [z, s] of Object.entries(current.perZone) as [ZoneId, number][]) if (s > (current.perZone[best] ?? 0)) best = z;
      current.zone = best;
      return { active: true, current, ended, onRoadRunS };
    },
  };
}
