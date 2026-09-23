// The diagnostics host's shadow comparator (plan Task 16; validation stage 3 and the R-gaze row). In an
// internal build both gaze sources run on the same frames: one shadow engine per source (alerts muted),
// fed the rows the panel simulates and the frames native already delivers to the controller. From them it
// keeps, for the panel, counts and aggregates only:
// - per source: frames, observed time, the would-be alerts (the commands a live engine would have sounded)
//   and their rate per hour, and the count per alert kind;
// - the agreement on frames where both engines are TRACKING and each uses its own source (the geometric path,
//   and the net that ran): the median |Δyaw| and |Δpitch| between the two gazes relative to their road
//   centres (0.1° bins, so no sample is kept), and the zone agreement.
//
// It only listens to native's `frames` and `state` events. It never calls native (the controller owns the
// camera and its gate), keeps no frame, and logs and stores nothing. The net engine's column is null until a
// frame carries the net. Not for M7: the dev panel is its one user.
import type { FeatureRow } from '@/core/engine/types';
import type { DmsVisionApi, Subscription } from '../../../../modules/dms-vision/src/types';
import { decodeFrameBatch } from '../../../../modules/dms-vision/src/wire';
import { resolveDmsConfig, type DmsConfigOverrides } from '../engine/config';
import { createDmsEngine, type DmsEngine } from '../engine/engine';
import type { DriverSide } from '../engine/types';
import type { DmsHostPower } from './controller';
import { engineFrame } from './frames';
import { rowExtras } from './rowContext';

export interface DmsShadowSourceStats {
  frames: number;
  /** observed time, s (gaps over 0.5 s excluded) */
  observedS: number;
  /** the would-be alerts: start and once commands (a stop is not an alert) */
  alerts: number;
  /** alerts per hour of observed time; null before any */
  alertsPerHour: number | null;
  byKind: Record<string, number>;
}

export interface DmsShadowStats {
  /** rows fed to both shadow engines */
  rows: number;
  geometric: DmsShadowSourceStats;
  /** null until a frame carried the net (a build without it, or the net never on) */
  net: DmsShadowSourceStats | null;
  agreement: {
    /** frames where both are TRACKING and each used its own source */
    frames: number;
    medianAbsDyawDeg: number | null;
    medianAbsDpitchDeg: number | null;
    /** of those frames, the ones where both had a zone */
    zoneFrames: number;
    /** the share of zoneFrames where the zones were the same */
    zoneAgreement: number | null;
  };
}

export interface DmsShadowComparator {
  pushRow(row: FeatureRow, power: DmsHostPower): void;
  /** Ends both shadow drives; the session's totals are kept. */
  endDrive(): void;
  stats(): DmsShadowStats;
  /** Stops listening. */
  dispose(): void;
}

const GAP_MS = 500;
const BIN_DEG = 0.1;
const BINS = 900; // 0–90°, the last bin holding everything beyond

/** A fixed-bin histogram of |Δ|: the median without keeping a sample. */
function createHistogram() {
  const bins = new Uint32Array(BINS);
  let n = 0;
  return {
    add(v: number) {
      bins[Math.min(BINS - 1, Math.floor(Math.abs(v) / BIN_DEG))]! += 1;
      n++;
    },
    median(): number | null {
      if (n === 0) return null;
      let c = 0;
      for (let i = 0; i < BINS; i++) {
        c += bins[i]!;
        if (c * 2 >= n) return Math.round((i + 0.5) * BIN_DEG * 100) / 100;
      }
      return null;
    },
  };
}

function createSource(config: DmsConfigOverrides, gazeSource: 'geometric' | 'net', driverSide: DriverSide) {
  const cfg = resolveDmsConfig({ ...config, gazeSource });
  const make = () => createDmsEngine(cfg, { driverSide, sensitivity: 'normal', alerts: 'shadow', profile: null });
  let engine: DmsEngine = make();
  const totals = { frames: 0, observedMs: 0, alerts: 0, byKind: {} as Record<string, number> };
  let lastT: number | null = null;
  const drain = () => {
    for (const c of engine.drain().commands) {
      if (c.action === 'stop') continue;
      totals.alerts++;
      totals.byKind[c.kind] = (totals.byKind[c.kind] ?? 0) + 1;
    }
  };
  return {
    get engine() {
      return engine;
    },
    frame(tMs: number) {
      totals.frames++;
      if (lastT !== null && tMs > lastT && tMs - lastT <= GAP_MS) totals.observedMs += tMs - lastT;
      lastT = tMs;
      drain();
    },
    drain,
    endDrive(tMs: number) {
      engine.endDrive(tMs);
      drain();
      engine = make();
      lastT = null;
    },
    stats(): DmsShadowSourceStats {
      const observedS = totals.observedMs / 1000;
      return { frames: totals.frames, observedS, alerts: totals.alerts, alertsPerHour: observedS > 0 ? totals.alerts / (observedS / 3600) : null, byKind: { ...totals.byKind } };
    },
  };
}

export function createShadowComparator(native: Pick<DmsVisionApi, 'addListener'>, opts: { config?: DmsConfigOverrides; driverSide?: DriverSide } = {}): DmsShadowComparator {
  const side = opts.driverSide ?? 'left';
  const geo = createSource(opts.config ?? {}, 'geometric', side);
  const net = createSource(opts.config ?? {}, 'net', side);
  let netFrames = 0;
  let rows = 0;
  const dYaw = createHistogram();
  const dPitch = createHistogram();
  let agreeFrames = 0;
  let zoneFrames = 0;
  let zoneSame = 0;
  // The decoder's state, reset on each native session (as the controller's).
  let lastTMs: number | null = null;
  let offset: number | null = null;
  let driveStartTs: number | null = null;
  let lastT = 0;
  let disposed = false;

  const subs: Subscription[] = [
    native.addListener('frames', (raw) => {
      if (disposed) return;
      const res = decodeFrameBatch(raw, lastTMs);
      if (res.batch === null) return;
      lastTMs = res.lastTMs;
      offset ??= res.batch.anchorEpochMs - res.batch.anchorTMs;
      for (const f of res.batch.frames) {
        const ef = engineFrame(f, offset);
        if (ef.net !== null) netFrames++;
        geo.engine.pushFrame(ef);
        net.engine.pushFrame(ef);
        geo.frame(ef.tMs);
        net.frame(ef.tMs);
        lastT = ef.tMs;
        const a = geo.engine.snapshot();
        const b = net.engine.snapshot();
        if (a.quality === 'tracking' && b.quality === 'tracking' && a.gazeFrom === 'geometric' && b.gazeFrom === 'net' && a.gazeRel !== null && b.gazeRel !== null) {
          agreeFrames++;
          dYaw.add(a.gazeRel.yaw - b.gazeRel.yaw);
          dPitch.add(a.gazeRel.pitch - b.gazeRel.pitch);
          if (a.zone !== null && b.zone !== null) {
            zoneFrames++;
            if (a.zone === b.zone) zoneSame++;
          }
        }
      }
    }),
    native.addListener('state', (ev) => {
      if (ev.state === 'starting') {
        lastTMs = null;
        offset = null;
      }
    }),
  ];

  return {
    pushRow(row, power) {
      if (disposed) return;
      driveStartTs ??= row.ts;
      rows++;
      const ex = rowExtras(row, power, Math.max(0, (row.ts - driveStartTs) / 1000));
      for (const s of [geo, net]) {
        s.engine.pushRow(row, ex, row.ts);
        s.drain();
      }
      lastT = Math.max(lastT, row.ts);
    },
    endDrive() {
      if (disposed) return;
      geo.endDrive(lastT);
      net.endDrive(lastT);
      driveStartTs = null;
      lastTMs = null;
      offset = null;
    },
    stats() {
      return {
        rows,
        geometric: geo.stats(),
        net: netFrames > 0 ? net.stats() : null,
        agreement: { frames: agreeFrames, medianAbsDyawDeg: dYaw.median(), medianAbsDpitchDeg: dPitch.median(), zoneFrames, zoneAgreement: zoneFrames > 0 ? zoneSame / zoneFrames : null },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of subs) s.remove();
    },
  };
}
