// The driver profile (plan §M3) and the visual mount signature (C-6). A profile is stored by the host
// (settings key `dms.profile`, rev1 S-M2) and validated here field by field on load; anything
// unexpected makes it null, and the drive calibrates from scratch.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from './config';
import type { AnglePair, DriverSide, Rotation } from './types';

/** Medians over TRACKING frames: head pose in the camera frame, the face box centre, the IOD. */
export interface MountSignature {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  boxCx: number;
  boxCy: number;
  iod: number;
}

/** A mirror zone learned across drives on one mount (Task 7 fills these). */
export interface LearnedZone {
  id: 'rear_mirror' | 'driver_mirror' | 'passenger_mirror';
  yawDeg: number;
  pitchDeg: number;
  halfYawDeg: number;
  halfPitchDeg: number;
  drives: number;
}

export interface DmsProfileV1 {
  v: 1;
  driverSide: DriverSide;
  /** the wire's rotationDeg the profile was learned at */
  orientation: Rotation;
  mount: MountSignature;
  /** per gaze source present (rev1 R-gaze); at least one */
  gazeCentres: { geometric?: AnglePair; net?: AnglePair };
  headCentre: AnglePair;
  rollOffsetDeg: number;
  radiusDeg: number;
  /** [right, left]; an eye never seen open enough is null */
  openEyeEar: [number | null, number | null];
  neutralMar: number;
  neutralMouthW: number;
  learnedZones: LearnedZone[];
  savedAtMs: number;
}

type Cfg = Pick<DmsConfig, 'calibration'>;
type ZoneCfg = Pick<DmsConfig, 'calibration' | 'zones'>;

// ---------------------------------------------------------------------------------------------
// Signatures.
// ---------------------------------------------------------------------------------------------

/**
 * `match`: every field within the C-6 tolerances. `driverChange`: a mismatch large enough to be another
 * driver (|ΔIOD| / IOD ≥ 15 % or a box shift ≥ 0.15; rev1 I7). IOD is relative to `before`.
 */
export function compareSignatures(before: MountSignature, after: MountSignature, cfg: Cfg): { match: boolean; driverChange: boolean } {
  const t = cfg.calibration.resumeTolerance;
  const box = Math.hypot(after.boxCx - before.boxCx, after.boxCy - before.boxCy);
  const iod = Math.abs(after.iod - before.iod) / before.iod;
  const match =
    Math.abs(after.yawDeg - before.yawDeg) <= t.yawDeg &&
    Math.abs(after.pitchDeg - before.pitchDeg) <= t.pitchDeg &&
    Math.abs(after.rollDeg - before.rollDeg) <= t.rollDeg &&
    box <= t.box &&
    iod <= t.iodFrac;
  const dc = cfg.calibration.driverChange;
  return { match, driverChange: !match && (iod >= dc.iodFrac || box >= dc.box) };
}

export function mountMatches(a: MountSignature, b: MountSignature, cfg: Cfg): boolean {
  return compareSignatures(a, b, cfg).match;
}

// ---------------------------------------------------------------------------------------------
// Learned-mirror bounds (T7 review I2), applied when learning and when loading a profile.
// ---------------------------------------------------------------------------------------------

/** The distance from a direction to a zone's default rectangle (0 inside; Infinity if not a rectangle). */
export function distanceToDefault(id: LearnedZone['id'], yaw: number, pitch: number, cfg: Pick<DmsConfig, 'zones'>): number {
  const r = cfg.zones.table.find((z) => z.id === id)?.region;
  if (r === undefined || r.kind !== 'rect') return Infinity;
  const dy = Math.max(r.yaw[0] - yaw, 0, yaw - r.yaw[1]);
  const dp = Math.max(r.pitch[0] - pitch, 0, pitch - r.pitch[1]);
  return Math.hypot(dy, dp);
}

/**
 * A learned mirror may be used only if its half-widths are within [ellipseMinHalfWidthDeg,
 * learnedMaxHalfWidthDeg], its centroid is within mirrorNearDeg of the default rectangle, and it cannot
 * reach the road-centre circle at its largest radius: |centroid| − max(half-widths) ≥ radiusMaxDeg.
 */
export function learnedZoneWithinBounds(z: Omit<LearnedZone, 'drives'>, cfg: ZoneCfg): boolean {
  const c = cfg.zones;
  const halves = [z.halfYawDeg, z.halfPitchDeg];
  if (!halves.every((h) => h > 0 && h <= c.learnedMaxHalfWidthDeg + 1e-9)) return false;
  if (distanceToDefault(z.id, z.yawDeg, z.pitchDeg, cfg) > c.mirrorNearDeg) return false;
  const reach = Math.hypot(z.yawDeg, z.pitchDeg) - Math.max(z.halfYawDeg, z.halfPitchDeg);
  return reach >= cfg.calibration.radiusMaxDeg;
}

// ---------------------------------------------------------------------------------------------
// Parsing.
// ---------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const keysExactly = (o: Record<string, unknown>, keys: string[], optional: string[] = []) =>
  keys.every((k) => k in o) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k));

function angle(x: unknown): AnglePair | null {
  if (!isObj(x) || !keysExactly(x, ['yaw', 'pitch'])) return null;
  if (!fin(x.yaw) || !fin(x.pitch) || Math.abs(x.yaw) > 180 || Math.abs(x.pitch) > 90) return null;
  return { yaw: x.yaw, pitch: x.pitch };
}

function signature(x: unknown): MountSignature | null {
  const k = ['yawDeg', 'pitchDeg', 'rollDeg', 'boxCx', 'boxCy', 'iod'];
  if (!isObj(x) || !keysExactly(x, k) || !k.every((key) => fin(x[key]))) return null;
  const s = x as unknown as MountSignature;
  if (Math.abs(s.yawDeg) > 180 || Math.abs(s.pitchDeg) > 90 || Math.abs(s.rollDeg) > 180) return null;
  if (s.boxCx < 0 || s.boxCx > 1 || s.boxCy < 0 || s.boxCy > 1 || !(s.iod > 0) || s.iod > 1) return null;
  return { yawDeg: s.yawDeg, pitchDeg: s.pitchDeg, rollDeg: s.rollDeg, boxCx: s.boxCx, boxCy: s.boxCy, iod: s.iod };
}

/** A structurally valid learned zone, or null (which rejects the profile). Bounds are checked by the caller. */
function learnedZone(x: unknown): LearnedZone | null {
  const k = ['id', 'yawDeg', 'pitchDeg', 'halfYawDeg', 'halfPitchDeg', 'drives'];
  if (!isObj(x) || !keysExactly(x, k)) return null;
  if (x.id !== 'rear_mirror' && x.id !== 'driver_mirror' && x.id !== 'passenger_mirror') return null;
  if (![x.yawDeg, x.pitchDeg, x.halfYawDeg, x.halfPitchDeg, x.drives].every(fin)) return null;
  const z = x as unknown as LearnedZone;
  if (!(z.halfYawDeg > 0) || !(z.halfPitchDeg > 0) || !Number.isInteger(z.drives) || z.drives < 0) return null;
  return { id: z.id, yawDeg: z.yawDeg, pitchDeg: z.pitchDeg, halfYawDeg: z.halfYawDeg, halfPitchDeg: z.halfPitchDeg, drives: z.drives };
}

const KEYS = [
  'v',
  'driverSide',
  'orientation',
  'mount',
  'gazeCentres',
  'headCentre',
  'rollOffsetDeg',
  'radiusDeg',
  'openEyeEar',
  'neutralMar',
  'neutralMouthW',
  'learnedZones',
  'savedAtMs',
];

/** A stored profile, validated field by field; null when anything is off. */
export function parseProfile(x: unknown, cfg: ZoneCfg = DEFAULT_DMS_CONFIG as DmsConfig): DmsProfileV1 | null {
  if (!isObj(x) || !keysExactly(x, KEYS)) return null;
  if (x.v !== 1) return null;
  if (x.driverSide !== 'left' && x.driverSide !== 'right') return null;
  if (x.orientation !== 0 && x.orientation !== 90 && x.orientation !== 180 && x.orientation !== 270) return null;
  const mount = signature(x.mount);
  if (mount === null) return null;
  if (!isObj(x.gazeCentres) || !Object.keys(x.gazeCentres).every((k) => k === 'geometric' || k === 'net')) return null;
  const gazeCentres: DmsProfileV1['gazeCentres'] = {};
  for (const k of ['geometric', 'net'] as const) {
    if (k in x.gazeCentres) {
      const a = angle(x.gazeCentres[k]);
      if (a === null) return null;
      gazeCentres[k] = a;
    }
  }
  if (gazeCentres.geometric === undefined && gazeCentres.net === undefined) return null;
  const headCentre = angle(x.headCentre);
  if (headCentre === null) return null;
  const c = cfg.calibration;
  if (!fin(x.rollOffsetDeg) || Math.abs(x.rollOffsetDeg) > 180) return null;
  if (!fin(x.radiusDeg) || x.radiusDeg < c.radiusMinDeg || x.radiusDeg > c.radiusMaxDeg) return null;
  const ear = x.openEyeEar;
  if (!Array.isArray(ear) || ear.length !== 2 || !ear.every((e) => e === null || (fin(e) && e > 0 && e < 1))) return null;
  if (!fin(x.neutralMar) || x.neutralMar < c.neutralMarFloor || x.neutralMar > 1) return null;
  if (!fin(x.neutralMouthW) || !(x.neutralMouthW > 0)) return null;
  if (!Array.isArray(x.learnedZones)) return null;
  const learnedZones: LearnedZone[] = [];
  for (const z of x.learnedZones) {
    const lz = learnedZone(z);
    if (lz === null) return null; // a structural error rejects the profile
    // An out-of-bounds zone is dropped, never the whole profile (T7 review R1-m1).
    if (learnedZoneWithinBounds(lz, cfg)) learnedZones.push(lz);
  }
  if (!fin(x.savedAtMs) || x.savedAtMs < 0) return null;
  return {
    v: 1,
    driverSide: x.driverSide,
    orientation: x.orientation,
    mount,
    gazeCentres,
    headCentre,
    rollOffsetDeg: x.rollOffsetDeg,
    radiusDeg: x.radiusDeg,
    openEyeEar: [ear[0] as number | null, ear[1] as number | null],
    neutralMar: x.neutralMar,
    neutralMouthW: x.neutralMouthW,
    learnedZones,
    savedAtMs: x.savedAtMs,
  };
}
