// Task C9 (T9; review-C9 "Stage 1 robustness"): the navigation-heavy starts (S-NAV-START, S-NAV-START-SIDE,
// S-WARM-NAV-DUAL). 60 km/h straight, mirror checks every 15 s (0.8 s at (27°, 10°) and at (−45°, 0°)); for the first
// `startS` seconds a navigation display is watched `share` of every 10 s; then normal driving.
import { angularDistanceDeg } from '../../engine/angles';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent } from '../../engine/engine';
import type { DmsProfileV1 } from '../../engine/profile';
import type { AnglePair } from '../../engine/types';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

/**
 * The phone mount for the "phone at the camera" starts: 25° right of and 15° below the road (mountShift (−25°, 15°)),
 * as in S-2H-MANY. A display at the camera is then watched at the camera's own direction, (25°, −15°) in the driver
 * frame; with the synth's default mount the camera is about 3.6° from the road, inside its circle.
 */
export const PHONE_MOUNT: AnglePair = { yaw: -25, pitch: 15 };
export const AT_CAMERA: AnglePair = { yaw: 25, pitch: -15 };

export interface NavStart {
  seed: number;
  /** the display share of every 10 s during the start (0.85 = 8.5 s of every 10 s) */
  share: number;
  /** the display, in the driver frame relative to the road (rel), or AT_CAMERA (absolute, with PHONE_MOUNT) */
  at: AnglePair;
  camera?: boolean;
  /** the nav-heavy start, seconds */
  startS: number;
  seconds: number;
  /** mirror checks every 15 s (default true) */
  mirrors?: boolean;
  /**
   * after a mirror check the driver looks at the road for `roadAfterMirrorS` before the display pattern resumes
   * (the side test; the default pattern lets the display take the gaze straight back when it is due)
   */
  roadAfterMirrorS?: number;
  profile?: DmsProfileV1 | null;
  cfg?: DmsConfig;
}

export interface NavResult {
  events: (DmsEvent & { cause?: string })[];
  commands: DmsAlertCommand[];
  /** once a second: the gaze centre */
  seconds: { tMs: number; centre: AnglePair | null }[];
  /** the centre just after each 'calibrated' event */
  passes: { tMs: number; centre: AnglePair }[];
  /** the profile saved at the end of the drive */
  profile: DmsProfileV1 | null;
}

function mirrorAt(t: number): AnglePair | null {
  const k = t % 15;
  if (k >= 5 && k < 5.8) return rel(27, 10);
  if (k >= 11 && k < 11.8) return rel(-45, 0);
  return null;
}

function sinceMirror(t: number): number {
  const k = t % 15;
  if (k >= 5.8 && k < 11) return k - 5.8;
  if (k >= 11.8) return k - 11.8;
  if (k < 5) return k + 15 - 11.8;
  return 0;
}

export function navDrive(o: NavStart): NavResult {
  const mount = o.camera === true ? PHONE_MOUNT : undefined;
  const display = o.camera === true ? AT_CAMERA : rel(o.at.yaw, o.at.pitch);
  const driver = (t: number, r: () => number): DriverState => {
    const m = o.mirrors === false ? null : mirrorAt(t);
    const reading = t < o.startS && t % 10 < o.share * 10 && !(o.roadAfterMirrorS !== undefined && o.mirrors !== false && sinceMirror(t) < o.roadAfterMirrorS);
    return { gaze: m ?? (reading ? display : onRoad(r)), openness: blinkOpenness(t), speedKmh: 60, ...(mount !== undefined ? { mountShift: mount } : {}) };
  };
  const items = synthDrive({ fps: 15, seconds: o.seconds, seed: o.seed, source: 'geometric', driver, motion: true });
  const e = createDmsEngine(o.cfg ?? C, { ...DEFAULT_INIT, profile: o.profile ?? null });
  const out: NavResult = { events: [], commands: [], seconds: [], passes: [], profile: null };
  let next = 0;
  for (const it of items) {
    if (it.row !== undefined) e.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    e.pushFrame(it.frame);
    const d = e.drain();
    out.events.push(...d.events);
    out.commands.push(...d.commands);
    if (d.events.some((x) => x.kind === 'calibrated')) out.passes.push({ tMs: it.frame.tMs, centre: e.snapshot().centre.gaze! });
    if (it.frame.tMs >= next) {
      next += 1000;
      out.seconds.push({ tMs: it.frame.tMs, centre: e.snapshot().centre.gaze });
    }
  }
  out.profile = e.endDrive(items.at(-1)!.frame.tMs).profile;
  return out;
}

/** The road's centre for a seed (and mount): a display-free drive's centre at the end (the gain error is per drive). */
const truths = new Map<string, AnglePair>();
export function truthOf(seed: number, camera = false): AnglePair {
  const key = `${seed}:${camera}`;
  const hit = truths.get(key);
  if (hit !== undefined) return hit;
  const d = navDrive({ seed, share: 0, at: { yaw: 0, pitch: 0 }, camera, startS: 0, seconds: 180 });
  const t = d.seconds.at(-1)!.centre!;
  truths.set(key, t);
  return t;
}

export const firstCalS = (d: NavResult): number | null => {
  const c = d.events.find((x) => x.kind === 'calibrated');
  return c === undefined ? null : c.tMs / 1000;
};

export const centreAt = (d: NavResult, tMs: number): AnglePair | null => [...d.seconds].reverse().find((s) => s.tMs <= tMs)?.centre ?? null;

/** the largest distance of the centre from the truth once calibrated (a pass onto the screen shows here) */
export function worstAfterCal(d: NavResult, truth: AnglePair): number {
  const t0 = firstCalS(d);
  if (t0 === null) return 0;
  let worst = 0;
  for (const s of d.seconds) if (s.tMs >= t0 * 1000 && s.centre !== null) worst = Math.max(worst, angularDistanceDeg(s.centre, truth));
  return worst;
}
