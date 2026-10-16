/**
 * The forgot-to-start reminder's JS side: turning it on asks only at that tap and only for what is
 * missing (iOS: While Using first, then "Always" once; Android: never any location), it is saved on
 * even when something stays missing, and the Settings line says what it does or needs.
 */
import { createFakeDriveSense, type TripReminderStatus } from '@drive-sense';

import { fakeAdapter, snap } from '@/features/permissions/__fixtures__/harness';

import { reminderCopy } from '../copy';
import { readReminderStatus, turnOffReminder, turnOnReminder } from '../enable';
import { reminderLine } from '../line';

const status = (over: Partial<TripReminderStatus> = {}): TripReminderStatus => ({
  enabled: true,
  state: 'on',
  missing: [],
  ...over,
});

describe('turnOnReminder', () => {
  test('iOS: motion, notifications, While Using, then Always (once); saved on; never a drive start', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', motion: 'undetermined', notifications: 'undetermined' }));
    const native = createFakeDriveSense({ platform: 'ios' });
    const s = await turnOnReminder(adapter, native);
    expect(adapter.log).toEqual(['snapshot', 'requestMotion', 'requestNotifications', 'requestLocationForeground', 'snapshot', 'requestAlwaysForReminder']);
    expect(s).toMatchObject({ enabled: true, state: 'on' });
    expect(native.tripReminderOn).toBe(true);
    expect(native.calls).toEqual(['setTripReminder:true']);
  });

  test('iOS with While Using already: Always is the one location request', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }));
    await turnOnReminder(adapter, createFakeDriveSense({ platform: 'ios' }));
    expect(adapter.log).toEqual(['snapshot', 'requestAlwaysForReminder']);
  });

  test('iOS with location denied: no location prompt at all; on, and the status says what is missing', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'denied' }));
    const native = createFakeDriveSense({ platform: 'ios' });
    native.setTripReminderEnv({ missing: ['locationAlways'] });
    const s = await turnOnReminder(adapter, native);
    expect(adapter.log).toEqual(['snapshot']);
    expect(s).toMatchObject({ enabled: true, state: 'needs', missing: ['locationAlways'] });
  });

  test('Android: motion and notifications only; no location of any kind', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', motion: 'undetermined', notifications: 'denied', notificationsCanAskAgain: true }));
    await turnOnReminder(adapter, createFakeDriveSense({ platform: 'android' }));
    expect(adapter.log).toEqual(['snapshot', 'requestMotion', 'requestNotifications']);
  });

  test('nothing missing asks nothing; notifications refused for good are not asked again', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', notifications: 'denied', notificationsCanAskAgain: false }));
    await turnOnReminder(adapter, createFakeDriveSense({ platform: 'android' }));
    expect(adapter.log).toEqual(['snapshot']);
  });

  test('a phone that cannot run it is asked nothing and stays off', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', motion: 'undetermined', notifications: 'undetermined' }));
    const native = createFakeDriveSense({ platform: 'android' });
    native.setTripReminderEnv({ available: false });
    await expect(turnOnReminder(adapter, native)).resolves.toMatchObject({ enabled: false, state: 'unavailable' });
    expect(adapter.log).toEqual([]);
    expect(native.calls).toEqual([]);
    expect(native.tripReminderOn).toBe(false);
  });

  test('a phone read that fails still turns it on', async () => {
    const adapter = fakeAdapter(snap());
    adapter.failReads = true;
    const native = createFakeDriveSense({ platform: 'android' });
    await expect(turnOnReminder(adapter, native)).resolves.toMatchObject({ enabled: true });
  });

  test('off and read go straight to native', async () => {
    const native = createFakeDriveSense({ platform: 'android' });
    await native.setTripReminder(true);
    await expect(readReminderStatus(native)).resolves.toMatchObject({ state: 'on' });
    await expect(turnOffReminder(native)).resolves.toMatchObject({ enabled: false, state: 'off' });
    expect(native.calls).toEqual(['setTripReminder:true', 'setTripReminder:false']);
    expect(native.calls.some((c) => c.startsWith('startCapture'))).toBe(false);
  });
});

describe('the Settings line', () => {
  const L = reminderCopy.lines;
  test.each([
    ['off', status({ enabled: false, state: 'off' }), 'android', L.off, null],
    ['on, Android', status(), 'android', L.onAndroid, null],
    ['on, iPhone', status(), 'ios', L.onIos, null],
    ['unavailable', status({ enabled: false, state: 'unavailable' }), 'android', L.unavailable, null],
  ] as const)('%s', (_name, s, platform, text, action) => {
    expect(reminderLine(s, platform)).toMatchObject({ text, action });
  });

  test('Android names only what is missing', () => {
    expect(reminderLine(status({ state: 'needs', missing: ['motion', 'notifications'] }), 'android').text).toBe(
      'On, but it needs motion access and notifications.'
    );
    expect(reminderLine(status({ state: 'needs', missing: ['notifications'] }), 'android')).toEqual({
      text: 'On, but it needs notifications.',
      action: 'openSettings',
      disabled: false,
    });
  });

  test('iPhone names the first thing to fix: Always, then precise, then notifications', () => {
    expect(reminderLine(status({ state: 'needs', missing: ['notifications', 'locationAlways'] }), 'ios').text).toBe(L.needsAlways);
    expect(reminderLine(status({ state: 'needs', missing: ['notifications', 'locationPrecise'] }), 'ios').text).toBe(L.needsPrecise);
    expect(reminderLine(status({ state: 'needs', missing: ['notifications'] }), 'ios').text).toBe(L.needsIosNotifications);
  });

  test('the unavailable switch is disabled', () => {
    expect(reminderLine(status({ state: 'unavailable' }), 'ios').disabled).toBe(true);
  });

  test('the words promise only a note, never a drive started for you', () => {
    const all = JSON.stringify(reminderCopy).toLowerCase();
    expect(all).toContain('never starts a drive');
    expect(all).not.toMatch(/automatic|auto-start|starts recording|records for you/);
  });
});
