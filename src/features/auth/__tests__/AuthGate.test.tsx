import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { AuthGate, flushSignedInConsents, mergeOwnProfileFlags } from '@/features/auth/AuthGate';
import { DISCLAIMER_VERSION, legalState } from '@/features/auth/legal';
import { DISCLAIMER_ACK_KEY, PENDING_TERMS_KEY, startSignInVisit } from '@/features/auth/pendingConsent';
import { finishOnboarding } from '@/features/onboarding/finish';
import {
  clearAllHeldJoinArrivals,
  HELD_JOIN_KEY,
  HELD_JOIN_TTL_MS,
  isHeldJoinArrival,
  ONBOARDING_PENDING_HREF_KEY,
  PENDING_PERMISSION_CONSENTS_KEY,
  PERMISSION_CONSENT_VERSION,
} from '@/features/onboarding/state';

type Status = 'loading' | 'signedOut' | 'signedIn';

// Read from inside the mocked hooks at render time, so each case can set the world before it runs.
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn(async () => {});
const mockWorld: {
  status: Status;
  profile: Record<string, unknown> | null;
  profileSource: 'network' | 'cache' | null;
  segments: string[];
  pathname: string;
  driveStatus: string;
  driveMode: string;
  hostBusy: boolean;
  update: 'required' | 'ok' | 'unknown' | null;
  db: Db | null;
  uid: string;
} = {
  status: 'loading',
  profile: null,
  profileSource: null,
  segments: [],
  pathname: '/',
  driveStatus: 'off',
  driveMode: 'mounted',
  hostBusy: false,
  update: 'ok',
  db: null,
  uid: 'u1',
};

jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({
    status: mockWorld.status,
    session: mockWorld.status === 'signedIn' ? { user: { id: mockWorld.uid } } : null,
    profile: mockWorld.profile,
    profileSource: mockWorld.profileSource,
    refreshProfile: mockRefresh,
  }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useSegments: () => mockWorld.segments,
  usePathname: () => mockWorld.pathname,
}));
jest.mock('@/drive/useDrive', () => ({
  useDrive: (select: (s: { status: string; mode: string }) => unknown) =>
    select({ status: mockWorld.driveStatus, mode: mockWorld.driveMode }),
  useDriveHost: () => ({ isBusy: () => mockWorld.hostBusy }),
}));
jest.mock('@/features/auth/version', () => ({
  useUpdateStatus: () => mockWorld.update,
}));
jest.mock('@/data/config/appConfig', () => ({
  useAppConfig: () => ({ config: {}, ready: true }),
}));
jest.mock('@/data/queries', () => ({
  useDb: () => mockWorld.db,
}));
const mockRpc = jest.fn(async (..._args: unknown[]) => ({ data: {} as unknown, error: null as unknown }));
const mockFrom = jest.fn((..._args: unknown[]): unknown => ({}));
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

const READY = { id: 'u1', age_band: '18_plus', flags: { onboarded: true } };
const OWED = { id: 'u1', age_band: '18_plus', flags: {} };
const U13 = { id: 'u1', age_band: 'u13', flags: {} };

let db: Db;
let settings: SettingsRepo;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
  Object.assign(mockWorld, {
    status: 'loading',
    profile: null,
    profileSource: null,
    segments: [],
    pathname: '/',
    driveStatus: 'off',
    driveMode: 'mounted',
    hostBusy: false,
    update: 'ok',
    db,
    uid: 'u1',
  });
  mockReplace.mockReset();
  mockPush.mockReset();
  mockRefresh.mockClear();
  mockFrom.mockReset();
  mockRpc.mockClear();
});

function gate() {
  return (
    <AuthGate>
      <Text>app</Text>
    </AuthGate>
  );
}

async function mount(world: Partial<typeof mockWorld>) {
  Object.assign(mockWorld, world);
  return render(gate());
}

const cases: [Status, Record<string, unknown> | null, string[], string | null][] = [
  // Nothing is known yet: a warm start must not flash Welcome at a signed-in driver.
  ['loading', null, [], null],
  ['loading', null, ['(auth)', 'welcome'], null],
  ['loading', null, ['(tabs)', 'home'], null],
  // Signing out, or a session expiring, cannot leave anyone inside the app.
  ['signedOut', null, ['(tabs)', 'home'], '/(auth)/welcome'],
  ['signedOut', null, ['(auth)', 'sign-in'], null],
  ['signedOut', null, ['auth', 'callback'], null],
  // Signed in and onboarded: out of the sign-in screens and the landing pad.
  ['signedIn', READY, ['(auth)', 'welcome'], '/(tabs)/home'],
  ['signedIn', READY, ['auth', 'callback'], '/(tabs)/home'],
  ['signedIn', READY, ['(tabs)', 'insights'], null],
  // Setup owed: the callback can no longer skip it (M0 M-13), nor can the tabs.
  ['signedIn', OWED, ['auth', 'callback'], '/(onboarding)/start'],
  ['signedIn', OWED, ['(tabs)', 'home'], '/(onboarding)/start'],
  ['signedIn', OWED, ['(onboarding)', '[step]'], null],
  ['signedIn', U13, ['(tabs)', 'home'], '/(onboarding)/not-eligible'],
  // No profile yet: off the sign-in screens to the launch router.
  ['signedIn', null, ['(auth)', 'sign-in'], '/'],
  ['signedIn', null, ['(tabs)', 'home'], null],
  // The launch router owns the cold start at `/`.
  ['signedIn', OWED, [], null],
  ['signedOut', null, [], null],
];

test.each(cases)('%s with %j at [%s] redirects to %s', async (status, profile, segments, expected) => {
  await mount({ status, profile, profileSource: profile ? 'network' : null, segments });
  if (expected === null) expect(mockReplace).not.toHaveBeenCalled();
  else expect(mockReplace).toHaveBeenCalledWith(expected);
});

test('passes the app through untouched', async () => {
  await mount({ status: 'signedIn', profile: READY, profileSource: 'network', segments: ['(tabs)', 'home'] });
  expect(screen.getByText('app')).toBeOnTheScreen();
});

describe('a drive under way (rev1: I10)', () => {
  test('a busy host holds every gate, and the redirect comes once the drive goes idle', async () => {
    const view = await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['(tabs)', 'home'],
      driveStatus: 'recording',
      hostBusy: true,
      update: 'required',
    });
    expect(mockReplace).not.toHaveBeenCalled();

    // Finalizing is still busy.
    mockWorld.driveStatus = 'finalizing';
    await view.rerender(gate());
    expect(mockReplace).not.toHaveBeenCalled();

    mockWorld.driveStatus = 'armed';
    mockWorld.hostBusy = false;
    await view.rerender(gate());
    expect(mockReplace).toHaveBeenCalledWith('/update-required');
  });

  test('a drive screen is never replaced, even with the host idle', async () => {
    await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['drive', 'end'],
      update: 'required',
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('a candidate (the host busy) holds the gate too', async () => {
    await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['(tabs)', 'home'],
      driveStatus: 'candidate',
      hostBusy: true,
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('the forced update', () => {
  test('required wins over the profile gates', async () => {
    await mount({ status: 'signedIn', profile: OWED, profileSource: 'network', segments: ['(tabs)', 'home'], update: 'required' });
    expect(mockReplace).toHaveBeenCalledWith('/update-required');
  });

  test('unknown (offline, never fetched) never shows it', async () => {
    await mount({ status: 'signedIn', profile: READY, profileSource: 'network', segments: ['(tabs)', 'home'], update: 'unknown' });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('the config not read yet counts as unknown', async () => {
    await mount({ status: 'signedIn', profile: READY, profileSource: 'network', segments: ['(tabs)', 'home'], update: null });
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('a deep link blocked by onboarding', () => {
  test('an allowlisted link is held in onboarding.pendingHref', async () => {
    await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['(app)', 'trips', '[id]', 'summary'],
      pathname: '/trips/t_123/summary',
    });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    await waitFor(async () =>
      expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'u1', href: '/trips/t_123/summary' })
    );
  });

  test('anything else is not held', async () => {
    await mount({ status: 'signedIn', profile: OWED, profileSource: 'network', segments: ['(tabs)', 'home'], pathname: '/home' });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    await act(async () => {});
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('a blocked account holds nothing', async () => {
    await mount({ status: 'signedIn', profile: U13, profileSource: 'network', segments: ['(app)', 'inbox'], pathname: '/inbox' });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/not-eligible');
    await act(async () => {});
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });
});

describe('the sign-in flush', () => {
  test('merges the device-local disclaimer acknowledgement into profiles.flags, once per session', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const view = await mount({
      status: 'signedIn',
      profile: { id: 'u1', age_band: '18_plus', flags: { onboarded: false, other: 1 } },
      profileSource: 'network',
      segments: ['(onboarding)', '[step]'],
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    // Only the acknowledgement goes up; the server merges it into the row as it is now (no
    // read-modify-write of `onboarded` or `other`).
    expect(mockRpc).toHaveBeenCalledWith('merge_own_profile_flags', {
      patch: { disclaimerAcknowledged: DISCLAIMER_VERSION },
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));

    // The refreshed row arrives: nothing more is written this session.
    mockWorld.profile = { id: 'u1', age_band: '18_plus', flags: { disclaimerAcknowledged: DISCLAIMER_VERSION } };
    await view.rerender(gate());
    await act(async () => {});
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  test('never against a cached row, and not for a blocked account', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    await mount({ status: 'signedIn', profile: OWED, profileSource: 'cache', segments: ['(onboarding)', '[step]'] });
    await act(async () => {});
    expect(mockRpc).not.toHaveBeenCalled();

    await mount({ status: 'signedIn', profile: U13, profileSource: 'network', segments: ['(onboarding)', '[step]'] });
    await act(async () => {});
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('a row that is not this account’s own is never written from (security M-2)', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    await mount({
      status: 'signedIn',
      profile: { id: 'u2', age_band: '18_plus', flags: { onboarded: true, someoneElse: true } },
      profileSource: 'network',
      segments: ['(tabs)', 'home'],
    });
    await act(async () => {});
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('a cached profile is re-read on each return to the front', async () => {
    const { AppState } = jest.requireActual<typeof import('react-native')>('react-native');
    const listeners: ((s: string) => void)[] = [];
    const spy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        listeners.push(listener as (s: string) => void);
        return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
      });
    try {
      await mount({ status: 'signedIn', profile: READY, profileSource: 'cache', segments: ['(tabs)', 'home'] });
      expect(mockRefresh).not.toHaveBeenCalled();
      listeners.forEach((l) => l('background'));
      expect(mockRefresh).not.toHaveBeenCalled();
      listeners.forEach((l) => l('active'));
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('flushSignedInConsents', () => {
  const published = legalState({
    onboarding: { tos_version: 't1', privacy_version: 'p1' },
    legal_urls: { terms: 'https://t.test/', privacy: 'https://p.test/' },
  });
  const unpublished = legalState(null);

  function api() {
    const calls: string[] = [];
    return {
      calls,
      fetchConsents: jest.fn(async () => []),
      recordConsent: jest.fn(async (_u: string, c: { type: string; version: string }) => {
        calls.push(`${c.type}@${c.version}`);
      }),
    };
  }

  test('records a pending published acceptance and merges the disclaimer', async () => {
    await settings.set(PENDING_TERMS_KEY, { tos: 't1', privacy: 'p1', at: Date.now(), visit: startSignInVisit() });
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const consentApi = api();
    const mergeFlags = jest.fn(async () => ({}));
    const out = await flushSignedInConsents({
      db, settings, userId: 'u1', legal: published, flags: { onboarded: true }, consentApi, mergeFlags,
    });
    expect(consentApi.calls).toEqual(['tos@t1', 'privacy@p1']);
    expect(mergeFlags).toHaveBeenCalledWith({ disclaimerAcknowledged: DISCLAIMER_VERSION });
    expect(out).toEqual({ recorded: ['tos', 'privacy'], disclaimerMerged: true, failure: null });
  });

  test('no write when the account already holds the current acknowledgement', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const mergeFlags = jest.fn(async () => ({}));
    const out = await flushSignedInConsents({
      db, settings, userId: 'u1', legal: unpublished,
      flags: { disclaimerAcknowledged: DISCLAIMER_VERSION }, mergeFlags,
    });
    expect(mergeFlags).not.toHaveBeenCalled();
    expect(out.disclaimerMerged).toBe(false);
  });

  test('an older device acknowledgement is never copied (and never downgrades the row)', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, '2020-01-01');
    const mergeFlags = jest.fn(async () => ({}));
    await flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: null, mergeFlags });
    expect(mergeFlags).not.toHaveBeenCalled();
  });

  test('nothing acknowledged on the device: no write', async () => {
    const mergeFlags = jest.fn(async () => ({}));
    await flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: {}, mergeFlags });
    expect(mergeFlags).not.toHaveBeenCalled();
  });

  test('a failed consent write still merges the disclaimer, then rejects', async () => {
    await settings.set(PENDING_TERMS_KEY, { tos: 't1', privacy: 'p1', at: Date.now(), visit: startSignInVisit() });
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const consentApi = { fetchConsents: jest.fn(async () => { throw new Error('offline'); }), recordConsent: jest.fn() };
    const mergeFlags = jest.fn(async () => ({}));
    await expect(
      flushSignedInConsents({ db, settings, userId: 'u1', legal: published, flags: {}, consentApi, mergeFlags })
    ).rejects.toThrow('offline');
    expect(mergeFlags).toHaveBeenCalledTimes(1);
  });

  test('a failed flag write rejects', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const mergeFlags = jest.fn(async () => { throw new Error('42501'); });
    await expect(
      flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: {}, mergeFlags })
    ).rejects.toThrow('42501');
  });
});

describe('mergeOwnProfileFlags', () => {
  test('calls the server merge with only the patch', async () => {
    mockRpc.mockResolvedValueOnce({ data: { onboarded: true, disclaimerAcknowledged: 'v' }, error: null });
    await expect(mergeOwnProfileFlags({ disclaimerAcknowledged: 'v' })).resolves.toEqual({
      onboarded: true,
      disclaimerAcknowledged: 'v',
    });
    expect(mockRpc).toHaveBeenCalledWith('merge_own_profile_flags', { patch: { disclaimerAcknowledged: 'v' } });
  });

  test('a refused call rejects', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'bad key' } });
    await expect(mergeOwnProfileFlags({ disclaimerAcknowledged: 'v' })).rejects.toMatchObject({ code: '22023' });
  });
});

describe('leaving onboarding with a held link (T14 review, ruling 1)', () => {
  const SEGMENTS: Record<string, string[]> = {
    '/inbox': ['(app)', 'inbox'],
    '/trips/t_1/summary': ['(app)', 'trips', '[id]', 'summary'],
    '/(tabs)/home': ['(tabs)', 'home'],
    '/(onboarding)/start': ['(onboarding)', 'start'],
  };
  const PATHS: Record<string, string> = {
    '/inbox': '/inbox',
    '/trips/t_1/summary': '/trips/t_1/summary',
    '/(tabs)/home': '/home',
    '/(onboarding)/start': '/start',
  };
  /** The navigator: a replace moves the world to that route, which the next render reads. */
  function navigate() {
    mockReplace.mockImplementation((href: string) => {
      mockWorld.segments = SEGMENTS[href] ?? ['unknown'];
      mockWorld.pathname = PATHS[href] ?? href;
    });
  }
  const replaced = () => mockReplace.mock.calls.map(([href]) => href as string);

  async function atReady(held: string | null) {
    if (held) await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: held });
    navigate();
    const view = await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['(onboarding)', '[step]'],
      pathname: '/ready',
    });
    await act(async () => {});
    return view;
  }

  test('the whole finish: a held /inbox lands on /inbox, never Home, and nothing is held again', async () => {
    const view = await atReady('/inbox');
    await act(async () => {
      await finishOnboarding({
        settings,
        userId: 'u1',
        router: { replace: mockReplace, push: jest.fn() },
        // The server's row arrives; the replace that follows is rendered in the same pass.
        refreshProfile: async () => {
          mockWorld.profile = READY;
        },
        mergeFlags: async () => ({}),
      });
    });
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/inbox']);
    expect(mockWorld.segments).toEqual(['(app)', 'inbox']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('after the normal finish, a later visit to an onboarding route never replays the link', async () => {
    const view = await atReady('/inbox');
    await act(async () => {
      await finishOnboarding({
        settings,
        userId: 'u1',
        router: { replace: mockReplace, push: jest.fn() },
        refreshProfile: async () => {
          mockWorld.profile = READY;
        },
        mergeFlags: async () => ({}),
      });
    });
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/inbox']);
    // Some time later, the same account opens an onboarding route (a stray link, a back stack).
    mockReplace.mockClear();
    Object.assign(mockWorld, { segments: ['(onboarding)', '[step]'], pathname: '/location' });
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/(tabs)/home']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('a render between the refresh and the replace still lands on /inbox, never Home', async () => {
    const view = await atReady('/inbox');
    let gateMovedFirst: string[] = [];
    // Not wrapped in one act: the render inside the refresh must commit, and its effects run, before
    // finishOnboarding gets to navigate.
    await finishOnboarding({
      settings,
      userId: 'u1',
      router: { replace: mockReplace, push: jest.fn() },
      refreshProfile: async () => {
        mockWorld.profile = READY;
        await view.rerender(gate());
        await act(async () => {});
        gateMovedFirst = replaced();
      },
      mergeFlags: async () => ({}),
    });
    // The gate itself answered the ready profile inside onboarding, with the held link.
    expect(gateMovedFirst).toEqual(['/inbox']);
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).not.toContain('/(tabs)/home');
    expect(replaced()).not.toContain('/(onboarding)/start');
    expect(replaced()[0]).toBe('/inbox');
    expect(mockWorld.segments).toEqual(['(app)', 'inbox']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('a profile that turns ready inside onboarding opens the held link once, then clears it', async () => {
    const view = await atReady('/trips/t_1/summary');
    mockWorld.profile = READY;
    await view.rerender(gate());
    await act(async () => {});
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/trips/t_1/summary']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('with nothing held, Home', async () => {
    const view = await atReady(null);
    mockWorld.profile = READY;
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/(tabs)/home']);
  });
});

describe('owed permission consents (T14 review m2)', () => {
  const unpublished = legalState(null);

  test('sent under their own account, then cleared', async () => {
    await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u1', types: ['location', 'notifications'] });
    const record = jest.fn(async (_u: string, _c: { type: string; version: string }) => ({}));
    await flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: {}, recordPermissionConsent: record });
    expect(record.mock.calls).toEqual([
      ['u1', { type: 'location', version: PERMISSION_CONSENT_VERSION }],
      ['u1', { type: 'notifications', version: PERMISSION_CONSENT_VERSION }],
    ]);
    expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toBeNull();
  });

  test('never under another account, and kept for it', async () => {
    await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u2', types: ['motion'] });
    const record = jest.fn(async () => ({}));
    await flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: {}, recordPermissionConsent: record });
    expect(record).not.toHaveBeenCalled();
    expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toEqual({ userId: 'u2', types: ['motion'] });
  });

  test('a failure keeps what was not sent and is reported, not thrown (T14 r1 n1)', async () => {
    await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u1', types: ['location', 'motion'] });
    const record = jest.fn(async (_u: string, c: { type: string }) => {
      if (c.type === 'motion') throw new Error('offline');
    });
    const out = await flushSignedInConsents({
      db, settings, userId: 'u1', legal: unpublished, flags: {}, recordPermissionConsent: record,
    });
    expect(out.failure).toEqual(new Error('offline'));
    expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toEqual({ userId: 'u1', types: ['motion'] });
  });

  test('the gate sends them once per signed-in session, against the network row', async () => {
    await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u1', types: ['location'] });
    const insert = jest.fn((_row: unknown) => ({
      select: () => ({ single: async () => ({ data: {}, error: null }) }),
    }));
    mockFrom.mockImplementation(() => ({ insert }));
    await mount({ status: 'signedIn', profile: READY, profileSource: 'network', segments: ['(tabs)', 'home'] });
    await waitFor(async () => expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toBeNull());
    expect(insert).toHaveBeenCalledWith({ user_id: 'u1', type: 'location', version: PERMISSION_CONSENT_VERSION });
  });
});

describe('round 2 (T14 r1 review)', () => {
  test('n1: a failing permission consent never holds back the refresh a merged disclaimer needs', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId: 'u1', types: ['location'] });
    mockFrom.mockImplementation(() => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: new Error('offline') }) }) }),
    }));
    await mount({ status: 'signedIn', profile: OWED, profileSource: 'network', segments: ['(onboarding)', '[step]'] });
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('merge_own_profile_flags', { patch: { disclaimerAcknowledged: DISCLAIMER_VERSION } })
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toEqual({ userId: 'u1', types: ['location'] });
  });

  test('m1: A held a link, signed out, B signs in and is ready inside onboarding: B goes Home, never to A’s link', async () => {
    // A: setup owed, a deep link to /inbox arrives and is held.
    const view = await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(app)', 'inbox'],
      pathname: '/inbox',
    });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    await act(async () => {});
    // A signs out while an onboarding screen is still showing; the handover wipe empties settings.
    Object.assign(mockWorld, { status: 'signedOut', profile: null, profileSource: null, segments: ['(onboarding)', '[step]'], pathname: '/ready' });
    await view.rerender(gate());
    await settings.remove(ONBOARDING_PENDING_HREF_KEY);
    // B signs in, already set up, still on that onboarding screen.
    mockReplace.mockClear();
    Object.assign(mockWorld, { status: 'signedIn', uid: 'u2', profile: { ...READY, id: 'u2' }, profileSource: 'network' });
    await view.rerender(gate());
    await act(async () => {});
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockReplace).not.toHaveBeenCalledWith('/inbox');
  });

  test('m1 control: the same account keeps its link across the same steps without a sign-out', async () => {
    const view = await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(app)', 'inbox'],
      pathname: '/inbox',
    });
    await act(async () => {});
    Object.assign(mockWorld, { segments: ['(onboarding)', '[step]'], pathname: '/ready' });
    await view.rerender(gate());
    await settings.remove(ONBOARDING_PENDING_HREF_KEY);
    mockReplace.mockClear();
    Object.assign(mockWorld, { profile: READY });
    await view.rerender(gate());
    await act(async () => {});
    expect(mockReplace).toHaveBeenCalledWith('/inbox');
  });
});

describe('the signed-out invite hold (M5 T12 r1, JOIN HOLD)', () => {
  const JOIN = '/join/ABCD2345';
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await act(async () => {});
  };
  const slot = () => settings.get<Record<string, unknown>>(HELD_JOIN_KEY);

  afterEach(() => clearAllHeldJoinArrivals());

  /** A link opened while nobody is signed in: the gate sends them to Welcome and holds it. */
  async function captured(pathname = '/join/abcd-2345') {
    const view = await mount({ status: 'signedOut', segments: ['join', '[code]'], pathname });
    await settle();
    return view;
  }

  /** Someone signs in (uid, profile), landing where the gate put them. */
  async function signIn(
    view: Awaited<ReturnType<typeof mount>>,
    uid: string,
    profile: Record<string, unknown> | null,
    segments: string[]
  ) {
    Object.assign(mockWorld, {
      status: 'signedIn',
      uid,
      profile: profile ? { ...profile, id: uid } : null,
      profileSource: profile ? 'network' : null,
      segments,
      pathname: '/' + segments.slice(1).join('/'),
    });
    await view.rerender(gate());
    await settle();
  }

  test('captured while signed out: one canonical, unbound slot, and the gate still sends them to Welcome', async () => {
    const before = Date.now();
    await captured();
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/welcome');
    const held = await slot();
    expect(held).toMatchObject({ href: JOIN, uid: null });
    expect(Object.keys(held ?? {}).sort()).toEqual(['heldAt', 'href', 'uid']);
    expect(held?.heldAt).toBeGreaterThanOrEqual(before);
  });

  test.each([['/inbox'], ['/join/IIII1111'], ['/join/ABCD2345/x'], ['/trips/t_1/summary']])(
    'nothing else is held while signed out (%s)',
    async (pathname) => {
      await captured(pathname);
      expect(await slot()).toBeNull();
    }
  );

  test('a newer link replaces the earlier one', async () => {
    const view = await captured();
    mockWorld.pathname = '/join/MNPQ6789';
    await view.rerender(gate());
    await settle();
    expect((await slot())?.href).toBe('/join/MNPQ6789');
  });

  test('an existing, ready account signs in: pushed to the join screen once, from Home; the slot is gone first', async () => {
    const view = await captured();
    await signIn(view, 'u1', READY, ['(tabs)', 'home']);
    expect(mockPush.mock.calls).toEqual([[JOIN]]);
    expect(await slot()).toBeNull();
    expect(isHeldJoinArrival('u1', JOIN)).toBe(true);
    // More renders, and a relaunch, never replay it.
    await view.rerender(gate());
    await settle();
    await view.unmount();
    await mount({});
    await settle();
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  test('consumption waits for Home (not a sign-in screen) and for no drive busy or open', async () => {
    const view = await captured();
    await signIn(view, 'u1', READY, ['(auth)', 'sign-in']);
    expect(mockPush).not.toHaveBeenCalled();
    Object.assign(mockWorld, { segments: ['(tabs)', 'home'], hostBusy: true, driveStatus: 'recording' });
    await view.rerender(gate());
    await settle();
    expect(mockPush).not.toHaveBeenCalled();
    expect((await slot())?.uid).toBe('u1');
    Object.assign(mockWorld, { hostBusy: false, driveStatus: 'armed' });
    await view.rerender(gate());
    await settle();
    expect(mockPush.mock.calls).toEqual([[JOIN]]);
  });

  test('a new account with setup owed: the invite becomes the onboarding hold, bound to it, and finishing lands on it', async () => {
    const view = await captured();
    await signIn(view, 'u1', OWED, ['(onboarding)', '[step]']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'u1', href: JOIN });
    expect(await slot()).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
    mockReplace.mockClear();
    await act(async () => {
      await finishOnboarding({
        settings,
        userId: 'u1',
        router: { replace: mockReplace, push: jest.fn() },
        refreshProfile: async () => {
          mockWorld.profile = READY;
        },
        mergeFlags: async () => ({}),
      });
    });
    await view.rerender(gate());
    await settle();
    // Only navigated: the join screen asks before anything is used (JoinScreen suite).
    expect(mockReplace.mock.calls.map(([h]) => h)).toContain(JOIN);
    expect(mockReplace).not.toHaveBeenCalledWith('/(tabs)/home');
    expect(mockRpc).not.toHaveBeenCalledWith('redeem_referral_code', expect.anything());
    expect(isHeldJoinArrival('u1', JOIN)).toBe(true);
  });

  test('the shared phone: A opens the link, B signs up — the hold binds to B, and B is asked (JoinScreen)', async () => {
    const view = await captured();
    await signIn(view, 'uB', OWED, ['(onboarding)', '[step]']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'uB', href: JOIN });
    expect(mockRpc).not.toHaveBeenCalledWith('redeem_referral_code', expect.anything());
  });

  test('bound to one account, then another signs in: removed, and they are never sent to it', async () => {
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: Date.now(), uid: 'u9' });
    const view = await mount({ status: 'signedOut', segments: ['(auth)', 'welcome'], pathname: '/welcome' });
    await settle();
    await signIn(view, 'u1', READY, ['(tabs)', 'home']);
    expect(await slot()).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('older than 24 h: dropped, never opened', async () => {
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: Date.now() - HELD_JOIN_TTL_MS - 1, uid: null });
    const view = await mount({ status: 'signedOut', segments: ['(auth)', 'welcome'], pathname: '/welcome' });
    await settle();
    await signIn(view, 'u1', READY, ['(tabs)', 'home']);
    expect(mockPush).not.toHaveBeenCalled();
    expect(await slot()).toBeNull();
  });

  test('a tampered slot is ignored and removed', async () => {
    await settings.set(HELD_JOIN_KEY, { href: '/settings/delete-account', heldAt: Date.now(), uid: null });
    const view = await mount({ status: 'signedOut', segments: ['(auth)', 'welcome'], pathname: '/welcome' });
    await settle();
    await signIn(view, 'u1', READY, ['(tabs)', 'home']);
    expect(mockPush).not.toHaveBeenCalled();
    expect(await slot()).toBeNull();
  });

  test('signed out before it was used: the slot goes, and the next account is sent nowhere', async () => {
    const view = await captured();
    // Signed in, profile not known yet: nothing consumes it.
    await signIn(view, 'u1', null, ['(tabs)', 'home']);
    expect((await slot())?.uid).toBe('u1');
    Object.assign(mockWorld, {
      status: 'signedOut',
      profile: null,
      profileSource: null,
      segments: ['(auth)', 'welcome'],
      pathname: '/welcome',
    });
    await view.rerender(gate());
    await settle();
    expect(await slot()).toBeNull();
    await signIn(view, 'u2', READY, ['(tabs)', 'home']);
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('an under-13 account: dropped without a word, never held for onboarding', async () => {
    const view = await captured();
    await signIn(view, 'u1', U13, ['(onboarding)', 'not-eligible']);
    expect(await slot()).toBeNull();
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('the app killed between sign-up and onboarding: the bound slot survives and is moved once', async () => {
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: Date.now() - 60_000, uid: 'u1' });
    await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(onboarding)', '[step]'],
      pathname: '/location',
    });
    await settle();
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'u1', href: JOIN });
    expect(await slot()).toBeNull();
  });

  test("M4's stored hold: a legacy bare string is no hold, and is removed", async () => {
    await settings.set(ONBOARDING_PENDING_HREF_KEY, '/inbox');
    mockReplace.mockImplementation((href: string) => {
      mockWorld.segments = href === '/(tabs)/home' ? ['(tabs)', 'home'] : ['unknown'];
    });
    const view = await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(onboarding)', '[step]'],
      pathname: '/ready',
    });
    await settle();
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
    mockWorld.profile = READY;
    await view.rerender(gate());
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockReplace).not.toHaveBeenCalledWith('/inbox');
  });

  test("M4's stored hold for another account is never used by this one", async () => {
    await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u2', href: '/inbox' });
    mockReplace.mockImplementation((href: string) => {
      mockWorld.segments = href === '/(tabs)/home' ? ['(tabs)', 'home'] : ['unknown'];
    });
    const view = await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(onboarding)', '[step]'],
      pathname: '/ready',
    });
    await settle();
    mockWorld.profile = READY;
    await view.rerender(gate());
    await settle();
    expect(mockReplace).not.toHaveBeenCalledWith('/inbox');
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });
});

describe('T12 round 2: the arrival mark (m2) and the in-memory hold (n3)', () => {
  const JOIN = '/join/ABCD2345';
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await act(async () => {});
  };
  afterEach(() => clearAllHeldJoinArrivals());

  async function signInAfterCapture(profile: Record<string, unknown>, segments: string[]) {
    const view = await mount({ status: 'signedOut', segments: ['join', '[code]'], pathname: '/join/ABCD2345' });
    await settle();
    Object.assign(mockWorld, { status: 'signedIn', uid: 'u1', profile, profileSource: 'network', segments, pathname: '/x' });
    await view.rerender(gate());
    await settle();
    return view;
  }

  test('a sign-out clears every mark', async () => {
    const view = await signInAfterCapture(READY, ['(tabs)', 'home']);
    expect(mockPush).toHaveBeenCalledWith(JOIN);
    expect(isHeldJoinArrival('u1', JOIN)).toBe(true);
    Object.assign(mockWorld, { status: 'signedOut', profile: null, profileSource: null, segments: ['(auth)', 'welcome'], pathname: '/welcome' });
    await view.rerender(gate());
    await settle();
    expect(isHeldJoinArrival('u1', JOIN)).toBe(false);
  });

  test('no mark when nothing navigated to the link: moved into onboarding, then a "Start a drive" finish', async () => {
    await signInAfterCapture(OWED, ['(onboarding)', '[step]']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'u1', href: JOIN });
    // Moved, not opened: no mark yet.
    expect(isHeldJoinArrival('u1', JOIN)).toBe(false);
    await act(async () => {
      await finishOnboarding(
        {
          settings,
          userId: 'u1',
          router: { replace: mockReplace, push: jest.fn() },
          refreshProfile: async () => {
            mockWorld.profile = READY;
          },
          mergeFlags: async () => ({}),
        },
        { startDrive: true }
      );
    });
    expect(isHeldJoinArrival('u1', JOIN)).toBe(false);
  });

  test('the mark is the account\'s own: set for u1, not for anyone else', async () => {
    await signInAfterCapture(READY, ['(tabs)', 'home']);
    expect(isHeldJoinArrival('u1', JOIN)).toBe(true);
    expect(isHeldJoinArrival('u2', JOIN)).toBe(false);
    expect(isHeldJoinArrival(null, JOIN)).toBe(false);
  });

  test('n3: a non-link path resolving to onboarding never clears the held link in memory', async () => {
    const SEG: Record<string, string[]> = { [JOIN]: ['join', '[code]'], '/(tabs)/home': ['(tabs)', 'home'] };
    mockReplace.mockImplementation((href: string) => {
      mockWorld.segments = SEG[href] ?? ['(onboarding)', 'start'];
    });
    const view = await signInAfterCapture(OWED, ['(onboarding)', '[step]']);
    // The stored copy is gone (as if already consumed elsewhere): only memory holds it now.
    await settings.remove(ONBOARDING_PENDING_HREF_KEY);
    // The driver wanders to a tab: the gate sends them back to onboarding from a non-link path.
    Object.assign(mockWorld, { segments: ['(tabs)', 'home'], pathname: '/home' });
    await view.rerender(gate());
    await settle();
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    mockReplace.mockClear();
    Object.assign(mockWorld, { segments: ['(onboarding)', '[step]'], pathname: '/ready', profile: READY });
    await view.rerender(gate());
    await settle();
    expect(mockReplace).toHaveBeenCalledWith(JOIN);
    expect(mockReplace).not.toHaveBeenCalledWith('/(tabs)/home');
    expect(isHeldJoinArrival('u1', JOIN)).toBe(true);
  });
});
