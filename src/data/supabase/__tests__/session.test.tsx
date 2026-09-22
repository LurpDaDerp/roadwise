import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text, View } from 'react-native';

import { SessionProvider, useSession } from '@/data/supabase/session';

type AuthListener = (event: string, session: unknown) => void;
type Gate<T> = { resolve?: (value: T) => void; reject?: (reason: unknown) => void };

// `jest.mock` is hoisted above these imports; the variables below are only read from inside the
// mocked functions, so they are initialised by the time any of them runs. Each is declared with a
// pure initialiser, which is what lets babel-plugin-jest-hoist accept them.
const listeners: AuthListener[] = [];
const profileCalls: string[] = [];
// The gates hold getSession / fetchProfile open, so a test can observe the provider mid-flight and
// decide the order in which promises settle.
const mockSessionGate: Gate<{ data: { session: unknown } }> = {};
const mockProfileGate: Gate<unknown> = {};
// Recorded rather than held as a jest.fn: the factory below is hoisted above these declarations,
// so it must not read one of them as a value at definition time.
const authCalls: string[] = [];

jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() => new Promise((resolve, reject) => { mockSessionGate.resolve = resolve; mockSessionGate.reject = reject; })),
      onAuthStateChange: jest.fn((cb: AuthListener) => { listeners.push(cb); return { data: { subscription: { unsubscribe: jest.fn() } } }; }),
      signOut: jest.fn(async () => { authCalls.push('signOut'); return { error: null }; }),
    },
  },
}));
// A scheduled "your drive is ready" must not fire after its driver signed out (U3).
jest.mock('@/features/drive/summaryNotifier', () => ({
  cancelDriveSummaries: jest.fn(async () => {
    authCalls.push('cancelDriveSummaries');
  }),
}));
jest.mock('@/data/supabase/profile', () => ({
  fetchProfile: jest.fn((userId: string) => new Promise((resolve, reject) => {
    profileCalls.push(userId);
    mockProfileGate.resolve = resolve;
    mockProfileGate.reject = reject;
  })),
}));

const ava = { id: 'u1', display_name: 'Ava', age_band: '18_plus' };
const sessionFor = (id: string) => ({ user: { id } });

function Probe() {
  const s = useSession();
  return (
    <View>
      <Text>{s.status}:{s.profile?.display_name ?? '-'}</Text>
      <Text onPress={() => { s.signOut().catch(() => {}); }}>sign out</Text>
      <Text onPress={() => { s.refreshProfile().catch(() => {}); }}>refresh</Text>
    </View>
  );
}

const emit = (event: string, session: unknown) => listeners.forEach((cb) => cb(event, session));

beforeEach(() => {
  listeners.length = 0;
  profileCalls.length = 0;
  authCalls.length = 0;
  delete mockSessionGate.resolve;
  delete mockSessionGate.reject;
  delete mockProfileGate.resolve;
  delete mockProfileGate.reject;
});

async function mount() {
  await render(<SessionProvider><Probe /></SessionProvider>);
}

test('starts loading, becomes signedOut, then signedIn with profile on auth event', async () => {
  await mount();
  // While the stored session is still being read nothing downstream may treat the user as signed
  // out - that is what keeps a warm start off the sign-in screen.
  expect(screen.getByText('loading:-')).toBeTruthy();

  // The provider settles inside promises, so drive each transition through act(); otherwise React
  // warns that the state updates escaped it.
  await act(async () => { mockSessionGate.resolve?.({ data: { session: null } }); });
  await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());

  await act(async () => { emit('SIGNED_IN', sessionFor('u1')); });
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
});

test('reading the stored session can fail without stranding the app on loading', async () => {
  await mount();
  expect(screen.getByText('loading:-')).toBeTruthy();

  // An unreadable Keychain entry rejects getSession; the app has to fall back to signed out rather
  // than hang on the splash screen forever.
  await act(async () => { mockSessionGate.reject?.(new Error('DecryptException')); });

  await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());
});

test('stays signed in when the profile row is not readable yet', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: null } }); });

  await act(async () => { emit('SIGNED_IN', sessionFor('u1')); });
  // The handle_new_user trigger can lag the first read; a missing row must not hold up sign-in.
  await act(async () => { mockProfileGate.reject?.(new Error('row not found')); });
  await waitFor(() => expect(screen.getByText('signedIn:-')).toBeTruthy());

  // A later event retries, because there is still no profile in hand.
  await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
  expect(profileCalls).toEqual(['u1', 'u1']);
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
});

test('does not refetch the profile for the same user on a token refresh', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());

  await act(async () => { emit('INITIAL_SESSION', sessionFor('u1')); });
  await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
  await act(async () => { emit('USER_UPDATED', sessionFor('u1')); });

  // One fetch for the whole lifecycle, and the profile never blinks out.
  expect(profileCalls).toEqual(['u1']);
  expect(screen.getByText('signedIn:Ava')).toBeTruthy();
});

test('a superseded load never overwrites newer state', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: null } }); });

  await act(async () => { emit('SIGNED_IN', sessionFor('u1')); });
  expect(profileCalls).toEqual(['u1']);

  // Signing out while that fetch is still in flight, then letting it land: the stale result must
  // not resurrect a session the user has already ended.
  await act(async () => { emit('SIGNED_OUT', null); });
  await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());
  await act(async () => { mockProfileGate.resolve?.(ava); });

  expect(screen.getByText('signedOut:-')).toBeTruthy();
});

test('signOut asks Supabase to end the session and clears it on the event', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());

  await act(async () => { fireEvent.press(screen.getByText('sign out')); });
  // The session ends first; then the pending drive summaries are cancelled.
  expect(authCalls).toEqual(['signOut', 'cancelDriveSummaries']);

  await act(async () => { emit('SIGNED_OUT', null); });
  await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());
});

test('a hung profile fetch cannot strand the app on loading', async () => {
  jest.useFakeTimers();
  try {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    // The fetch is gated and never settles. Unbounded, status would stay 'loading' for the rest of
    // the process and every later event would just join the same hung promise.
    expect(screen.getByText('loading:-')).toBeTruthy();

    await act(async () => { jest.advanceTimersByTime(10_000); });
    expect(screen.getByText('signedIn:-')).toBeTruthy();

    // The in-flight slot was released too, so the next event genuinely retries.
    await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
    expect(profileCalls).toEqual(['u1', 'u1']);
    await act(async () => { mockProfileGate.resolve?.(ava); });
    expect(screen.getByText('signedIn:Ava')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test('a refresh landing after sign-out does not resurrect the profile', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());

  await act(async () => { fireEvent.press(screen.getByText('refresh')); });
  expect(profileCalls).toEqual(['u1', 'u1']);

  await act(async () => { emit('SIGNED_OUT', null); });
  await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());

  // That refresh was started for a session that has since ended; its row must not be written.
  await act(async () => { mockProfileGate.resolve?.(ava); });
  expect(screen.getByText('signedOut:-')).toBeTruthy();
});

describe('sign-out stops recording (final review I3)', () => {
  async function signedInWith(props: Partial<Parameters<typeof SessionProvider>[0]>) {
    await render(
      <SessionProvider {...props}>
        <Probe />
      </SessionProvider>
    );
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
  }

  test('the drive is stopped (ended, finalized, disarmed) first, then the deletes flushed, then the session ends', async () => {
    const recording = {
      stop: jest.fn(async () => { authCalls.push('stopRecording'); }),
      resume: jest.fn(async () => { authCalls.push('resumeRecording'); }),
    };
    const flush = jest.fn(async () => { authCalls.push('flush'); return { sent: 0, left: 0 }; });
    await signedInWith({ recording, flushBeforeSignOut: flush });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['stopRecording', 'flush', 'signOut', 'cancelDriveSummaries']);
    expect(recording.resume).not.toHaveBeenCalled();
  });

  test('a sign-out the driver backs out of (deletes unsent) re-arms recording and ends nothing', async () => {
    const recording = {
      stop: jest.fn(async () => { authCalls.push('stopRecording'); }),
      resume: jest.fn(async () => { authCalls.push('resumeRecording'); }),
    };
    const flush = jest.fn(async () => ({ sent: 0, left: 2 }));
    await signedInWith({ recording, flushBeforeSignOut: flush });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['stopRecording', 'resumeRecording']);
  });

  test('a recording stop that fails still signs out (the next launch starts disarmed anyway)', async () => {
    const recording = {
      stop: jest.fn(async () => { throw new Error('host gone'); }),
      resume: jest.fn(async () => {}),
    };
    await signedInWith({ recording });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['signOut', 'cancelDriveSummaries']);
  });
});
