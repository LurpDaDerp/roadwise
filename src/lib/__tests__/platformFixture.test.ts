// The test helper that runs a test as one phone (`src/lib/__fixtures__/platform.ts`): `OS`, `select`
// and `Version` move together and come back as they were.
import { Platform } from 'react-native';

import { asPlatform, PLATFORMS, runAs } from '@/lib/__fixtures__/platform';

test('Jest runs as iOS; asPlatform moves OS, select and Version to Android and restores them (twice is harmless)', () => {
  expect(Platform.OS).toBe('ios');
  const version = Platform.Version;
  const restore = asPlatform('android');
  expect(Platform.OS).toBe('android');
  expect(Platform.select({ ios: 'i', android: 'a' })).toBe('a');
  expect(Platform.select({ ios: 'i', native: 'n' })).toBe('n');
  expect(Platform.select({ ios: 'i', default: 'd' })).toBe('d');
  expect(Platform.Version).toBe(35);
  restore();
  restore();
  expect(Platform.OS).toBe('ios');
  expect(Platform.select({ ios: 'i', android: 'a' })).toBe('i');
  expect(Platform.Version).toBe(version);
});

test('a version of its own (an older Android)', () => {
  const restore = asPlatform('android', 29);
  expect(Platform.Version).toBe(29);
  restore();
});

test('both phones, iOS first', () => {
  expect(PLATFORMS).toEqual(['ios', 'android']);
});

describe('runAs', () => {
  runAs('android');
  test('every test in the describe is Android', () => {
    expect(Platform.OS).toBe('android');
  });
});

test('and back to iOS after it', () => {
  expect(Platform.OS).toBe('ios');
});
