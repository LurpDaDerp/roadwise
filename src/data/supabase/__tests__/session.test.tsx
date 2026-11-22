import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, Text, View, type AppStateStatus } from 'react-native';

import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { DataProvider } from '@/data/queries/context';
import { SessionProvider, registerAfterSignOut, registerBeforeSignOut, useSession, type SignOutOutcome } from '@/data/supabase/session';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { readProfileCache, writeProfileCache } from '@/features/auth/profileCache';
import { readHomeNotice, showHomeNotice } from '@/features/home/homeNotice';

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
// What `auth.signOut` answers: null (ended), or the error Supabase reports when it could not end it.
const mockSignOutError: { current: unknown } = { current: null };
// The options each `auth.signOut` was called with.
const mockSignOutOptions: unknown[] = [];
// What the client's own storage holds (`readStoredSession`), and how often it was read.
const mockStored: { session: unknown; reads: number } = { session: null, reads: 0 };

jest.mock('@/data/supabase/client', () => ({
  readStoredSession: jest.fn(async () => { mockStored.reads += 1; return mockStored.session; }),
  supabase: {
    auth: {
      getSession: jest.fn(() => new Promise((resolve, reject) => { mockSessionGate.resolve = resolve; mockSessionGate.reject = reject; })),
      onAuthStateChange: jest.fn((cb: AuthListener) => { listeners.push(cb); return { data: { subscription: { unsubscribe: jest.fn() } } }; }),
      signOut: jest.fn(async (options?: unknown) => { authCalls.push('signOut'); mockSignOutOptions.push(options); return { error: mockSignOutError.current }; }),
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

const ava = { id: 'u1', username: 'ava' };
const sessionFor = (id: string) => ({ user: { id } });

function Probe() {
  const s = useSession();
  return (
    <View>
      <Text>{s.status}:{s.profile?.username ?? '-'}</Text>
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
  mockSignOutError.current = null;
  mockSignOutOptions.length = 0;
  mockStored.session = null;
  mockStored.reads = 0;
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
  await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
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
  await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
});

test('does not refetch the profile for the same user on a token refresh', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());

  await act(async () => { emit('INITIAL_SESSION', sessionFor('u1')); });
  await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
  await act(async () => { emit('USER_UPDATED', sessionFor('u1')); });

  // One fetch for the whole lifecycle, and the profile never blinks out.
  expect(profileCalls).toEqual(['u1']);
  expect(screen.getByText('signedIn:ava')).toBeTruthy();
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
  await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());

  showHomeNotice('notDriving');
  await act(async () => { fireEvent.press(screen.getByText('sign out')); });
  // The session ends first; then the pending drive summaries are cancelled.
  expect(authCalls).toEqual(['signOut', 'cancelDriveSummaries']);
  // This phone's session only: the driver's other phones stay signed in.
  expect(mockSignOutOptions).toEqual([{ scope: 'local' }]);
  // Home's notice line belongs to this driver: the next one never sees it.
  expect(readHomeNotice()).toBeNull();

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
    expect(screen.getByText('signedIn:ava')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

test('a refresh landing after sign-out does not resurrect the profile', async () => {
  await mount();
  await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
  await act(async () => { mockProfileGate.resolve?.(ava); });
  await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());

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
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
  }

  test('the drive is stopped (ended, finalized, host signed out) first, then the deletes flushed, then the session ends', async () => {
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

  test('a forced sign-out (deletes left unsent, or Delete account) also ends this phone’s session only', async () => {
    function Forced() {
      const s = useSession();
      return <Text onPress={() => { void s.signOut({ force: true }); }}>forced</Text>;
    }
    await render(<DataProvider db={db}><SessionProvider flushBeforeSignOut={async () => ({ sent: 0, left: 2 })}><Probe /><Forced /></SessionProvider></DataProvider>);
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await act(async () => { fireEvent.press(screen.getByText('forced')); });
    expect(mockSignOutOptions).toEqual([{ scope: 'local' }]);
  });

  test('a recording stop that fails still signs out (the next launch is signed out anyway)', async () => {
    const recording = {
      stop: jest.fn(async () => { throw new Error('host gone'); }),
      resume: jest.fn(async () => {}),
    };
    await signedInWith({ recording });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['signOut', 'cancelDriveSummaries']);
  });
});

describe('a sign-out Supabase could not finish (offline, the access token expired)', () => {
  const unregister: (() => void)[] = [];
  afterEach(() => unregister.splice(0).forEach((u) => u()));

  test('the driver stays signed in, recording arms again, the after-sign-out work never runs, and the caller is told', async () => {
    const after = jest.fn(async () => { authCalls.push('wipe'); });
    unregister.push(registerAfterSignOut(after));
    const recording = {
      stop: jest.fn(async () => { authCalls.push('stopRecording'); }),
      resume: jest.fn(async () => { authCalls.push('resumeRecording'); }),
    };
    let outcome: SignOutOutcome | null = null;
    function Out() {
      const s = useSession();
      return <Text onPress={() => { void s.signOut().then((o) => { outcome = o; }); }}>out</Text>;
    }
    await render(<DataProvider db={db}><SessionProvider recording={recording} flushBeforeSignOut={async () => ({ sent: 0, left: 0 })}><Probe /><Out /></SessionProvider></DataProvider>);
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    mockSignOutError.current = { name: 'AuthRetryableFetchError', status: 0 };
    await act(async () => { fireEvent.press(screen.getByText('out')); });
    // The check reads the stored session again: still there.
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await waitFor(() => expect(outcome).toEqual({ signedOut: false, failed: true }));
    expect(authCalls).toEqual(['stopRecording', 'signOut', 'resumeRecording']);
    expect(after).not.toHaveBeenCalled();
  });

  test('an error after which no session is left is a sign-out like any other: the after-sign-out work runs', async () => {
    const after = jest.fn(async () => { authCalls.push('wipe'); });
    unregister.push(registerAfterSignOut(after));
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    mockSignOutError.current = { name: 'AuthApiError', status: 500 };
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    await act(async () => { mockSessionGate.resolve?.({ data: { session: null }, error: null } as never); });
    await waitFor(() => expect(authCalls).toEqual(['signOut', 'wipe', 'cancelDriveSummaries']));
  });

  test('a sign-out that ends the session runs the after-sign-out work after it', async () => {
    unregister.push(registerAfterSignOut(async () => { authCalls.push('wipe'); }));
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    expect(authCalls).toEqual(['signOut', 'wipe', 'cancelDriveSummaries']);
  });
});

describe('refreshProfile (M0 T7)', () => {
  async function signedIn() {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
  }

  test('a same-user token refresh while a refresh is in flight no longer drops it', async () => {
    await signedIn();
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    // Token churn for the same driver is not a reason to throw the fresh row away.
    await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
    await act(async () => { mockProfileGate.resolve?.({ ...ava, username: 'ava_stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava_stone')).toBeTruthy());
  });

  test('overlapping refreshes: an older read landing last never overwrites a newer one', async () => {
    await signedIn();
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    await act(async () => { fireEvent.press(screen.getByText('refresh')); });
    const [, older, newer] = mockProfileQueue;
    await act(async () => { newer?.resolve?.({ ...ava, username: 'Newer' }); });
    await waitFor(() => expect(screen.getByText('signedIn:Newer')).toBeTruthy());
    await act(async () => { older?.resolve?.({ ...ava, username: 'Older' }); });
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
    await act(async () => { u2Read?.resolve?.({ id: 'u2', username: 'Ben' }); });
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
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    expect(screen.getByText('source:cache')).toBeTruthy();
  });

  test('a read that times out leaves the cached row standing', async () => {
    await writeProfileCache(settings(), ava as never);
    jest.useFakeTimers();
    try {
      await mount();
      await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
      await act(async () => { jest.advanceTimersByTime(10_000); });
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
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
    await writeProfileCache(settings(), { ...ava, id: 'u2', username: 'Ben' } as never);
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
    expect(screen.getByText('signedIn:ava')).toBeTruthy();
    await act(async () => { mockProfileGate.resolve?.({ ...ava, username: 'ava_stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava_stone')).toBeTruthy());
    expect(screen.getByText('source:network')).toBeTruthy();
  });
});

describe('an offline cold start with an expired access token (auth-js retries the refresh for about 25 s)', () => {
  const settings = () => createSettingsRepo(db);
  const unknown = { data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0 } };
  const stored = { ...sessionFor('u1'), access_token: 'a', refresh_token: 'r', expires_at: 1 };

  // The phone is u1's: the launch that settled them as its owner has run.
  beforeEach(async () => {
    await settings().set(LAST_USER_KEY, 'u1');
    await settings().set(SESSION_UID_KEY, 'u1');
  });
  afterEach(() => jest.useRealTimers());

  test('while the read is still retrying, the stored session stands in after the launch’s wait: the cached profile lands', async () => {
    await writeProfileCache(settings(), { ...ava, flags: { onboarded: true } } as never);
    mockStored.session = stored;
    jest.useFakeTimers();
    await mount();
    await act(async () => { jest.advanceTimersByTime(1_499); });
    expect(screen.getByText('loading:-')).toBeTruthy();
    expect(mockStored.reads).toBe(0);
    await act(async () => { jest.advanceTimersByTime(1); });
    await act(async () => {});
    expect(screen.getByText('signedIn:ava')).toBeTruthy();
    expect(screen.getByText('source:cache')).toBeTruthy();

    // The read gives up at last: no session, with the refresh's error, and INITIAL_SESSION with
    // null. Neither signs the driver out.
    await act(async () => { emit('INITIAL_SESSION', null); });
    await act(async () => { mockSessionGate.resolve?.(unknown as never); });
    expect(screen.getByText('signedIn:ava')).toBeTruthy();

    // The network comes back and the refresh lands: the server row replaces the cached one.
    await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
    await act(async () => { mockProfileQueue[mockProfileQueue.length - 1]?.resolve?.({ ...ava, username: 'ava_stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava_stone')).toBeTruthy());
  });

  test('a read that answers no session with an error lets the stored session stand in at once', async () => {
    await writeProfileCache(settings(), ava as never);
    mockStored.session = stored;
    await mount();
    await act(async () => { mockSessionGate.resolve?.(unknown as never); });
    await act(async () => { emit('INITIAL_SESSION', null); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    expect(mockStored.reads).toBe(1);
  });

  test('with nothing stored, that answer is a sign-out after all', async () => {
    await mount();
    await act(async () => { mockSessionGate.resolve?.(unknown as never); });
    await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());
  });

  test('a launch that is really signed out (no session, no error) never reads the storage', async () => {
    mockStored.session = stored;
    jest.useFakeTimers();
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: null }, error: null } as never); });
    await act(async () => { emit('INITIAL_SESSION', null); });
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(screen.getByText('signedOut:-')).toBeTruthy();
    expect(mockStored.reads).toBe(0);
  });

  test('the server refusing the stored session (SIGNED_OUT) ends the stand-in', async () => {
    await writeProfileCache(settings(), ava as never);
    mockStored.session = stored;
    await mount();
    await act(async () => { mockSessionGate.resolve?.(unknown as never); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    await act(async () => { emit('SIGNED_OUT', null); });
    await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());
  });

  test('a SIGNED_OUT while the storage is read is not undone by the stand-in', async () => {
    let release: (s: unknown) => void = () => {};
    jest.requireMock<{ readStoredSession: jest.Mock }>('@/data/supabase/client').readStoredSession.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );
    await mount();
    await act(async () => { mockSessionGate.resolve?.(unknown as never); });
    await act(async () => { emit('SIGNED_OUT', null); });
    await act(async () => { release(stored); });
    expect(screen.getByText('signedOut:-')).toBeTruthy();
  });

  // B signed in on A's phone and the process died before the handover's wipe: A's drives are still
  // on the phone, and B's session and cached profile are stored. Offline, B must not land on Home
  // over A's drives; the sign-in screen shows, as it did before any session stood in.
  test.each([
    { name: 'another driver’s stored session', settled: { owner: 'u1', seen: 'u1', pending: null }, storedFor: 'u2' },
    { name: 'a handover to another driver under way', settled: { owner: 'u1', seen: 'u1', pending: 'u2' }, storedFor: 'u1' },
    { name: 'a session the sync runner saw for another driver', settled: { owner: 'u1', seen: 'u2', pending: null }, storedFor: 'u1' },
    { name: 'a phone whose owner was never settled', settled: { owner: null, seen: null, pending: 'u1' }, storedFor: 'u1' },
  ])('$name never stands in: the read’s answer is a sign-out', async ({ settled, storedFor }) => {
    const repo = settings();
    for (const [key, value] of [[LAST_USER_KEY, settled.owner], [SESSION_UID_KEY, settled.seen], [PENDING_OWNER_KEY, settled.pending]] as const) {
      if (value === null) await repo.remove(key);
      else await repo.set(key, value);
    }
    await writeProfileCache(repo, { ...ava, id: storedFor, username: 'ben', flags: { onboarded: true } } as never);
    mockStored.session = { ...stored, ...sessionFor(storedFor) };
    jest.useFakeTimers();
    await mount();
    // The launch's wait passes: nothing stands in, the read is still out.
    await act(async () => { jest.advanceTimersByTime(1_500); });
    await act(async () => {});
    expect(screen.getByText('loading:-')).toBeTruthy();
    // The read gives up: no session, with the refresh's error.
    await act(async () => { mockSessionGate.resolve?.(unknown as never); });
    await act(async () => {});
    expect(screen.getByText('signedOut:-')).toBeTruthy();
    expect(screen.queryByText(/ben/)).toBeNull();
    expect(profileCalls).toEqual([]);
  });
});

describe('sign-out clears a pending Terms acceptance (T15 r2)', () => {
  test('the pending acceptance goes', async () => {
    const settings = createSettingsRepo(db);
    await settings.set(PENDING_TERMS_KEY, { version: '1', at: Date.now() });
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('sign out')); });
    await waitFor(async () => expect(await settings.get(PENDING_TERMS_KEY)).toBeNull());
  });

  test('a sign-out the driver backs out of keeps it', async () => {
    const settings = createSettingsRepo(db);
    await settings.set(PENDING_TERMS_KEY, { version: '1', at: Date.now() });
    await render(
      <DataProvider db={db}>
        <SessionProvider flushBeforeSignOut={async () => ({ sent: 0, left: 1 })}>
          <Probe />
        </SessionProvider>
      </DataProvider>
    );
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
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

describe('fix round 1', () => {
  test('a hanging read serves the same user’s cache at once, and the server row replaces it (m1)', async () => {
    await writeProfileCache(createSettingsRepo(db), ava as never);
    jest.useFakeTimers();
    try {
      await mount();
      await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
      // The read is still hanging: no 10 s wait for the cached row.
      await act(async () => { jest.advanceTimersByTime(100); });
      expect(screen.getByText('signedIn:ava')).toBeTruthy();
      expect(screen.getByText('source:cache')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
    await act(async () => { mockProfileGate.resolve?.({ ...ava, username: 'ava_stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava_stone')).toBeTruthy());
    expect(screen.getByText('source:network')).toBeTruthy();
  });

  test('a hanging read with only another user’s cache still waits with no profile', async () => {
    await writeProfileCache(createSettingsRepo(db), { ...ava, id: 'u2', username: 'Ben' } as never);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    expect(screen.getByText('loading:-')).toBeTruthy();
  });

  test('a SIGNED_OUT the driver did not start (revoked, expired) clears a pending Terms tick (M-1)', async () => {
    const settings = createSettingsRepo(db);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    await settings.set(PENDING_TERMS_KEY, { version: '1', at: Date.now(), uid: 'u1' });
    await act(async () => { emit('SIGNED_OUT', null); });
    await waitFor(async () => expect(await settings.get(PENDING_TERMS_KEY)).toBeNull());
  });

  test('a SIGNED_OUT the driver did not start (revoked, expired) takes Home’s notice line down', async () => {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    showHomeNotice('permission');
    await act(async () => { emit('SIGNED_OUT', null); });
    expect(readHomeNotice()).toBeNull();
  });

  test('a launch that simply starts signed out keeps a tick waiting for its sign-in', async () => {
    const settings = createSettingsRepo(db);
    await settings.set(PENDING_TERMS_KEY, { version: '1', at: Date.now() });
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: null } }); });
    await act(async () => { emit('INITIAL_SESSION', null); });
    await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());
    expect(await settings.get(PENDING_TERMS_KEY)).not.toBeNull();
  });

  test('a sign-in binds a waiting tick to that account (M-1)', async () => {
    const settings = createSettingsRepo(db);
    await settings.set(PENDING_TERMS_KEY, { version: '1', at: Date.now() });
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: null } }); });
    await act(async () => { emit('SIGNED_IN', sessionFor('u1')); });
    await waitFor(async () => expect(await settings.get(PENDING_TERMS_KEY)).toMatchObject({ uid: 'u1' }));
  });
});

describe('a launch in the background (an iOS drive wake) reads no profile from the server', () => {
  const settings = () => createSettingsRepo(db);
  let appStateListener: ((s: AppStateStatus) => void) | null = null;
  const initialState = Object.getOwnPropertyDescriptor(AppState, 'currentState');

  beforeEach(() => {
    appStateListener = null;
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, l) => {
      appStateListener = l as (s: AppStateStatus) => void;
      return { remove: () => (appStateListener = null) };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (initialState) Object.defineProperty(AppState, 'currentState', initialState);
  });

  test('the cached profile goes on screen, and the server is read the first time the app comes to the front', async () => {
    await writeProfileCache(settings(), ava as never);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    expect(screen.getByText('source:cache')).toBeTruthy();
    // A token refresh in the background asks the server nothing either.
    await act(async () => { emit('TOKEN_REFRESHED', sessionFor('u1')); });
    expect(profileCalls).toEqual([]);

    Object.defineProperty(AppState, 'currentState', { value: 'inactive', configurable: true });
    await act(async () => { appStateListener?.('inactive'); });
    expect(profileCalls).toEqual([]);

    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    await act(async () => { appStateListener?.('active'); });
    expect(profileCalls).toEqual(['u1']);
    await act(async () => { mockProfileGate.resolve?.({ ...ava, username: 'ava_stone' }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava_stone')).toBeTruthy());
    expect(screen.getByText('source:network')).toBeTruthy();

    // Once read, later trips to the front cost nothing.
    await act(async () => { appStateListener?.('active'); });
    expect(profileCalls).toEqual(['u1']);
  });

  test('with no cache it waits, still loading, for the first time the app comes to the front', async () => {
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    expect(screen.getByText('loading:-')).toBeTruthy();
    expect(profileCalls).toEqual([]);

    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    await act(async () => { appStateListener?.('active'); });
    expect(profileCalls).toEqual(['u1']);
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
  });

  test('coming to the front while the cache is read (the change heard by no one) still reads the server', async () => {
    const execute = db.execute.bind(db);
    jest.spyOn(db, 'execute').mockImplementation(async (...a: Parameters<Db['execute']>) => {
      const result = await execute(...a);
      Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
      return result;
    });
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await waitFor(() => expect(profileCalls).toEqual(['u1']));
    await act(async () => { mockProfileGate.resolve?.(ava); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
  });

  test('a sign-out while waiting leaves nothing to read on the next trip to the front', async () => {
    await writeProfileCache(settings(), ava as never);
    await mount();
    await act(async () => { mockSessionGate.resolve?.({ data: { session: sessionFor('u1') } }); });
    await waitFor(() => expect(screen.getByText('signedIn:ava')).toBeTruthy());
    await act(async () => { emit('SIGNED_OUT', null); });
    await waitFor(() => expect(screen.getByText('signedOut:-')).toBeTruthy());

    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    await act(async () => { appStateListener?.('active'); });
    expect(profileCalls).toEqual([]);
    expect(screen.getByText('signedOut:-')).toBeTruthy();
  });
});
