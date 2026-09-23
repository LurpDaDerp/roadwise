// The DMS host controller (plan "Bridge API", Task 14): the one object M7 plugs into. It owns the native
// module's lifecycle, the privacy gate, the capture policy and the engine, and it is fail-closed:
// - No native call at all (getPermission included) unless every gate input but the permission holds; the
//   permission is read from native only then, and again on every row while running (rev1 S-M4).
// - One gate per controller (M7 builds one controller per signed-in uid and disposes it on sign-out or an
//   account switch: security M-2/M-4), evaluated on every input change, drive end included, so the remote
//   flag latches at each drive start. The nonce is a CSPRNG UUID (expo-crypto), never logged or stored;
//   a gate that throws is closed (security M-3).
// - Every user or OS input (opt-out, role, mode, app state, a revoked permission, a native permission
//   error) stops native at once: the stop is queued in the same call.
// - Native failures are silent (SR9): one retry 5 s later (row-driven: no timer), then off for the drive.
// - The capture policy is evaluated on every 1 Hz row, and its decision is sent as setPolicy: that is also
//   native's heartbeat. The policy's cameraOff edge calls engine.cameraOff (a Critical is kept; T13 r1 I1).
// - Frames and rows share the epoch clock: a record's clock moves by its native session's anchor offset,
//   and the decoder's last-accepted time resets on every new session (T1r1 m1). Rows keep feeding the
//   engine while the camera is off, so a running Critical still ends on a known low speed.
// - Commands go to onAlert and events to onEvent; a throwing callback never breaks the controller.
// - The HUD status says `active` only with TRACKING or HEAD_ONLY frames in the last 1 s.
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
import { createGate, type DmsGate, type GateClosedReason, type GateToken } from '../policy/gate';
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
  reason: GateClosedReason | 'error' | 'thermal' | 'low_light' | 'stopped' | 'face_lost' | null;
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

export type DmsHostSummary = DmsTripSummary & { camera: { starts: number; retries: number; gaveUp: boolean } };

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
  endDrive(): Promise<DmsHostSummary | null>;
  dispose(): Promise<void>;
  /** Resolves once the queued native calls have settled (tests and the dev panel). */
  idle(): Promise<void>;
  diagnostics(): { droppedBatches: number; droppedRecords: number; frames: number };
}

const RETRY_AFTER_MS = 5_000;
const ACTIVE_WITHIN_MS = 1_000;
/** F events closer than this belong to one drowsiness episode (one focus sample). */
const EPISODE_GAP_MS = 30_000;
const FOCUS_BY_KIND: Record<string, number> = { microsleep: 1, sleep: 3, unresponsive: 6 };

export function createDmsController(deps: DmsControllerDeps): DmsController {
  const cfg: DmsConfig = resolveDmsConfig(deps.config ?? {});
  const native = gatedNative(deps.native);
  const gate = createGate(deps.random ?? (() => randomUUID()));
  let inputs: DmsGateInputs | null = null;
  let closedReason: GateClosedReason | 'error' | null = 'no_drive';
  let token: GateToken | null = null;
  let disposed = false;
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
  const qualities = new RingBuffer<{ t: number; tracking: boolean }>(60 * 30);
  // Native status.
  let thermal: ThermalName = 'nominal';
  let lowPower = false;
  // Failures (SR9).
  let errorAt: number | null = null;
  let retries = 0;
  let gaveUp = false;
  let starts = 0;
  // Stats, focus, status.
  const stats = { droppedBatches: 0, droppedRecords: 0, frames: 0 };
  const focus = createFocusQueue(cfg);
  let lastAlertStartT: number | null = null;
  let lastDrowsyT = Number.NEGATIVE_INFINITY;
  let lastStatusJson = '';

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
      } else if (e.kind in FOCUS_BY_KIND) {
        if (e.tMs - lastDrowsyT > EPISODE_GAP_MS) focus.drowsiness(FOCUS_BY_KIND[e.kind]!);
        lastDrowsyT = e.tMs;
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
    if (now() - lastGoodT <= ACTIVE_WITHIN_MS) return { camera: 'active', reason: null, ...base };
    return { camera: 'limited', reason: 'face_lost', ...base };
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

  function stopNative(): void {
    token = null;
    if (nativeState === 'stopped') return;
    nativeState = 'stopped';
    enqueue(() => native.stop());
  }

  function failed(code: string | undefined): void {
    if (code === 'E_PERMISSION') {
      closedReason = 'permission';
      stopNative();
      return;
    }
    if (code === 'E_NOT_FOREGROUND') return; // the app state closes the gate
    if (retries >= 1) gaveUp = true;
    errorAt = lastRow?.ts ?? 0;
    stopNative();
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
      engine = createDmsEngine({ ...cfg, gazeSource: source }, { driverSide: g.driverSide, sensitivity: g.sensitivity, alerts: g.alerts, profile: parseProfile(stored) });
      driveStartTs = lastRow?.ts ?? null;
    })();
    await creating;
    creating = null;
  }

  /** Open (after reading the permission), start if needed, and send the policy. */
  function openAndApply(): void {
    enqueue(async () => {
      if (disposed || inputs === null || gaveUp || errorAt !== null) return;
      const perm = await deps.native.getPermission();
      if (disposed || inputs === null) return;
      let open: GateToken | null = null;
      try {
        const r = gate.gateOpen(inputs, perm.status);
        if (r.open) open = r.token;
        else closedReason = r.reason;
      } catch {
        closedReason = 'error'; // a gate that throws is closed (security M-3)
      }
      if (open === null) {
        stopNative();
        return;
      }
      closedReason = null;
      token = open;
      await ensureEngine(inputs);
      const out = lastOut;
      if (out !== null && out.action === 'off') return;
      try {
        if (nativeState === 'stopped') {
          starts++;
          nativeState = 'starting';
          await native.start({ gateToken: open, fps: out !== null && out.fps !== 0 ? out.fps : 5, gazeNet: out?.gazeNet ?? false, gazeNetEvery: out?.gazeNetEvery ?? 1, delegate: 'cpu', rotationOffsetDegrees: 0 });
          if (nativeState === 'starting') nativeState = 'running';
        }
        const p = out === null ? null : nativePolicy(out, open);
        if (p !== null) await native.setPolicy(p);
      } catch (e) {
        if (nativeState === 'starting') nativeState = 'stopped';
        failed((e as { code?: string }).code);
      }
      publishStatus();
    });
  }

  /** The synchronous gate check: no native call unless every input but the permission holds. */
  function evaluate(): boolean {
    if (disposed || inputs === null) return false;
    let reason: GateClosedReason | 'error' | null;
    try {
      reason = gate.check(inputs, 'granted');
    } catch {
      reason = 'error';
    }
    if (reason !== null) {
      closedReason = reason;
      stopNative();
      publishStatus();
      return false;
    }
    return true;
  }

  const subs: Subscription[] = [
    deps.native.addListener('frames', (raw) => {
      if (disposed || engine === null) return;
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
        qualities.push({ t: ef.tMs, tracking: q === 'tracking' });
      }
      dispatch();
      publishStatus();
    }),
    deps.native.addListener('state', (ev) => {
      const prev = reported;
      reported = ev.state;
      nativeState = ev.state;
      // A new native session: its clock may restart on another base (T1r1 m1).
      if ((ev.state === 'starting' || ev.state === 'running') && prev === 'stopped') {
        lastTMs = null;
        sessionOffset = null;
      }
      if (ev.state === 'stopped' && ev.reason === 'error') failed('E_CAMERA');
      if (ev.state === 'stopped' && ev.reason === 'permission') failed('E_PERMISSION');
      if (ev.state === 'stopped') token = null;
      publishStatus();
    }),
    deps.native.addListener('status', (s) => {
      thermal = s.thermal;
      lowPower = s.lowPower;
    }),
  ];

  return {
    setGate(g) {
      if (disposed) return;
      inputs = { ...g };
      if (evaluate()) openAndApply();
    },

    pushRow(row, power) {
      if (disposed) return null;
      lastRow = row;
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
        gazeNetEvery: 1,
      });
      lastOut = out;
      if (engine !== null) {
        if (out.cameraOff !== null) engine.cameraOff(row.ts, out.cameraOff);
        engine.setHost({ thermalLevel: out.thermalLevel, search: out.search, gazeNetEvery: out.gazeNetEvery });
        engine.pushRow(row, rowExtras(row, power, driveStartTs === null ? 0 : (row.ts - driveStartTs) / 1000), row.ts);
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
      return { ...engine.summary(), camera: { starts, retries, gaveUp } };
    },

    async endDrive() {
      await ops;
      if (creating !== null) await creating;
      if (engine !== null) {
        const r = engine.endDrive(now());
        dispatch();
        if (r.profile !== null && r.summary.calibration.state === 'calibrated') {
          try {
            await deps.profileStore.save(r.profile);
          } catch {
            // a failed save leaves the next drive to calibrate afresh
          }
        }
        lastSummary = { ...r.summary, camera: { starts, retries, gaveUp } };
        engine = null;
      }
      policy = createCapturePolicy();
      lastOut = null;
      errorAt = null;
      retries = 0;
      gaveUp = false;
      starts = 0;
      stopNative();
      await ops;
      publishStatus();
      return lastSummary;
    },

    async dispose() {
      if (disposed) return;
      const summary = engine !== null ? this.endDrive() : Promise.resolve(null);
      await summary;
      disposed = true;
      stopNative();
      await ops;
      for (const s of subs) s.remove();
    },

    async idle() {
      let p: Promise<void>;
      do {
        p = ops;
        await p;
      } while (p !== ops);
    },

    diagnostics: () => ({ ...stats }),
  };
}
