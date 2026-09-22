import {
  assessHealth,
  type HealthContext,
  type HealthRow,
  type HealthRowId,
  type PermissionSnapshot,
} from '@/core/permissions';
import { rowConsequence, rowStatus, rowTitle } from '@/features/permissions/copy';
import { fixFor } from '@/features/permissions/HealthRow';

jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));
jest.mock('@/data/supabase/session', () => ({ useSession: jest.fn() }));

const base: PermissionSnapshot = {
  platform: 'android',
  location: 'always',
  precise: true,
  locationCanAskAgain: true,
  motion: 'granted',
  notifications: 'granted',
  notificationsCanAskAgain: true,
  batteryOptimization: 'exempt',
  lowPowerMode: false,
  checkedAt: 0,
};
const ctx: HealthContext = {
  drives: true,
  autoDetectOn: true,
  autoDetectAvailable: true,
  firstDriveDone: true,
  manualByChoice: false,
  everGranted: {},
};

function rowOf(id: HealthRowId, s: Partial<PermissionSnapshot>, c: Partial<HealthContext> = {}): {
  row: HealthRow;
  snapshot: PermissionSnapshot;
} {
  const snapshot = { ...base, ...s };
  const row = assessHealth(snapshot, { ...ctx, ...c }).rows.find((r) => r.id === id);
  if (!row) throw new Error(`no ${id} row`);
  return { row, snapshot };
}

const say = (id: HealthRowId, s: Partial<PermissionSnapshot>, c: Partial<HealthContext> = {}) => {
  const { row, snapshot } = rowOf(id, s, c);
  const wanted = c.autoDetectOn ?? true;
  return {
    status: rowStatus(row),
    line: rowConsequence(row, { snapshot, autoRecordWanted: wanted && !(c.manualByChoice ?? false) }),
    fix: fixFor(row, snapshot),
  };
};

describe('row copy per status', () => {
  test.each([
    ['location ok', 'location', {}, {}, 'All set', 'RoadWise can measure your drives.', null],
    ['location denied, askable', 'location', { location: 'denied' }, {}, 'Off', 'Without location, RoadWise can’t record drives.', 'requestLocation'],
    ['location denied, Settings only', 'location', { location: 'denied', locationCanAskAgain: false }, {}, 'Off', 'Without location, RoadWise can’t record drives.', 'openSettings'],
    ['location lapsed', 'location', { location: 'denied', locationCanAskAgain: false }, { everGranted: { location: true } }, 'Off', 'Location was turned off, so RoadWise can’t record drives.', 'openSettings'],
    ['location not asked yet', 'location', { location: 'undetermined' }, {}, 'Needs attention', 'Not allowed yet, so RoadWise can’t record drives.', 'requestLocation'],
    ['approximate', 'precise', { precise: false }, {}, 'Needs attention', 'Approximate location makes speed and distance less accurate.', 'openSettings'],
    ['precise unknown', 'precise', { precise: null }, {}, "Can't check", 'We can’t check this from here.', null],
    ['Always lost, auto-record wanted', 'locationAlways', { location: 'foreground' }, { everGranted: { locationAlways: true } }, 'Needs attention', 'Background location was turned off, so auto-record can’t start drives.', 'disclosure'],
    ['Always not given yet', 'locationAlways', { location: 'foreground' }, {}, 'Needs attention', 'Auto-record needs this to start drives while the app is closed.', 'disclosure'],
    ['Always, Settings only: still the disclosure first', 'locationAlways', { location: 'foreground', locationCanAskAgain: false }, {}, 'Needs attention', 'Auto-record needs this to start drives while the app is closed.', 'disclosure'],
    ['Always, manual by choice', 'locationAlways', { location: 'foreground' }, { manualByChoice: true }, 'Your choice', 'You’re starting drives yourself, so this isn’t needed.', null],
    ['Always, auto-record off', 'locationAlways', { location: 'foreground' }, { autoDetectOn: false }, 'Your choice', 'You’re starting drives yourself, so this isn’t needed.', null],
    ['Always, flag withdrawn', 'locationAlways', { location: 'foreground' }, { autoDetectAvailable: false }, 'Not available', 'Auto-record isn’t available yet, so this isn’t needed.', null],
    ['Always, iOS before the first drive', 'locationAlways', { platform: 'ios', location: 'foreground', lowPowerMode: false }, { firstDriveDone: false }, 'After your first drive', 'On iPhone, RoadWise asks for this after your first drive.', null],
    ['auto-record on', 'autoRecord', {}, {}, 'All set', 'Turned on, and this phone allows it.', null],
    ['auto-record blocked by Always', 'autoRecord', { location: 'foreground' }, {}, 'Needs attention', 'Turned on, but it needs background location to start drives.', 'disclosure'],
    ['auto-record blocked by motion', 'autoRecord', { motion: 'undetermined' }, {}, 'Needs attention', 'Turned on, but it needs motion access to start drives.', 'requestMotion'],
    ['auto-record off by choice', 'autoRecord', { location: 'foreground' }, { autoDetectOn: false }, 'Your choice', 'You start drives yourself with Start drive.', null],
    ['auto-record withdrawn', 'autoRecord', {}, { autoDetectAvailable: false }, 'Not available', 'Auto-record isn’t available yet. Tap Start drive whenever you drive.', null],
    ['auto-record iOS before first drive', 'autoRecord', { platform: 'ios', location: 'foreground' }, { firstDriveDone: false }, 'After your first drive', 'On iPhone, auto-record can be turned on after your first drive.', null],
    ['motion ok', 'motion', {}, {}, 'All set', 'Helps tell driving apart from walking.', null],
    ['motion not asked, auto-record wanted', 'motion', { motion: 'undetermined' }, {}, 'Needs attention', 'Not allowed yet, so auto-record can’t start drives and drives may not end on their own.', 'requestMotion'],
    ['motion lapsed, manual driver', 'motion', { motion: 'denied', location: 'foreground' }, { manualByChoice: true, everGranted: { motion: true } }, 'Off', 'Motion access was turned off, so drives may not end on their own.', 'openSettings'],
    ['motion off, auto-record off', 'motion', { motion: 'denied' }, { autoDetectOn: false }, 'Off', 'Motion access is off, so drives may not end on their own.', 'openSettings'],
    ['motion unavailable', 'motion', { motion: 'unavailable' }, {}, 'Not on this phone', 'This phone has no motion sensing RoadWise can use.', null],
    ['motion unknown', 'motion', { motion: null }, {}, "Can't check", 'We can’t check this from here.', null],
    ['notifications ok', 'notifications', {}, {}, 'All set', 'You’ll see drive summaries and notices.', null],
    ['notifications off', 'notifications', { notifications: 'denied', notificationsCanAskAgain: false }, {}, 'Off', 'Off. Updates wait in your Inbox instead.', 'openSettings'],
    ['notifications not asked', 'notifications', { notifications: 'undetermined' }, {}, 'Needs attention', 'Not allowed yet. Updates wait in your Inbox instead.', 'requestNotifications'],
    ['battery exempt', 'battery', {}, {}, 'All set', 'Your phone lets RoadWise run in the background.', null],
    ['battery optimised', 'battery', { batteryOptimization: 'optimized' }, {}, 'Needs attention', 'Your phone may stop RoadWise in the background, so drives may be missed.', 'openBatterySettings'],
    ['battery unknown: can’t check, but its settings page is offered', 'battery', { batteryOptimization: 'unknown' }, {}, "Can't check", 'We can’t check this from here.', 'openBatterySettings'],
    ['battery, manual by choice', 'battery', { batteryOptimization: 'optimized' }, { manualByChoice: true }, 'Your choice', 'You’re starting drives yourself, so this isn’t needed.', null],
    ['Low Power off', 'lowPower', { platform: 'ios' }, {}, 'All set', 'Low Power Mode is off.', null],
    ['Low Power on (informational)', 'lowPower', { platform: 'ios', lowPowerMode: true }, {}, 'On', 'While it’s on, drives may be recorded in less detail.', null],
    ['Low Power unknown', 'lowPower', { platform: 'ios', lowPowerMode: null }, {}, "Can't check", 'We can’t check this from here.', null],
  ] as const)('%s', (_name, id, s, c, status, line, fix) => {
    expect(say(id, s, c)).toEqual({ status, line, fix });
  });
});

test('info rows never offer a Fix, except the battery row that cannot be read', () => {
  const infoRows: { row: HealthRow; snapshot: PermissionSnapshot }[] = [
    rowOf('precise', { precise: null }),
    rowOf('locationAlways', { location: 'foreground' }, { manualByChoice: true }),
    rowOf('locationAlways', { location: 'foreground' }, { autoDetectAvailable: false }),
    rowOf('locationAlways', { platform: 'ios', location: 'foreground' }, { firstDriveDone: false }),
    rowOf('autoRecord', { location: 'foreground' }, { autoDetectOn: false }),
    rowOf('motion', { motion: 'unavailable' }),
    rowOf('motion', { motion: null }),
    rowOf('battery', { batteryOptimization: 'optimized' }, { manualByChoice: true }),
    rowOf('battery', { batteryOptimization: 'optimized' }, { autoDetectAvailable: false }),
    rowOf('lowPower', { platform: 'ios', lowPowerMode: true }),
  ];
  for (const { row, snapshot } of infoRows) {
    expect(row.status).toBe('info');
    expect(fixFor(row, snapshot)).toBeNull();
  }
  const battery = rowOf('battery', { batteryOptimization: 'unknown' });
  expect(battery.row.status).toBe('info');
  expect(fixFor(battery.row, battery.snapshot)).toBe('openBatterySettings');
});

test('no Fix for background location ever goes straight to the OS: it opens the disclosure', () => {
  for (const s of [
    { location: 'foreground' as const },
    { location: 'foreground' as const, locationCanAskAgain: false },
    { location: 'foreground' as const, platform: 'ios' as const },
  ]) {
    const { row, snapshot } = rowOf('locationAlways', s, { everGranted: { locationAlways: true } });
    expect(fixFor(row, snapshot)).toBe('disclosure');
  }
});

test('titles are per platform where the OS names differ', () => {
  expect(rowTitle('motion', 'ios')).toBe('Motion & Fitness');
  expect(rowTitle('motion', 'android')).toBe('Physical activity');
  expect(rowTitle('battery', 'android')).toBe('Battery optimisation');
});

test('no row copy promises detection', () => {
  const lines: string[] = [];
  for (const id of ['location', 'precise', 'locationAlways', 'autoRecord', 'motion', 'notifications', 'battery'] as const) {
    for (const s of [{}, { location: 'foreground' as const }, { motion: 'denied' as const }, { precise: false }]) {
      try {
        lines.push(say(id, s).line);
      } catch {
        // the row is not present in this state
      }
    }
  }
  for (const line of lines) expect(line).not.toMatch(/will be (detected|recorded)/i);
});
