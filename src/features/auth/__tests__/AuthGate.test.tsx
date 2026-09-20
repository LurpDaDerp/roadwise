import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AuthGate } from '@/features/auth/AuthGate';

type Status = 'loading' | 'signedOut' | 'signedIn';

// Read from inside the mocked hooks at render time, so each case can set the world before it runs.
const mockReplace = jest.fn();
const mockWorld: { status: Status; segments: string[] } = { status: 'loading', segments: [] };

jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ status: mockWorld.status }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSegments: () => mockWorld.segments,
}));

async function mount(status: Status, segments: string[]) {
  mockWorld.status = status;
  mockWorld.segments = segments;
  mockReplace.mockClear();
  await render(
    <AuthGate>
      <Text>app</Text>
    </AuthGate>
  );
}

const cases: [Status, string[], string | null][] = [
  // Nothing is known yet: a warm start must not flash Welcome at a signed-in driver.
  ['loading', [], null],
  ['loading', ['(auth)', 'welcome'], null],
  ['loading', ['(tabs)', 'home'], null],
  // Signing out, or a session expiring, cannot leave anyone inside the app.
  ['signedOut', ['(tabs)', 'home'], '/(auth)/welcome'],
  ['signedOut', ['(auth)', 'sign-in'], null],
  // A magic-link landing is signed out until the exchange comes back. Moving now would unmount
  // the callback mid-flight and an expired link could never show its retry.
  ['signedOut', ['auth', 'callback'], null],
  // Signing in moves the driver on, from the sign-in screen or the deep-link landing pad.
  ['signedIn', ['(auth)', 'welcome'], '/(tabs)/home'],
  ['signedIn', ['(auth)', 'sign-in'], '/(tabs)/home'],
  ['signedIn', ['auth', 'callback'], '/(tabs)/home'],
  ['signedIn', ['(tabs)', 'insights'], null],
  // The launch router owns the cold start at `/`, whatever the status; a second opinion from the
  // gate only mounts the destination twice.
  ['signedIn', [], null],
  ['signedOut', [], null],
];

test.each(cases)('%s at [%s] redirects to %s', async (status, segments, expected) => {
  await mount(status, segments);
  if (expected === null) expect(mockReplace).not.toHaveBeenCalled();
  else expect(mockReplace).toHaveBeenCalledWith(expected);
});

test('passes the app through untouched', async () => {
  await mount('signedIn', ['(tabs)', 'home']);
  expect(screen.getByText('app')).toBeOnTheScreen();
});
