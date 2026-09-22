import { assessHealth, nextEverGranted } from '../health';
import type { HealthContext, HealthRow, HealthRowId, PermissionSnapshot } from '../types';

const snap = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  platform: 'android',
  location: 'always',
  precise: true,
  locationCanAskAgain: true,
  motion: 'granted',
  notifications: 'granted',
  notificationsCanAskAgain: true,
  batteryOptimization: 'exempt',
  lowPowerMode: false,
  checkedAt: 1_700_000_000_000,
  ...over,
});

const ctx = (over: Partial<HealthContext> = {}): HealthContext => ({
  drives: true,
  autoDetectOn: true,
  firstDriveDone: true,
  manualByChoice: false,
  everGranted: {},
  ...over,
});

const row = (rows: HealthRow[], id: HealthRowId): HealthRow | undefined =>
  rows.find((r) => r.id === id);

describe('assessHealth', () => {
  it('everything granted on Android with auto-record on: ok, automatic, no banner', () => {
    const r = assessHealth(snap(), ctx());
    expect(r.overall).toBe('ok');
    expect(r.recordingMode).toBe('automatic');
    expect(r.showBanner).toBe(false);
    expect(r.rows.map((x) => x.id)).toEqual([
      'location',
      'precise',
      'locationAlways',
      'autoRecord',
      'motion',
      'notifications',
      'battery',
    ]);
    expect(r.rows.every((x) => x.status === 'ok' && x.fix === 'none')).toBe(true);
  });

  it('never has Bluetooth, camera or usage-access rows', () => {
    const ids = assessHealth(snap({ platform: 'ios' }), ctx()).rows.map((x) => x.id as string);
    for (const banned of ['bluetooth', 'camera', 'usageAccess']) expect(ids).not.toContain(banned);
  });

  it('iOS has the Low Power row (informational) and no battery row', () => {
    const r = assessHealth(snap({ platform: 'ios', lowPowerMode: true }), ctx());
    expect(row(r.rows, 'battery')).toBeUndefined();
    expect(row(r.rows, 'lowPower')).toEqual({ id: 'lowPower', status: 'info', fix: 'none' });
    expect(r.overall).toBe('ok');
  });

  describe('iOS before the first completed drive', () => {
    const s = snap({ platform: 'ios', location: 'foreground' });
    const c = ctx({ firstDriveDone: false, autoDetectOn: false });

    it('the Always row is info, fix none, reason afterFirstDrive — never a request', () => {
      const r = assessHealth(s, c);
      expect(row(r.rows, 'locationAlways')).toEqual({
        id: 'locationAlways',
        status: 'info',
        fix: 'none',
        reason: 'afterFirstDrive',
      });
      expect(row(r.rows, 'autoRecord')).toMatchObject({ status: 'info', fix: 'none' });
      expect(r.rows.some((x) => x.id === 'locationAlways' && x.fix === 'request')).toBe(false);
    });

    it('shows no banner and is not "attention"', () => {
      const r = assessHealth(s, c);
      expect(r.showBanner).toBe(false);
      expect(r.overall).toBe('ok');
      expect(r.recordingMode).toBe('manual');
    });

    it('still no request even when the OS could ask and Always was once granted', () => {
      const r = assessHealth(
        { ...s, locationCanAskAgain: true },
        { ...c, autoDetectOn: true, everGranted: { locationAlways: true } }
      );
      expect(row(r.rows, 'locationAlways')).toMatchObject({ status: 'info', fix: 'none' });
      expect(row(r.rows, 'autoRecord')?.fix).not.toBe('request');
    });
  });

  describe('manual mode by choice', () => {
    it('Always and auto-record rows are info with reason choice, no fix, no banner', () => {
      const r = assessHealth(
        snap({ location: 'foreground' }),
        ctx({ manualByChoice: true, autoDetectOn: false, everGranted: { locationAlways: true } })
      );
      expect(row(r.rows, 'locationAlways')).toEqual({
        id: 'locationAlways',
        status: 'info',
        fix: 'none',
        reason: 'choice',
      });
      expect(row(r.rows, 'autoRecord')).toEqual({
        id: 'autoRecord',
        status: 'info',
        fix: 'none',
        reason: 'choice',
      });
      expect(r.showBanner).toBe(false);
      expect(r.overall).toBe('ok');
      expect(r.recordingMode).toBe('manual');
    });

    it('battery optimisation is not raised against a manual-by-choice driver', () => {
      const r = assessHealth(
        snap({ location: 'foreground', batteryOptimization: 'optimized' }),
        ctx({ manualByChoice: true, autoDetectOn: false })
      );
      expect(row(r.rows, 'battery')).toEqual({
        id: 'battery',
        status: 'info',
        fix: 'none',
        reason: 'choice',
      });
    });
  });

  describe('states the driver did not choose raise the banner', () => {
    it('location denied: off, broken, banner; Settings when the OS cannot ask', () => {
      const r = assessHealth(snap({ location: 'denied', precise: null, locationCanAskAgain: false }), ctx());
      expect(row(r.rows, 'location')).toEqual({ id: 'location', status: 'off', fix: 'openSettings' });
      expect(r.showBanner).toBe(true);
      expect(r.overall).toBe('broken');
      expect(r.recordingMode).toBe('unavailable');
      // No Always / precise rows while location itself is off: the location row carries it.
      expect(row(r.rows, 'locationAlways')).toBeUndefined();
      expect(row(r.rows, 'precise')).toBeUndefined();
    });

    it('location denied but askable: the fix is a request', () => {
      const r = assessHealth(snap({ location: 'denied', precise: null, locationCanAskAgain: true }), ctx());
      expect(row(r.rows, 'location')?.fix).toBe('request');
    });

    it('approximate location: attention, Settings, banner', () => {
      const r = assessHealth(snap({ precise: false }), ctx());
      expect(row(r.rows, 'precise')).toEqual({ id: 'precise', status: 'attention', fix: 'openSettings' });
      expect(r.showBanner).toBe(true);
      expect(r.overall).toBe('attention');
    });

    it('Always lapsed from granted while auto-record is wanted: attention, lapsed, banner', () => {
      const r = assessHealth(
        snap({ location: 'foreground', locationCanAskAgain: false }),
        ctx({ everGranted: { location: true, locationAlways: true } })
      );
      expect(row(r.rows, 'locationAlways')).toEqual({
        id: 'locationAlways',
        status: 'attention',
        fix: 'openSettings',
        reason: 'lapsed',
      });
      expect(row(r.rows, 'autoRecord')).toMatchObject({ status: 'attention', reason: 'lapsed' });
      expect(r.showBanner).toBe(true);
      expect(r.recordingMode).toBe('manual');
    });

    it('location lapsed from granted to denied: reason lapsed, banner', () => {
      const r = assessHealth(
        snap({ location: 'denied', precise: null, locationCanAskAgain: false }),
        ctx({ everGranted: { location: true } })
      );
      expect(row(r.rows, 'location')).toEqual({
        id: 'location',
        status: 'off',
        fix: 'openSettings',
        reason: 'lapsed',
      });
      expect(r.showBanner).toBe(true);
    });

    it('motion lapsed from granted: off, lapsed, Settings, banner', () => {
      const r = assessHealth(snap({ motion: 'denied' }), ctx({ everGranted: { motion: true } }));
      expect(row(r.rows, 'motion')).toEqual({
        id: 'motion',
        status: 'off',
        fix: 'openSettings',
        reason: 'lapsed',
      });
      expect(r.showBanner).toBe(true);
      expect(r.recordingMode).toBe('manual');
    });
  });

  describe('states that are not a lapse and not chosen-against raise no banner', () => {
    it('motion denied without ever being granted: off, no banner', () => {
      const r = assessHealth(snap({ motion: 'denied' }), ctx());
      expect(row(r.rows, 'motion')).toEqual({ id: 'motion', status: 'off', fix: 'openSettings' });
      expect(r.showBanner).toBe(false);
    });

    it('location undetermined: attention with a request, no banner, recording unavailable', () => {
      const r = assessHealth(snap({ location: 'undetermined', precise: null }), ctx({ autoDetectOn: false }));
      expect(row(r.rows, 'location')).toEqual({ id: 'location', status: 'attention', fix: 'request' });
      expect(r.showBanner).toBe(false);
      expect(r.recordingMode).toBe('unavailable');
      expect(r.overall).toBe('broken');
    });

    it('Android foreground-only with auto-record off (its opt-in default): no Always nag', () => {
      const r = assessHealth(
        snap({ location: 'foreground', batteryOptimization: 'optimized' }),
        ctx({ autoDetectOn: false })
      );
      expect(row(r.rows, 'locationAlways')).toEqual({
        id: 'locationAlways',
        status: 'info',
        fix: 'none',
        reason: 'choice',
      });
      expect(row(r.rows, 'autoRecord')).toMatchObject({ status: 'info', reason: 'choice' });
      expect(row(r.rows, 'battery')).toEqual({ id: 'battery', status: 'info', fix: 'none', reason: 'choice' });
      expect(r.showBanner).toBe(false);
      expect(r.overall).toBe('ok');
    });

    it('negative control: auto-record wanted, Always never granted → attention with a request, no banner', () => {
      const r = assessHealth(snap({ location: 'foreground' }), ctx({ autoDetectOn: true }));
      expect(row(r.rows, 'locationAlways')).toEqual({
        id: 'locationAlways',
        status: 'attention',
        fix: 'request',
      });
      expect(row(r.rows, 'autoRecord')).toEqual({ id: 'autoRecord', status: 'attention', fix: 'request' });
      expect(r.showBanner).toBe(false);
      expect(r.overall).toBe('attention');
    });

    it('Always lapsed but auto-record turned off by the driver: no banner', () => {
      const r = assessHealth(
        snap({ location: 'foreground' }),
        ctx({ autoDetectOn: false, everGranted: { locationAlways: true } })
      );
      expect(r.showBanner).toBe(false);
    });

    it('notifications denied: off, no banner; askable → request, else Settings', () => {
      const a = assessHealth(snap({ notifications: 'denied', notificationsCanAskAgain: false }), ctx());
      expect(row(a.rows, 'notifications')).toEqual({ id: 'notifications', status: 'off', fix: 'openSettings' });
      expect(a.showBanner).toBe(false);
      const b = assessHealth(snap({ notifications: 'undetermined' }), ctx());
      expect(row(b.rows, 'notifications')).toEqual({ id: 'notifications', status: 'attention', fix: 'request' });
    });

    it('provisional notifications count as on', () => {
      const r = assessHealth(snap({ notifications: 'provisional' }), ctx());
      expect(row(r.rows, 'notifications')?.status).toBe('ok');
    });

    it('motion unavailable: info, no fix', () => {
      const r = assessHealth(snap({ motion: 'unavailable' }), ctx({ autoDetectOn: false }));
      expect(row(r.rows, 'motion')).toEqual({ id: 'motion', status: 'info', fix: 'none' });
    });

    it('motion undetermined: attention with a request', () => {
      const r = assessHealth(snap({ motion: 'undetermined' }), ctx());
      expect(row(r.rows, 'motion')).toEqual({ id: 'motion', status: 'attention', fix: 'request' });
    });
  });

  describe('Android battery optimisation', () => {
    it('unknown → info, reason cantCheck, no fix', () => {
      const r = assessHealth(snap({ batteryOptimization: 'unknown' }), ctx());
      expect(row(r.rows, 'battery')).toEqual({
        id: 'battery',
        status: 'info',
        fix: 'none',
        reason: 'cantCheck',
      });
      expect(r.overall).toBe('ok');
    });

    it('optimized while auto-record is wanted → attention, battery settings (negative control)', () => {
      const r = assessHealth(snap({ batteryOptimization: 'optimized' }), ctx());
      expect(row(r.rows, 'battery')).toEqual({ id: 'battery', status: 'attention', fix: 'openBatterySettings' });
      expect(r.overall).toBe('attention');
      expect(r.showBanner).toBe(false);
    });
  });

  describe('auto-record withdrawn by the server (flag off)', () => {
    const c = ctx({ autoDetectAvailable: false, autoDetectOn: true, everGranted: { locationAlways: true } });

    it('Always, auto-record and battery rows are info notAvailable — no "tap to fix", no banner', () => {
      const r = assessHealth(snap({ location: 'foreground', batteryOptimization: 'optimized' }), c);
      for (const id of ['locationAlways', 'autoRecord', 'battery'] as const) {
        expect(row(r.rows, id)).toEqual({ id, status: 'info', fix: 'none', reason: 'notAvailable' });
      }
      expect(r.showBanner).toBe(false);
      expect(r.overall).toBe('ok');
    });

    it('iOS before the first drive says notAvailable, not "after your first drive"', () => {
      const r = assessHealth(snap({ platform: 'ios', location: 'foreground' }), { ...c, firstDriveDone: false });
      expect(row(r.rows, 'locationAlways')?.reason).toBe('notAvailable');
    });

    it('negative control: the same lapse with the flag on raises the banner', () => {
      const r = assessHealth(snap({ location: 'foreground' }), { ...c, autoDetectAvailable: true });
      expect(r.showBanner).toBe(true);
      expect(row(r.rows, 'locationAlways')?.status).toBe('attention');
    });
  });

  describe('motion that could not be checked', () => {
    it('is info cantCheck, raises no banner, and does not decide the recording mode', () => {
      const r = assessHealth(snap({ motion: null }), ctx({ everGranted: { motion: true } }));
      expect(row(r.rows, 'motion')).toEqual({ id: 'motion', status: 'info', fix: 'none', reason: 'cantCheck' });
      expect(r.showBanner).toBe(false);
      expect(r.recordingMode).toBe('automatic');
      expect(r.overall).toBe('ok');
    });
  });

  describe('recordingMode', () => {
    it('automatic needs auto-record on, Always and motion', () => {
      expect(assessHealth(snap(), ctx()).recordingMode).toBe('automatic');
      expect(assessHealth(snap(), ctx({ autoDetectOn: false })).recordingMode).toBe('manual');
      expect(assessHealth(snap({ motion: 'denied' }), ctx()).recordingMode).toBe('manual');
      expect(assessHealth(snap({ location: 'foreground' }), ctx()).recordingMode).toBe('manual');
    });

    it('never automatic while the server withdraws auto-record', () => {
      const r = assessHealth(snap(), ctx({ autoDetectAvailable: false }));
      expect(r.recordingMode).toBe('manual');
      expect(row(r.rows, 'autoRecord')).toEqual({
        id: 'autoRecord',
        status: 'info',
        fix: 'none',
        reason: 'notAvailable',
      });
    });

    it('auto-record on but motion missing: the auto-record row points at the motion fix', () => {
      const r = assessHealth(snap({ motion: 'undetermined' }), ctx());
      expect(row(r.rows, 'autoRecord')).toEqual({ id: 'autoRecord', status: 'attention', fix: 'request' });
    });

    it('auto-record off by choice with everything granted: info choice', () => {
      const r = assessHealth(snap(), ctx({ autoDetectOn: false }));
      expect(row(r.rows, 'autoRecord')).toEqual({
        id: 'autoRecord',
        status: 'info',
        fix: 'none',
        reason: 'choice',
      });
      expect(r.overall).toBe('ok');
    });
  });

  it('a non-driver gets only the notifications row, never a banner', () => {
    const r = assessHealth(snap({ location: 'denied', motion: 'denied', precise: null }), ctx({ drives: false }));
    expect(r.rows.map((x) => x.id)).toEqual(['notifications']);
    expect(r.showBanner).toBe(false);
    expect(r.recordingMode).toBe('unavailable');
    expect(r.overall).toBe('ok');
  });

  it('precise null while location is granted: info cantCheck', () => {
    const r = assessHealth(snap({ precise: null }), ctx());
    expect(row(r.rows, 'precise')).toEqual({ id: 'precise', status: 'info', fix: 'none', reason: 'cantCheck' });
  });
});

describe('nextEverGranted', () => {
  it('adds what is granted now and never forgets', () => {
    expect(nextEverGranted({}, snap({ location: 'foreground', motion: 'denied' }))).toEqual({ location: true });
    expect(nextEverGranted({ motion: true }, snap())).toEqual({
      location: true,
      locationAlways: true,
      motion: true,
    });
    expect(
      nextEverGranted({ locationAlways: true }, snap({ location: 'denied', motion: 'denied' }))
    ).toEqual({ locationAlways: true });
  });

  it('returns the same object when nothing new was granted (no needless write)', () => {
    const prev = { location: true, locationAlways: true, motion: true };
    expect(nextEverGranted(prev, snap())).toBe(prev);
  });
});

describe('this account has not affirmed the disclosure (Task 19 r1, security I-1)', () => {
  it('auto-record wanted, Always and motion allowed: manual, its own fixable reason, and a banner', () => {
    const r = assessHealth(snap(), ctx({ disclosureAffirmed: false }));
    expect(r.recordingMode).toBe('manual');
    expect(row(r.rows, 'autoRecord')).toEqual({
      id: 'autoRecord',
      status: 'attention',
      fix: 'request',
      reason: 'notAffirmed',
    });
    expect(r.showBanner).toBe(true);
    expect(r.overall).toBe('attention');
  });

  it('never shown as a choice, and never raised where auto-record is not wanted or offered', () => {
    for (const c of [
      ctx({ disclosureAffirmed: false, autoDetectOn: false }),
      ctx({ disclosureAffirmed: false, manualByChoice: true }),
      ctx({ disclosureAffirmed: false, autoDetectAvailable: false }),
    ]) {
      const r = assessHealth(snap(), c);
      expect(row(r.rows, 'autoRecord')?.reason).not.toBe('notAffirmed');
      expect(r.showBanner).toBe(false);
    }
  });

  it('a missing permission is named first: without Always the row points at Always, not the affirmation', () => {
    const r = assessHealth(snap({ location: 'foreground' }), ctx({ disclosureAffirmed: false }));
    expect(row(r.rows, 'autoRecord')?.reason).not.toBe('notAffirmed');
  });

  it('affirmed, or not known (a pure caller): automatic as before', () => {
    expect(assessHealth(snap(), ctx({ disclosureAffirmed: true })).recordingMode).toBe('automatic');
    expect(assessHealth(snap(), ctx()).recordingMode).toBe('automatic');
  });
});
