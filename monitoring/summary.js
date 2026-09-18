// Helpers for the per-drive monitoring metrics stored in the drive record.
import { ALERT_SEVERITY } from './types';

export function emptyMonitoringMetrics() {
  return {
    eyesOffRoadSeconds: 0,
    alertCounts: { info: 0, warning: 0, critical: 0 },
    alertsByType: {},
    drowsinessPeak: 0,
    drowsinessHistory: [],
    calibrationQuality: null,
  };
}

// Build the optional `monitoring` block of a drive record (docs/UX_REWORK.md §7).
export function buildMonitoringRecord({ enabled, metrics, calibrationState }) {
  if (!enabled) return { enabled: false };
  const m = metrics || emptyMonitoringMetrics();
  return {
    enabled: true,
    eyesOffRoadSeconds: Math.round(Number(m.eyesOffRoadSeconds) || 0),
    alertCounts: {
      info: Number(m.alertCounts?.info) || 0,
      warning: Number(m.alertCounts?.warning) || 0,
      critical: Number(m.alertCounts?.critical) || 0,
    },
    alertsByType: m.alertsByType || {},
    drowsinessPeak: Number(m.drowsinessPeak) || 0,
    drowsinessHistory: (m.drowsinessHistory || []).slice(-120),
    calibrationQuality: typeof m.calibrationQuality === 'number' ? m.calibrationQuality : null,
    calibrationState: calibrationState || null,
    // The monitoring branch's per-drive engine diagnostics (docs/dms/DETECTION_DESIGN.md §10); plain JSON.
    engine: m.engine && typeof m.engine === 'object' ? m.engine : null,
  };
}

// Does the monitoring data alone make this a "distracted" drive?
// Rule: any CRITICAL alert, three or more WARNINGs, or ≥ 30 s of eyes off the road.
export function monitoringVerdict(record) {
  if (!record || !record.enabled) return { distracted: false, reasons: [] };
  const reasons = [];
  const c = record.alertCounts || {};
  if ((c.critical || 0) > 0) reasons.push(`${c.critical} critical alert${c.critical === 1 ? '' : 's'}`);
  if ((c.warning || 0) >= 3) reasons.push(`${c.warning} warnings`);
  if ((record.eyesOffRoadSeconds || 0) >= 30) reasons.push(`${Math.round(record.eyesOffRoadSeconds)} s eyes off road`);
  return { distracted: reasons.length > 0, reasons };
}

export function totalAlerts(record) {
  const c = record?.alertCounts || {};
  return (c.info || 0) + (c.warning || 0) + (c.critical || 0);
}

export function severityRank(severity) {
  switch (severity) {
    case ALERT_SEVERITY.CRITICAL: return 3;
    case ALERT_SEVERITY.WARNING: return 2;
    case ALERT_SEVERITY.INFO: return 1;
    default: return 0;
  }
}
