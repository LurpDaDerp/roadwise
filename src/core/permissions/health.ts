// The permission-health model (product B2, design §5.3, M4 rev1: I12). Pure: a snapshot of what
// the phone allows plus the driver's own choices in, a report out. It never nags about a choice:
//
// - iOS before the first completed drive, Always is "Available after your first drive" — `info`,
//   no fix, and never a request (design §5.3: iOS Always is asked only after the first drive).
// - Manual mode by choice (A9 Skip, Always declined) makes the Always / auto-record rows `info`
//   with reason `choice`; the UI may offer an informational "Turn on" link, never a Fix.
// - `showBanner` is only for states the driver did not choose: location denied or approximate,
//   or a lapse from a previously granted state (`everGranted`).
// - A fix is `request` only while the OS can still ask; otherwise `openSettings`.
// - No Bluetooth, camera or usage-access rows (M4 has none of those features).
import type {
  EverGranted,
  FixAction,
  HealthContext,
  HealthReport,
  HealthRow,
  PermissionSnapshot,
  RecordingMode,
} from './types';

const hasLocation = (s: PermissionSnapshot): boolean =>
  s.location === 'foreground' || s.location === 'always';

const askOrSettings = (canAsk: boolean): FixAction => (canAsk ? 'request' : 'openSettings');

function locationRow(s: PermissionSnapshot, c: HealthContext): HealthRow {
  if (hasLocation(s)) return { id: 'location', status: 'ok', fix: 'none' };
  const lapsed = c.everGranted.location === true;
  const row: HealthRow = {
    id: 'location',
    status: s.location === 'denied' ? 'off' : 'attention',
    fix: askOrSettings(s.locationCanAskAgain),
  };
  return lapsed ? { ...row, reason: 'lapsed' } : row;
}

function preciseRow(s: PermissionSnapshot): HealthRow {
  if (s.precise === true) return { id: 'precise', status: 'ok', fix: 'none' };
  if (s.precise === null) return { id: 'precise', status: 'info', fix: 'none', reason: 'cantCheck' };
  // Approximate location: only Settings reliably switches precise back on, on both platforms.
  return { id: 'precise', status: 'attention', fix: 'openSettings' };
}

/** Why Always is not something to fix right now, if it is not. */
function alwaysExcuse(s: PermissionSnapshot, c: HealthContext): 'afterFirstDrive' | 'choice' | null {
  if (s.platform === 'ios' && !c.firstDriveDone) return 'afterFirstDrive';
  if (c.manualByChoice) return 'choice';
  return null;
}

function alwaysRow(s: PermissionSnapshot, c: HealthContext): HealthRow {
  if (s.location === 'always') return { id: 'locationAlways', status: 'ok', fix: 'none' };
  const excuse = alwaysExcuse(s, c);
  if (excuse) return { id: 'locationAlways', status: 'info', fix: 'none', reason: excuse };
  const row: HealthRow = {
    id: 'locationAlways',
    status: 'attention',
    fix: askOrSettings(s.locationCanAskAgain),
  };
  return c.everGranted.locationAlways ? { ...row, reason: 'lapsed' } : row;
}

function motionRow(s: PermissionSnapshot, c: HealthContext): HealthRow {
  switch (s.motion) {
    case 'granted':
      return { id: 'motion', status: 'ok', fix: 'none' };
    case 'unavailable':
      return { id: 'motion', status: 'info', fix: 'none' };
    case 'undetermined':
      return { id: 'motion', status: 'attention', fix: 'request' };
    case 'denied': {
      // drive-sense reports no can-ask-again for motion; iOS never re-prompts, so Settings.
      const row: HealthRow = { id: 'motion', status: 'off', fix: 'openSettings' };
      return c.everGranted.motion ? { ...row, reason: 'lapsed' } : row;
    }
  }
}

function autoRecordRow(
  s: PermissionSnapshot,
  c: HealthContext,
  always: HealthRow,
  motion: HealthRow,
  mode: RecordingMode
): HealthRow {
  if (mode === 'automatic') return { id: 'autoRecord', status: 'ok', fix: 'none' };
  if (c.autoDetectAvailable === false) return { id: 'autoRecord', status: 'info', fix: 'none' };
  const excuse = alwaysExcuse(s, c);
  if (excuse) return { id: 'autoRecord', status: 'info', fix: 'none', reason: excuse };
  if (!c.autoDetectOn) return { id: 'autoRecord', status: 'info', fix: 'none', reason: 'choice' };
  // Wanted but blocked: point at whatever blocks it, Always first (the host needs both).
  const blocker = always.status !== 'ok' ? always : motion;
  if (blocker.status === 'info') return { id: 'autoRecord', status: 'info', fix: 'none' };
  const row: HealthRow = { id: 'autoRecord', status: 'attention', fix: blocker.fix };
  return blocker.reason === 'lapsed' ? { ...row, reason: 'lapsed' } : row;
}

function notificationsRow(s: PermissionSnapshot): HealthRow {
  switch (s.notifications) {
    case 'granted':
    case 'provisional':
      return { id: 'notifications', status: 'ok', fix: 'none' };
    case 'undetermined':
      return { id: 'notifications', status: 'attention', fix: askOrSettings(s.notificationsCanAskAgain) };
    case 'denied':
      return { id: 'notifications', status: 'off', fix: askOrSettings(s.notificationsCanAskAgain) };
  }
}

function batteryRow(s: PermissionSnapshot, c: HealthContext): HealthRow {
  switch (s.batteryOptimization) {
    case 'exempt':
      return { id: 'battery', status: 'ok', fix: 'none' };
    case 'unknown':
      return { id: 'battery', status: 'info', fix: 'none', reason: 'cantCheck' };
    case 'optimized':
      // It matters to background detection only, which a manual-by-choice driver declined.
      return c.manualByChoice
        ? { id: 'battery', status: 'info', fix: 'none', reason: 'choice' }
        : { id: 'battery', status: 'attention', fix: 'openBatterySettings' };
  }
}

function lowPowerRow(s: PermissionSnapshot): HealthRow {
  if (s.lowPowerMode === false) return { id: 'lowPower', status: 'ok', fix: 'none' };
  if (s.lowPowerMode === null) return { id: 'lowPower', status: 'info', fix: 'none', reason: 'cantCheck' };
  return { id: 'lowPower', status: 'info', fix: 'none' };
}

function recordingModeOf(s: PermissionSnapshot, c: HealthContext): RecordingMode {
  if (!c.drives || !hasLocation(s)) return 'unavailable';
  const automatic =
    c.autoDetectAvailable !== false &&
    c.autoDetectOn &&
    s.location === 'always' &&
    s.motion === 'granted';
  return automatic ? 'automatic' : 'manual';
}

function bannerFor(s: PermissionSnapshot, c: HealthContext): boolean {
  if (!c.drives) return false;
  if (s.location === 'denied') return true;
  if (hasLocation(s) && s.precise === false) return true;
  // Lapses. Always only matters while the driver wants auto-record, and never before an iOS
  // driver's first drive or after a choice of manual mode.
  if (
    s.location === 'foreground' &&
    c.everGranted.locationAlways === true &&
    c.autoDetectOn &&
    alwaysExcuse(s, c) === null
  ) {
    return true;
  }
  if (s.motion === 'denied' && c.everGranted.motion === true) return true;
  return false;
}

export function assessHealth(s: PermissionSnapshot, c: HealthContext): HealthReport {
  const recordingMode = recordingModeOf(s, c);
  const rows: HealthRow[] = [];

  if (c.drives) {
    rows.push(locationRow(s, c));
    const motion = motionRow(s, c);
    if (hasLocation(s)) {
      const always = alwaysRow(s, c);
      rows.push(preciseRow(s), always, autoRecordRow(s, c, always, motion, recordingMode));
    }
    rows.push(motion);
  }
  rows.push(notificationsRow(s));
  if (c.drives) rows.push(s.platform === 'android' ? batteryRow(s, c) : lowPowerRow(s));

  const needsWork = rows.some((r) => r.status === 'attention' || r.status === 'off');
  const overall =
    c.drives && recordingMode === 'unavailable' ? 'broken' : needsWork ? 'attention' : 'ok';

  return { overall, rows, recordingMode, showBanner: bannerFor(s, c) };
}

/**
 * `everGranted` after seeing `s`: what is granted now is remembered, nothing is ever forgotten.
 * Returns `prev` itself when nothing new was granted, so a caller can skip the settings write.
 */
export function nextEverGranted(prev: EverGranted, s: PermissionSnapshot): EverGranted {
  const add: EverGranted = {};
  if (hasLocation(s) && !prev.location) add.location = true;
  if (s.location === 'always' && !prev.locationAlways) add.locationAlways = true;
  if (s.motion === 'granted' && !prev.motion) add.motion = true;
  return Object.keys(add).length === 0 ? prev : { ...prev, ...add };
}
