import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { AuthGate, flushSignedInConsents } from '@/features/auth/AuthGate';
import { DISCLAIMER_VERSION, legalState } from '@/features/auth/legal';
import { DISCLAIMER_ACK_KEY, PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { ONBOARDING_PENDING_HREF_KEY } from '@/features/onboarding/state';

type Status = 'loading' | 'signedOut' | 'signedIn';

// Read from inside the mocked hooks at render time, so each case can set the world before it runs.
const mockReplace = jest.fn();
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
};

jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({
    status: mockWorld.status,
    session: mockWorld.status === 'signedIn' ? { user: { id: 'u1' } } : null,
    profile: mockWorld.profile,
    profileSource: mockWorld.profileSource,
    refreshProfile: mockRefresh,
  }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
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
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockUpdateOwnProfile = jest.fn(async (..._args: unknown[]) => ({}));
jest.mock('@/data/supabase/profile', () => ({
  updateOwnProfile: (...args: unknown[]) => mockUpdateOwnProfile(...args),
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
  });
  mockReplace.mockClear();
  mockRefresh.mockClear();
  mockUpdateOwnProfile.mockClear();
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
      expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBe('/trips/t_123/summary')
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
    await waitFor(() => expect(mockUpdateOwnProfile).toHaveBeenCalledTimes(1));
    expect(mockUpdateOwnProfile).toHaveBeenCalledWith('u1', {
      flags: { onboarded: false, other: 1, disclaimerAcknowledged: DISCLAIMER_VERSION },
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));

    // The refreshed row arrives: nothing more is written this session.
    mockWorld.profile = { id: 'u1', age_band: '18_plus', flags: { disclaimerAcknowledged: DISCLAIMER_VERSION } };
    await view.rerender(gate());
    await act(async () => {});
    expect(mockUpdateOwnProfile).toHaveBeenCalledTimes(1);
  });

  test('never against a cached row, and not for a blocked account', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    await mount({ status: 'signedIn', profile: OWED, profileSource: 'cache', segments: ['(onboarding)', '[step]'] });
    await act(async () => {});
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();

    await mount({ status: 'signedIn', profile: U13, profileSource: 'network', segments: ['(onboarding)', '[step]'] });
    await act(async () => {});
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
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
    expect(mockUpdateOwnProfile).not.toHaveBeenCalled();
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
    await settings.set(PENDING_TERMS_KEY, { tos: 't1', privacy: 'p1', at: Date.now() });
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const consentApi = api();
    const updateProfile = jest.fn(async () => ({}));
    const out = await flushSignedInConsents({
      db, settings, userId: 'u1', legal: published, flags: { onboarded: true }, consentApi, updateProfile,
    });
    expect(consentApi.calls).toEqual(['tos@t1', 'privacy@p1']);
    expect(updateProfile).toHaveBeenCalledWith('u1', {
      flags: { onboarded: true, disclaimerAcknowledged: DISCLAIMER_VERSION },
    });
    expect(out).toEqual({ recorded: ['tos', 'privacy'], disclaimerMerged: true });
  });

  test('no write when the account already holds the current acknowledgement', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const updateProfile = jest.fn(async () => ({}));
    const out = await flushSignedInConsents({
      db, settings, userId: 'u1', legal: unpublished,
      flags: { disclaimerAcknowledged: DISCLAIMER_VERSION }, updateProfile,
    });
    expect(updateProfile).not.toHaveBeenCalled();
    expect(out.disclaimerMerged).toBe(false);
  });

  test('an older device acknowledgement is never copied (and never downgrades the row)', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, '2020-01-01');
    const updateProfile = jest.fn(async () => ({}));
    await flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: null, updateProfile });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  test('nothing acknowledged on the device: no write', async () => {
    const updateProfile = jest.fn(async () => ({}));
    await flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: {}, updateProfile });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  test('a failed consent write still merges the disclaimer, then rejects', async () => {
    await settings.set(PENDING_TERMS_KEY, { tos: 't1', privacy: 'p1', at: Date.now() });
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const consentApi = { fetchConsents: jest.fn(async () => { throw new Error('offline'); }), recordConsent: jest.fn() };
    const updateProfile = jest.fn(async () => ({}));
    await expect(
      flushSignedInConsents({ db, settings, userId: 'u1', legal: published, flags: {}, consentApi, updateProfile })
    ).rejects.toThrow('offline');
    expect(updateProfile).toHaveBeenCalledTimes(1);
  });

  test('a failed flag write rejects', async () => {
    await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
    const updateProfile = jest.fn(async () => { throw new Error('42501'); });
    await expect(
      flushSignedInConsents({ db, settings, userId: 'u1', legal: unpublished, flags: {}, updateProfile })
    ).rejects.toThrow('42501');
  });
});
