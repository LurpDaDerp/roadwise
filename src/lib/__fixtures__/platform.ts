// Running a test as one phone. Jest runs as iOS (jest-expo's default preset), and React Native's iOS
// `Platform` answers `select` with the iOS branch whatever `OS` says, so flipping `OS` alone leaves
// half of a module on iOS. `asPlatform` flips both (and `Version`: Android's API level, iOS's
// version string) until its restore runs; `runAs` does it around every test of a describe. A module
// that takes its platform as an argument (the drive host's `platform`, the display's) needs neither:
// pass it.
import { Platform } from 'react-native';

export type TestOS = 'ios' | 'android';

/** Both phones, for `it.each` / `describe.each` over a behaviour that must match. */
export const PLATFORMS: readonly TestOS[] = ['ios', 'android'];

/** What `Platform.Version` reads as each phone (Android 15's API level; an iOS 18 version string). */
const VERSION: Record<TestOS, number | string> = { android: 35, ios: '18.0' };

type Spec<T> = { ios?: T; android?: T; native?: T; default?: T };

/** `Platform.select` as React Native answers it on `os`. */
const selectOn =
  (os: TestOS) =>
  <T>(spec: Spec<T>): T | undefined =>
    os in spec ? spec[os] : 'native' in spec ? spec.native : spec.default;

/**
 * `Platform.OS`, `Platform.select` and `Platform.Version` as on `os`, `version` overriding the
 * default version. Returns the restore (idempotent).
 */
export function asPlatform(os: TestOS, version?: number | string): () => void {
  const target = Platform as unknown as Record<string, unknown>;
  const keys = ['OS', 'select', 'Version'] as const;
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(target, k)] as const);
  Object.defineProperty(target, 'OS', { value: os, configurable: true, writable: true });
  Object.defineProperty(target, 'select', { value: selectOn(os), configurable: true, writable: true });
  Object.defineProperty(target, 'Version', { value: version ?? VERSION[os], configurable: true, writable: true });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(target, k, d);
      else delete target[k];
    }
  };
}

/** Every test in the enclosing describe runs as `os` (set before each, restored after). */
export function runAs(os: TestOS, version?: number | string): void {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = asPlatform(os, version);
  });
  afterEach(() => {
    restore?.();
    restore = null;
  });
}
