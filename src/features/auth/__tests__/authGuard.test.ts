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
import type { EngineStatus } from '@/core/engine/engine.types';
import type { UpdateStatus } from '@/features/auth/version';

const IDLE: DriveFacts = { busy: false, tripOpen: false, origin: null };
const RECORDING: DriveFacts = { busy: true, tripOpen: true, origin: 'manual' };
/** An open trip whose origin the snapshot did not carry: treated as manual (the driving screen). */
const RECORDING_UNKNOWN: DriveFacts = { busy: true, tripOpen: true, origin: null };
const RECORDING_AUTO: DriveFacts = { busy: true, tripOpen: true, origin: 'auto' };
const FINALIZING: DriveFacts = { busy: true, tripOpen: false, origin: null };

describe('profileGate (v3: onboarded_at and a username)', () => {
  test.each<[string, unknown, ProfileGate]>([
    ['no profile', null, 'unknown'],
    ['a non-object', 'x', 'unknown'],
    ['neither column', {}, 'onboarding'],
    ['a username but not onboarded', { username: 'swift_fox', onboarded_at: null }, 'onboarding'],
    ['onboarded but no username', { username: null, onboarded_at: '2026-10-05T00:00:00Z' }, 'onboarding'],
    ['a blank username', { username: '  ', onboarded_at: '2026-10-05T00:00:00Z' }, 'onboarding'],
    ['onboarded with a username', { username: 'swift_fox', onboarded_at: '2026-10-05T00:00:00Z' }, 'ready'],
    // v2 columns mean nothing any more.
    ['v2 flags only', { age_band: '18_plus', flags: { onboarded: true } }, 'onboarding'],
  ])('%s → %s', (_label, profile, expected) => expect(profileGate(profile)).toBe(expected));
});

describe('driveFacts', () => {
  test.each<[string, boolean, DriveFacts]>([
    ['idle', false, { busy: false, tripOpen: false, origin: null }],
    ['recording', true, { busy: true, tripOpen: true, origin: null }],
    ['finalizing', true, { busy: true, tripOpen: false, origin: null }],
  ])('%s', (status, hostBusy, expected) =>
    expect(driveFacts({ status: status as EngineStatus }, hostBusy)).toEqual(expected)
  );

  test('the origin is carried only while a trip is open', () => {
    expect(driveFacts({ status: 'recording', origin: 'auto' }, true).origin).toBe('auto');
    expect(driveFacts({ status: 'recording', origin: 'manual' }, true).origin).toBe('manual');
    expect(driveFacts({ status: 'recording', origin: null }, true).origin).toBeNull();
    // finalizing is over, whatever the snapshot still says
    expect(driveFacts({ status: 'finalizing', origin: 'manual' }, true)).toEqual({ busy: true, tripOpen: false, origin: null });
    expect(driveFacts({ status: 'idle', origin: 'auto' }, false).origin).toBeNull();
  });

  test('the host saying busy is enough, whatever the snapshot says', () =>
    expect(driveFacts({ status: 'idle' }, true).busy).toBe(true));
});

describe('resolveStart', () => {
  test.each<[SessionStatus, ProfileGate, UpdateStatus | null, DriveFacts, string | null]>([
    // An open manual trip wins over everything: back to the driving screen.
    ['signedIn', 'ready', 'ok', RECORDING, '/drive'],
    ['signedIn', 'onboarding', 'required', RECORDING, '/drive'],
    ['loading', 'unknown', null, RECORDING, '/drive'],
    ['signedOut', 'unknown', 'required', RECORDING, '/drive'],
    // So does an open trip of no known origin (never less than before).
    ['signedIn', 'ready', 'ok', RECORDING_UNKNOWN, '/drive'],
    ['loading', 'unknown', null, RECORDING_UNKNOWN, '/drive'],
    // An automatic drive opens on Home (its strip leads to the driving screen), by the usual rules.
    ['signedIn', 'ready', 'ok', RECORDING_AUTO, '/(tabs)/home'],
    ['signedIn', 'ready', 'unknown', RECORDING_AUTO, '/(tabs)/home'],
    ['signedIn', 'ready', null, RECORDING_AUTO, null],
    ['loading', 'unknown', 'ok', RECORDING_AUTO, null],
    ['signedIn', 'unknown', 'ok', RECORDING_AUTO, null],
    ['signedIn', 'ready', 'required', RECORDING_AUTO, '/update-required'],
    // Finalizing is already over: never the driving screen.
    ['signedIn', 'ready', 'ok', FINALIZING, '/(tabs)/home'],
    // The config has not been read: hold the frame.
    ['signedIn', 'ready', null, IDLE, null],
    // The update gate wins next.
    ['signedIn', 'ready', 'required', IDLE, '/update-required'],
    ['signedOut', 'unknown', 'required', IDLE, '/update-required'],
    ['loading', 'unknown', 'ok', IDLE, null],
    ['signedOut', 'unknown', 'ok', IDLE, '/(auth)/sign-in'],
    ['signedOut', 'unknown', 'unknown', IDLE, '/(auth)/sign-in'],
    ['signedIn', 'unknown', 'ok', IDLE, null],
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
    ['(auth)', 'sign-in'],
    ['(tabs)', 'home'],
    ['(tabs)', 'leagues'],
    ['(app)', 'drives'],
    ['(onboarding)', '[step]'],
    ['update-required'],
    ['drive'],
  ];
  const STATUSES: SessionStatus[] = ['loading', 'signedOut', 'signedIn'];
  const GATES: ProfileGate[] = ['unknown', 'onboarding', 'ready'];
  const UPDATES: UpdateStatus[] = ['required', 'ok', 'unknown'];

  test('a busy drive host means no redirect of any kind, from every segment and state (I10)', () => {
    for (const status of STATUSES)
      for (const gate of GATES)
        for (const update of UPDATES)
          for (const segments of SEGMENTS)
            for (const drive of [RECORDING, FINALIZING])
              expect(resolveGate(status, gate, update, segments, drive)).toBeNull();
  });

  test('the driving screen means no redirect of any kind, even with the host idle (I10)', () => {
    for (const status of STATUSES)
      for (const gate of GATES)
        for (const update of UPDATES) expect(resolveGate(status, gate, update, ['drive'], IDLE)).toBeNull();
  });

  test('once the drive goes idle the same state redirects', () => {
    expect(resolveGate('signedIn', 'onboarding', 'ok', ['(tabs)', 'home'], RECORDING)).toBeNull();
    expect(resolveGate('signedIn', 'onboarding', 'ok', ['(tabs)', 'home'], IDLE)).toBe('/(onboarding)/start');
    expect(resolveGate('signedIn', 'ready', 'required', ['(tabs)', 'home'], FINALIZING)).toBeNull();
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
    ['signedOut', 'unknown', 'required', ['(auth)', 'sign-in'], '/update-required'],
    ['loading', 'unknown', 'required', ['(tabs)', 'home'], '/update-required'],
    ['signedIn', 'ready', 'required', ['update-required'], null],
    // Leaving the update screen once it no longer applies (updated, or offline/unknown).
    ['signedIn', 'ready', 'ok', ['update-required'], '/'],
    ['signedIn', 'ready', 'unknown', ['update-required'], '/'],
    // Loading: nothing is known.
    ['loading', 'unknown', 'ok', ['(auth)', 'sign-in'], null],
    ['loading', 'unknown', 'ok', ['(tabs)', 'home'], null],
    // Signed out: the sign-in screen.
    ['signedOut', 'unknown', 'ok', ['(tabs)', 'home'], '/(auth)/sign-in'],
    ['signedOut', 'unknown', 'ok', ['(onboarding)', '[step]'], '/(auth)/sign-in'],
    ['signedOut', 'unknown', 'ok', ['(app)', 'drives'], '/(auth)/sign-in'],
    ['signedOut', 'unknown', 'ok', ['(auth)', 'sign-in'], null],
    // Profile unknown: stay put, except off the sign-in screen.
    ['signedIn', 'unknown', 'ok', ['(tabs)', 'home'], null],
    ['signedIn', 'unknown', 'ok', ['(onboarding)', '[step]'], null],
    ['signedIn', 'unknown', 'ok', ['(auth)', 'sign-in'], '/'],
    // Onboarding owed: from anywhere outside onboarding.
    ['signedIn', 'onboarding', 'ok', ['(tabs)', 'home'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(tabs)', 'leagues'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(app)', 'drives'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(auth)', 'sign-in'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'unknown', ['(auth)', 'sign-in'], '/(onboarding)/start'],
    ['signedIn', 'onboarding', 'ok', ['(onboarding)', '[step]'], null],
    // Ready: out of the sign-in screen and onboarding; otherwise stay.
    ['signedIn', 'ready', 'ok', ['(auth)', 'sign-in'], '/(tabs)/home'],
    ['signedIn', 'ready', 'ok', ['(onboarding)', '[step]'], '/(tabs)/home'],
    ['signedIn', 'ready', 'ok', ['(tabs)', 'leagues'], null],
    ['signedIn', 'ready', 'unknown', ['(app)', 'drives'], null],
  ])('%s, %s, update %s at [%s] → %s', (status, gate, update, segments, expected) =>
    expect(resolveGate(status, gate, update, segments, IDLE)).toBe(expected)
  );
});

describe('pendingHrefFor (the deep links a gate may hold)', () => {
  test.each<[string, string | null]>([
    ['/drives/0f8fad5b-d9cb-469f-a165-70867728950e', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e'],
    ['/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1', '/drives/0f8fad5b-d9cb-469f-a165-70867728950e?fresh=1'],
    ['/drives', '/drives'],
    ['/home', '/home'],
    ['/leagues', '/leagues'],
    ['/friends', '/friends'],
    // Not allowlisted: nothing is held.
    ['/settings/permissions', null],
    ['/drives/abc_123', null],
    ['/', null],
    ['/drives/../settings', null],
    ['/drives/abc?x=1', null],
    ['https://evil.test/drives', null],
    ['/drives/' + 'a'.repeat(65), null],
    ['/drive', null],
    ['/inbox', null],
    ['/update-required', null],
    // A friend's profile, normalised to one form.
    ['/u/maya_16', '/u/maya_16'],
    ['/add/Maya_16', '/u/maya_16'],
    ['/u/a', null],
    ['/u/maya?x=1', null],
    // Clans are gone: an old invite link is not held.
    ['/clan/abcd2345', null],
    ['/clan/join?code=ABCD2345', null],
    ['/clan/join', null],
    // There is no DashPal link to hold.
    ['/dashpal', null],
    ['/dashpal?d=f412fa0c9e01', null],
    ['/dashpal?d=F412FA0C9E01', null],
    ['/dashpal?d=f412fa0c9e01&k=000G40R40M30E209185GR38E1W60', null],
    ['/dashpal?k=000G40R40M30E209185GR38E1W60', null],
    ['/dashpal#d=f412fa0c9e01&k=000G40R40M30E209185GR38E1W60', null],
    ['/dashpal?d=f412fa0c9e0', null],
    ['/dashpal/setup', null],
  ])('%s → %s', (pathname, expected) => expect(pendingHrefFor(pathname)).toBe(expected));

  test('a non-string is nothing', () => expect(pendingHrefFor(undefined)).toBeNull());
});
