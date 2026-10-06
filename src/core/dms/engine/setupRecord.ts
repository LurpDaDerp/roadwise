// The setup session's result (product spec v3: "camera permission … also runs a 20-second mount and gaze
// calibration"; "Calibrate those gaze zones during DMS setup"). Stored by the host (settings key
// `dms.setup`, uid-bound, like the profile) and applied at every drive's start: the seed gives the engine the
// road-centre gaze and head directions (state `seeded`, verified against fresh evidence), and the mirror zones
// give the zone learner its prior, promoted at once, so a mirror or blind-spot glance is classified as safe
// from the first frame. Face-geometry-derived (a mount signature, gaze and head angles, the open-eye EAR);
// it never leaves the device. Pure.
import type { CalibrationSeed } from './calibration';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from './config';
import { learnedZoneWithinBounds, parseAngle, parseLearnedZone, parseSignature, type LearnedZone } from './profile';
import { median, sd } from './stats';
import type { AnglePair } from './types';
import type { MirrorId } from './zones';

export interface DmsSetupRecord {
  v: 1;
  seed: CalibrationSeed;
  /** the mirror zones measured during setup; `drives` = the adoption threshold, so they are promoted at once */
  mirrors: LearnedZone[];
  savedAtMs: number;
}

/** The mirror prompts of the setup, in order, and the zone each one measures (LHD: the driver's mirror is on the left). */
export const SETUP_MIRRORS: readonly { id: MirrorId; prompt: 'left_mirror' | 'right_mirror' | 'rear_mirror' }[] = [
  { id: 'driver_mirror', prompt: 'left_mirror' },
  { id: 'passenger_mirror', prompt: 'right_mirror' },
  { id: 'rear_mirror', prompt: 'rear_mirror' },
];

/** Fewer gaze samples than this during a mirror prompt leave that mirror at its default rectangle. */
export const MIRROR_MIN_SAMPLES = 10;

type Cfg = Pick<DmsConfig, 'zones' | 'calibration'>;

/**
 * A mirror zone from the gaze directions sampled while the driver looked at that mirror (relative to the seeded
 * road centre, driver frame): the median direction, half-widths of ellipseSigmas × SD within the learned bounds,
 * and the adoption count. Null when too few samples or when the result is out of bounds (too close to the road
 * centre, or too far from the default mirror rectangle): the default rectangle then stays.
 */
export function mirrorZoneFromSamples(id: MirrorId, samples: readonly AnglePair[], cfg: Cfg = DEFAULT_DMS_CONFIG as DmsConfig): LearnedZone | null {
  if (samples.length < MIRROR_MIN_SAMPLES) return null;
  const z = cfg.zones;
  const yaws = samples.map((a) => a.yaw);
  const pitches = samples.map((a) => a.pitch);
  const half = (xs: number[]) => Math.min(z.learnedMaxHalfWidthDeg, Math.max(z.ellipseSigmas * sd(xs), z.ellipseMinHalfWidthDeg));
  const zone: LearnedZone = { id, yawDeg: median(yaws), pitchDeg: median(pitches), halfYawDeg: half(yaws), halfPitchDeg: half(pitches), drives: z.drivesToAdopt };
  return learnedZoneWithinBounds(zone, cfg) ? zone : null;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const earValue = (x: unknown): x is number | null => x === null || (fin(x) && x > 0 && x < 1);

function parseSeed(x: unknown): CalibrationSeed | null {
  if (!isObj(x)) return null;
  const gc = x.gazeCentres;
  if (!isObj(gc) || !('geometric' in gc) || !('net' in gc) || !Object.keys(gc).every((k) => k === 'geometric' || k === 'net')) return null;
  const geometric = gc.geometric === null ? null : parseAngle(gc.geometric);
  const net = gc.net === null ? null : parseAngle(gc.net);
  if ((gc.geometric !== null && geometric === null) || (gc.net !== null && net === null)) return null;
  if (geometric === null && net === null) return null;
  const headCentre = parseAngle(x.headCentre);
  const mount = parseSignature(x.mount);
  if (headCentre === null || mount === null) return null;
  if (!fin(x.rollOffsetDeg) || Math.abs(x.rollOffsetDeg) > 180) return null;
  if (x.orientation !== 0 && x.orientation !== 90 && x.orientation !== 180 && x.orientation !== 270) return null;
  const ear = x.openEyeEar;
  if (!isObj(ear) || !earValue(ear.r) || !earValue(ear.l)) return null;
  return { gazeCentres: { geometric, net }, headCentre, rollOffsetDeg: x.rollOffsetDeg, mount, orientation: x.orientation, openEyeEar: { r: ear.r, l: ear.l } };
}

/** A stored setup record, validated field by field; null when anything is off (the drive then calibrates from scratch). */
export function parseSetupRecord(x: unknown, cfg: Cfg = DEFAULT_DMS_CONFIG as DmsConfig): DmsSetupRecord | null {
  if (!isObj(x) || x.v !== 1) return null;
  const seed = parseSeed(x.seed);
  if (seed === null) return null;
  if (!Array.isArray(x.mirrors)) return null;
  const mirrors: LearnedZone[] = [];
  const seen = new Set<string>();
  for (const m of x.mirrors) {
    const lz = parseLearnedZone(m);
    if (lz === null || seen.has(lz.id)) return null;
    seen.add(lz.id);
    if (learnedZoneWithinBounds(lz, cfg)) mirrors.push(lz); // an out-of-bounds zone is dropped, never the record
  }
  if (!fin(x.savedAtMs) || x.savedAtMs < 0) return null;
  return { v: 1, seed, mirrors, savedAtMs: x.savedAtMs };
}
