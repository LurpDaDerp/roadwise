import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { DataProvider } from '@/data/queries/context';
import { SessionProvider } from '@/data/supabase/session';
import { writeProfileCache } from '@/features/auth/profileCache';
import { ThemeProvider } from '@/ui/theme';

import Launch, { launchCopy } from '../index';

// A1 over the real SessionProvider: Supabase and the profile read are the only fakes, so the
// offline cold start below runs through the same code a phone in a garage does.
const mockWorld: {
  session: unknown;
  profile: 'fail' | Record<string, unknown>;
  driveStatus: string;
  hostBusy: boolean;
  update: 'required' | 'ok' | 'unknown' | null;
} = { session: null, profile: 'fail', driveStatus: 'idle', hostBusy: false, update: 'ok' };
const mockProfileCalls: string[] = [];

jest.mock('expo-router', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Redirect: ({ href }: { href: string }) => <RNText>{`redirect:${href}`}</RNText> };
});
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: mockWorld.session } })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));
jest.mock('@/features/drive/summaryNotifier', () => ({ cancelDriveSummaries: jest.fn(async () => {}) }));
jest.mock('@/data/supabase/profile', () => ({
  fetchProfile: jest.fn(async (userId: string) => {
    mockProfileCalls.push(userId);
    if (mockWorld.profile === 'fail') throw new Error('Network request failed');
    return mockWorld.profile;
  }),
}));
jest.mock('@/drive/useDrive', () => ({
  useDrive: (select: (s: { status: string }) => unknown) => select({ status: mockWorld.driveStatus }),
  useDriveHost: () => ({ isBusy: () => mockWorld.hostBusy }),
}));
jest.mock('@/features/auth/version', () => ({ useUpdateStatus: () => mockWorld.update }));

const ONBOARDED = { id: 'u1', username: 'swift_fox', onboarded_at: '2026-10-05T00:00:00Z' };

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mockProfileCalls.length = 0;
  Object.assign(mockWorld, {
    session: { user: { id: 'u1' } },
    profile: ONBOARDED,
    driveStatus: 'idle',
    hostBusy: false,
    update: 'ok',
  });
});

async function launch() {
  await render(
    <ThemeProvider>
      <DataProvider db={db}>
        <SessionProvider>
          <Launch />
        </SessionProvider>
      </DataProvider>
    </ThemeProvider>
  );
  await act(async () => {});
}

const landed = () => screen.queryByText(/^redirect:/)?.props.children as string | undefined;

describe('an open trip on a cold start (rev1: I2, N-m3)', () => {
  test('recording → the driving screen, before any other rule (signed out, update required)', async () => {
    Object.assign(mockWorld, { driveStatus: 'recording', hostBusy: true, update: 'required', session: null });
    await launch();
    expect(landed()).toBe('redirect:/drive');
  });

  test('recording with the config not read yet still goes straight to the drive', async () => {
    Object.assign(mockWorld, { driveStatus: 'recording', hostBusy: true, update: null });
    await launch();
    expect(landed()).toBe('redirect:/drive');
  });

  test('finalizing is not a trip to go back to', async () => {
    Object.assign(mockWorld, { driveStatus: 'finalizing', hostBusy: true });
    await launch();
    expect(landed()).toBe('redirect:/(tabs)/home');
  });
});

test('signed out → sign-in', async () => {
  mockWorld.session = null;
  await launch();
  expect(landed()).toBe('redirect:/(auth)/sign-in');
});

test('onboarding owed (no onboarded_at, or no username) → the onboarding entry, not Home', async () => {
  mockWorld.profile = { ...ONBOARDED, onboarded_at: null };
  await launch();
  expect(landed()).toBe('redirect:/(onboarding)/start');
});

test('onboarded → Home', async () => {
  await launch();
  expect(landed()).toBe('redirect:/(tabs)/home');
});

test('a required update → the update screen', async () => {
  mockWorld.update = 'required';
  await launch();
  expect(landed()).toBe('redirect:/update-required');
});

test('the config not read yet holds the frame', async () => {
  mockWorld.update = null;
  await launch();
  expect(landed()).toBeUndefined();
  expect(screen.getByLabelText(launchCopy.loading)).toBeOnTheScreen();
});

describe('an offline cold start (rev1: I11)', () => {
  test('with a cached, onboarded profile → Home', async () => {
    await writeProfileCache(createSettingsRepo(db), ONBOARDED as never);
    mockWorld.profile = 'fail';
    await launch();
    expect(landed()).toBe('redirect:/(tabs)/home');
  });

  test('a cache for someone else is not used: the retry card after 10 s', async () => {
    await writeProfileCache(createSettingsRepo(db), { ...ONBOARDED, id: 'u2' } as never);
    mockWorld.profile = 'fail';
    jest.useFakeTimers();
    try {
      await launch();
      expect(landed()).toBeUndefined();
      await act(async () => { jest.advanceTimersByTime(10_000); });
      expect(screen.getByText("We couldn't load your profile")).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  test('with no cache: a held frame, then after 10 s the retry card, whose retry lands', async () => {
    mockWorld.profile = 'fail';
    jest.useFakeTimers();
    try {
      await launch();
      expect(landed()).toBeUndefined();
      expect(screen.getByLabelText(launchCopy.loading)).toBeOnTheScreen();
      await act(async () => { jest.advanceTimersByTime(9_999); });
      expect(screen.queryByText(launchCopy.failed)).toBeNull();
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(screen.getByRole('header', { name: launchCopy.failed })).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }

    // Back online: Try again reads the profile and the launch lands.
    mockWorld.profile = ONBOARDED;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(mockProfileCalls).toEqual(['u1', 'u1']);
    expect(landed()).toBe('redirect:/(tabs)/home');
  });
});

test('announces "RoadWise loading" while it holds the frame', async () => {
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  mockWorld.update = null;
  await launch();
  expect(spy).toHaveBeenCalledWith('RoadWise loading');
  spy.mockRestore();
});
