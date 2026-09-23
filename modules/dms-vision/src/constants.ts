// The single source of the DmsVision wire and lifecycle numbers (plan rev1: m1). The capture policy
// (src/core/dms/policy) imports these, and the Swift and Kotlin text tests read them, so nothing
// else in the repo may define them. README.md restates each one; `contract.test.ts` keeps it honest.

/**
 * The 38 float32 fields of one frame record, in wire order (plan "Wire contract v1", rev2: R1-I1).
 *
 * Field 0 is `tOffMs`, the record's time relative to the batch header's `anchorTMs` (a float64, the
 * FIRST record's clock value), so it is ≥ 0 and under about a second (Task 1 review C1). The record
 * clock counts from device boot, and float32 holds whole milliseconds only up to 2^24 ms (4.66 h),
 * so an absolute float32 time would quantise every duration to 8 ms after a day of uptime and 64 ms
 * after a week. The decoder rebuilds `tMs = anchorTMs + tOffMs` in double precision.
 */
export const FRAME_FIELDS = [
  'tOffMs',
  'face',
  'boxCx',
  'boxCy',
  'boxW',
  'boxH',
  'iod',
  'headYaw',
  'headPitch',
  'headRoll',
  'netYaw',
  'netPitch',
  'earR',
  'earL',
  'eyeWR',
  'eyeWL',
  'eyeLumaR',
  'eyeLumaL',
  'irisContrastR',
  'irisContrastL',
  'eyeSatR',
  'eyeSatL',
  'irisOxR',
  'irisOyR',
  'irisOxL',
  'irisOyL',
  'irisInR',
  'irisInL',
  'faceLuma',
  'blur',
  'mar',
  'mouthW',
  'frameLuma',
  'rotationDeg',
  'latLandmarkMs',
  'latTotalMs',
  'flags',
  'reserved',
] as const;

export type FrameField = (typeof FRAME_FIELDS)[number];

/**
 * When a field is NaN ("not computed"), and it must be NaN exactly then — never a stale finite
 * value, never NaN otherwise:
 * - A always finite;
 * - F NaN ⇔ face = 0;
 * - P NaN ⇔ face = 0 or POSE_MISSING;
 * - N finite ⇔ NET_RAN;
 * - R / L NaN ⇔ face = 0 or EYE_CLIPPED_R / EYE_CLIPPED_L;
 * - M NaN ⇔ face = 0 or MOUTH_CLIPPED.
 */
export type MaskClass = 'A' | 'F' | 'P' | 'N' | 'R' | 'L' | 'M';

const MASK_BY_FIELD: Readonly<Record<FrameField, MaskClass>> = {
  tOffMs: 'A',
  face: 'A',
  boxCx: 'F',
  boxCy: 'F',
  boxW: 'F',
  boxH: 'F',
  iod: 'F',
  headYaw: 'P',
  headPitch: 'P',
  headRoll: 'P',
  netYaw: 'N',
  netPitch: 'N',
  earR: 'R',
  earL: 'L',
  eyeWR: 'R',
  eyeWL: 'L',
  eyeLumaR: 'R',
  eyeLumaL: 'L',
  irisContrastR: 'R',
  irisContrastL: 'L',
  eyeSatR: 'R',
  eyeSatL: 'L',
  irisOxR: 'R',
  irisOyR: 'R',
  irisOxL: 'L',
  irisOyL: 'L',
  irisInR: 'F',
  irisInL: 'F',
  faceLuma: 'F',
  blur: 'F',
  mar: 'M',
  mouthW: 'M',
  frameLuma: 'A',
  rotationDeg: 'A',
  latLandmarkMs: 'A',
  latTotalMs: 'A',
  flags: 'A',
  reserved: 'A',
};

export const FRAME_MASK: readonly MaskClass[] = FRAME_FIELDS.map((f) => MASK_BY_FIELD[f]);

export const FRAME_STRIDE = 38;
export const FRAME_BYTES = FRAME_STRIDE * 4; // 152
export const FRAME_WIRE_VERSION = 1;

/** Record flag bits. With face = 0 the flags must be 0. */
export const FLAG = {
  NET_RAN: 1,
  EYE_CLIPPED_R: 2,
  EYE_CLIPPED_L: 4,
  MOUTH_CLIPPED: 8,
  POSE_MISSING: 16,
} as const;
export const FLAGS_ALL = 31;

export const ALLOWED_FPS = [5, 8, 10, 15] as const;
export type DmsFps = (typeof ALLOWED_FPS)[number];
export const ALLOWED_ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ALLOWED_ROTATIONS)[number];

/**
 * A record more than this after its batch's anchor is implausible (a batch spans BATCH_MS) and is
 * dropped: it also keeps `tOffMs` well inside float32's sub-microsecond range (Task 1 review).
 */
export const MAX_T_OFF_MS = 10_000;
/** Native flushes pending records to JS at most this often (plan rev1: m8). */
export const BATCH_MS = 100;
/** No `setPolicy` heartbeat for this long while running → native pauses (reason `watchdog`). */
export const WATCHDOG_PAUSE_MS = 10_000;
/** …and this much longer again with no heartbeat → native stops and releases everything. */
export const WATCHDOG_STOP_MS = 60_000;
/** Paused this long → native releases the models and stops (reason `released`). */
export const MODEL_RELEASE_AFTER_PAUSE_MS = 300_000;
/** Known speed below 10 km/h this long → the policy pauses the camera (checklist D22). */
export const PAUSE_AFTER_STOP_MS = 5_000;
/** The OS must report `fair` (Android MODERATE) this long before thermal level 1 applies (rev1: m9). */
export const THERMAL_L1_ENTRY_DWELL_MS = 60_000;
/** A cooler thermal state must hold this long before the floor steps down. */
export const THERMAL_COOL_DWELL_MS = 60_000;

export type ThermalName = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
export type ThermalLevel = 0 | 1 | 2 | 3;

export interface ThermalStep {
  level: ThermalLevel;
  /** iOS `ProcessInfo.ThermalState` names that map to this level. */
  ios: readonly string[];
  /** Android `PowerManager.THERMAL_STATUS_*` suffixes that map to this level. */
  android: readonly string[];
  /** 0 = camera off. */
  fpsCap: 0 | 8 | 15;
  gazeNet: boolean;
}

/**
 * The native thermal floor (design §3.5: 15 fps → 8 fps → landmarks only → off; "dim" is the HUD's
 * step 4, decided by the policy). `unknown` (Android below API 29) maps to level 0.
 */
export const THERMAL_FLOOR: readonly ThermalStep[] = [
  { level: 0, ios: ['nominal'], android: ['NONE', 'LIGHT'], fpsCap: 15, gazeNet: true },
  { level: 1, ios: ['fair'], android: ['MODERATE'], fpsCap: 8, gazeNet: true },
  { level: 2, ios: ['serious'], android: ['SEVERE'], fpsCap: 8, gazeNet: false },
  { level: 3, ios: ['critical'], android: ['CRITICAL', 'EMERGENCY', 'SHUTDOWN'], fpsCap: 0, gazeNet: false },
];

/** The level a thermal name maps to before any dwell. */
export function thermalLevelOf(name: ThermalName): ThermalLevel {
  switch (name) {
    case 'fair':
      return 1;
    case 'serious':
      return 2;
    case 'critical':
      return 3;
    default:
      return 0;
  }
}
