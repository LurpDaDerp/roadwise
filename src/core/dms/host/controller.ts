// The DMS host controller (plan "Bridge API", Task 14): the one object M7 plugs into. It owns the native
// module's lifecycle, the privacy gate, the capture policy and the engine, and it is fail-closed:
// - No native call at all (getPermission included) unless every gate input but the permission holds; the
//   permission is read from native only then, and again on every row while running (rev1 S-M4).
// - One gate per controller (M7 builds one controller per signed-in uid and disposes it on sign-out or an
//   account switch: security M-2/M-4), evaluated on every input change. The nonce is a CSPRNG UUID
//   (expo-crypto), never logged or stored; a gate that throws is closed (security M-3).
// - A drive end closes first (security T14 I-1): endDrive() sets the drive inactive, runs the gate (the
//   latch edge: the remote flag is read again at the next drive start) and stops native, synchronously,
//   before it awaits anything. dispose() marks the controller closing (setGate, pushRow and a queued open
//   are then ignored) and stops native first, then ends the drive.
// - Every user or OS input (opt-out, role, mode, app state, a revoked permission, a permission read that
//   fails, a native permission error) stops native at once: the stop is called directly, never behind the
//   queue (security T14 m-2); a start still in flight is stopped again once it settles. Every open ->
//   closed transition also stops the sound (engine.stopAlerts; T14 r1 I1): monitoring ended, the drive
//   goes on. The policy's own pauses do not (a known stop ends a Critical; heat and dark are cameraOff).
// - Native failures are silent (SR9): one retry 5 s later (row-driven: no timer), then off for the drive.
//   A failure caused by our own stop (a setPolicy that lost the race) is not a failure. A fault while the
//   camera ran is the camera going off at speed (engine.cameraOff 'fault'; T14 r2 R1-m1), and a fault while
//   the permission is being read waits for its retry (R1-m3).
// - One native owner (T15 r2 seat m1): with an owner slot (createDefaultDmsController), the slot is taken
//   before the first native call of a drive and given back at its end and on dispose; a controller that
//   cannot take it is closed (`busy`), makes no native call and ignores the other session's events.
// - The capture policy is evaluated on every 1 Hz row, and its decision is sent as setPolicy: that is also
//   native's heartbeat. The policy's cameraOff edge calls engine.cameraOff (a Critical is kept; T13 r1 I1).
// - Frames and rows share the epoch clock: a record's clock moves by its native session's anchor offset,
//   and the decoder's last-accepted time resets on every new session (T1r1 m1). Rows keep feeding the
//   engine while the camera is off, so a running Critical still ends on a known low speed.
// - The engine is created on the first gate open of a drive, and the drive's last 10 rows are replayed into
//   it at once (T14 r1 m1: the last known speed for the tunnel hold, the straight flag, the course rate).
// - Everything per drive is reset at its end and at the engine's creation (T14 r1 I2): the focus queue
//   (its remaining samples go out with the summary as `pendingFocus`), the quality clocks, the last frame,
//   the alert-start time and the decoder's session state.
// - Commands go to onAlert and events to onEvent; a throwing callback never breaks the controller.
// - The HUD status (T14 r1 m3): `active` with TRACKING in the last 1 s, or HEAD_ONLY for under 10 s;
//   HEAD_ONLY for 10 s or more is `limited` / `eyes_not_visible` (the eye-closure rules are paused);
//   no good frame in 1 s is `limited` / `low_light` when the engine says the LOST frames are dark, else
//   `face_lost`.
import { randomUUID } from 'expo-crypto';
import type { FeatureRow, CameraFocusSample } from '@/core/engine/types';
import type { ThermalName } from '../../../../modules/dms-vision/src/constants';
import type { NativeState, DmsVisionApi, Subscription } from '../../../../modules/dms-vision/src/types';
import { decodeFrameBatch } from '../../../../modules/dms-vision/src/wire';
import { createFocusQueue } from '../adapters/focus';
import type { DmsAlertCommand } from '../engine/alerts';
import type { CalibrationState } from '../engine/calibration';
import { resolveDmsConfig, type DmsConfig, type DmsConfigOverrides } from '../engine/config';
import { createDmsEngine, type DmsEngine, type DmsEvent } from '../engine/engine';
import type { FatigueLevel } from '../engine/fatigue';
import { parseProfile } from '../engine/profile';
import type { Quality } from '../engine/quality';
import type { DmsTripSummary } from '../engine/summary';
import type { EngineFrame, Sensitivity, DriverSide } from '../engine/types';
import { RingBuffer } from '../engine/windows';
import { createCapturePolicy, nativePolicy, type PolicyOutput } from '../policy/capture';
import { createGate, type DmsGate, type GateClosedReason, type GateToken, type PermissionStatus } from '../policy/gate';
import { engineFrame } from './frames';
import { gatedNative } from './native';
import type { DmsProfileStore } from './profileStore';
import { policyRow, rowExtras } from './rowContext';

export interface DmsGateInputs extends DmsGate {
  driverSide: DriverSide;
  sensitivity: Sensitivity;
  alerts: 'live' | 'shadow';
}

export interface DmsHostPower {
  batteryLevel: number | null;
  charging: boolean | null;
  /** local minutes since midnight; null when unknown (never 0, which is night) */
  localMinutes: number | null;
}

export interface DmsHudStatus {
  camera: 'off' | 'starting' | 'active' | 'limited' | 'paused';
  reason: GateClosedReason | 'error' | 'busy' | 'thermal' | 'low_light' | 'stopped' | 'face_lost' | 'eyes_not_visible' | null;
  calibration: CalibrationState | null;
  fatigueLevel: FatigueLevel;
  dimAdvised: boolean;
}

export interface DmsSetupCheck {
  faceVisible: boolean | 'unknown';
  bothEyesTracked: boolean | 'unknown';
  lightingOk: boolean | 'unknown';
  angleOk: boolean | 'unknown';
  phoneSteady: boolean | 'unknown';
}

export type DmsSeedResult = { ok: true; warmStart: false } | { ok: false; reason: string };

export type DmsHostSummary = DmsTripSummary & {
  camera: { starts: number; retries: number; gaveUp: boolean };
  /**
   * The focus samples not yet handed out by pushRow when the drive ended (T14 r1 I2): M7 gives them to the
   * ending trip's scoring (drowsiness samples are never dropped). Empty on summary() mid-drive.
   */
  pendingFocus: CameraFocusSample[];
};

/** Native's own report, as the dev panel shows it: rates and states only. */
export interface DmsNativeView {
  fpsActual: number;
  fpsTarget: number;
  thermal: ThermalName;
  gazeNetAvailable: boolean;
  gazeNetOn: boolean;
}

export interface DmsHostDiagnostics {
  droppedBatches: number;
  droppedRecords: number;
  frames: number;
  /** the engine's rule speed at its last frame (null: unknown, or no engine) */
  ruleSpeedKmh: number | null;
  /** native's last status event, or null before one */
  native: DmsNativeView | null;
}

export interface DmsControllerDeps {
  native: DmsVisionApi;
  onAlert(cmd: DmsAlertCommand): void;
  onStatus(s: DmsHudStatus): void;
  onEvent?(e: DmsEvent): void;
  /** createSettingsProfileStore(settings, uid) for the signed-in uid (rev1 S-M2) */
  profileStore: Pick<DmsProfileStore, 'save' | 'clear'> & { load(): Promise<unknown> };
  config?: DmsConfigOverrides;
  /** the gate's nonce source; default expo-crypto randomUUID (security M-3) */
  random?: () => string;
  /**
   * The native module's one owner (T15 r2 seat m1): acquired before the first native call of a drive, released
   * at its end and on dispose. A controller that cannot acquire it stays closed (`busy`) with no native call.
   * createDefaultDmsController passes the module-wide slot; tests with their own fake pass none.
   */
  owner?: DmsNativeOwner;
}

export interface DmsNativeOwner {
  /** true when this controller holds (or now takes) the native module */
  acquire(): boolean;
  release(): void;
}

export interface DmsController {
  setGate(g: DmsGateInputs): void;
  pushRow(row: FeatureRow, power: DmsHostPower): CameraFocusSample | null;
  beginSetup(): void;
  endSetup(): void;
  setupCheck(): DmsSetupCheck;
  seedFromSetup(): DmsSeedResult;
  tagLastAlert(tag: 'wrong'): void;
  status(): DmsHudStatus;
  summary(): DmsHostSummary | null;
  /** Ends the drive (closing the gate first) and returns its summary, or null when no engine ran. */
  endDrive(): Promise<DmsHostSummary | null>;
  dispose(): Promise<void>;
  /**
   * Shows the OS camera prompt, only when the permission is the one input closing the gate (every other
   * input holds); otherwise null and no native call. The gate is evaluated again after the answer.
   */
  requestPermission(): Promise<PermissionStatus | null>;
  /** Resolves once the queued native calls have settled (tests and the dev panel). */
  idle(): Promise<void>;
  diagnostics(): DmsHostDiagnostics;
}

const RETRY_AFTER_MS = 5_000;
const ACTIVE_WITHIN_MS = 1_000;
/** HEAD_ONLY this long (the C-7 notice time) is `limited` / `eyes_not_visible` (T14 r1 m3). */
const EYES_NOT_VISIBLE_MS = 10_000;
/** A drowsiness sample's length is capped at the queue's scale (a drowsy minute is 60 s; T14 r1 m2). */
const EPISODE_MAX_S = 60;
/** The rows replayed into an engine created mid-drive (T14 r1 m1). */
const REPLAY_ROWS = 10;

export function createDmsController(deps: DmsControllerDeps): DmsController {
  const cfg: DmsConfig = resolveDmsConfig(deps.config ?? {});
  const native = gatedNative(deps.native);
  const gate = createGate(deps.random ?? (() => randomUUID()));
  let inputs: DmsGateInputs | null = null;
  let closedReason: GateClosedReason | 'error' | 'busy' | null = 'no_drive';
  let token: GateToken | null = null;
  let disposed = false;
  /** dispose() has begun: every input is ignored from here (security T14 I-1) */
  let closing = false;
  let nativeState: NativeState = 'stopped';
  /** the state as native last reported it (its own session edges; ours runs ahead of it) */
  let reported: NativeState = 'stopped';
  let policy = createCapturePolicy();
  let lastOut: PolicyOutput | null = null;
  let setup = false;
  // The drive's engine: created on the first gate open of a drive.
  let engine: DmsEngine | null = null;
  let creating: Promise<void> | null = null;
  let driveStartTs: number | null = null;
  let lastSummary: DmsHostSummary | null = null;
  let lastRow: FeatureRow | null = null;
  // Frames.
  let lastTMs: number | null = null;
  let sessionOffset: number | null = null;
  let quality: Quality | null = null;
  let qualitySince = 0;
  let lastGoodT = Number.NEGATIVE_INFINITY;
  let lastFrame: EngineFrame | null = null;
  let lastTrackingT = Number.NEGATIVE_INFINITY;
  /** the first HEAD_ONLY frame since the last TRACKING one */
  let headOnlySince: number | null = null;
  const qualities = new RingBuffer<{ t: number; tracking: boolean }>(60 * 30);
  const recent = new RingBuffer<{ row: FeatureRow; power: DmsHostPower }>(REPLAY_ROWS);
  // Native status.
  let thermal: ThermalName = 'nominal';
  let lowPower = false;
  let nativeView: DmsNativeView | null = null;
  // Failures (SR9).
  let errorAt: number | null = null;
  let retries = 0;
  let gaveUp = false;
  let starts = 0;
  // Stats, focus, status.
  const stats = { droppedBatches: 0, droppedRecords: 0, frames: 0 };
  let focus = createFocusQueue(cfg);
  let lastAlertStartT: number | null = null;
  let lastStatusJson = '';

  /** Every per-drive field back to its initial value (T14 r1 I2). */
  function resetDrive(): void {
    focus = createFocusQueue(cfg);
    quality = null;
    qualitySince = 0;
    lastGoodT = Number.NEGATIVE_INFINITY;
    lastTrackingT = Number.NEGATIVE_INFINITY;
    headOnlySince = null;
    lastFrame = null;
    qualities.clear();
    lastAlertStartT = null;
    lastTMs = null;
    sessionOffset = null;
  }

  let ops: Promise<void> = Promise.resolve();
  const enqueue = (f: () => Promise<void>) => {
    ops = ops.then(f).catch(() => undefined);
  };
  const now = () => Math.max(lastRow?.ts ?? 0, lastFrame?.tMs ?? 0);

  // ---------------------------------------------------------------------------------------------
  // Output: commands, events, focus samples and the status.
  // ---------------------------------------------------------------------------------------------

  function dispatch(): void {
    if (engine === null) return;
    const out = engine.drain();
    for (const c of out.commands) {
      if (c.action === 'start') lastAlertStartT = c.tMs;
      try {
        deps.onAlert(c);
      } catch {
        // the player's bug is never the controller's
      }
    }
    for (const e of out.events) {
      try {
        deps.onEvent?.(e);
      } catch {
        // ditto
      }
      if (e.kind === 'glance_end' && 'zone' in e && e.zone !== undefined && e.durS !== undefined) {
        const from = e.tMs - e.durS * 1000;
        let n = 0;
        let tracked = 0;
        qualities.forEach((q) => {
          if (q.t >= from && q.t <= e.tMs) {
            n++;
            if (q.tracking) tracked++;
          }
        });
        focus.glance({ endT: e.tMs, durS: e.durS, zone: e.zone, shoulderCheck: e.shoulderCheck === true }, { trackingShare: n > 0 ? tracked / n : 0, calibrated: engine.snapshot().calibration === 'calibrated', lastAlertStartT });
      } else if (e.kind === 'microsleep_nod') {
        // A nod-off is its own drowsiness episode, with no closure episode (T14 r2 R1-m2).
        focus.drowsiness(Math.max(0.5, Math.min(EPISODE_MAX_S, e.deepMaxS)));
      } else if (e.kind === 'episode_end') {
        // One sample per closure episode that reached F1-F3, with its measured length (T14 r1 m2).
        focus.drowsiness(Math.min(EPISODE_MAX_S, e.durMs / 1000));
      } else if (e.kind === 'fatigue_minute' && 'level' in e && (e.level === 'drowsy' || e.level === 'severe')) {
        focus.drowsiness(60);
      }
    }
  }

  function computeStatus(): DmsHudStatus {
    const snap = engine?.snapshot() ?? null;
    const base = { calibration: snap?.calibration ?? null, fatigueLevel: snap?.fatigueLevel ?? ('none' as FatigueLevel), dimAdvised: lastOut?.dimAdvised ?? false };
    if (gaveUp) return { camera: 'off', reason: 'error', ...base };
    if (closedReason !== null || token === null) return { camera: 'off', reason: closedReason ?? null, ...base };
    if (lastOut?.action === 'pause') return { camera: 'paused', reason: lastOut.reason === 'gate' ? null : lastOut.reason, ...base };
    if (nativeState !== 'running') return { camera: 'starting', reason: null, ...base };
    const t = now();
    if (t - lastTrackingT <= ACTIVE_WITHIN_MS) return { camera: 'active', reason: null, ...base };
    if (t - lastGoodT <= ACTIVE_WITHIN_MS) {
      // HEAD_ONLY: the eye-closure rules are paused; short runs (a glance, sunglasses pushed up) stay active.
      if (headOnlySince !== null && t - headOnlySince >= EYES_NOT_VISIBLE_MS) return { camera: 'limited', reason: 'eyes_not_visible', ...base };
      return { camera: 'active', reason: null, ...base };
    }
    return { camera: 'limited', reason: snap?.lostLowLight === true ? 'low_light' : 'face_lost', ...base };
  }

  function publishStatus(): void {
    const s = computeStatus();
    const json = JSON.stringify(s);
    if (json === lastStatusJson) return;
    lastStatusJson = json;
    try {
      deps.onStatus(s);
    } catch {
      // ditto
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Native.
  // ---------------------------------------------------------------------------------------------

  /** This controller holds the native module (always, without an owner slot). */
  let held = false;
  const mine = () => deps.owner === undefined || held;
  function releaseOwner(): void {
    if (deps.owner === undefined || !held) return;
    held = false;
    deps.owner.release();
  }

  function stopNative(): void {
    token = null;
    // Not the owner: another controller's session is none of ours to stop (T15 r2 seat m1).
    if (!mine()) nativeState = 'stopped';
    if (nativeState === 'stopped') return;
    const startInFlight = nativeState === 'starting';
    nativeState = 'stopped';
    // At once, never behind a pending call (security T14 m-2); a start still in flight is stopped again
    // once it settles.
    void native.stop().catch(() => undefined);
    if (startInFlight) enqueue(() => native.stop());
  }

  /**
   * The gate is closed for `reason`: native stops, and an open -> closed transition also stops the sound
   * (T14 r1 I1). Not for drive end (the engine's endDrive stops it) or the policy's pauses.
   */
  function closeGate(reason: GateClosedReason | 'error' | 'busy'): void {
    const wasOpen = closedReason === null;
    closedReason = reason;
    stopNative();
    if (wasOpen && engine !== null) {
      engine.stopAlerts(now());
      dispatch();
    }
    publishStatus();
  }

  /** A native failure; `wasRunning`: the camera was delivering frames when it failed. */
  function failed(code: string | undefined, wasRunning: boolean): void {
    if (code === 'E_PERMISSION') {
      closeGate('permission');
      return;
    }
    if (code === 'E_NOT_FOREGROUND') return; // the app state closes the gate
    if (retries >= 1) gaveUp = true;
    errorAt = lastRow?.ts ?? 0;
    stopNative();
    // The camera went off at speed, as with heat or the dark (T14 r2 R1-m1): a distraction stops, a Critical
    // is kept (bounded by the blind cap). The retry's frames clear the blind clock.
    if (wasRunning && engine !== null) {
      engine.cameraOff(now(), 'fault');
      dispatch();
    }
  }

  async function ensureEngine(g: DmsGateInputs): Promise<void> {
    if (engine !== null) return;
    creating ??= (async () => {
      let stored: unknown = null;
      try {
        stored = await deps.profileStore.load();
      } catch {
        stored = null;
      }
      let source: 'geometric' | 'net' = 'geometric';
      if (cfg.gazeSource === 'net') {
        try {
          source = (await deps.native.getModelInfo()).gazeNetAvailable ? 'net' : 'geometric';
        } catch {
          source = 'geometric';
        }
      }
      const e = createDmsEngine({ ...cfg, gazeSource: source }, { driverSide: g.driverSide, sensitivity: g.sensitivity, alerts: g.alerts, profile: parseProfile(stored) });
      resetDrive();
      // The drive's last rows, so the engine starts with the last known speed, the straight flag and the
      // course rate (T14 r1 m1). Rows only: no frame came before the engine.
      driveStartTs = recent.first()?.row.ts ?? lastRow?.ts ?? null;
      recent.forEach(({ row, power }) => e.pushRow(row, rowExtras(row, power, driveSeconds(row)), row.ts));
      engine = e;
      dispatch();
    })();
    await creating;
    creating = null;
  }

  const driveSeconds = (row: FeatureRow) => (driveStartTs === null ? 0 : Math.max(0, (row.ts - driveStartTs) / 1000));

  /** Open (after reading the permission), start if needed, and send the policy. */
  function openAndApply(): void {
    enqueue(async () => {
      if (disposed || closing || inputs === null || gaveUp || errorAt !== null) return;
      let perm: PermissionStatus;
      try {
        perm = (await deps.native.getPermission()).status;
      } catch {
        // A permission read that fails is a closed permission (security T14 m-2).
        if (!disposed) closeGate('permission');
        return;
      }
      // Re-checked after the await (T14 r2 R1-m3): a native fault meanwhile waits for its retry.
      if (disposed || closing || inputs === null || gaveUp || errorAt !== null) return;
      let open: GateToken | null = null;
      let reason: GateClosedReason | 'error' = 'error';
      try {
        const r = gate.gateOpen(inputs, perm);
        if (r.open) open = r.token;
        else reason = r.reason;
      } catch {
        reason = 'error'; // a gate that throws is closed (security M-3)
      }
      if (open === null) {
        closeGate(reason);
        return;
      }
      closedReason = null;
      token = open;
      await ensureEngine(inputs);
      // Closed, or a native fault, while the engine was made: nothing starts.
      if (token !== open || disposed || closing || gaveUp || errorAt !== null) return;
      const out = lastOut;
      if (out !== null && out.action === 'off') return;
      try {
        if (nativeState === 'stopped') {
          starts++;
          nativeState = 'starting';
          await native.start({ gateToken: open, fps: out !== null && out.fps !== 0 ? out.fps : 5, gazeNet: out?.gazeNet ?? false, gazeNetEvery: out?.gazeNetEvery ?? cfg.gazeNetEvery, delegate: 'cpu', rotationOffsetDegrees: 0 });
          if (nativeState === 'starting') nativeState = 'running';
        }
        const p = out === null || token !== open ? null : nativePolicy(out, open);
        if (p !== null) await native.setPolicy(p);
      } catch (e) {
        if (nativeState === 'starting') nativeState = 'stopped';
        // A call that lost the race with our own stop is not a native failure.
        if (token === open) failed((e as { code?: string }).code, reported === 'running' || reported === 'paused');
      }
      publishStatus();
    });
  }

  /** The synchronous gate check: no native call unless every input but the permission holds. */
  function evaluate(): boolean {
    if (disposed || closing || inputs === null) return false;
    let reason: GateClosedReason | 'error' | null;
    try {
      reason = gate.check(inputs, 'granted');
    } catch {
      reason = 'error';
    }
    if (reason !== null) {
      closeGate(reason);
      return false;
    }
    // One native owner (T15 r2 seat m1): before any native call, the permission read included.
    if (deps.owner !== undefined && !held) {
      if (!deps.owner.acquire()) {
        closeGate('busy');
        return false;
      }
      held = true;
    }
    return true;
  }

  /** endDrive's body, also run by dispose(). */
  async function endDriveNow(): Promise<DmsHostSummary | null> {
    // Close first, synchronously (security T14 I-1): the drive is over, the gate sees it (the latch edge),
    // and native stops before anything is awaited.
    let reason: GateClosedReason | 'error' | null = 'no_drive';
    if (inputs !== null) {
      inputs = { ...inputs, driveActive: false };
      try {
        reason = gate.check(inputs, 'granted');
      } catch {
        reason = 'error';
      }
    }
    closedReason = reason ?? 'no_drive';
    stopNative();
    await ops;
    if (creating !== null) await creating;
    let summary: DmsHostSummary | null = null;
    if (engine !== null) {
      const r = engine.endDrive(now());
      dispatch(); // the stops, and the sample of an F episode still open
      const pendingFocus: CameraFocusSample[] = [];
      for (let f = focus.take(); f !== null; f = focus.take()) pendingFocus.push(f);
      if (r.profile !== null && r.summary.calibration.state === 'calibrated') {
        try {
          await deps.profileStore.save(r.profile);
        } catch {
          // a failed save leaves the next drive to calibrate afresh
        }
      }
      summary = { ...r.summary, camera: { starts, retries, gaveUp }, pendingFocus };
      lastSummary = summary;
      engine = null;
    }
    policy = createCapturePolicy();
    lastOut = null;
    errorAt = null;
    retries = 0;
    gaveUp = false;
    starts = 0;
    driveStartTs = null;
    resetDrive();
    recent.clear();
    await ops;
    releaseOwner(); // the camera is stopped: another controller may take it (T15 r2 seat m1)
    publishStatus();
    return summary;
  }

  const subs: Subscription[] = [
    deps.native.addListener('frames', (raw) => {
      if (disposed || engine === null || !mine()) return;
      const res = decodeFrameBatch(raw, lastTMs);
      if (res.batch === null) {
        stats.droppedBatches++;
        return;
      }
      stats.droppedRecords += res.droppedRecords;
      lastTMs = res.lastTMs;
      sessionOffset ??= res.batch.anchorEpochMs - res.batch.anchorTMs;
      for (const f of res.batch.frames) {
        const ef = engineFrame(f, sessionOffset);
        engine.pushFrame(ef);
        stats.frames++;
        lastFrame = ef;
        const q = engine.snapshot().quality;
        if (q !== quality) {
          quality = q;
          qualitySince = ef.tMs;
        }
        if (q === 'tracking' || q === 'head_only') lastGoodT = ef.tMs;
        if (q === 'tracking') {
          lastTrackingT = ef.tMs;
          headOnlySince = null;
        } else if (q === 'head_only') headOnlySince ??= ef.tMs;
        qualities.push({ t: ef.tMs, tracking: q === 'tracking' });
      }
      dispatch();
      publishStatus();
    }),
    deps.native.addListener('state', (ev) => {
      if (!mine()) return; // another controller's session
      const prev = reported;
      reported = ev.state;
      nativeState = ev.state;
      // A new native session: its clock may restart on another base (T1r1 m1).
      if ((ev.state === 'starting' || ev.state === 'running') && prev === 'stopped') {
        lastTMs = null;
        sessionOffset = null;
      }
      if (ev.state === 'stopped' && ev.reason === 'error') failed('E_CAMERA', prev === 'running' || prev === 'paused');
      if (ev.state === 'stopped' && ev.reason === 'permission') failed('E_PERMISSION', false);
      if (ev.state === 'stopped') token = null;
      publishStatus();
    }),
    deps.native.addListener('status', (s) => {
      if (!mine()) return;
      thermal = s.thermal;
      lowPower = s.lowPower;
      nativeView = { fpsActual: s.fpsActual, fpsTarget: s.fpsTarget, thermal: s.thermal, gazeNetAvailable: s.gazeNetAvailable, gazeNetOn: s.gazeNetOn };
    }),
  ];

  return {
    setGate(g) {
      if (disposed || closing) return;
      inputs = { ...g };
      if (evaluate()) openAndApply();
    },

    pushRow(row, power) {
      if (disposed || closing) return null;
      lastRow = row;
      recent.push({ row, power });
      if (errorAt !== null && !gaveUp && row.ts - errorAt >= RETRY_AFTER_MS) {
        errorAt = null;
        retries++;
      }
      const open = evaluate();
      const snap = engine?.snapshot() ?? null;
      const out = policy.next({
        tMs: row.ts,
        gateOpen: open,
        row: policyRow(row),
        quality,
        qualityForMs: quality === null ? 0 : Math.max(0, now() - qualitySince),
        thermal,
        lowPower,
        batteryLevel: power.batteryLevel,
        charging: power.charging,
        setup,
        lostLowLight: snap?.lostLowLight ?? false,
        gazeNetEvery: cfg.gazeNetEvery,
      });
      lastOut = out;
      if (engine !== null) {
        if (out.cameraOff !== null) engine.cameraOff(row.ts, out.cameraOff);
        engine.setHost({ thermalLevel: out.thermalLevel, search: out.search, gazeNetEvery: out.gazeNetEvery });
        engine.pushRow(row, rowExtras(row, power, driveSeconds(row)), row.ts);
        dispatch();
      }
      if (open) {
        if (out.action === 'off') stopNative();
        else openAndApply(); // re-reads the permission; the setPolicy is the heartbeat
      }
      publishStatus();
      return focus.take();
    },

    beginSetup() {
      setup = true;
    },
    endSetup() {
      setup = false;
    },

    setupCheck() {
      const u = 'unknown' as const;
      if (lastFrame === null) return { faceVisible: u, bothEyesTracked: u, lightingOk: u, angleOk: u, phoneSteady: lastRow === null ? u : lastRow.gravityStability >= 0.95 && lastRow.handlingScore < 0.6 };
      const f = lastFrame;
      return {
        faceVisible: f.face,
        bothEyesTracked: quality === 'tracking' && f.eyeR !== null && f.eyeL !== null && f.eyeR.irisIn && f.eyeL.irisIn,
        lightingOk: f.faceLuma !== null && f.faceLuma >= cfg.quality.headOnlyMinFaceLuma,
        angleOk: f.head !== null && Math.abs(f.head.yaw) <= 25 && Math.abs(f.head.pitch) <= 25,
        phoneSteady: lastRow === null ? u : lastRow.gravityStability >= 0.95 && lastRow.handlingScore < 0.6,
      };
    },

    seedFromSetup() {
      if (engine === null) return { ok: false, reason: 'no_tracking' };
      const r = engine.seedFromSetup();
      dispatch();
      return r.ok ? { ok: true, warmStart: false } : { ok: false, reason: r.reason };
    },

    tagLastAlert(tag) {
      engine?.tagLastAlert(tag);
    },

    status: computeStatus,

    summary() {
      if (engine === null) return lastSummary;
      return { ...engine.summary(), camera: { starts, retries, gaveUp }, pendingFocus: [] };
    },

    async endDrive() {
      if (disposed || closing) return null;
      return endDriveNow();
    },

    async dispose() {
      if (disposed || closing) return;
      // Closing first (security T14 I-1): every input is ignored from now, and native stops before the
      // drive's end (its summary and the profile save) is awaited.
      closing = true;
      closedReason = 'no_drive';
      stopNative();
      if (engine !== null || creating !== null) await endDriveNow();
      disposed = true;
      stopNative();
      await ops;
      releaseOwner();
      await ops;
      for (const s of subs) s.remove();
    },

    async requestPermission() {
      if (disposed || closing || closedReason !== 'permission') return null;
      let status: PermissionStatus;
      try {
        status = (await deps.native.requestPermission()).status;
      } catch {
        return null;
      }
      if (evaluate()) openAndApply();
      return status;
    },

    async idle() {
      let p: Promise<void>;
      do {
        p = ops;
        await p;
      } while (p !== ops);
    },

    diagnostics: () => ({ ...stats, ruleSpeedKmh: engine?.snapshot().ruleSpeedKmh ?? null, native: nativeView === null ? null : { ...nativeView } }),
  };
}
