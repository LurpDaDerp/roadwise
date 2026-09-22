import { drainPolicy, enterHeadless, isHeadlessActive, launchProfile } from '@/boot/launchProfile';

describe('launchProfile', () => {
  test('only an active app is a foreground launch', () => {
    expect(launchProfile({ currentState: 'active' })).toBe('foreground');
    // An iOS location wake, the Android headless task, and an iOS cold start not yet active.
    for (const state of ['background', 'inactive', 'unknown', null, undefined]) {
      expect(launchProfile({ currentState: state })).toBe('background');
    }
  });
});

describe('the headless task lifetime', () => {
  test('counts overlapping bodies, and a second leave is harmless', () => {
    expect(isHeadlessActive()).toBe(false);
    const leaveA = enterHeadless();
    const leaveB = enterHeadless();
    leaveA();
    leaveA();
    expect(isHeadlessActive()).toBe(true);
    leaveB();
    expect(isHeadlessActive()).toBe(false);
  });
});

describe('drainPolicy (§3.5: upload from the service or on foreground)', () => {
  test('drains while active, on either platform', () => {
    const appState = { currentState: 'active' as string | null };
    for (const os of ['ios', 'android']) {
      expect(drainPolicy({ appState, os, headlessActive: () => false })()).toBe(true);
    }
  });

  test('in the background only the Android headless task may drain', () => {
    const appState = { currentState: 'background' };
    expect(drainPolicy({ appState, os: 'ios', headlessActive: () => true })()).toBe(false);
    expect(drainPolicy({ appState, os: 'android', headlessActive: () => false })()).toBe(false);
    expect(drainPolicy({ appState, os: 'android', headlessActive: () => true })()).toBe(true);
  });

  test('is read live: a background launch the driver opens drains without a rebuild', () => {
    const appState = { currentState: 'background' };
    const mayDrain = drainPolicy({ appState, os: 'ios', headlessActive: () => false });
    expect(mayDrain()).toBe(false);
    appState.currentState = 'active';
    expect(mayDrain()).toBe(true);
  });
});
