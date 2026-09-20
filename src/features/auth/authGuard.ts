/**
 * Where a cold start lands. The launch route is a pure function of the two facts the app knows
 * before it draws anything, so it can be reasoned about (and tested) without a navigator.
 */
export type StartRoute = '/(auth)/welcome' | '/(onboarding)' | '/(tabs)/home';

export function resolveStart(
  status: 'loading' | 'signedOut' | 'signedIn',
  onboarded: boolean
): StartRoute | null {
  // Null, not a route: while the stored session is still being read nobody may be sent anywhere,
  // or a warm start flashes the sign-in screen at a signed-in driver.
  if (status === 'loading') return null;
  if (status === 'signedOut') return '/(auth)/welcome';
  return onboarded ? '/(tabs)/home' : '/(onboarding)';
}
