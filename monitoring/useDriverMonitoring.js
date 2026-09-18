// ============================================================================
// useDriverMonitoring — MOCK IMPLEMENTATION (mount-point contract).
//
// The camera-based driver-monitoring branch replaces the body of this file with
// the real hook (gaze model + landmark rules over the front camera). Keep the
// signature and the returned shape exactly as documented in
// docs/UX_REWORK.md §5.2; every UI surface (DriveScreen, DrivePrep, Settings,
// DriveSummary, DriveDetail, Insights) is already wired to it.
//
// Mock behaviour: when `enabled && driveActive`, the status walks
// STARTING → CALIBRATING (progress 0→1 over ~45 s) → PROVISIONAL (~45 s) →
// CONFIRMED / ACTIVE. No alerts are produced unless `demo` is true, in which
// case a scripted sequence (INFO → WARNING → CRITICAL → clear) plays once so
// the banners, overlay and audio policy can be exercised without the model.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ALERT_SEVERITY, ALERT_TYPE, CALIBRATION_STATE, MONITOR_STATUS, alertCopy } from './types';
import { emptyMonitoringMetrics } from './summary';

const CALIBRATION_MS = 45_000;
const PROVISIONAL_MS = 45_000;
const TICK_MS = 1000;

const DEMO_SCRIPT = [
  { at: 8, type: ALERT_TYPE.OFF_ROAD_GLANCE, severity: ALERT_SEVERITY.INFO, duration: 3 },
  { at: 16, type: ALERT_TYPE.LONG_GLANCE, severity: ALERT_SEVERITY.WARNING, duration: 4 },
  { at: 26, type: ALERT_TYPE.EYES_CLOSED, severity: ALERT_SEVERITY.CRITICAL, duration: 6 },
  { at: 40, type: ALERT_TYPE.YAWNING, severity: ALERT_SEVERITY.INFO, duration: 3 },
];

export function useDriverMonitoring({ enabled = false, driveActive = false, settings, onAlert, demo = false } = {}) {
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

  const running = enabled && driveActive;

  // Reset everything when a monitored drive starts; keep metrics after it ends
  // so the summary can read them.
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

  // Tick.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      const sinceCal = now - (calibrationStartedAt.current || now);
      const elapsedS = Math.floor((now - (startedAt.current || now)) / 1000);

      // Calibration state machine.
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

      // Drowsiness history sample every 10 s (level stays 0 in the mock).
      if (elapsedS % 10 === 0) {
        setMetrics((m) => ({
          ...m,
          drowsinessHistory: [...m.drowsinessHistory.slice(-119), { t: elapsedS, level: 0 }],
          calibrationQuality: sinceCal >= CALIBRATION_MS ? Math.min(0.95, 0.6 + (sinceCal - CALIBRATION_MS) / PROVISIONAL_MS) : null,
        }));
      }

      // Demo alert script.
      if (demo) {
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
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, demo]);

  return useMemo(
    () => ({
      status,
      calibration,
      activeAlert,
      drowsiness,
      metrics,
      recalibrate,
      acknowledgeAlert,
      previewComponent: null,
      settings,
    }),
    [status, calibration, activeAlert, drowsiness, metrics, recalibrate, acknowledgeAlert, settings]
  );
}

export default useDriverMonitoring;
