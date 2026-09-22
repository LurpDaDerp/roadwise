import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text, View } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { DataProvider } from '@/data/queries/context';
import { SessionProvider, registerBeforeSignOut, useSession } from '@/data/supabase/session';
import { DISCLAIMER_ACK_KEY, PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { readProfileCache, writeProfileCache } from '@/features/auth/profileCache';

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
// Every read's own gate, in call order, for the tests where reads overlap.
const mockProfileQueue: Gate<unknown>[] = [];
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
    mockProfileQueue.push({ resolve, reject });
  })),
}));

const ava = { id: 'u1', display_name: 'Ava', age_band: '18_plus' };
const sessionFor = (id: string) => ({ user: { id } });

function Probe() {
  const s = useSession();
  return (
    <View>
      <Text>{s.status}:{s.profile?.display_name ?? '-'}</Text>
      <Text>source:{s.profileSource ?? '-'}</Text>
      <Text onPress={() => { s.signOut().catch(() => {}); }}>sign out</Text>
      <Text onPress={() => { s.refreshProfile().catch(() => {}); }}>refresh</Text>
    </View>
  );
}

const emit = (event: string, session: unknown) => listeners.forEach((cb) => cb(event, session));

// The provider reads the device's settings (the profile cache, the pending Terms) through the data
// context it sits inside in the app; a sql.js database stands in here.
let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  listeners.length = 0;
  profileCalls.length = 0;
  mockProfileQueue.length = 0;
  authCalls.length = 0;
  delete mockSessionGate.resolve;
  delete mockSessionGate.reject;
  delete mockProfileGate.resolve;
  delete mockProfileGate.reject;
});

async function mount() {
  await render(<DataProvider db={db}><SessionProvider><Probe /></SessionProvider></DataProvider>);
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
      <DataProvider db={db}>
        <SessionProvider {...props}>
          <Probe />
        </SessionProvider>
      </DataProvider>
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

describe('refreshProfile (M0 T7)', () => {
  async function signedIn() {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
  }

  test('a same-user token refresh while a refresh is in flight no longer drops it', async () => {
    await signedIn();
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    // Token churn for the same driver is not a reason to throw the fresh row away.
    await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
    await act(async () => { mockProfileGate.resolve?.({ ...ava, display_name: 'Ava Stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava Stone')).toBeTruthy());
  });

  test('overlapping refreshes: an older read landing last never overwrites a newer one', async () => {
    await signedIn();
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    const [, older, newer] = mockProfileQueue;
    await act(async () => { newer?.resolve?.({ ...ava, display_name: 'Newer' }); });
    await waitFor(() => expect(screen.getByText('signedIn:Newer')).toBeTruthy());
    await act(async () => { older?.resolve?.({ ...ava, display_name: 'Older' }); });
    expect(screen.getByText('signedIn:Newer')).toBeTruthy();
  });

  test('a refresh for a driver who has since changed is not written', async () => {
    await signedIn();
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    await act(async () => { emit('SIGNED_IN', sessionFor('u2')); });
    const [, refresh, u2Read] = mockProfileQueue;
    await act(async () => { refresh?.resolve?.(ava); });
    // The previous driver's row never reaches the new driver's screen.
    expect(screen.getByText('signedIn:-')).toBeTruthy();
    await act(async () => { u2Read?.resolve?.({ id: 'u2', display_name: 'Ben' }); });
    await waitFor(() => expect(screen.getByText('signedIn:Ben')).toBeTruthy());
  });
});

describe('the profile cache (rev1: I11)', () => {
  const settings = () => createSettingsRepo(db);

  test('every successful read is cached for its user', async () => {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('source:network')).toBeTruthy());
    await waitFor(async () => expect(await readProfileCache(settings(), 'u1')).toEqual(ava));
  });

  test('an offline cold start with a cache for the same user is signed in with the cached row', async () => {
    await writeProfileCache(settings(), { ...ava, flags: { onboarded: true } } as never);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.reject?.(new Error('Network request failed')); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
    expect(screen.getByText('source:cache')).toBeTruthy();
  });

  test('a timed-out read falls back to the cache as well', async () => {
    await writeProfileCache(settings(), ava as never);
    jest.useFakeTimers();
    try {
      await mount();
      await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
      expect(screen.getByText('loading:-')).toBeTruthy();
      await act(async () => { jest.advanceTimersByTime(10_000); });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
    expect(screen.getByText('source:cache')).toBeTruthy();
  });

  test('with no cache a failed first read leaves the profile null', async () => {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.reject?.(new Error('offline')); });
    await waitFor(() => expect(screen.getByText('signedIn:-')).toBeTruthy());
    expect(screen.getByText('source:-')).toBeTruthy();
  });

  test('a cache is never served to a different user id', async () => {
    await writeProfileCache(settings(), { ...ava, id: 'u2', display_name: 'Ben' } as never);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.reject?.(new Error('offline')); });
    await waitFor(() => expect(screen.getByText('signedIn:-')).toBeTruthy());
    expect(screen.queryByText('signedIn:Ben')).toBeNull();
  });

  test('a cached row is replaced by the server row on the next event', async () => {
    await writeProfileCache(settings(), ava as never);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.reject?.(new Error('offline')); });
    await waitFor(() => expect(screen.getByText('source:cache')).toBeTruthy());

    // Unlike a server row, a cached one does not end the retries: the next event reads again.
    await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
    expect(profileCalls).toEqual(['u1', 'u1']);
    expect(screen.getByText('signedIn:Ava')).toBeTruthy();
    await act(async () => { mockProfileGate.resolve?.({ ...ava, display_name: 'Ava Stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava Stone')).toBeTruthy());
    expect(screen.getByText('source:network')).toBeTruthy();
  });
});

describe('sign-out clears a pending Terms acceptance (T15 r2)', () => {
  test('the pending acceptance goes; the disclaimer acknowledgement stays', async () => {
    const settings = createSettingsRepo(db);
    await settings.set(PENDING_TERMS_KEY, { tos: '1', privacy: '1', at: Date.now() });
    await settings.set(DISCLAIMER_ACK_KEY, '2026-09-21');
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    await waitFor(async () => expect(await settings.get(PENDING_TERMS_KEY)).toBeNull());
    expect(await settings.get(DISCLAIMER_ACK_KEY)).toBe('2026-09-21');
  });

  test('a sign-out the driver backs out of keeps it', async () => {
    const settings = createSettingsRepo(db);
    await settings.set(PENDING_TERMS_KEY, { tos: '1', privacy: '1', at: Date.now() });
    await render(
      <DataProvider db={db}>
        <SessionProvider flushBeforeSignOut={async () => ({ sent: 0, left: 1 })}>
          <Probe />
        </SessionProvider>
      </DataProvider>
    );
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(await settings.get(PENDING_TERMS_KEY)).not.toBeNull();
  });
});

describe('registerBeforeSignOut', () => {
  const unregister: (() => void)[] = [];
  afterEach(() => {
    unregister.splice(0).forEach((u) => u());
    jest.useRealTimers();
  });
  const register = (task: () => unknown) => unregister.push(registerBeforeSignOut(task));

  async function signedInWith(props: Partial<Parameters<typeof SessionProvider>[0]> = {}) {
    await render(
      <DataProvider db={db}>
        <SessionProvider {...props}>
          <Probe />
        </SessionProvider>
      </DataProvider>
    );
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:Ava')).toBeTruthy());
  }

  test('runs after the drive stops and the deletes are sent, before the session ends', async () => {
    register(async () => { authCalls.push('unregisterPush'); });
    await signedInWith({
      recording: { stop: async () => { authCalls.push('stopRecording'); }, resume: async () => {} },
      flushBeforeSignOut: async () => { authCalls.push('flush'); return { sent: 0, left: 0 }; },
    });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['stopRecording', 'flush', 'unregisterPush', 'signOut', 'cancelDriveSummaries']);
  });

  test('a task that rejects or throws costs the others and the sign-out nothing', async () => {
    register(async () => { throw new Error('offline'); });
    register(() => { throw new Error('sync'); });
    register(async () => { authCalls.push('third'); });
    await signedInWith();
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['third', 'signOut', 'cancelDriveSummaries']);
  });

  test('the tasks share one 2-second budget: a hung task holds the sign-out no longer', async () => {
    register(() => new Promise(() => {})); // never settles
    register(() => new Promise((resolve) => setTimeout(resolve, 1_500)));
    await signedInWith();
    jest.useFakeTimers();
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    await act(async () => { jest.advanceTimersByTime(1_999); });
    expect(authCalls).toEqual([]);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(authCalls).toEqual(['signOut', 'cancelDriveSummaries']);
  });

  test('not run when the driver backs out, nor once unregistered', async () => {
    const task = jest.fn(async () => {});
    register(task);
    await signedInWith({ flushBeforeSignOut: async () => ({ sent: 0, left: 3 }) });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(task).not.toHaveBeenCalled();

    unregister.splice(0).forEach((u) => u());
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(task).not.toHaveBeenCalled();
  });

  test('is on the session context too', async () => {
    const seen = jest.fn();
    function Grab() {
      const { registerBeforeSignOut: fromCtx } = useSession();
      seen(fromCtx);
      return null;
    }
    await render(<DataProvider db={db}><SessionProvider><Grab /></SessionProvider></DataProvider>);
    expect(seen).toHaveBeenLastCalledWith(registerBeforeSignOut);
  });
});
