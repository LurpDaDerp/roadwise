import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SessionProvider, useSession } from '@/data/supabase/session';

// `jest.mock` is hoisted above these imports; the variables below are only read from inside the
// mocked functions, so they are initialised by the time any of them runs.
const listeners: ((e: string, s: unknown) => void)[] = [];
// Held open so the provider's first paint can be observed while getSession is still in flight.
const mockSessionGate: { resolve?: (value: { data: { session: unknown } }) => void } = {};
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => new Promise((resolve) => { mockSessionGate.resolve = resolve; })),
      onAuthStateChange: jest.fn((cb: (e: string, s: unknown) => void) => { listeners.push(cb); return { data: { subscription: { unsubscribe: jest.fn() } } }; }),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));
jest.mock('@/data/supabase/profile', () => ({ fetchProfile: jest.fn(async () => ({ id: 'u1', display_name: 'Ava', age_band: '18_plus' })) }));

function Probe() { const s = useSession(); return <Text>{s.status}:{s.profile?.display_name ?? '-'}</Text>; }

test('starts loading, becomes signedOut, then signedIn with profile on auth event', async () => {
  await render(<SessionProvider><Probe /></SessionProvider>);
  // While the stored session is still being read nothing downstream may treat the user as signed
  // out - that is what keeps a warm start off the sign-in screen.
  expect(screen.getByText('loading:-')).toBeTruthy();

  // The provider settles inside promises, so drive each transition through act(); otherwise React
  // warns that the state updates escaped it.
  await act(async () => {
    mockSessionGate.resolve?.({ data: { session: null } });
  });
  await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());

  await act(async () => {
    listeners.forEach((cb) => cb('SIGNED_IN', { user: { id: 'u1' } }));
  });
  await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
});
