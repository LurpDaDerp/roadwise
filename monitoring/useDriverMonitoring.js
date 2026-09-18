// ============================================================================
// useDriverMonitoring — the REAL hook (camera + gaze model + rule engine).
//
// It replaces the mock of the UX branch and keeps its signature and returned
// shape exactly (docs/UX_REWORK.md §5.2); every surface — DriveScreen, DrivePrep,
// Settings, DriveSummary, DriveDetail, Insights — is already wired to it.  The
// only new input is `speedKmh` (number | null): the app's GPS speed, which the
// rules need for the stationary speed gate (docs/dms/DETECTION_DESIGN.md §8).
//
// What this hook owns
//   * the camera session (modules/dms-vision), its permission and the AppState
//     transitions — the camera stops in the background, the rules keep their clocks;
//   * the per-frame pipeline: landmark frame -> dms/gaze_inputs (prepareInputs)
//     -> the gaze network (predictGaze, one in flight at a time) -> dms/monitor
//     (calibration, attention, drowsiness, arbiter) -> MonitoringBridge;
//   * the cadence / thermal / battery policy (20 / 10 / 5 fps, pause when hot);
//   * the persisted forward reference (a repeat drive is calibrated in ~20 s);
//   * the once-per-run ONNX parity self-test and the eye-line orientation check.
//
// What it does NOT own: audio.  The screen plays `activeAlert` through
// monitoring/alertAudio.js, so every audible cue in the app follows one policy.
//
// `demo: true` runs the mock's scripted sequence unchanged (no camera), so the
// banners, overlay and audio policy can be exercised without the model.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Battery from 'expo-battery';

import { ALERT_SEVERITY, ALERT_TYPE, CALIBRATION_STATE, MONITOR_STATUS, alertCopy } from './types';
import { emptyMonitoringMetrics } from './summary';
import { MonitoringBridge } from './engineBridge';
import { DriverMonitor } from '../dms/monitor';
import { createAppConfig } from '../dms/app_config';
import { createSpeedGate } from '../hooks/monitor/speedGate';
import { createCadencePolicy } from '../hooks/monitor/cadencePolicy';
import { loadReference, saveReference, clearReference } from '../hooks/monitor/referenceStore';

// The local Expo module that owns the camera, MediaPipe and the ONNX runtime.
// A missing or broken module must never break the drive screen.
let DmsVision = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require('../modules/dms-vision/src');
  DmsVision = mod && mod.default ? mod.default : mod;
} catch (err) {
  DmsVision = null;
}

// eslint-disable-next-line global-require
const PARITY_FIXTURE = require('../dms/tests/fixtures/onnx_parity.json');

// ---------------------------------------------------------------- mock (demo) constants
const CALIBRATION_MS = 45_000;
const PROVISIONAL_MS = 45_000;
const TICK_MS = 1000;

const DEMO_SCRIPT = [
  { at: 8, type: ALERT_TYPE.OFF_ROAD_GLANCE, severity: ALERT_SEVERITY.INFO, duration: 3 },
  { at: 16, type: ALERT_TYPE.LONG_GLANCE, severity: ALERT_SEVERITY.WARNING, duration: 4 },
  { at: 26, type: ALERT_TYPE.EYES_CLOSED, severity: ALERT_SEVERITY.CRITICAL, duration: 6 },
  { at: 40, type: ALERT_TYPE.YAWNING, severity: ALERT_SEVERITY.INFO, duration: 3 },
];

// ---------------------------------------------------------------- engine constants
const UI_TICK_MS = 250;           // React state is published at most 4x/s
const DETAIL_EVERY = 4;           // ... and the engine diagnostics once a second
const BATTERY_POLL_MS = 60_000;
const THERMAL_POLL_MS = 10_000;
const TARGET_FPS = 20;
const ORIENTATION_WINDOW_S = 3.0;
const EYE_LINE_MAX_DEG = 35.0;
const LEFT_EYE_OUTER = 33;        // MediaPipe outer eye corners in the upright frame
const RIGHT_EYE_OUTER = 263;

const OFF_STATE = {
  status: MONITOR_STATUS.OFF,
  calibration: { state: CALIBRATION_STATE.OFF, progress: 0, quality: null },
  activeAlert: null,
  drowsiness: { level: 0, perclos: null },
};

function nowS() {
  return Date.now() / 1000;
}

function safe(fn, fallback = null) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch (err) {
    return fallback;
  }
}

/** A start() rejection that is really a permission denial. */
function isPermissionError(err) {
  const text = `${(err && (err.code || err.name)) || ''} ${(err && err.message) || ''}`.toLowerCase();
  return text.includes('permission') || text.includes('denied') || text.includes('unauthorized')
    || text.includes('not authorized') || text.includes('camera access');
}

async function requestCameraPermission(module) {
  if (!module) return 'unavailable';
  const names = ['requestPermission', 'requestCameraPermission', 'requestPermissionsAsync',
    'requestCameraPermissionsAsync', 'getPermission', 'getCameraPermission', 'getPermissionsAsync'];
  for (const name of names) {
    if (typeof module[name] !== 'function') continue;
    try {
      const raw = await module[name]();
      if (raw === true) return 'granted';
      if (raw === false) return 'denied';
      const status = typeof raw === 'string' ? raw : (raw && (raw.status || (raw.granted === true ? 'granted' : raw.granted === false ? 'denied' : null)));
      if (typeof status === 'string') {
        const s = status.toLowerCase();
        if (s === 'granted' || s === 'authorized') return 'granted';
        if (s === 'denied' || s === 'restricted' || s === 'blocked') return 'denied';
        if (s.startsWith('undetermined') || s === 'notdetermined') return 'undetermined';
      }
    } catch (err) {
      return isPermissionError(err) ? 'denied' : 'undetermined';
    }
  }
  // the module does not expose a permission API: start() will decide
  return 'undetermined';
}

// ============================================================================
// The demo path: the UX mock's scripted sequence, unchanged.
// ============================================================================
function useDemoMonitoring({ running, enabled, onAlert }) {
  const [status, setStatus] = useState(MONITOR_STATUS.OFF);
  const [calibration, setCalibration] = useState({ state: CALIBRATION_STATE.OFF, progress: 0, quality: null });
  const [activeAlert, setActiveAlert] = useState(null);
  const [drowsiness, setDrowsiness] = useState({ level: 0, perclos: null });
  const [metrics, setMetrics] = useState(emptyMonitoringMetrics);

  const startedAt = useRef(null);
  const calibrationStartedAt = useRef(null);
  const acknowledged = useRef(new Set());
  const emitted = useRef(new Set());
  const onAlertRef = useRef(onAlert);
  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);

  useEffect(() => {
    if (running) {
      startedAt.current = Date.now();
      calibrationStartedAt.current = Date.now();
      acknowledged.current = new Set();
      emitted.current = new Set();
      setMetrics(emptyMonitoringMetrics());
      setActiveAlert(null);
      setDrowsiness({ level: 0, perclos: null });
      setStatus(MONITOR_STATUS.STARTING);
      setCalibration({ state: CALIBRATION_STATE.CALIBRATING, progress: 0, quality: null });
    } else {
      setStatus(MONITOR_STATUS.OFF);
      setActiveAlert(null);
      if (!enabled) setCalibration({ state: CALIBRATION_STATE.OFF, progress: 0, quality: null });
    }
  }, [running, enabled]);

  const recalibrate = useCallback(() => {
    if (!running) return;
    calibrationStartedAt.current = Date.now();
    setCalibration({ state: CALIBRATION_STATE.CALIBRATING, progress: 0, quality: null });
    setStatus(MONITOR_STATUS.CALIBRATING);
  }, [running]);

  const acknowledgeAlert = useCallback((id) => {
    if (!id) return;
    acknowledged.current.add(id);
    setActiveAlert((a) => (a && a.id === id ? null : a));
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      const sinceCal = now - (calibrationStartedAt.current || now);
      const elapsedS = Math.floor((now - (startedAt.current || now)) / 1000);

      if (sinceCal < CALIBRATION_MS) {
        setCalibration({ state: CALIBRATION_STATE.CALIBRATING, progress: Math.min(1, sinceCal / CALIBRATION_MS), quality: null });
        setStatus(MONITOR_STATUS.CALIBRATING);
      } else if (sinceCal < CALIBRATION_MS + PROVISIONAL_MS) {
        const q = 0.6 + 0.35 * ((sinceCal - CALIBRATION_MS) / PROVISIONAL_MS);
        setCalibration({ state: CALIBRATION_STATE.PROVISIONAL, progress: 1, quality: Math.round(q * 100) / 100 });
        setStatus(MONITOR_STATUS.ACTIVE);
      } else {
        setCalibration({ state: CALIBRATION_STATE.CONFIRMED, progress: 1, quality: 0.95 });
        setStatus(MONITOR_STATUS.ACTIVE);
      }

      if (elapsedS % 10 === 0) {
        setMetrics((m) => ({
          ...m,
          drowsinessHistory: [...m.drowsinessHistory.slice(-119), { t: elapsedS, level: 0 }],
          calibrationQuality: sinceCal >= CALIBRATION_MS ? Math.min(0.95, 0.6 + (sinceCal - CALIBRATION_MS) / PROVISIONAL_MS) : null,
        }));
      }

      for (const step of DEMO_SCRIPT) {
        const key = `${step.at}-${step.type}`;
        const active = elapsedS >= step.at && elapsedS < step.at + step.duration;
        if (active && !emitted.current.has(key)) {
          emitted.current.add(key);
          const copy = alertCopy(step.type);
          const alert = { id: key, type: step.type, severity: step.severity, title: copy.title, message: copy.message, startedAt: now };
          setActiveAlert(alert);
          setMetrics((m) => ({
            ...m,
            alertCounts: { ...m.alertCounts, [step.severity]: (m.alertCounts[step.severity] || 0) + 1 },
            alertsByType: { ...m.alertsByType, [step.type]: (m.alertsByType[step.type] || 0) + 1 },
            eyesOffRoadSeconds: m.eyesOffRoadSeconds + (step.severity === ALERT_SEVERITY.INFO ? 1 : step.duration),
            drowsinessPeak: step.type === ALERT_TYPE.EYES_CLOSED ? Math.max(m.drowsinessPeak, 3) : m.drowsinessPeak,
          }));
          if (step.type === ALERT_TYPE.EYES_CLOSED) setDrowsiness({ level: 3, perclos: 0.4 });
          onAlertRef.current?.(alert);
        }
        if (!active && emitted.current.has(key)) {
          setActiveAlert((a) => (a && a.id === key ? null : a));
          if (step.type === ALERT_TYPE.EYES_CLOSED) setDrowsiness({ level: 0, perclos: null });
        }
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  return useMemo(
    () => ({ status, calibration, activeAlert, drowsiness, metrics, recalibrate, acknowledgeAlert }),
    [status, calibration, activeAlert, drowsiness, metrics, recalibrate, acknowledgeAlert]
  );
}

// ============================================================================
// The real path: camera + gaze model + rule engine, through the bridge.
// ============================================================================
function useEngineMonitoring({ running, enabled, settings, onAlert, speedKmh }) {
  const [state, setState] = useState(() => ({ ...OFF_STATE, metrics: emptyMonitoringMetrics() }));

  // --- refs: everything on the frame path -------------------------------------------
  const bridgeRef = useRef(null);
  if (bridgeRef.current === null) bridgeRef.current = new MonitoringBridge();
  const monitorRef = useRef(null);
  const speedGateRef = useRef(null);
  if (speedGateRef.current === null) speedGateRef.current = createSpeedGate();
  const cadenceRef = useRef(null);
  if (cadenceRef.current === null) cadenceRef.current = createCadencePolicy({ fullFps: TARGET_FPS });

  const runningRef = useRef(false);
  const enabledRef = useRef(false);
  enabledRef.current = Boolean(enabled);
  const wantCameraRef = useRef(false);
  wantCameraRef.current = Boolean(running);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const subsRef = useRef([]);
  const speedRef = useRef(null);
  speedRef.current = speedKmh;
  const settingsRef = useRef(settings || {});
  settingsRef.current = settings || {};
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;

  const lastFrameTRef = useRef(null);
  const lastAlertIdRef = useRef(null);
  const frameMetaRef = useRef({ focalScale: null, isMirrored: null, orientation: null, intrinsicsSource: 'default' });
  const orientationRef = useRef({ samples: [], startT: null, checked: false });
  const nativeStatusRef = useRef({ thermal: 'nominal', lowPower: false, fps: 0, dropped: 0 });
  const powerRef = useRef({ level: null, charging: null });
  const modelRef = useRef({ sha: null });
  const selfTestRef = useRef(null);
  const seededRef = useRef(false);
  const detailRef = useRef(null);

  // --- the rule engine ----------------------------------------------------------------
  const buildMonitor = useCallback((rebuild) => {
    if (monitorRef.current && !rebuild) return monitorRef.current;
    const s = settingsRef.current || {};
    const meta = frameMetaRef.current;
    const config = createAppConfig({
      sensitivity: s.sensitivity || 'medium',        // low | medium | high (app_config aliases)
      driverSide: s.driverSide === 'right' ? 'right' : 'left',
      focalScale: Number.isFinite(meta.focalScale) ? meta.focalScale : undefined,
      // an un-mirrored capture of a driver facing the camera has their left side on image right
      imageRightIsDriverLeft: meta.isMirrored === null ? undefined : !meta.isMirrored,
    });
    const previous = monitorRef.current;
    let next;
    try {
      next = new DriverMonitor(config);
    } catch (err) {
      console.warn('[dms] could not build the rule engine:', err);
      return monitorRef.current;
    }
    // carry a learned reference across a rebuild (a sensitivity change mid-drive)
    if (previous && previous.calibration && previous.calibration.reference
        && typeof next.calibration.seedStale === 'function') {
      safe(() => next.calibration.seedStale(previous.calibration.reference, previous.calibration.head_mode_xy));
    }
    monitorRef.current = next;
    bridgeRef.current.setConfig(config);
    bridgeRef.current.setMonitor(next);
    return next;
  }, []);

  // --- the persisted forward reference (DETECTION_DESIGN §5.2) -------------------------
  const seedFromPrior = useCallback(async (orientation) => {
    const monitor = monitorRef.current;
    if (!monitor || !monitor.calibration || seededRef.current) return;
    if (typeof monitor.calibration.seedStale !== 'function') return;   // not ported yet
    const loaded = await loadReference(AsyncStorage, {
      facing: 'front',
      orientation: orientation || 'unknown',
      nowMs: Date.now(),
      modelSha: modelRef.current.sha,
    });
    if (!loaded.ok || !mountedRef.current) return;
    const ok = safe(() => {
      monitor.calibration.seedStale(loaded.value.reference, loaded.value.headMode);
      return true;
    }, false);
    if (ok) {
      seededRef.current = true;
      bridgeRef.current.noteStatus({ seededFromPrior: true });
    }
  }, []);

  const persistReference = useCallback(async () => {
    const monitor = monitorRef.current;
    const cal = monitor && monitor.calibration;
    if (!cal || cal.confidence !== 'CONFIRMED' || !cal.reference) return;
    await saveReference(AsyncStorage, {
      reference: Array.from(cal.reference),
      headMode: cal.head_mode_xy ? Array.from(cal.head_mode_xy) : null,
      facing: 'front',
      orientation: frameMetaRef.current.orientation || 'unknown',
      modelSha: modelRef.current.sha,
      focalScale: frameMetaRef.current.focalScale,
      savedAtMs: Date.now(),
    });
  }, []);

  // --- the eye-line orientation sanity check (DETECTION_DESIGN §2) ---------------------
  const checkEyeLine = useCallback((frame) => {
    const st = orientationRef.current;
    if (st.checked) return;
    if (st.startT === null) st.startT = frame.t;
    const lm = frame.landmarks;
    const dx = (lm[RIGHT_EYE_OUTER * 3] - lm[LEFT_EYE_OUTER * 3]) * (frame.width || 1);
    const dy = (lm[RIGHT_EYE_OUTER * 3 + 1] - lm[LEFT_EYE_OUTER * 3 + 1]) * (frame.height || 1);
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      else if (angle < -90) angle += 180;
      st.samples.push(Math.abs(angle));
      if (st.samples.length > 120) st.samples.shift();
    }
    if (frame.t - st.startT >= ORIENTATION_WINDOW_S && st.samples.length >= 5) {
      const sorted = st.samples.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      st.checked = true;
      const fault = median > EYE_LINE_MAX_DEG;
      bridgeRef.current.noteStatus({ orientationFault: fault });
      if (fault) {
        console.warn(`[dms] the eye line is ${median.toFixed(1)} deg off horizontal: the landmark frame may not be upright`);
      }
    }
  }, []);

  // --- one camera frame ----------------------------------------------------------------
  const onFrame = useCallback((f) => {
    if (!runningRef.current || !f) return;
    const monitor = monitorRef.current;
    if (!monitor || inFlightRef.current) return;      // never queue: drop the frame instead

    const meta = frameMetaRef.current;
    if (Number.isFinite(f.focalScale) && meta.focalScale === null) meta.focalScale = f.focalScale;
    if (typeof f.isMirrored === 'boolean' && meta.isMirrored === null) meta.isMirrored = f.isMirrored;
    if (f.intrinsicsSource) meta.intrinsicsSource = f.intrinsicsSource;
    if (f.orientation && meta.orientation !== f.orientation) {
      const first = meta.orientation === null;
      meta.orientation = f.orientation;
      if (first) {
        seedFromPrior(f.orientation);
      } else {
        // the mount changed: re-validate the reference rather than forget it (§9)
        const cal = monitor.calibration;
        if (cal && cal.reference && typeof cal.seedStale === 'function') {
          safe(() => cal.seedStale(cal.reference, cal.head_mode_xy));
        } else {
          safe(() => monitor.resetCalibration());
        }
      }
    }

    const facePresent = Boolean(f.facePresent) && !!f.landmarks && f.landmarks.length >= 1434;
    const frame = {
      t: Number.isFinite(f.t) ? f.t : nowS(),
      width: f.width,
      height: f.height,
      face_present: facePresent,
      landmarks: facePresent ? f.landmarks : null,
    };
    lastFrameTRef.current = frame.t;
    cadenceRef.current.noteFace(nowS(), facePresent);
    if (facePresent) checkEyeLine(frame);

    let inputs = null;
    try {
      inputs = monitor.prepareInputs(frame);
    } catch (err) {
      inputs = null;
    }

    if (inputs === null) {
      safe(() => bridgeRef.current.update(monitor.finishFrame(frame, null, null)));
      return;
    }
    if (!DmsVision || typeof DmsVision.predictGaze !== 'function') return;

    inFlightRef.current = true;
    DmsVision.predictGaze(inputs.cloud, inputs.context, inputs.validity)
      .then((prediction) => {
        if (!runningRef.current) return;
        bridgeRef.current.update(monitor.finishFrame(frame, inputs, prediction));
      })
      .catch(() => {
        bridgeRef.current.noteStatus({ error: true });
        if (!runningRef.current) return;
        // the head rules still run without a gaze vector
        safe(() => bridgeRef.current.update(monitor.finishFrame(frame, inputs, null)));
      })
      .then(() => { inFlightRef.current = false; }, () => { inFlightRef.current = false; });
  }, [checkEyeLine, seedFromPrior]);

  // --- the native session ---------------------------------------------------------------
  const detachListeners = useCallback(() => {
    for (const sub of subsRef.current) safe(() => sub && sub.remove && sub.remove());
    subsRef.current = [];
  }, []);

  const attachListeners = useCallback(() => {
    detachListeners();
    if (!DmsVision) return;
    if (typeof DmsVision.addFrameListener === 'function') {
      const sub = safe(() => DmsVision.addFrameListener(onFrame));
      if (sub) subsRef.current.push(sub);
    }
    if (typeof DmsVision.addStatusListener === 'function') {
      const sub = safe(() => DmsVision.addStatusListener((s) => {
        if (!s) return;
        const n = nativeStatusRef.current;
        if (s.thermal !== undefined) n.thermal = s.thermal;
        if (typeof s.lowPower === 'boolean') n.lowPower = s.lowPower;
        if (Number.isFinite(s.dropped)) n.dropped = s.dropped;
        if (Number.isFinite(s.fps)) {
          n.fps = s.fps;
          bridgeRef.current.noteStatus({ fps: s.fps });
        }
      }));
      if (sub) subsRef.current.push(sub);
    }
    if (typeof DmsVision.addErrorListener === 'function') {
      const sub = safe(() => DmsVision.addErrorListener((err) => {
        bridgeRef.current.noteStatus({ error: true });
        console.warn('[dms] native error:', err && err.message ? err.message : err);
      }));
      if (sub) subsRef.current.push(sub);
    }
  }, [detachListeners, onFrame]);

  const runSelfTest = useCallback(async () => {
    if (!DmsVision || typeof DmsVision.selfTest !== 'function' || selfTestRef.current !== null) return;
    selfTestRef.current = { pending: true, ok: null };
    try {
      const result = await DmsVision.selfTest(PARITY_FIXTURE);
      selfTestRef.current = {
        ok: Boolean(result && result.ok),
        maxAbsGaze: result ? result.maxAbsGaze : null,
        maxAbsRotation: result ? result.maxAbsRotation : null,
        pending: false,
      };
      if (!selfTestRef.current.ok) console.warn('[dms] ONNX parity self-test FAILED', result);
    } catch (err) {
      selfTestRef.current = { ok: false, pending: false, error: String(err && err.message ? err.message : err) };
      console.warn('[dms] ONNX parity self-test could not run:', err);
    }
    bridgeRef.current.noteStatus({ parity: selfTestRef.current });
  }, []);

  const start = useCallback(async () => {
    if (!DmsVision) {
      bridgeRef.current.setSession('camera_error');
      return;
    }
    if (runningRef.current || startingRef.current || !wantCameraRef.current) return;
    if (!safe(() => DmsVision.isAvailable(), false)) {
      bridgeRef.current.setSession('camera_error');
      return;
    }
    startingRef.current = true;
    bridgeRef.current.setSession('starting');
    try {
      const permission = await requestCameraPermission(DmsVision);
      bridgeRef.current.noteStatus({ permission });
      if (!mountedRef.current || !wantCameraRef.current) return;
      if (permission === 'denied') {
        bridgeRef.current.setSession('permission_denied');
        return;
      }

      if (modelRef.current.sha === null) {
        const info = safe(() => DmsVision.getModelInfo(), null);
        modelRef.current.sha = (info && (info.onnxSha256 || info.sha256 || info.sha || info.modelSha)) || null;
      }
      // the intrinsics of the last frame: focal scale, their source and the mirror flag, so the
      // rule engine is built with the right camera and the right driver-relative left / right
      const intrinsics = safe(() => DmsVision.getIntrinsics(), null);
      if (intrinsics) {
        if (Number.isFinite(intrinsics.focalScale)) frameMetaRef.current.focalScale = intrinsics.focalScale;
        if (intrinsics.intrinsicsSource) frameMetaRef.current.intrinsicsSource = intrinsics.intrinsicsSource;
        if (typeof intrinsics.isMirrored === 'boolean' && frameMetaRef.current.isMirrored === null) {
          frameMetaRef.current.isMirrored = intrinsics.isMirrored;
        }
        if (intrinsics.orientation && frameMetaRef.current.orientation === null) {
          frameMetaRef.current.orientation = intrinsics.orientation;
        }
      }
      bridgeRef.current.noteStatus({
        intrinsicsSource: frameMetaRef.current.intrinsicsSource,
        focalScale: frameMetaRef.current.focalScale,
      });

      buildMonitor(false);
      attachListeners();
      await DmsVision.start({ targetFps: TARGET_FPS, facing: 'front', landmarkFrame: 'upright' });
      if (!mountedRef.current || !wantCameraRef.current) {
        safe(() => DmsVision.stop());
        detachListeners();
        return;
      }
      runningRef.current = true;
      bridgeRef.current.setSession('running');
      bridgeRef.current.noteStatus({ permission: 'granted' });
      cadenceRef.current.reset();
      runSelfTest();
      if (frameMetaRef.current.orientation) seedFromPrior(frameMetaRef.current.orientation);
    } catch (err) {
      detachListeners();
      runningRef.current = false;
      if (isPermissionError(err)) {
        bridgeRef.current.setSession('permission_denied');
        bridgeRef.current.noteStatus({ permission: 'denied' });
      } else {
        bridgeRef.current.setSession('camera_error');
        bridgeRef.current.noteStatus({ error: true });
        console.warn('[dms] camera start failed:', err);
      }
    } finally {
      startingRef.current = false;
    }
  }, [attachListeners, buildMonitor, detachListeners, runSelfTest, seedFromPrior]);

  const stop = useCallback(async (options = {}) => {
    const wasRunning = runningRef.current;
    runningRef.current = false;
    inFlightRef.current = false;
    detachListeners();
    if (DmsVision && wasRunning) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        try {
          const p = DmsVision.stop();
          if (p && typeof p.then === 'function') p.then(done, done);
          else done();
        } catch (err) { done(); }
      });
    }
    if (options.persist !== false) await persistReference();
    if (options.session !== false) bridgeRef.current.setSession(options.session || 'off');
  }, [detachListeners, persistReference]);

  // --- lifecycle -------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop({ persist: true });
    };
  }, [stop]);

  // start / stop with the drive; a profile change rebuilds the rule engine in place
  const sensitivity = settings ? settings.sensitivity : undefined;
  const driverSide = settings ? settings.driverSide : undefined;
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (!running) {
      wasRunningRef.current = false;
      stop({ persist: true });
      return undefined;
    }
    if (!wasRunningRef.current) {
      // a new monitored drive: everything starts over (the mock does the same)
      wasRunningRef.current = true;
      bridgeRef.current.reset();
      monitorRef.current = null;
      seededRef.current = false;
      lastAlertIdRef.current = null;
      detailRef.current = null;
      speedGateRef.current.reset();
      cadenceRef.current.reset();
      orientationRef.current = { samples: [], startT: null, checked: false };
      setState({ ...OFF_STATE, metrics: emptyMonitoringMetrics() });
    } else {
      buildMonitor(true);        // a sensitivity / driver-side change mid-drive
    }
    start();
    return undefined;
  }, [running, sensitivity, driverSide, start, stop, buildMonitor]);

  // the camera stops in the background; the rules keep their clocks (§3)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (wantCameraRef.current) start();
      } else if (runningRef.current) {
        stop({ persist: false, session: 'starting' });
      }
    });
    return () => sub.remove();
  }, [start, stop]);

  // Low Power Mode and the battery level (§3)
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const [lowPower, level, batteryState] = await Promise.all([
          Battery.isLowPowerModeEnabledAsync(),
          Battery.getBatteryLevelAsync(),
          Battery.getBatteryStateAsync(),
        ]);
        if (cancelled) return;
        nativeStatusRef.current.lowPower = Boolean(lowPower);
        powerRef.current.level = Number.isFinite(level) ? level : null;
        powerRef.current.charging = batteryState === Battery.BatteryState.CHARGING
          || batteryState === Battery.BatteryState.FULL;
      } catch (err) { /* battery info is optional */ }
    };
    read();
    const timer = setInterval(read, BATTERY_POLL_MS);
    let sub = null;
    try {
      sub = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
        nativeStatusRef.current.lowPower = Boolean(lowPowerMode);
      });
    } catch (err) { sub = null; }
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (sub) safe(() => sub.remove());
    };
  }, []);

  // thermal backstop for a module that does not push status events
  useEffect(() => {
    if (!DmsVision || typeof DmsVision.getThermalState !== 'function') return undefined;
    const poll = () => {
      const s = safe(() => DmsVision.getThermalState(), null);
      if (s) nativeStatusRef.current.thermal = s;
    };
    poll();
    const timer = setInterval(poll, THERMAL_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // --- the 4 Hz tick: speed, cadence, and the only React state updates -------------------
  useEffect(() => {
    let ticks = 0;
    let lastVersion = -1;
    const tick = () => {
      ticks += 1;
      const wall = nowS();

      // vehicle speed (§8): the gate smooths it and holds "moving" through a crawl
      const raw = speedRef.current;
      if (raw !== null && raw !== undefined && Number.isFinite(raw)) speedGateRef.current.onFixKmh(wall, raw);
      const gate = speedGateRef.current.read(wall);
      if (monitorRef.current) safe(() => monitorRef.current.setVehicleSpeed(gate.kmh));

      // cadence / thermal / battery (§3)
      const native = nativeStatusRef.current;
      const decision = cadenceRef.current.update({
        t: wall,
        moving: gate.kmh === null ? null : gate.moving,
        thermal: native.thermal,
        lowPower: native.lowPower,
        batteryLevel: powerRef.current.level,
        batteryCharging: powerRef.current.charging,
      });
      if (DmsVision && wantCameraRef.current) {
        if (decision.paused) {
          if (runningRef.current) {
            bridgeRef.current.noteStatus({ thermalPause: true });
            stop({ persist: false, session: 'starting' });
          }
        } else if (!runningRef.current && !startingRef.current && (decision.resume || decision.changed)) {
          start();
        } else if (runningRef.current && decision.changed) {
          safe(() => DmsVision.setTargetFps(decision.targetFps));
          safe(() => DmsVision.setIdleMode(decision.reason === 'noFace'));
        }
      }

      if (!mountedRef.current) return;

      // publish only when the bridge says something changed
      const bridge = bridgeRef.current;
      if (ticks % DETAIL_EVERY === 0) detailRef.current = bridge.engineDetail();
      if (bridge.version !== lastVersion) {
        lastVersion = bridge.version;
        const snap = bridge.snapshot();
        const alert = snap.activeAlert;
        if (alert && alert.id !== lastAlertIdRef.current) {
          lastAlertIdRef.current = alert.id;
          if (onAlertRef.current) safe(() => onAlertRef.current(alert));
        } else if (!alert) {
          lastAlertIdRef.current = null;
        }
        setState({
          status: snap.status,
          calibration: snap.calibration,
          activeAlert: snap.activeAlert,
          drowsiness: snap.drowsiness,
          metrics: detailRef.current ? { ...snap.metrics, engine: detailRef.current } : snap.metrics,
        });
      }
    };
    const timer = setInterval(tick, UI_TICK_MS);
    return () => clearInterval(timer);
  }, [start, stop]);

  // --- imperative API ---------------------------------------------------------------------
  const recalibrate = useCallback(() => {
    bridgeRef.current.recalibrate();
    seededRef.current = false;
    clearReference(AsyncStorage, { facing: 'front', orientation: frameMetaRef.current.orientation || 'unknown' });
    const snap = bridgeRef.current.snapshot();
    setState((prev) => ({ ...prev, calibration: snap.calibration, activeAlert: snap.activeAlert }));
  }, []);

  const acknowledgeAlert = useCallback((id) => {
    if (!id) return;
    bridgeRef.current.acknowledge(id);
    const snap = bridgeRef.current.snapshot();
    lastAlertIdRef.current = snap.activeAlert ? snap.activeAlert.id : null;
    setState((prev) => ({ ...prev, activeAlert: snap.activeAlert }));
  }, []);

  return useMemo(
    () => ({
      status: state.status,
      calibration: state.calibration,
      activeAlert: state.activeAlert,
      drowsiness: state.drowsiness,
      metrics: state.metrics,
      recalibrate,
      acknowledgeAlert,
    }),
    [state, recalibrate, acknowledgeAlert]
  );
}

// ============================================================================
/**
 * @param {object} params
 *   enabled      the monitoring setting AND the per-drive toggle
 *   driveActive  true between Start and End
 *   settings     monitoringSettingsFrom(settings) — sensitivity, driverSide, showPreview, ...
 *   onAlert      called once per new alert
 *   demo         run the scripted mock instead of the camera
 *   speedKmh     the app's GPS speed in km/h, or null when it is unknown (DETECTION §8)
 */
export function useDriverMonitoring({
  enabled = false, driveActive = false, settings, onAlert, demo = false, speedKmh = null,
} = {}) {
  const running = Boolean(enabled && driveActive);

  // Both paths are hooks, so both must run on every render; only one is active.
  const demoState = useDemoMonitoring({ running: running && demo, enabled: enabled && demo, onAlert });
  const engineState = useEngineMonitoring({
    running: running && !demo,
    enabled: enabled && !demo,
    settings,
    onAlert,
    speedKmh,
  });
  const source = demo ? demoState : engineState;

  return useMemo(
    () => ({
      status: source.status,
      calibration: source.calibration,
      activeAlert: source.activeAlert,
      drowsiness: source.drowsiness,
      metrics: source.metrics,
      recalibrate: source.recalibrate,
      acknowledgeAlert: source.acknowledgeAlert,
      // The native module renders no preview (DETECTION_DESIGN §3: no preview by default).
      // `settings.showPreview` is accepted and ignored; CameraPlacementGuide falls back to its
      // illustration.
      previewComponent: null,
      settings,
    }),
    [source, settings]
  );
}

export default useDriverMonitoring;
