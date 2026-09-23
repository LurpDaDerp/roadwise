// Runs synthetic streams through quality → conditioner → calibrator, as the engine façade will.
import type { Calibrator } from '../calibration';
import { createConditioner, type Perceived } from '../conditioning';
import type { DmsConfig } from '../config';
import { classifyQuality } from '../quality';
import type { DriverSide, EngineFrame, VehicleContext } from '../types';
import { ctx as mkCtx, drvToCam, frame, gauss, rng, type FrameSpec } from './synth';

export interface Item {
  frame: EngineFrame;
  ctx: VehicleContext | null;
}

export interface StreamOpts {
  fps: number;
  seconds: number;
  fromMs?: number;
  seed?: number;
  side?: DriverSide;
  /** the frame at time t (s), with gaze/head in the DRIVER frame (converted for `side`) */
  sample: (tS: number, r: () => number) => Omit<FrameSpec, 'tMs' | 'gaze' | 'head' | 'net'> & {
    gazeDrv?: { yaw: number; pitch: number };
    headDrv?: { yaw: number; pitch: number; roll?: number };
    netDrv?: { yaw: number; pitch: number } | null;
  };
  ctx?: (tS: number) => Partial<VehicleContext> | null;
}

export function stream(o: StreamOpts): Item[] {
  const r = rng(o.seed ?? 1);
  const side = o.side ?? 'left';
  const n = Math.round(o.fps * o.seconds);
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const tMs = (o.fromMs ?? 0) + (i * 1000) / o.fps;
    const tS = tMs / 1000;
    const s = o.sample(tS, r);
    const { gazeDrv, headDrv, netDrv, ...rest } = s;
    const h = headDrv ?? { yaw: 0, pitch: 0 };
    const hc = drvToCam(h, side);
    const spec: FrameSpec = {
      ...rest,
      tMs,
      head: { yaw: hc.yaw, pitch: hc.pitch, roll: headDrv?.roll ?? 0 },
      gaze: gazeDrv ? drvToCam(gazeDrv, side) : undefined,
      net: netDrv ? drvToCam(netDrv, side) : null,
    };
    const c = o.ctx ? o.ctx(tS) : {};
    out.push({ frame: frame(spec), ctx: c === null ? null : mkCtx({ tMs, ...c }) });
  }
  return out;
}

/** Road cluster + mirror glances + lap glances, as i.i.d. draws; head follows 40 % of the gaze. */
export function roadSampler(centre: { yaw: number; pitch: number }, sdDeg = 2, share = { mirror: 0.1, lap: 0.1 }) {
  return (_t: number, r: () => number) => {
    const u = r();
    let g: { yaw: number; pitch: number };
    if (u < share.mirror) g = { yaw: 28 + gauss(r), pitch: 9 + gauss(r) };
    else if (u < share.mirror + share.lap) g = { yaw: 20 + gauss(r) * 2, pitch: -35 + gauss(r) * 2 };
    else g = { yaw: centre.yaw + gauss(r) * sdDeg, pitch: centre.pitch + gauss(r) * sdDeg };
    return { gazeDrv: g, headDrv: { yaw: 0.4 * g.yaw, pitch: 0.4 * g.pitch } };
  };
}

export function perceive(cfg: DmsConfig, cal: Calibrator, items: Item[]): Perceived[] {
  const c = createConditioner(cfg);
  return items.map(({ frame: f, ctx }) => {
    const p = c.step(f, classifyQuality(f, cfg), cal.refs());
    cal.observe(f, p, ctx);
    return p;
  });
}

/** A shared conditioner for runs split into several calls. */
export function perceiver(cfg: DmsConfig, cal: Calibrator) {
  const c = createConditioner(cfg);
  return (items: Item[]): Perceived[] =>
    items.map(({ frame: f, ctx }) => {
      const p = c.step(f, classifyQuality(f, cfg), cal.refs());
      cal.observe(f, p, ctx);
      return p;
    });
}
