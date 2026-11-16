// The touch-feedback helper (src/ui/haptics.ts): iPhone keeps the Taptic calls it always made;
// Android uses the system's touch-feedback constants, falling back on older releases.
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import { androidHapticFor, haptics } from '../haptics';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  performAndroidHapticsAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
  AndroidHaptics: { Confirm: 'confirm', Segment_Tick: 'segment-tick', Virtual_Key: 'virtual-key' },
}));

const H = Haptics as unknown as Record<'impactAsync' | 'notificationAsync' | 'performAndroidHapticsAsync', jest.Mock>;

let restore: (() => void)[] = [];
function setPlatform(os: 'ios' | 'android', version?: number) {
  restore.push(jest.replaceProperty(Platform, 'OS', os).restore);
  if (version !== undefined) {
    const spy = jest.spyOn(Platform, 'Version', 'get').mockReturnValue(version);
    restore.push(() => spy.mockRestore());
  }
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  restore.forEach((r) => r());
  restore = [];
});

test('iPhone: a tick and a press are a light impact, a success the success notification', () => {
  setPlatform('ios');
  haptics.tick();
  haptics.press();
  haptics.success();
  expect(H.impactAsync.mock.calls).toEqual([['light'], ['light']]);
  expect(H.notificationAsync.mock.calls).toEqual([['success']]);
  expect(H.performAndroidHapticsAsync).not.toHaveBeenCalled();
});

test('Android 14 and up: segment tick, virtual key, confirm; never the vibrator one-shots', () => {
  setPlatform('android', 34);
  haptics.tick();
  haptics.press();
  haptics.success();
  expect(H.performAndroidHapticsAsync.mock.calls).toEqual([['segment-tick'], ['virtual-key'], ['confirm']]);
  expect(H.impactAsync).not.toHaveBeenCalled();
  expect(H.notificationAsync).not.toHaveBeenCalled();
});

test('the Android constant falls back to what each release has', () => {
  expect(androidHapticFor('tick', 33)).toBe('virtual-key');
  expect(androidHapticFor('success', 30)).toBe('confirm');
  expect(androidHapticFor('success', 29)).toBe('virtual-key');
  expect(androidHapticFor('press', 36)).toBe('virtual-key');
  expect(androidHapticFor('tick', 24)).toBe('virtual-key');
});

test('a rejected or missing native call never throws', async () => {
  setPlatform('android', 35);
  H.performAndroidHapticsAsync.mockImplementationOnce(async () => {
    throw new Error('not supported');
  });
  expect(() => haptics.success()).not.toThrow();
  H.performAndroidHapticsAsync.mockImplementationOnce(() => {
    throw new Error('no module');
  });
  expect(() => haptics.tick()).not.toThrow();
  await Promise.resolve();
});
