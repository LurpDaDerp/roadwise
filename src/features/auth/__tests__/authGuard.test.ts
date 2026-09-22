import {
  driveFacts,
  pendingHrefFor,
  profileGate,
  resolveGate,
  resolveStart,
  type DriveFacts,
  type ProfileGate,
  type SessionStatus,
} from '@/features/auth/authGuard';
import type { UpdateStatus } from '@/features/auth/version';

const IDLE: DriveFacts = { busy: false, mode: null, tripOpen: false };
const RECORDING_MOUNTED: DriveFacts = { busy: true, mode: 'mounted', tripOpen: true };
const RECORDING_POCKET: DriveFacts = { busy: true, mode: 'pocket', tripOpen: true };
const RECORDING_AUTO: DriveFacts = { busy: true, mode: 'auto', tripOpen: true };
const CANDIDATE: DriveFacts = { busy: true, mode: 'auto', tripOpen: false };

describe('profileGate', () => {
  test.each<[string, unknown, ProfileGate]>([
    ['no profile', null, 'unknown'],
    ['an under-13 account', { age_band: 'u13', flags: { onboarded: true } }, 'blocked'],
    ['not onboarded', { age_band: '18_plus', flags: {} }, 'onboarding'],
    ['flags absent (every M0–M3 install)', { age_band: '18_plus', flags: null }, 'onboarding'],
    ['onboarded as a string is not onboarded', { age_band: '18_plus', flags: { onboarded: 'true' } }, 'onboarding'],
    ['an unknown band, not onboarded', { age_band: 'unknown', flags: {} }, 'onboarding'],
    ['onboarded adult', { age_band: '18_plus', flags: { onboarded: true } }, 'ready'],
    ['onboarded teen', { age_band: '13_17', flags: { onboarded: true } }, 'ready'],
  ])('%s → %s', (_label, profile, expected) =>
    expect(profileGate(profile as Parameters<typeof profileGate>[0])).toBe(expected)
  );
});

describe('driveFacts', () => {
  test.each<[string, boolean, DriveFacts]>([
    ['off', false, { busy: false, mode: 'mounted', tripOpen: false }],
    ['armed', false, { busy: false, mode: 'mounted', tripOpen: false }],
    ['candidate', true, { busy: true, mode: 'mounted', tripOpen: false }],
    ['recording', true, { busy: true, mode: 'mounted', tripOpen: true }],
    ['ending', true, { busy: true, mode: 'mounted', tripOpen: true }],
    ['finalizing', true, { busy: true, mode: 'mounted', tripOpen: false }],
  ])('%s', (status, hostBusy, expected) =>
    expect(driveFacts({ status: status as never, mode: 'mounted' }, hostBusy)).toEqual(expected)
  );

  test('the host saying busy is enough, whatever the snapshot says', () =>
    expect(driveFacts({ status: 'armed', mode: 'pocket' }, true).busy).toBe(true));
});

describe('resolveStart (A1)', () => {
  test.each<[SessionStatus, ProfileGate, UpdateStatus | null, DriveFacts, string | null]>([
    // An open trip wins over everything (C3/C4, N-m3): recording or ending only.
    ['signedIn', 'ready', 'ok', RECORDING_MOUNTED, '/drive/hud'],
    ['signedIn', 'ready', 'ok', RECORDING_POCKET, '/drive/pocket'],
    ['signedIn', 'ready', 'ok', RECORDING_AUTO, '/drive/pocket'],
    ['signedIn', 'onboarding', 'required', RECORDING_MOUNTED, '/drive/hud'],
    ['loading', 'unknown', null, RECORDING_POCKET, '/drive/pocket'],
    ['signedOut', 'unknown', 'required', RECORDING_MOUNTED, '/drive/hud'],
    // A candidate may be a bus ride: never the drive screen.
    ['signedIn', 'ready', 'ok', CANDIDATE, '/(tabs)/home'],
    // The config has not been read: hold the frame.
    ['signedIn', 'ready', null, IDLE, null],
    // The update gate wins next.
    ['signedIn', 'ready', 'required', IDLE, '/update-required'],
    ['signedOut', 'unknown', 'required', IDLE, '/update-required'],
    ['loading', 'unknown', 'ok', IDLE, null],
    ['signedOut', 'unknown', 'ok', IDLE, '/(auth)/welcome'],
    ['signedOut', 'unknown', 'unknown', IDLE, '/(auth)/welcome'],
    ['signedIn', 'unknown', 'ok', IDLE, null],
    ['signedIn', 'blocked', 'ok', IDLE, '/(onboarding)/not-eligible'],
    ['signedIn', 'onboarding', 'ok', IDLE, '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'unknown', IDLE, '/(onboarding)/start'],
    ['signedIn', 'ready', 'ok', IDLE, '/(tabs)/home'],
    ['signedIn', 'ready', 'unknown', IDLE, '/(tabs)/home'],
  ])('%s, %s, update %s, drive %j → %s', (status, gate, update, drive, expected) =>
    expect(resolveStart(status, gate, update, drive)).toBe(expected)
  );
});

describe('resolveGate', () => {
  const SEGMENTS: string[][] = [
    ['(auth)', 'welcome'],
    ['(auth)', 'sign-in'],
    ['auth', 'callback'],
    ['(tabs)', 'home'],
    ['(tabs)', 'insights'],
    ['(app)', 'trips'],
    ['(onboarding)', '[step]'],
    ['update-required'],
    ['drive', 'hud'],
    ['drive', 'pocket'],
  ];
  const STATUSES: SessionStatus[] = ['loading', 'signedOut', 'signedIn'];
  const GATES: ProfileGate[] = ['unknown', 'blocked', 'onboarding', 'ready'];
  const UPDATES: UpdateStatus[] = ['required', 'ok', 'unknown'];

  test('a busy drive host means no redirect of any kind, from every segment and state (I10)', () => {
    for (const status of STATUSES)
      for (const gate of GATES)
        for (const update of UPDATES)
          for (const segments of SEGMENTS)
            for (const drive of [RECORDING_MOUNTED, RECORDING_POCKET, CANDIDATE])
              expect(resolveGate(status, gate, update, segments, drive)).toBeNull();
  });

  test('a drive segment means no redirect of any kind, even with the host idle (I10)', () => {
    for (const status of STATUSES)
      for (const gate of GATES)
        for (const update of UPDATES)
          for (const segments of [['drive', 'hud'], ['drive', 'pocket'], ['drive', 'end'], ['drive', 'start']])
            expect(resolveGate(status, gate, update, segments, IDLE)).toBeNull();
  });

  test('once the drive goes idle the same state redirects', () => {
    expect(resolveGate('signedIn', 'onboarding', 'ok', ['(tabs)', 'home'], RECORDING_MOUNTED)).toBeNull();
    expect(resolveGate('signedIn', 'onboarding', 'ok', ['(tabs)', 'home'], IDLE)).toBe('/(onboarding)/start');
    expect(resolveGate('signedIn', 'ready', 'required', ['(tabs)', 'home'], CANDIDATE)).toBeNull();
    expect(resolveGate('signedIn', 'ready', 'required', ['(tabs)', 'home'], IDLE)).toBe('/update-required');
  });

  test('the launch router owns `/`', () => {
    for (const status of STATUSES)
      for (const gate of GATES)
        for (const update of UPDATES) expect(resolveGate(status, gate, update, [], IDLE)).toBeNull();
  });

  test.each<[SessionStatus, ProfileGate, UpdateStatus, string[], string | null]>([
    // The update gate wins everywhere else, never on its own screen.
    ['signedIn', 'ready', 'required', ['(tabs)', 'home'], '/update-required'],
    ['signedIn', 'onboarding', 'required', ['(onboarding)', '[step]'], '/update-required'],
    ['signedOut', 'unknown', 'required', ['(auth)', 'welcome'], '/update-required'],
    ['loading', 'unknown', 'required', ['(tabs)', 'home'], '/update-required'],
    ['signedIn', 'ready', 'required', ['update-required'], null],
    // Leaving the update screen once it no longer applies (updated, or offline/unknown).
    ['signedIn', 'ready', 'ok', ['update-required'], '/'],
    ['signedIn', 'ready', 'unknown', ['update-required'], '/'],
    // Loading: nothing is known.
    ['loading', 'unknown', 'ok', ['(auth)', 'welcome'], null],
    ['loading', 'unknown', 'ok', ['(tabs)', 'home'], null],
    // Signed out: M0 behaviour.
    ['signedOut', 'unknown', 'ok', ['(tabs)', 'home'], '/(auth)/welcome'],
    ['signedOut', 'unknown', 'ok', ['(onboarding)', '[step]'], '/(auth)/welcome'],
    ['signedOut', 'unknown', 'ok', ['(app)', 'trips'], '/(auth)/welcome'],
    ['signedOut', 'unknown', 'ok', ['(auth)', 'sign-in'], null],
    ['signedOut', 'unknown', 'ok', ['auth', 'callback'], null],
    // Profile unknown: stay put, except off the sign-in screens and the callback.
    ['signedIn', 'unknown', 'ok', ['(tabs)', 'home'], null],
    ['signedIn', 'unknown', 'ok', ['(onboarding)', '[step]'], null],
    ['signedIn', 'unknown', 'ok', ['(auth)', 'sign-in'], '/'],
    ['signedIn', 'unknown', 'ok', ['auth', 'callback'], '/'],
    // Blocked: the not-eligible step, from everywhere outside onboarding.
    ['signedIn', 'blocked', 'ok', ['(tabs)', 'home'], '/(onboarding)/not-eligible'],
    ['signedIn', 'blocked', 'ok', ['(app)', 'trips'], '/(onboarding)/not-eligible'],
    ['signedIn', 'blocked', 'ok', ['auth', 'callback'], '/(onboarding)/not-eligible'],
    ['signedIn', 'blocked', 'ok', ['(onboarding)', '[step]'], null],
    // Onboarding owed: from anywhere outside onboarding, including the callback (M0 M-13).
    ['signedIn', 'onboarding', 'ok', ['(tabs)', 'home'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(tabs)', 'insights'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(app)', 'trips'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(auth)', 'sign-in'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['auth', 'callback'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'unknown', ['auth', 'callback'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(onboarding)', '[step]'], null],
    // Ready: out of the sign-in screens, the callback and onboarding; otherwise stay.
    ['signedIn', 'ready', 'ok', ['(auth)', 'welcome'], '/(tabs)/home'],
    ['signedIn', 'ready', 'ok', ['auth', 'callback'], '/(tabs)/home'],
    ['signedIn', 'ready', 'ok', ['(onboarding)', '[step]'], '/(tabs)/home'],
    ['signedIn', 'ready', 'ok', ['(tabs)', 'insights'], null],
    ['signedIn', 'ready', 'unknown', ['(app)', 'trips'], null],
  ])('%s, %s, update %s at [%s] → %s', (status, gate, update, segments, expected) =>
    expect(resolveGate(status, gate, update, segments, IDLE)).toBe(expected)
  );
});

describe('pendingHrefFor (the deep links a gate may hold)', () => {
  test.each<[string, string | null]>([
    ['/trips/abc_123-X/summary', '/trips/abc_123-X/summary'],
    ['/trips', '/trips'],
    ['/inbox', '/inbox'],
    ['/permissions', '/permissions'],
    // Not allowlisted: nothing is held.
    ['/home', null],
    ['/', null],
    ['/trips/../settings/summary', null],
    ['/trips/abc/summary?x=1', null],
    ['https://evil.test/trips', null],
    ['/trips/' + 'a'.repeat(65) + '/summary', null],
    ['/drive/hud', null],
    ['/update-required', null],
  ])('%s → %s', (pathname, expected) => expect(pendingHrefFor(pathname)).toBe(expected));

  test('a non-string is nothing', () => expect(pendingHrefFor(undefined)).toBeNull());
});
