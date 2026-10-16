/** @jest-environment node */
// A tap on the forgot-to-start reminder: the token is read only from the reminder's own note, a
// drive starts only after native claimed the token, once, through the injected start (the Start
// Drive button's), and every way it cannot start lands on Home with the right line.
import { createFakeDriveSense, REMINDER, type ReminderTap } from '@drive-sense';

import type { StartResult } from '@/drive/host';
import type { StartNotice } from '@/features/home/startNotice';

import {
  isReminderResponse,
  REMINDER_NOTIFICATION_ID,
  reminderStartGate,
  reminderTokenOf,
  startFromReminderTap,
  watchReminderTapIntents,
  type StartGate,
  type StartGateFacts,
} from '../reminderTap';

jest.mock('expo-notifications', () => ({ DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT' }));

const TOKEN = '9f1c2b7e-0d4a-4c1e-9a77-1b2c3d4e5f60';
const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const T = 1_760_000_000_000;

const response = (o: { id?: string; action?: string; data?: unknown } = {}) => ({
  actionIdentifier: o.action ?? DEFAULT,
  notification: { date: 1, request: { identifier: o.id ?? REMINDER_NOTIFICATION_ID, content: { data: o.data === undefined ? { kind: 'tripReminder', reminderToken: TOKEN } : o.data } } },
});

describe('the token comes only from a tap on the reminder note', () => {
  test('the right note, action, kind and token', () => {
    expect(reminderTokenOf(response())).toBe(TOKEN);
    expect(isReminderResponse(response())).toBe(true);
  });

  test.each([
    ['a dismissal', response({ action: 'expo.modules.notifications.actions.DISMISS' })],
    ['a button', response({ action: 'roadwise.tripReminder.notDriving' })],
    ['another note', response({ id: 'drive-summary' })],
    ['no kind', response({ data: { reminderToken: TOKEN } })],
    ['another kind', response({ data: { kind: 'push', reminderToken: TOKEN } })],
    ['no token', response({ data: { kind: 'tripReminder' } })],
    ['a token with spaces', response({ data: { kind: 'tripReminder', reminderToken: 'a b' } })],
    ['a 65-character token', response({ data: { kind: 'tripReminder', reminderToken: 'x'.repeat(65) } })],
    ['a number token', response({ data: { kind: 'tripReminder', reminderToken: 42 } })],
    ['no data', response({ data: null })],
    ['not a response', null],
    ['garbage', { notification: 'x' }],
  ])('%s gives no token', (_n, r) => {
    expect(reminderTokenOf(r)).toBeNull();
  });

  test('the reminder note without a token (or pushed with its id) is still the reminder: never routed as a link', () => {
    expect(isReminderResponse(response({ data: { url: '/drive' } }))).toBe(true);
    expect(reminderTokenOf(response({ data: { url: '/drive' } }))).toBeNull();
    expect(isReminderResponse(response({ id: 'drive-summary' }))).toBe(false);
  });
});

describe('the start gate', () => {
  const facts = (over: Partial<StartGateFacts> = {}): StartGateFacts => ({
    ready: true,
    session: 'signedIn',
    update: 'ok',
    profile: 'ready',
    hostBooted: true,
    hostSignedIn: true,
    hostBusy: false,
    ...over,
  });
  test.each([
    ['all set', facts(), 'yes'],
    ['the navigator not mounted yet', facts({ ready: false }), 'wait'],
    ['the session still loading', facts({ session: 'loading' }), 'wait'],
    ['signed out', facts({ session: 'signedOut' }), 'never'],
    ['signed out beats an unknown update', facts({ session: 'signedOut', update: null }), 'never'],
    ['the config not read yet', facts({ update: null }), 'wait'],
    ['an update required', facts({ update: 'required' }), 'never'],
    ['the update gate unknown (offline)', facts({ update: 'unknown' }), 'yes'],
    ['the profile not known yet', facts({ profile: 'unknown' }), 'wait'],
    ['setup still owed', facts({ profile: 'onboarding' }), 'never'],
    ['the host not booted', facts({ hostBooted: false }), 'wait'],
    ['the host still signed out (a sign-in this process has not caught up with)', facts({ hostSignedIn: false }), 'wait'],
    ['a drive closing', facts({ hostBusy: true }), 'wait'],
  ] as const)('%s → %s', (_n, f, gate) => {
    expect(reminderStartGate(f)).toBe(gate);
  });
});

function harness(o: { claim?: boolean | Error; start?: StartResult | Error; gate?: StartGate; now?: number } = {}) {
  const log: string[] = [];
  const notices: StartNotice[] = [];
  const hrefs: string[] = [];
  let gate: StartGate = o.gate ?? 'yes';
  const native = {
    claimReminderTap: jest.fn(async (token: string) => {
      log.push(`claim:${token}`);
      if (o.claim instanceof Error) throw o.claim;
      return o.claim ?? true;
    }),
  };
  const start = jest.fn(async (): Promise<StartResult> => {
    log.push('start');
    if (o.start instanceof Error) throw o.start;
    return o.start ?? { ok: true, clientTripId: 'trip-1' };
  });
  const deps = {
    start,
    navigate: (h: string) => hrefs.push(h),
    notice: (n: StartNotice) => notices.push(n),
    gate: () => gate,
    now: () => o.now ?? T,
    native,
  };
  return { deps, log, notices, hrefs, native, start, setGate: (g: StartGate) => (gate = g) };
}

const hold = (at = T, token = TOKEN): ReminderTap => ({ token, at });

describe('startFromReminderTap', () => {
  test('a claim, then one start, then the drive screen', async () => {
    const h = harness();
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('started');
    expect(h.log).toEqual([`claim:${TOKEN}`, 'start']);
    expect(h.hrefs).toEqual(['/drive']);
    expect(h.notices).toEqual([]);
  });

  test('a claim refused (session over, already used, a drive open, wrong token): no start, Home says it expired', async () => {
    const h = harness({ claim: false });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('stale');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.notices).toEqual(['reminder-expired']);
    expect(h.hrefs).toEqual(['/home']);
  });

  test('a claim that throws (no native module): no start, expired', async () => {
    const h = harness({ claim: new Error('DriveSense native module is not available') });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('stale');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.notices).toEqual(['reminder-expired']);
  });

  test('a drive already running: the drive screen, no notice', async () => {
    const h = harness({ start: { ok: false, reason: 'busy' } });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('refused');
    expect(h.hrefs).toEqual(['/drive']);
    expect(h.notices).toEqual([]);
  });

  test.each(['permission', 'error'] as const)('a start refused for %s: Home with the same line the Start Drive button shows', async (reason) => {
    const h = harness({ start: { ok: false, reason } });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('refused');
    expect(h.notices).toEqual([reason]);
    expect(h.hrefs).toEqual(['/home']);
  });

  test('a start that throws: Home with the error line', async () => {
    const h = harness({ start: new Error('boom') });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('refused');
    expect(h.notices).toEqual(['error']);
    expect(h.hrefs).toEqual(['/home']);
  });

  test('the app still starting: wait, with no claim (the hold is kept)', async () => {
    const h = harness({ gate: 'wait' });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('waiting');
    expect(h.log).toEqual([]);
    expect(h.hrefs).toEqual([]);
    h.setGate('yes');
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('started');
    expect(h.log).toEqual([`claim:${TOKEN}`, 'start']);
  });

  test('setup, signed out or an update required: dropped, no claim, no navigation, no notice', async () => {
    const h = harness({ gate: 'never' });
    await expect(startFromReminderTap(hold(), h.deps)).resolves.toBe('dropped');
    expect(h.log).toEqual([]);
    expect(h.hrefs).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test('held 2:00 still runs; 2:00.001 is expired with no claim, even while the app is still starting', async () => {
    const fresh = harness({ now: T + REMINDER.TAP_FRESH_MS });
    await expect(startFromReminderTap(hold(), fresh.deps)).resolves.toBe('started');
    const late = harness({ now: T + REMINDER.TAP_FRESH_MS + 1, gate: 'wait' });
    await expect(startFromReminderTap(hold(), late.deps)).resolves.toBe('stale');
    expect(late.log).toEqual([]);
    expect(late.notices).toEqual(['reminder-expired']);
    expect(late.hrefs).toEqual(['/home']);
  });
});

describe('with the native policy behind the claim (the fake)', () => {
  test('one start per token, however often the tap reaches JS; never a start without a claim true', async () => {
    let now = T;
    const native = createFakeDriveSense({ platform: 'ios', now: () => now });
    await native.setTripReminder(true);
    native.postReminderForTest(TOKEN);
    const starts: number[] = [];
    const deps = {
      start: async (): Promise<StartResult> => {
        starts.push(now);
        return { ok: true, clientTripId: 'trip-1' };
      },
      navigate: () => {},
      notice: () => {},
      gate: (): StartGate => 'yes',
      now: () => now,
      native,
    };
    // the listener and the launch response, and a remount's replay of it
    await startFromReminderTap(hold(now), deps);
    await startFromReminderTap(hold(now), deps);
    now += 1000;
    await startFromReminderTap(hold(now), deps);
    expect(starts).toEqual([T]);
    // a foreign token never starts
    await startFromReminderTap(hold(now, 'tok-z'), deps);
    expect(starts).toEqual([T]);
  });

  test("Android: a token handed over is taken once on subscribe, on the reminderTap event and on return to the front; the same token handed over again (a recreated activity) is never taken", async () => {
    const native = createFakeDriveSense({ platform: 'android', now: () => T });
    await native.setTripReminder(true);
    let active: ((s: string) => void) | null = null;
    const appState = {
      addEventListener: (_t: 'change', fn: (s: string) => void) => {
        active = fn;
        return { remove: () => (active = null) };
      },
    };
    const taps: ReminderTap[] = [];
    native.postReminderForTest('tok-a');
    native.tapReminderForTest('tok-a'); // before the subscribe: a cold start
    const stop = watchReminderTapIntents((t) => taps.push(t), native, appState);
    await Promise.resolve();
    await Promise.resolve();
    expect(taps).toEqual([{ token: 'tok-a', at: T }]);
    // a recreated activity's saved intent: dropped natively
    expect(native.tapReminderForTest('tok-a')).toBe(false);
    native.postReminderForTest('tok-b');
    native.tapReminderForTest('tok-b'); // the event takes it
    await Promise.resolve();
    await Promise.resolve();
    expect(taps.map((t) => t.token)).toEqual(['tok-a', 'tok-b']);
    active!('active'); // nothing more waiting
    await Promise.resolve();
    await Promise.resolve();
    expect(taps).toHaveLength(2);
    stop();
    expect(active).toBeNull();
    expect(native.listenerCount('reminderTap')).toBe(0);
  });

  test('iOS: nothing is ever handed over natively', async () => {
    const native = createFakeDriveSense({ platform: 'ios' });
    const appState = { addEventListener: () => ({ remove: () => {} }) };
    const taps: ReminderTap[] = [];
    const stop = watchReminderTapIntents((t) => taps.push(t), native, appState);
    await Promise.resolve();
    await Promise.resolve();
    expect(taps).toEqual([]);
    stop();
  });

  test('a native module that is missing (Expo Go) yields nothing and throws nothing', async () => {
    const native = {
      takeReminderTap: jest.fn(async () => {
        throw new Error('not available');
      }),
      addListener: jest.fn(() => ({ remove: () => {} })),
    };
    const stop = watchReminderTapIntents(() => {
      throw new Error('never');
    }, native, { addEventListener: () => ({ remove: () => {} }) });
    await Promise.resolve();
    await Promise.resolve();
    stop();
    expect(native.takeReminderTap).toHaveBeenCalledTimes(1);
  });
});
