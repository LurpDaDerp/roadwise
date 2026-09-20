import { resolveStart } from '@/features/auth/authGuard';

test('loading → null', () => expect(resolveStart('loading', false)).toBeNull());
test('signed out → welcome', () => expect(resolveStart('signedOut', false)).toBe('/(auth)/welcome'));
test('signed in, not onboarded → onboarding', () =>
  expect(resolveStart('signedIn', false)).toBe('/(onboarding)'));
test('signed in, onboarded → home', () =>
  expect(resolveStart('signedIn', true)).toBe('/(tabs)/home'));
