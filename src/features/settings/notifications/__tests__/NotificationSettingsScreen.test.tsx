/**
 * Notification settings round-trip through `get_notification_prefs` / `set_notification_prefs`:
 * what the server says is shown, a change sends only that field (plus the zone), and the answer
 * is what the screen shows next. A failed save puts the switch back and says so.
 */
import { screen, waitFor } from '@testing-library/react-native';

import { RpcError } from '@/data/server/rpc';
import { answerRpc, appWorld, clearQueryClients, fakeAppState, tap } from '@/features/permissions/__fixtures__/harness';

import { prefsArgs, type NotificationPrefs } from '../api';
import { notificationSettingsCopy as copy } from '../copy';
import { NotificationSettingsScreen, type OsNotificationsPort } from '../NotificationSettingsScreen';
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

async function show(access: 'granted' | 'denied' = 'granted') {
  const w = await appWorld();
  await w.render(<NotificationSettingsScreen deps={{ os: os(access), appState: fakeAppState(), zone: () => 'America/Chicago' }} />);
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
