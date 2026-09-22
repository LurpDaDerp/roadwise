import { permissionsFingerprint, toServerPermissions } from '../serverShape';
import type { PermissionSnapshot } from '../types';

const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  platform: 'ios',
  location: 'foreground',
  precise: true,
  locationCanAskAgain: false,
  motion: 'granted',
  notifications: 'provisional',
  notificationsCanAskAgain: true,
  batteryOptimization: 'exempt',
  lowPowerMode: true,
  checkedAt: Date.UTC(2026, 8, 22, 12, 0, 0),
  ...over,
});

describe('toServerPermissions', () => {
  it('has exactly the server keys, with checkedAt as ISO and ack defaulting to false', () => {
    expect(toServerPermissions(snap(), 'foreground')).toEqual({
      v: 1,
      location: 'foreground',
      precise: true,
      motion: 'granted',
      notifications: 'provisional',
      batteryOptimization: 'exempt',
      reportedFrom: 'foreground',
      ack: false,
      alwaysExcused: false,
      checkedAt: '2026-09-22T12:00:00.000Z',
    });
  });

  it('final review I4: carries alwaysExcused, and a change of it alone changes the fingerprint', () => {
    const wanted = toServerPermissions(snap(), 'foreground', false, false);
    const excused = toServerPermissions(snap(), 'foreground', false, true);
    expect(excused.alwaysExcused).toBe(true);
    expect(permissionsFingerprint(excused)).not.toBe(permissionsFingerprint(wanted));
    // A report stored before the field existed reads as not excused: no spurious re-report.
    const { alwaysExcused: _dropped, ...legacy } = wanted;
    expect(permissionsFingerprint(legacy)).toBe(permissionsFingerprint(wanted));
  });

  it('carries ack and reportedFrom', () => {
    const p = toServerPermissions(snap(), 'background', true);
    expect(p.ack).toBe(true);
    expect(p.reportedFrom).toBe('background');
  });

  it('leaves motion out when it could not be checked (a missing key is unknown, never a lapse)', () => {
    const p = toServerPermissions(snap({ motion: null }), 'foreground');
    expect('motion' in p).toBe(false);
    expect(permissionsFingerprint(p)).toBe(permissionsFingerprint(snap({ motion: null })));
  });

  it('fits in 2048 bytes', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(toServerPermissions(snap(), 'background', true)));
    expect(bytes.length).toBeLessThanOrEqual(2048);
  });
});

describe('permissionsFingerprint', () => {
  it('is stable across time, low power, can-ask-again, reportedFrom and ack', () => {
    const a = snap();
    const b = snap({ checkedAt: a.checkedAt + 60_000, lowPowerMode: false, locationCanAskAgain: true, notificationsCanAskAgain: false });
    expect(permissionsFingerprint(a)).toBe(permissionsFingerprint(b));
    expect(permissionsFingerprint(toServerPermissions(a, 'foreground'))).toBe(permissionsFingerprint(a));
    expect(permissionsFingerprint(toServerPermissions(a, 'background', true))).toBe(permissionsFingerprint(a));
  });

  it('changes when any reported permission changes', () => {
    const base = permissionsFingerprint(snap());
    for (const over of [
      { location: 'always' },
      { precise: false },
      { precise: null },
      { motion: 'denied' },
      { motion: null },
      { notifications: 'granted' },
      { batteryOptimization: 'unknown' },
    ] as Partial<PermissionSnapshot>[]) {
      expect(permissionsFingerprint(snap(over))).not.toBe(base);
    }
  });
});
