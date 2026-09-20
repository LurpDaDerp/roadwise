// Only the `DriveSense` lookup is stubbed. Replacing the whole of `expo-modules-core` (or every
// `requireNativeModule` call) strips the native classes Expo's winter runtime extends at load
// time, and the suite then dies with "Super expression must either be null or a function" before
// a single test runs.
jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  return {
    ...actual,
    requireNativeModule: (name: string) =>
      name === 'DriveSense'
        ? { getState: async () => ({ armed: false, capturing: false, platform: 'ios' }) }
        : actual.requireNativeModule(name),
  };
});

import DriveSense, { DRIVE_SENSE_EVENTS } from '../src';

test('getState resolves the shell state', async () => {
  await expect(DriveSense.getState()).resolves.toEqual({
    armed: false,
    capturing: false,
    platform: 'ios',
  });
});

test('event names are fixed', () => {
  expect(DRIVE_SENSE_EVENTS).toEqual([
    'wake',
    'activity',
    'row',
    'screen',
    'thermal',
    'notificationAction',
  ]);
});
