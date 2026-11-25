/**
 * Notification settings round-trip through `get_notification_prefs` / `set_notification_prefs`:
 * what the server says is shown, a change sends only that field (plus the zone), and the answer
 * is what the screen shows next. A failed save puts the switch back and says so.
 */
import { screen, waitFor } from '@testing-library/react-native';

import { RpcError } from '@/data/server/rpc';
import { COMMUTE_HEADS_UP_KEY } from '@/features/weather/commuteSetting';
import { answerRpc, appWorld, clearQueryClients, fakeAppState, tap } from '@/features/permissions/__fixtures__/harness';

import { prefsArgs, type NotificationPrefs } from '../api';
import { notificationSettingsCopy as copy } from '../copy';
import { ARE_YOU_DRIVING_KEY, DRIVE_RECAPS_KEY, DRIVE_STARTED_KEY } from '../localSwitches';
import { NotificationSettingsScreen, type CommuteHeadsUpPort, type OsNotificationsPort } from '../NotificationSettingsScreen';
import { QUIET_HOURS_KEY } from '../quietHours';
import { syncNotificationPrefs, TZ_SENT_KEY } from '../sync';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ back: jest.fn(), canGoBack: () => true }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

const DEFAULTS: NotificationPrefs = {
  weekly_recap: true,
  social: true,
  quiet_enabled: true,
  quiet_start: '22:00',
  quiet_end: '07:00',
  tz: null,
};

const os = (access: 'granted' | 'denied' = 'granted'): OsNotificationsPort => ({
  read: async () => access,
  request: async () => 'granted',
  openSettings: jest.fn(async () => {}),
});

const headsUpPort = (): CommuteHeadsUpPort & { cancel: jest.Mock; replan: jest.Mock } => ({ cancel: jest.fn(async () => {}), replan: jest.fn() });

async function show(access: 'granted' | 'denied' = 'granted', opts: { headsUp?: CommuteHeadsUpPort; settings?: Record<string, unknown> } = {}) {
  const w = await appWorld({ settings: opts.settings });
  await w.render(
    <NotificationSettingsScreen deps={{ os: os(access), appState: fakeAppState(), zone: () => 'America/Chicago', headsUp: opts.headsUp ?? headsUpPort() }} />
  );
  return w;
}

beforeEach(() => mockRpc.mockReset());
afterEach(() => clearQueryClients());

it('sends only the changed field and the zone', () => {
  expect(prefsArgs({ social: false }, 'America/Chicago')).toEqual({ p_social: false, p_tz: 'America/Chicago' });
  expect(prefsArgs({ quiet_start: '21:00', social: undefined }, null)).toEqual({ p_quiet_start: '21:00' });
});

it('shows the server’s prefs, saves a switch, and shows what the server answered', async () => {
  let stored = { ...DEFAULTS };
  answerRpc(mockRpc, {
    get_notification_prefs: () => stored,
    set_notification_prefs: (args) => {
      stored = { ...stored, weekly_recap: args?.p_weekly_recap as boolean, tz: args?.p_tz as string };
      return stored;
    },
  });
  await show();
  const recap = await screen.findByTestId('prefs-weekly_recap');
  expect(recap.props.value).toBe(true);
  expect(screen.getByLabelText(`${copy.quiet.title}, ${copy.quiet.on('10 PM', '7 AM')}`)).toBeOnTheScreen();

  await tap('prefs-weekly_recap');
  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith('set_notification_prefs', { p_weekly_recap: false, p_tz: 'America/Chicago' })
  );
  await waitFor(() => expect(screen.getByTestId('prefs-weekly_recap').props.value).toBe(false));
  expect(screen.getByLabelText(`${copy.kinds.weekly_recap.title}, ${copy.kinds.weekly_recap.off}`)).toBeOnTheScreen();
  // one switch for both: the weekly recap and the monthly Wrapped push
  expect(screen.getByLabelText('Weekly and monthly recaps, No weekly recap or monthly Wrapped.')).toBeOnTheScreen();
});

it('steps quiet hours by the hour', async () => {
  answerRpc(mockRpc, {
    get_notification_prefs: DEFAULTS,
    set_notification_prefs: (args) => ({ ...DEFAULTS, quiet_start: args?.p_quiet_start }),
  });
  await show();
  await tap('prefs-quiet-start-later');
  await waitFor(() =>
    expect(mockRpc).toHaveBeenCalledWith('set_notification_prefs', { p_quiet_start: '23:00', p_tz: 'America/Chicago' })
  );
  await waitFor(() => expect(screen.getByTestId('prefs-quiet-start-value')).toHaveTextContent('11 PM'));
});

it('a failed save puts the switch back and says so', async () => {
  answerRpc(mockRpc, {
    get_notification_prefs: DEFAULTS,
    set_notification_prefs: new RpcError('quiet hours must be HH:MM', '22023'),
  });
  await show();
  await tap('prefs-social');
  expect(await screen.findByTestId('prefs-save-error')).toBeOnTheScreen();
  expect(screen.getByTestId('prefs-social').props.value).toBe(true);
});

it('offers the weekly recap and friend requests, and no league switch', async () => {
  answerRpc(mockRpc, { get_notification_prefs: DEFAULTS });
  await show();
  expect(await screen.findByTestId('prefs-weekly_recap')).toBeOnTheScreen();
  expect(screen.getByTestId('prefs-social')).toBeOnTheScreen();
  expect(screen.queryByTestId('prefs-leagues')).toBeNull();
  expect(screen.queryByText(/league/i)).toBeNull();
});

it('says when the phone itself has notifications off', async () => {
  answerRpc(mockRpc, { get_notification_prefs: DEFAULTS });
  await show('denied');
  expect(await screen.findByTestId('prefs-os-denied')).toBeOnTheScreen();
});

describe('the foreground zone sync', () => {
  it('sends the zone once per change, per account', async () => {
    const w = await appWorld();
    const save = jest.fn(async () => {});
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'America/Chicago', save })).toBe('saved');
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'America/Chicago', save })).toBe('unchanged');
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'America/Denver', save })).toBe('saved');
    expect(save.mock.calls).toEqual([['America/Chicago'], ['America/Denver']]);
    expect(await w.settings.get(TZ_SENT_KEY)).toEqual({ uid: 'me', tz: 'America/Denver' });
  });

  it('a failure is reported and tried again next time', async () => {
    const w = await appWorld();
    const onError = jest.fn();
    const fail = jest.fn(async () => Promise.reject(new Error('offline')));
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', save: fail, onError })).toBe('error');
    expect(onError).toHaveBeenCalled();
    expect(await w.settings.get(TZ_SENT_KEY)).toBeNull();
  });
});

describe('weather before your commute', () => {
  it('is on until switched off; off takes the heads-ups down, on plans them', async () => {
    answerRpc(mockRpc, { get_notification_prefs: DEFAULTS });
    const headsUp = headsUpPort();
    const w = await show('granted', { headsUp });
    const row = await screen.findByTestId('prefs-weather-commute');
    expect(row.props.value).toBe(true);
    expect(screen.getByLabelText(`${copy.commute.title}, ${copy.commute.on}`)).toBeOnTheScreen();

    await tap('prefs-weather-commute');
    await waitFor(async () => expect(await w.settings.get(COMMUTE_HEADS_UP_KEY)).toBe(false));
    await waitFor(() => expect(headsUp.cancel).toHaveBeenCalled());
    expect(screen.getByTestId('prefs-weather-commute').props.value).toBe(false);
    expect(screen.getByLabelText(`${copy.commute.title}, ${copy.commute.off}`)).toBeOnTheScreen();
    expect(headsUp.replan).not.toHaveBeenCalled();

    await tap('prefs-weather-commute');
    await waitFor(async () => expect(await w.settings.get(COMMUTE_HEADS_UP_KEY)).toBe(true));
    await waitFor(() => expect(headsUp.replan).toHaveBeenCalledTimes(1));
    // The server is never asked: the switch is this phone's own.
    expect(mockRpc).not.toHaveBeenCalledWith('set_notification_prefs', expect.anything());
  });

  it('shows as stored, without waiting for the server prefs', async () => {
    answerRpc(mockRpc, { get_notification_prefs: new RpcError('down', '500') });
    await show('granted', { settings: { [COMMUTE_HEADS_UP_KEY]: false } });
    expect((await screen.findByTestId('prefs-weather-commute')).props.value).toBe(false);
    expect(screen.queryByTestId('prefs-weekly_recap')).toBeNull();
  });

  it('this phone keeps a copy of the quiet hours, as loaded and as saved; a change plans the heads-ups again', async () => {
    let stored = { ...DEFAULTS };
    answerRpc(mockRpc, {
      get_notification_prefs: () => stored,
      set_notification_prefs: (args) => {
        stored = { ...stored, quiet_enabled: args?.p_quiet_enabled as boolean };
        return stored;
      },
    });
    const headsUp = headsUpPort();
    const w = await show('granted', { headsUp });
    await waitFor(async () => expect(await w.settings.get(QUIET_HOURS_KEY)).toEqual({ enabled: true, start: '22:00', end: '07:00' }));
    // The default was in force already: nothing to plan again.
    expect(headsUp.replan).not.toHaveBeenCalled();
    await tap('prefs-quiet-toggle');
    await waitFor(async () => expect(await w.settings.get(QUIET_HOURS_KEY)).toEqual({ enabled: false, start: '22:00', end: '07:00' }));
    await waitFor(() => expect(headsUp.replan).toHaveBeenCalledTimes(1));
  });

  it('prefs that differ from the copy held plan the heads-ups again as they load', async () => {
    answerRpc(mockRpc, { get_notification_prefs: { ...DEFAULTS, quiet_end: '08:00' } });
    const headsUp = headsUpPort();
    const w = await show('granted', { headsUp, settings: { [QUIET_HOURS_KEY]: { enabled: true, start: '22:00', end: '07:00' } } });
    await waitFor(async () => expect(await w.settings.get(QUIET_HOURS_KEY)).toEqual({ enabled: true, start: '22:00', end: '08:00' }));
    await waitFor(() => expect(headsUp.replan).toHaveBeenCalledTimes(1));
  });
});

describe('the zone sync and the quiet hours', () => {
  it('the server’s answer refreshes this phone’s copy', async () => {
    const w = await appWorld();
    const save = jest.fn(async () => ({ ...DEFAULTS, quiet_start: '23:00' }));
    await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', save, onQuietHours: jest.fn() });
    expect(await w.settings.get(QUIET_HOURS_KEY)).toEqual({ enabled: true, start: '23:00', end: '07:00' });
  });

  it('an answer of another shape leaves it', async () => {
    const w = await appWorld();
    await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', save: async () => null, onQuietHours: jest.fn() });
    expect(await w.settings.get(QUIET_HOURS_KEY)).toBeNull();
  });

  it('with no copy and the zone already sent, the prefs are read once to make it, and the heads-ups planned again', async () => {
    const w = await appWorld({ settings: { [TZ_SENT_KEY]: { uid: 'me', tz: 'UTC' } } });
    const save = jest.fn(async () => DEFAULTS);
    const read = jest.fn(async () => ({ ...DEFAULTS, quiet_start: '21:00', quiet_end: '08:00' }));
    const onQuietHours = jest.fn();
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', save, read, onQuietHours })).toBe('unchanged');
    expect(await w.settings.get(QUIET_HOURS_KEY)).toEqual({ enabled: true, start: '21:00', end: '08:00' });
    expect(onQuietHours).toHaveBeenCalledTimes(1);
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', save, read, onQuietHours })).toBe('unchanged');
    expect(read).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('the server’s own default read: stored, nothing to plan again', async () => {
    const w = await appWorld({ settings: { [TZ_SENT_KEY]: { uid: 'me', tz: 'UTC' } } });
    const onQuietHours = jest.fn();
    await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', read: async () => DEFAULTS, onQuietHours });
    expect(await w.settings.get(QUIET_HOURS_KEY)).toEqual({ enabled: true, start: '22:00', end: '07:00' });
    expect(onQuietHours).not.toHaveBeenCalled();
  });

  it('a read that fails is reported and tried again next time', async () => {
    const w = await appWorld({ settings: { [TZ_SENT_KEY]: { uid: 'me', tz: 'UTC' } } });
    const onError = jest.fn();
    expect(await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', read: async () => Promise.reject(new Error('offline')), onError })).toBe('error');
    expect(onError).toHaveBeenCalled();
    expect(await w.settings.get(QUIET_HOURS_KEY)).toBeNull();
  });

  it('a zone answer with new quiet hours plans the heads-ups again', async () => {
    const w = await appWorld();
    const onQuietHours = jest.fn();
    await syncNotificationPrefs('me', { db: w.db, zone: () => 'UTC', save: async () => ({ ...DEFAULTS, quiet_enabled: false }), onQuietHours });
    expect(onQuietHours).toHaveBeenCalledTimes(1);
  });
});

describe('this phone’s own notifications and "All notifications"', () => {
  const ALL_KINDS = { driveStarted: true, areYouDriving: true };

  async function showAll(opts: { settings?: Record<string, unknown>; kinds?: { driveStarted: boolean; areYouDriving: boolean } } = {}) {
    const headsUp = headsUpPort();
    const driveStartNote = jest.fn(async (on: boolean) => {
      await w.settings.set(DRIVE_STARTED_KEY, on);
    });
    const w = await appWorld({ settings: opts.settings });
    await w.render(
      <NotificationSettingsScreen
        deps={{
          os: os(),
          appState: fakeAppState(),
          zone: () => 'America/Chicago',
          headsUp,
          kinds: opts.kinds ?? ALL_KINDS,
          driveStartNote,
        }}
      />
    );
    return { w, headsUp, driveStartNote };
  }

  const serverAnswering = () => {
    let stored = { ...DEFAULTS };
    answerRpc(mockRpc, {
      get_notification_prefs: () => stored,
      set_notification_prefs: (args) => {
        stored = {
          ...stored,
          ...(args?.p_weekly_recap !== undefined ? { weekly_recap: args.p_weekly_recap as boolean } : {}),
          ...(args?.p_social !== undefined ? { social: args.p_social as boolean } : {}),
        };
        return stored;
      },
    });
  };

  it('lists one switch per notification, this phone’s own first, each on until switched off', async () => {
    serverAnswering();
    await showAll();
    for (const id of ['prefs-drive-started', 'prefs-drive-recaps', 'prefs-are-you-driving', 'prefs-weather-commute']) {
      expect((await screen.findByTestId(id)).props.value).toBe(true);
    }
    expect(await screen.findByTestId('prefs-weekly_recap')).toBeOnTheScreen();
    expect(screen.getByLabelText(`${copy.driveStarted.title}, ${copy.driveStarted.on}`)).toBeOnTheScreen();
    expect(screen.getByLabelText(`${copy.driveRecaps.title}, ${copy.driveRecaps.on}`)).toBeOnTheScreen();
    expect(screen.getByLabelText(`${copy.areYouDriving.title}, ${copy.areYouDriving.on}`)).toBeOnTheScreen();
  });

  it('offers "Drive started" only with automatic drives and "Are you driving?" only with the car link', async () => {
    serverAnswering();
    await showAll({ kinds: { driveStarted: false, areYouDriving: false } });
    expect(await screen.findByTestId('prefs-drive-recaps')).toBeOnTheScreen();
    expect(screen.queryByTestId('prefs-drive-started')).toBeNull();
    expect(screen.queryByTestId('prefs-are-you-driving')).toBeNull();
  });

  it('"Drive started" goes to native through its setter; the others are stored on the phone and never sent', async () => {
    serverAnswering();
    const { w, driveStartNote } = await showAll();
    await tap('prefs-drive-started');
    await waitFor(() => expect(driveStartNote).toHaveBeenCalledWith(false));
    expect(screen.getByLabelText(`${copy.driveStarted.title}, ${copy.driveStarted.off}`)).toBeOnTheScreen();

    await tap('prefs-drive-recaps');
    await waitFor(async () => expect(await w.settings.get(DRIVE_RECAPS_KEY)).toBe(false));
    expect(screen.getByLabelText(`${copy.driveRecaps.title}, ${copy.driveRecaps.off}`)).toBeOnTheScreen();

    await tap('prefs-are-you-driving');
    await waitFor(async () => expect(await w.settings.get(ARE_YOU_DRIVING_KEY)).toBe(false));
    expect(screen.getByLabelText(`${copy.areYouDriving.title}, ${copy.areYouDriving.off}`)).toBeOnTheScreen();
    expect(mockRpc).not.toHaveBeenCalledWith('set_notification_prefs', expect.anything());
  });

  it('a "Drive started" change that fails goes back and says so', async () => {
    serverAnswering();
    const w = await appWorld();
    await w.render(
      <NotificationSettingsScreen
        deps={{
          os: os(),
          appState: fakeAppState(),
          zone: () => 'America/Chicago',
          headsUp: headsUpPort(),
          kinds: ALL_KINDS,
          driveStartNote: async () => Promise.reject(new Error('disk full')),
        }}
      />
    );
    await tap('prefs-drive-started');
    await waitFor(() => expect(screen.getByTestId('prefs-drive-started').props.value).toBe(true));
    expect(screen.getByTestId('prefs-save-error')).toBeOnTheScreen();
  });

  it('shows the phone’s own switches as stored, without waiting for the server', async () => {
    answerRpc(mockRpc, { get_notification_prefs: new RpcError('down', '500') });
    await showAll({ settings: { [DRIVE_RECAPS_KEY]: false } });
    expect((await screen.findByTestId('prefs-drive-recaps')).props.value).toBe(false);
    expect(screen.getByTestId('prefs-drive-started').props.value).toBe(true);
    // It needs the server's switches to say whether all are on.
    expect(screen.queryByTestId('prefs-all')).toBeNull();
  });

  it('"All notifications" is on while every switch is; off turns every one off, on turns every one on', async () => {
    serverAnswering();
    const { w, headsUp, driveStartNote } = await showAll();
    const all = await screen.findByTestId('prefs-all');
    expect(all.props.value).toBe(true);
    expect(screen.getByLabelText(`${copy.all.title}, ${copy.all.on}`)).toBeOnTheScreen();

    await tap('prefs-all');
    await waitFor(() => expect(screen.getByTestId('prefs-all').props.value).toBe(false));
    expect(mockRpc).toHaveBeenCalledWith('set_notification_prefs', { p_weekly_recap: false, p_social: false, p_tz: 'America/Chicago' });
    expect(driveStartNote).toHaveBeenCalledWith(false);
    expect(await w.settings.get(DRIVE_RECAPS_KEY)).toBe(false);
    expect(await w.settings.get(ARE_YOU_DRIVING_KEY)).toBe(false);
    expect(await w.settings.get(COMMUTE_HEADS_UP_KEY)).toBe(false);
    await waitFor(() => expect(headsUp.cancel).toHaveBeenCalled());
    for (const id of ['prefs-drive-started', 'prefs-drive-recaps', 'prefs-are-you-driving', 'prefs-weather-commute', 'prefs-weekly_recap', 'prefs-social']) {
      expect(screen.getByTestId(id).props.value).toBe(false);
    }
    expect(screen.getByLabelText(`${copy.all.title}, ${copy.all.off}`)).toBeOnTheScreen();

    await tap('prefs-all');
    await waitFor(() => expect(screen.getByTestId('prefs-all').props.value).toBe(true));
    expect(mockRpc).toHaveBeenCalledWith('set_notification_prefs', { p_weekly_recap: true, p_social: true, p_tz: 'America/Chicago' });
    expect(driveStartNote).toHaveBeenLastCalledWith(true);
    expect(await w.settings.get(COMMUTE_HEADS_UP_KEY)).toBe(true);
    await waitFor(() => expect(headsUp.replan).toHaveBeenCalled());
  });

  it('with some off it reads off and says so; turning it on sends only what was off', async () => {
    serverAnswering();
    const { driveStartNote } = await showAll({ settings: { [DRIVE_RECAPS_KEY]: false } });
    expect((await screen.findByTestId('prefs-all')).props.value).toBe(false);
    expect(screen.getByLabelText(`${copy.all.title}, ${copy.all.some}`)).toBeOnTheScreen();

    await tap('prefs-all');
    await waitFor(() => expect(screen.getByTestId('prefs-all').props.value).toBe(true));
    expect(screen.getByTestId('prefs-drive-recaps').props.value).toBe(true);
    // The server's switches were already on: nothing to send; "Drive started" was on too.
    expect(mockRpc).not.toHaveBeenCalledWith('set_notification_prefs', expect.anything());
    expect(driveStartNote).not.toHaveBeenCalled();
  });

  it('a server that refuses leaves every switch as it was', async () => {
    answerRpc(mockRpc, {
      get_notification_prefs: DEFAULTS,
      set_notification_prefs: new RpcError('down', '500'),
    });
    const { w, driveStartNote } = await showAll();
    await tap('prefs-all');
    expect(await screen.findByTestId('prefs-save-error')).toBeOnTheScreen();
    expect(screen.getByTestId('prefs-all').props.value).toBe(true);
    expect(driveStartNote).not.toHaveBeenCalled();
    expect(await w.settings.get(DRIVE_RECAPS_KEY)).toBeNull();
  });
});
