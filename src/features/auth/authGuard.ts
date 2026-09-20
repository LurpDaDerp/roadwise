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

export type GateRoute = '/(auth)/welcome' | '/(tabs)/home';

/**
 * Where the gate has to move a driver who is already somewhere. Cold start is `resolveStart`'s
 * job; this answers the question every later change of `status` asks — signing in, signing out,
 * a session expiring under the app — where the screen on show is now the wrong one.
 */
export function resolveGate(
  status: 'loading' | 'signedOut' | 'signedIn',
  segments: readonly string[]
): GateRoute | null {
  // Nothing is known yet. Moving now would throw a signed-in driver at Welcome on every warm start.
  if (status === 'loading') return null;

  const inAuthGroup = segments[0] === '(auth)';
  // `app/auth/callback.tsx` sits outside the group: it is a deep-link landing pad, not a screen
  // anyone should be left on once the session it was carrying has arrived.
  const onCallback = segments[0] === 'auth' && segments[1] === 'callback';

  if (status === 'signedOut') return inAuthGroup ? null : '/(auth)/welcome';
  // Onboarding routes arrive in M4; until then a signed-in driver lands on Home.
  return inAuthGroup || onCallback ? '/(tabs)/home' : null;
}
