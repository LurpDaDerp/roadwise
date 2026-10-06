import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { AuthGate } from '@/features/auth/AuthGate';
import { TERMS_VERSION } from '@/features/auth/legal';
import { PENDING_TERMS_KEY, bindPendingTerms, markTermsAccepted } from '@/features/auth/pendingConsent';
import { finishOnboarding } from '@/features/onboarding/finish';
import { ONBOARDING_PENDING_HREF_KEY } from '@/features/onboarding/state';

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
  driveStatus: 'idle',
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
  useDrive: (select: (s: { status: string }) => unknown) =>
    select({ status: mockWorld.driveStatus }),
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

const READY = { id: 'u1', username: 'swift_fox', onboarded_at: '2026-10-05T00:00:00Z' };
const OWED = { id: 'u1', username: null, onboarded_at: null };

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
    driveStatus: 'idle',
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
  // Nothing is known yet: a warm start must not flash sign-in at a signed-in driver.
  ['loading', null, [], null],
  ['loading', null, ['(auth)', 'sign-in'], null],
  ['loading', null, ['(tabs)', 'home'], null],
  // Signing out, or a session expiring, cannot leave anyone inside the app.
  ['signedOut', null, ['(tabs)', 'home'], '/(auth)/sign-in'],
  ['signedOut', null, ['(auth)', 'sign-in'], null],
  ['signedOut', null, ['auth', 'callback'], null],
  // Signed in and onboarded: out of the sign-in screens and the landing pad.
  ['signedIn', READY, ['(auth)', 'sign-in'], '/(tabs)/home'],
  ['signedIn', READY, ['auth', 'callback'], '/(tabs)/home'],
  ['signedIn', READY, ['(tabs)', 'leagues'], null],
  // Setup owed: the callback can no longer skip it (M0 M-13), nor can the tabs.
  ['signedIn', OWED, ['auth', 'callback'], '/(onboarding)/start'],
  ['signedIn', OWED, ['(tabs)', 'home'], '/(onboarding)/start'],
  ['signedIn', OWED, ['(onboarding)', '[step]'], null],
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

    mockWorld.driveStatus = 'idle';
    mockWorld.hostBusy = false;
    await view.rerender(gate());
    expect(mockReplace).toHaveBeenCalledWith('/update-required');
  });

  test('a drive screen is never replaced, even with the host idle', async () => {
    await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['drive'],
      update: 'required',
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('a busy host holds the gate too, whatever the snapshot says', async () => {
    await mount({
      status: 'signedIn',
      profile: OWED,
      profileSource: 'network',
      segments: ['(tabs)', 'home'],
      driveStatus: 'idle',
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
      segments: ['(app)', 'drives', '[clientTripId]'],
      pathname: '/drives/t-123',
    });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    await waitFor(async () =>
      expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'u1', href: '/drives/t-123' })
    );
  });

  test('anything else is not held', async () => {
    await mount({ status: 'signedIn', profile: OWED, profileSource: 'network', segments: ['(tabs)', 'leagues'], pathname: '/stats' });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    await act(async () => {});
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });
});

describe('the sign-in attestation (accept_terms)', () => {
  test('a tick made before sign-in is sent once per session, with the terms version', async () => {
    await markTermsAccepted(settings);
    await bindPendingTerms(settings, 'u1');
    const view = await mount({ status: 'signedIn', profile: OWED, profileSource: 'network', segments: ['(onboarding)', '[step]'] });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('accept_terms', { p_version: TERMS_VERSION }));
    await waitFor(async () => expect((await settings.get<{ sent?: boolean }>(PENDING_TERMS_KEY))?.sent).toBe(true));
    mockWorld.profile = { ...OWED };
    await view.rerender(gate());
    await act(async () => {});
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  test('a failure is retried on the next change of profile', async () => {
    await markTermsAccepted(settings);
    await bindPendingTerms(settings, 'u1');
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('offline') });
    const view = await mount({ status: 'signedIn', profile: OWED, profileSource: 'network', segments: ['(onboarding)', '[step]'] });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    await act(async () => {});
    mockWorld.profile = { ...OWED };
    await view.rerender(gate());
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
  });

  test('nothing ticked on this phone: nothing is sent', async () => {
    await mount({ status: 'signedIn', profile: READY, profileSource: 'network', segments: ['(tabs)', 'home'] });
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

describe('leaving onboarding with a held link (T14 review, ruling 1)', () => {
  const SEGMENTS: Record<string, string[]> = {
    '/drives': ['(app)', 'drives'],
    '/drives/t-1': ['(app)', 'drives', '[clientTripId]'],
    '/(tabs)/home': ['(tabs)', 'home'],
    '/(onboarding)/start': ['(onboarding)', 'start'],
  };
  const PATHS: Record<string, string> = {
    '/drives': '/drives',
    '/drives/t-1': '/drives/t-1',
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
      pathname: '/clan',
    });
    await act(async () => {});
    return view;
  }

  test('the whole finish: a held /drives lands on /drives, never Home, and nothing is held again', async () => {
    const view = await atReady('/drives');
    await act(async () => {
      await finishOnboarding({
        settings,
        userId: 'u1',
        router: { replace: mockReplace },
        // The server's row arrives; the replace that follows is rendered in the same pass.
        refreshProfile: async () => {
          mockWorld.profile = READY;
        },
        complete: async () => ({}),
      }, 'permit');
    });
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/drives']);
    expect(mockWorld.segments).toEqual(['(app)', 'drives']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('after the normal finish, a later visit to an onboarding route never replays the link', async () => {
    const view = await atReady('/drives');
    await act(async () => {
      await finishOnboarding({
        settings,
        userId: 'u1',
        router: { replace: mockReplace },
        refreshProfile: async () => {
          mockWorld.profile = READY;
        },
        complete: async () => ({}),
      }, 'permit');
    });
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/drives']);
    // Some time later, the same account opens an onboarding route (a stray link, a back stack).
    mockReplace.mockClear();
    Object.assign(mockWorld, { segments: ['(onboarding)', '[step]'], pathname: '/location' });
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/(tabs)/home']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('a render between the refresh and the replace still lands on /drives, never Home', async () => {
    const view = await atReady('/drives');
    let gateMovedFirst: string[] = [];
    // Not wrapped in one act: the render inside the refresh must commit, and its effects run, before
    // finishOnboarding gets to navigate.
    await finishOnboarding({
      settings,
      userId: 'u1',
      router: { replace: mockReplace },
      refreshProfile: async () => {
        mockWorld.profile = READY;
        await view.rerender(gate());
        await act(async () => {});
        gateMovedFirst = replaced();
      },
      complete: async () => ({}),
    }, 'permit');
    // The gate itself answered the ready profile inside onboarding, with the held link.
    expect(gateMovedFirst).toEqual(['/drives']);
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).not.toContain('/(tabs)/home');
    expect(replaced()).not.toContain('/(onboarding)/start');
    expect(replaced()[0]).toBe('/drives');
    expect(mockWorld.segments).toEqual(['(app)', 'drives']);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('a profile that turns ready inside onboarding opens the held link once, then clears it', async () => {
    const view = await atReady('/drives/t-1');
    mockWorld.profile = READY;
    await view.rerender(gate());
    await act(async () => {});
    await view.rerender(gate());
    await act(async () => {});
    expect(replaced()).toEqual(['/drives/t-1']);
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

describe('round 2 (T14 r1 review)', () => {
  test('m1: A held a link, signed out, B signs in and is ready inside onboarding: B goes Home, never to A’s link', async () => {
    // A: setup owed, a deep link to /drives arrives and is held.
    const view = await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(app)', 'drives'],
      pathname: '/drives',
    });
    expect(mockReplace).toHaveBeenCalledWith('/(onboarding)/start');
    await act(async () => {});
    // A signs out while an onboarding screen is still showing; the handover wipe empties settings.
    Object.assign(mockWorld, { status: 'signedOut', profile: null, profileSource: null, segments: ['(onboarding)', '[step]'], pathname: '/clan' });
    await view.rerender(gate());
    await settings.remove(ONBOARDING_PENDING_HREF_KEY);
    // B signs in, already set up, still on that onboarding screen.
    mockReplace.mockClear();
    Object.assign(mockWorld, { status: 'signedIn', uid: 'u2', profile: { ...READY, id: 'u2' }, profileSource: 'network' });
    await view.rerender(gate());
    await act(async () => {});
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockReplace).not.toHaveBeenCalledWith('/drives');
  });

  test('m1 control: the same account keeps its link across the same steps without a sign-out', async () => {
    const view = await mount({
      status: 'signedIn',
      uid: 'u1',
      profile: OWED,
      profileSource: 'network',
      segments: ['(app)', 'drives'],
      pathname: '/drives',
    });
    await act(async () => {});
    Object.assign(mockWorld, { segments: ['(onboarding)', '[step]'], pathname: '/clan' });
    await view.rerender(gate());
    await settings.remove(ONBOARDING_PENDING_HREF_KEY);
    mockReplace.mockClear();
    Object.assign(mockWorld, { profile: READY });
    await view.rerender(gate());
    await act(async () => {});
    expect(mockReplace).toHaveBeenCalledWith('/drives');
  });
});
