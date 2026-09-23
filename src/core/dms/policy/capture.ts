// The capture policy (plan "Budgets": capture states, the caps, speed classes and unknown speed; Task 13
// with rev1 I6, m9, m11 and rev2 R1-m1). Evaluated by the host on every 1 Hz row and every quality
// change; a pure function of its inputs and its own state: no timer, no clock, no native call (battery:
// nothing runs while the feature is armed but idle; the host decides when to evaluate).
//
// States, highest precedence first:
//   OFF            the gate is closed (no session, fps 0)
//   PAUSED         thermal L3 (reason `thermal`), the low-light suspend window (`low_light`), or a KNOWN
//                  speed < 10 km/h for PAUSE_AFTER_STOP_MS (`stopped`; never on a held or unknown speed)
//   SETUP          beginSetup() until endSetup() or 120 s: 15 fps, the net, the preview while stationary
//   SEARCH         the face LOST > 2 s at ≥ 10 km/h, or phone handling: 5 fps
//   HEAD_ONLY_RUN  ≥ 20 km/h with HEAD_ONLY ≥ 5 s: 10 fps
//   FULL           ≥ 20 km/h: 15 fps, the net every gazeNetEvery frame
//   CLOSURE_WATCH  below 20 km/h (not paused): 5 fps
// (SETUP outranks the `stopped` pause, since setup is done parked; L3 outranks everything but OFF.)
// Caps (lowest wins): the thermal floor (after its dwells: L1 only after `fair` for 60 s, L2/L3 at once,
// any cooler level only after holding 60 s; L4 = L3 for 120 s → dimAdvised), Low Power, and the battery
// below 20 % while not charging.
// Speed classes go up when the last 2 known rows reach a threshold and down after 3 known rows below the
// threshold − 2 km/h. Unknown speed (no fix, speed < 0, or a row older than 3 s) holds the last known
// class for 10 min with IMU motion, 10 s without, then CLOSURE_WATCH.
import {
  PAUSE_AFTER_STOP_MS,
  THERMAL_COOL_DWELL_MS,
  THERMAL_FLOOR,
  THERMAL_L1_ENTRY_DWELL_MS,
  thermalLevelOf,
  type DmsFps,
  type ThermalLevel,
  type ThermalName,
} from '../../../../modules/dms-vision/src/constants';
import {
  DOWN_MARGIN_KMH,
  DOWN_ROWS,
  FAST_KMH,
  HEAD_ONLY_RUN_MS,
  LOW_BATTERY_PCT,
  POWER_CAP_FPS,
  PREVIEW_STILL_KMH,
  PREVIEW_STILL_MS,
  ROW_STALE_MS,
  SEARCH_LOST_MS,
  SETUP_MAX_MS,
  SLOW_KMH,
  THERMAL_L4_AFTER_MS,
  UNKNOWN_HOLD_MOVING_MS,
  UNKNOWN_HOLD_STILL_MS,
  UP_ROWS,
} from './constants';

export type CaptureState = 'OFF' | 'PAUSED' | 'SEARCH' | 'CLOSURE_WATCH' | 'FULL' | 'HEAD_ONLY_RUN' | 'SETUP';

/** The Budgets' capture-state table, as data. */
export const STATE_TABLE: Readonly<Record<CaptureState, { camera: boolean; fps: 0 | DmsFps; gazeNet: boolean }>> = {
  OFF: { camera: false, fps: 0, gazeNet: false },
  PAUSED: { camera: false, fps: 0, gazeNet: false },
  SEARCH: { camera: true, fps: 5, gazeNet: false },
  CLOSURE_WATCH: { camera: true, fps: 5, gazeNet: false },
  FULL: { camera: true, fps: 15, gazeNet: true },
  HEAD_ONLY_RUN: { camera: true, fps: 10, gazeNet: false },
  SETUP: { camera: true, fps: 15, gazeNet: true },
};

/** The thermal ladder (15 → 8 → landmarks only → off → dim): the native floor plus the policy's L4. */
export const THERMAL_LADDER: readonly { level: 0 | 1 | 2 | 3 | 4; fpsCap: 0 | 8 | 15; gazeNet: boolean; dim: boolean }[] = [
  ...THERMAL_FLOOR.map((s) => ({ level: s.level, fpsCap: s.fpsCap, gazeNet: s.gazeNet, dim: false })),
  { level: 4, fpsCap: 0, gazeNet: false, dim: true },
];

export interface PolicyRow {
  /** host clock ms of the row */
  tMs: number;
  /** km/h when known (speed ≥ 0 and a valid fix); null = unknown */
  speedKmh: number | null;
  /** the drive engine's own ¬stillWithoutFix (rev2 R1-m1) */
  imuMoving: boolean;
  /** handlingScore ≥ 0.6 */
  handling: boolean;
}

export interface PolicyInput {
  tMs: number;
  gateOpen: boolean;
  /** the latest 1 Hz row (the same one until a new row arrives); null before any */
  row: PolicyRow | null;
  /** the engine's quality and how long it has held */
  quality: 'tracking' | 'head_only' | 'lost' | null;
  qualityForMs: number;
  /** the OS thermal state (native status) */
  thermal: ThermalName;
  lowPower: boolean;
  batteryLevel: number | null;
  charging: boolean | null;
  /** between beginSetup() and endSetup() */
  setup: boolean;
  /** the low-light suspend window (host-defined; see the report) */
  lowLightSuspend: boolean;
  gazeNetEvery: 1 | 2;
}

export interface PolicyOutput {
  action: 'off' | 'pause' | 'run';
  state: CaptureState;
  reason: 'gate' | 'thermal' | 'low_light' | 'stopped' | null;
  fps: 0 | DmsFps;
  gazeNet: boolean;
  gazeNetEvery: 1 | 2;
  setupMode: boolean;
  previewAllowed: boolean;
  dimAdvised: boolean;
  /** the thermal level in force, after the dwells (engine.setHost and the summary) */
  thermalLevel: ThermalLevel;
  /** SEARCH: the engine freezes D1/D2 (engine.setHost({ search })) */
  search: boolean;
  /**
   * True once, on the evaluation where thermal L3 turns the camera off while the car was running at speed:
   * the host ends the running alert sound then (T11 m1 carry), and keeps feeding rows.
   */
  stopAlerts: boolean;
}

type SpeedClass = 'stopped' | 'slow' | 'fast';
const RANK: Record<SpeedClass, number> = { stopped: 0, slow: 1, fast: 2 };
const classOf = (kmh: number): SpeedClass => (kmh >= FAST_KMH ? 'fast' : kmh >= SLOW_KMH ? 'slow' : 'stopped');
const downThreshold = (c: SpeedClass) => (c === 'fast' ? FAST_KMH : SLOW_KMH) - DOWN_MARGIN_KMH;

export function createCapturePolicy() {
  // Speed.
  let cls: SpeedClass | null = null;
  let lastRowT: number | null = null;
  const recentKnown: number[] = []; // the last known speeds (newest last), at most DOWN_ROWS
  let downCount = 0;
  let unknownSince: number | null = null;
  let unknownMoving = false;
  // The pause and the preview.
  let lowSince: number | null = null;
  let paused = false;
  let stillSince: number | null = null;
  // Setup.
  let setupSince: number | null = null;
  // Thermal.
  let applied: ThermalLevel = 0;
  let fairSince: number | null = null;
  let coolSince: number | null = null;
  let coolTarget: ThermalLevel = 0;
  let l3Since: number | null = null;
  let prevState: CaptureState = 'OFF';

  function onRow(r: PolicyRow): void {
    if (r.speedKmh === null) {
      unknownSince ??= r.tMs;
      unknownMoving = r.imuMoving;
      recentKnown.length = 0;
      downCount = 0;
      lowSince = null; // the pause never starts on an unknown speed (rev2 R1-m1)
      stillSince = null;
      if (paused && r.imuMoving) paused = false; // resume on IMU motion with unknown speed
      return;
    }
    const v = r.speedKmh;
    unknownSince = null;
    recentKnown.push(v);
    if (recentKnown.length > DOWN_ROWS) recentKnown.shift();
    if (cls === null) cls = classOf(v);
    else {
      // Up: the last UP_ROWS known rows all reach the higher class.
      const up = recentKnown.length >= UP_ROWS ? classOf(Math.min(...recentKnown.slice(-UP_ROWS))) : cls;
      if (RANK[up] > RANK[cls]) {
        cls = up;
        downCount = 0;
      } else if (v < downThreshold(cls)) {
        // Down: DOWN_ROWS consecutive rows below the threshold − 2 km/h.
        downCount++;
        if (downCount >= DOWN_ROWS) {
          cls = classOf(Math.max(...recentKnown.slice(-DOWN_ROWS)));
          downCount = 0;
        }
      } else downCount = 0;
    }
    if (v < SLOW_KMH) lowSince ??= r.tMs;
    else {
      lowSince = null;
      paused = false; // resume on the first row ≥ 10 km/h
    }
    stillSince = v < PREVIEW_STILL_KMH ? (stillSince ?? r.tMs) : null;
  }

  /** The speed class at `t`: known, held under the unknown-speed rules, or CLOSURE_WATCH's. */
  function classAt(t: number, row: PolicyRow | null): SpeedClass {
    let since = unknownSince;
    let moving = unknownMoving;
    if (row !== null && t - row.tMs > ROW_STALE_MS) {
      since ??= row.tMs + ROW_STALE_MS;
      moving = row.imuMoving;
    }
    if (row === null) return cls ?? 'slow';
    if (since === null) return cls ?? 'slow';
    const hold = moving ? UNKNOWN_HOLD_MOVING_MS : UNKNOWN_HOLD_STILL_MS;
    return t - since <= hold && cls !== null ? cls : 'slow';
  }

  function thermal(t: number, name: ThermalName): void {
    const raw = thermalLevelOf(name);
    fairSince = raw >= 1 ? (fairSince ?? t) : null;
    if (raw > applied) {
      coolSince = null;
      if (raw >= 2) applied = raw;
      else if (fairSince !== null && t - fairSince >= THERMAL_L1_ENTRY_DWELL_MS) applied = 1; // rev1 m9
    } else if (raw < applied) {
      if (coolSince === null) {
        coolSince = t;
        coolTarget = raw;
      } else coolTarget = Math.max(coolTarget, raw) as ThermalLevel;
      if (t - coolSince >= THERMAL_COOL_DWELL_MS) {
        applied = coolTarget;
        coolSince = null;
      }
    } else coolSince = null;
    l3Since = applied === 3 ? (l3Since ?? t) : null;
  }

  return {
    next(x: PolicyInput): PolicyOutput {
      if (x.row !== null && x.row.tMs !== lastRowT) {
        lastRowT = x.row.tMs;
        onRow(x.row);
      }
      thermal(x.tMs, x.thermal);
      const speedClass = classAt(x.tMs, x.row);
      const rowFresh = x.row !== null && x.tMs - x.row.tMs <= ROW_STALE_MS && x.row.speedKmh !== null;
      if (!paused && rowFresh && lowSince !== null && x.tMs - lowSince >= PAUSE_AFTER_STOP_MS) paused = true;
      if (x.setup) setupSince ??= x.tMs;
      else setupSince = null;
      const inSetup = setupSince !== null && x.tMs - setupSince < SETUP_MAX_MS;

      let state: CaptureState;
      let reason: PolicyOutput['reason'] = null;
      if (!x.gateOpen) {
        state = 'OFF';
        reason = 'gate';
      } else if (applied === 3) {
        state = 'PAUSED';
        reason = 'thermal';
      } else if (inSetup) state = 'SETUP';
      else if (x.lowLightSuspend) {
        state = 'PAUSED';
        reason = 'low_light';
      } else if (paused) {
        state = 'PAUSED';
        reason = 'stopped';
      } else if ((x.quality === 'lost' && x.qualityForMs > SEARCH_LOST_MS && speedClass !== 'stopped') || x.row?.handling === true) state = 'SEARCH';
      else if (speedClass === 'fast') state = x.quality === 'head_only' && x.qualityForMs >= HEAD_ONLY_RUN_MS ? 'HEAD_ONLY_RUN' : 'FULL';
      else state = 'CLOSURE_WATCH';

      // The caps, lowest wins.
      const floor = THERMAL_FLOOR[applied]!;
      const row = STATE_TABLE[state];
      let fps: 0 | DmsFps = row.fps;
      if (fps !== 0) {
        let cap: number = floor.fpsCap;
        if (x.lowPower) cap = Math.min(cap, POWER_CAP_FPS);
        if (x.batteryLevel !== null && x.batteryLevel < LOW_BATTERY_PCT && x.charging !== true) cap = Math.min(cap, POWER_CAP_FPS);
        fps = Math.min(fps, cap) as DmsFps;
      }
      const running = prevState === 'SEARCH' || prevState === 'CLOSURE_WATCH' || prevState === 'FULL' || prevState === 'HEAD_ONLY_RUN';
      const stopAlerts = state === 'PAUSED' && reason === 'thermal' && running && speedClass !== 'stopped';
      prevState = state;
      return {
        action: state === 'OFF' ? 'off' : state === 'PAUSED' ? 'pause' : 'run',
        state,
        reason,
        fps,
        gazeNet: row.gazeNet && floor.gazeNet,
        gazeNetEvery: x.gazeNetEvery,
        setupMode: state === 'SETUP',
        previewAllowed: state === 'SETUP' && stillSince !== null && rowFresh && x.tMs - stillSince >= PREVIEW_STILL_MS,
        dimAdvised: l3Since !== null && x.tMs - l3Since >= THERMAL_L4_AFTER_MS,
        thermalLevel: applied,
        search: state === 'SEARCH',
        stopAlerts,
      };
    },
  };
}

/**
 * The native `setPolicy` argument for a run or pause decision (null for OFF: the host stops native). A
 * paused policy still carries a valid fps (5), which native ignores while paused.
 */
export function nativePolicy(out: PolicyOutput, gateToken: string): { gateToken: string; capture: 'run' | 'pause'; fps: DmsFps; gazeNet: boolean; gazeNetEvery: 1 | 2; setupMode: boolean; previewAllowed: boolean } | null {
  if (out.action === 'off') return null;
  return {
    gateToken,
    capture: out.action === 'run' ? 'run' : 'pause',
    fps: out.fps === 0 ? 5 : out.fps,
    gazeNet: out.gazeNet,
    gazeNetEvery: out.gazeNetEvery,
    setupMode: out.setupMode,
    previewAllowed: out.previewAllowed,
  };
}
