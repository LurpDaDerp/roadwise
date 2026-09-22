import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { readPromptHistory, type NotificationAccess } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db/settings';
import type { Db } from '@/data/db/driver';
import { registerDriveStateSource } from '@/data/devices/driveStateStore';
import { createTestDb, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { routerDouble } from '@/features/trips/__fixtures__/render';
import {
  clockLabel,
  liveCategories,
  NotificationSettingsScreen,
  notificationSettingsCopy as copy,
  stepHour,
  type OsNotificationsPort,
} from '@/features/settings/notifications';
import { buildCatalog, countsTowardDailyCap } from '@/notifications/catalog';
import { PREFS_CACHE_KEY } from '@/notifications/keys';
import { ThemeProvider } from '@/ui/theme';

import { createFakePrefsServer, type FakePrefsServer } from '../__fixtures__/fakePrefsServer';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const UID = '11111111-1111-4111-8111-111111111111';
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '11111111-1111-4111-8111-111111111111' } } }),
}));

const clients: QueryClient[] = [];
let releases: (() => void)[] = [];

afterEach(async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await cleanup();
  for (const c of clients) c.clear();
  clients.length = 0;
  for (const r of releases) r();
  releases = [];
  jest.clearAllMocks();
});

function fakeAppState() {
  const listeners = new Set<(s: string) => void>();
  return {
    currentState: 'active',
    addEventListener(_t: 'change', l: (s: string) => void) {
      listeners.add(l);
      return { remove: () => listeners.delete(l) };
    },
    emit(s: string) {
      for (const l of [...listeners]) l(s);
    },
  };
}

function fakeOs(initial: NotificationAccess | null = 'granted') {
  const state: { access: NotificationAccess | null } = { access: initial };
  const os = {
    get access() {
      return state.access;
    },
    set access(v: NotificationAccess | null) {
      state.access = v;
    },
    read: jest.fn(async (): Promise<NotificationAccess | null> => state.access),
    request: jest.fn(async () => {
      state.access = 'granted';
      return 'granted' as NotificationAccess;
    }),
    openSettings: jest.fn(async () => undefined),
  };
  return os as typeof os & OsNotificationsPort;
}

interface Setup {
  rows?: Record<string, unknown>[];
  os?: ReturnType<typeof fakeOs>;
  catalog?: ReturnType<typeof buildCatalog>;
  server?: FakePrefsServer;
}

async function renderScreen(setup: Setup = {}) {
  const db: Db = await createTestDb();
  const server = setup.server ?? createFakePrefsServer(setup.rows ?? []);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  clients.push(client);
  const Data = wrapperFor(db, client, () => Date.parse('2026-09-22T21:00:00Z'));
  const appState = fakeAppState();
  const os = setup.os ?? fakeOs();
  await render(
    <ThemeProvider>
      <Data>
        <NotificationSettingsScreen
          deps={{
            client: server.client,
            zone: () => 'America/Los_Angeles',
            appConfig: { refresh: async () => undefined, appState },
            os,
            appState,
            catalog: setup.catalog,
          }}
        />
      </Data>
    </ThemeProvider>
  );
  return { db, server, os, appState };
}

const loaded = () => waitFor(() => expect(screen.getByTestId('prefs-categories')).toBeTruthy());

const toggle = async (testID: string, value: boolean) => {
  await act(async () => {
    fireEvent(screen.getByTestId(testID), 'valueChange', value);
  });
  await waitFor(() => expect(screen.getByTestId(testID).props.disabled ?? false).toBe(false));
};

const press = async (testID: string) => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
  await waitFor(() => expect(screen.getByTestId('prefs-quiet-toggle').props.disabled ?? false).toBe(false));
};

describe('helpers', () => {
  it('liveCategories: only the categories with a live type', () => {
    expect(liveCategories()).toEqual(['trip_summaries', 'recording', 'rewards']);
  });

  it('clockLabel', () => {
    expect(clockLabel('22:00')).toBe('10 PM');
    expect(clockLabel('00:00')).toBe('12 AM');
    expect(clockLabel('12:00')).toBe('12 PM');
    expect(clockLabel('06:30')).toBe('6:30 AM');
  });

  it('stepHour wraps and snaps a half hour to its whole hour', () => {
    expect(stepHour('22:00', 1)).toBe('23:00');
    expect(stepHour('23:00', 1)).toBe('00:00');
    expect(stepHour('00:00', -1)).toBe('23:00');
    expect(stepHour('06:30', -1)).toBe('06:00');
    expect(stepHour('06:30', 1)).toBe('07:00');
  });
});

describe('NotificationSettingsScreen', () => {
  it('renders only the live categories, on by default, with the config quiet hours', async () => {
    await renderScreen();
    await loaded();
    expect(screen.getByTestId('prefs-category-trip_summaries').props.value).toBe(true);
    expect(screen.getByTestId('prefs-category-recording').props.value).toBe(true);
    expect(screen.getByTestId('prefs-category-rewards').props.value).toBe(true);
    for (const c of ['family', 'safety', 'product', 'weekly_recap', 'crews']) {
      expect(screen.queryByTestId(`prefs-category-${c}`)).toBeNull();
    }
    expect(screen.getByTestId('prefs-quiet-toggle').props.value).toBe(true);
    expect(screen.getByTestId('prefs-quiet-start-value')).toHaveTextContent('10 PM');
    expect(screen.getByTestId('prefs-quiet-end-value')).toHaveTextContent('7 AM');
    expect(screen.getByTestId('prefs-zone')).toHaveTextContent('Times are in America/Los Angeles.');
  });

  it("each switch's hint states its consequence in either position", async () => {
    await renderScreen({ rows: [{ user_id: UID, categories: { recording: false } }] });
    await loaded();
    expect(screen.getByTestId('prefs-category-trip_summaries-hint')).toHaveTextContent(
      copy.categories.trip_summaries!.on
    );
    expect(screen.getByTestId('prefs-category-recording-hint')).toHaveTextContent(
      copy.categories.recording!.off
    );
    expect(screen.getByTestId('prefs-category-recording').props.accessibilityHint).toBe(
      copy.categories.recording!.off
    );
    expect(screen.getByTestId('prefs-quiet-toggle-hint')).toHaveTextContent(
      'Notifications due between 10 PM and 7 AM wait until 7 AM.'
    );
  });

  it('turning a category off writes the categories object only, with the change', async () => {
    const { server } = await renderScreen({ rows: [{ user_id: UID, categories: { recording: false } }] });
    await loaded();
    await toggle('prefs-category-trip_summaries', false);
    expect(server.writes().map((c) => c.values)).toEqual([
      { categories: { recording: false, trip_summaries: false } },
    ]);
    expect(screen.getByTestId('prefs-category-trip_summaries').props.value).toBe(false);
  });

  it('the first change with no row inserts it with user_id and only that field', async () => {
    const { server } = await renderScreen();
    await loaded();
    await toggle('prefs-quiet-toggle', false);
    expect(server.writes().map((c) => [c.op, c.values])).toEqual([
      ['update', { quiet_enabled: false }],
      ['insert', { user_id: UID, quiet_enabled: false }],
    ]);
    expect(server.rows[0]).toMatchObject({ quiet_start: null, quiet_end: null });
    expect(screen.queryByTestId('prefs-quiet-start-row')).toBeNull();
    expect(screen.getByTestId('prefs-quiet-toggle-hint')).toHaveTextContent(copy.quiet.off);
  });

  it('the hour pickers write an explicit value only for the field changed', async () => {
    const { server } = await renderScreen({ rows: [{ user_id: UID }] });
    await loaded();
    await press('prefs-quiet-start-later');
    expect(server.writes().map((c) => c.values)).toEqual([{ quiet_start: '23:00' }]);
    expect(screen.getByTestId('prefs-quiet-start-value')).toHaveTextContent('11 PM');
    expect(server.rows[0]).toMatchObject({ quiet_end: null, quiet_enabled: null });
    await press('prefs-quiet-end-earlier');
    expect(server.writes().map((c) => c.values)[1]).toEqual({ quiet_end: '06:00' });
  });

  it('the hour row is one adjustable element for a screen reader', async () => {
    const { server } = await renderScreen({ rows: [{ user_id: UID }] });
    await loaded();
    const row = screen.getByTestId('prefs-quiet-end-row');
    expect(row.props.accessibilityRole).toBe('adjustable');
    expect(row.props.accessibilityValue).toEqual({ text: '7 AM' });
    await act(async () => {
      fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    });
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.values).toEqual({ quiet_end: '08:00' });
  });

  it('start = end says quiet hours are off', async () => {
    await renderScreen({ rows: [{ user_id: UID, quiet_start: '07:00:00', quiet_end: '07:00:00' }] });
    await loaded();
    expect(screen.getByTestId('prefs-quiet-toggle-hint')).toHaveTextContent(copy.quiet.same);
  });

  it('writes the effective prefs to the cache on read and on save', async () => {
    const { db } = await renderScreen({ rows: [{ user_id: UID, quiet_end: '06:00:00' }] });
    await loaded();
    const settings = createSettingsRepo(db);
    await waitFor(async () =>
      expect(await settings.get(PREFS_CACHE_KEY)).toMatchObject({ quiet: { end: '06:00' } })
    );
    await toggle('prefs-category-recording', false);
    await waitFor(async () =>
      expect(await settings.get(PREFS_CACHE_KEY)).toMatchObject({ categories: { recording: false } })
    );
  });

  describe('the recording promise', () => {
    it('is shown only while this phone reports its drive state', async () => {
      await renderScreen();
      await loaded();
      expect(screen.queryByTestId('prefs-promise')).toBeNull();
      await act(async () => {
        releases.push(registerDriveStateSource());
      });
      expect(screen.getByTestId('prefs-promise')).toHaveTextContent(copy.promise, { exact: false });
    });
  });

  it('shows a Rewards switch whose hint states its consequence in either position (M5)', async () => {
    expect(copy.categories.rewards).toEqual({
      title: 'Rewards',
      on: 'Streaks, weekly goals, challenges, new classes and badges. At most one a day.',
      off: 'No notification. Streaks, goals, challenges, classes and badges still appear in your inbox.',
    });
    await renderScreen({ rows: [{ user_id: UID, categories: { rewards: false } }] });
    await loaded();
    expect(screen.getByText('Rewards')).toBeTruthy();
    expect(screen.getByTestId('prefs-category-rewards').props.value).toBe(false);
    expect(screen.getByTestId('prefs-category-rewards-hint')).toHaveTextContent(copy.categories.rewards!.off);
  });

  describe('the cap line', () => {
    it('shows while every live type counts toward the daily cap', async () => {
      await renderScreen();
      await loaded();
      expect(screen.getByTestId('prefs-cap')).toHaveTextContent(copy.cap);
    });

    it('stays true with the rewards types live: each of them counts toward the cap', () => {
      for (const t of ['streak_milestone', 'goal_completed', 'level_up', 'referral_qualified'] as const) {
        expect(countsTowardDailyCap(t)).toBe(true);
      }
    });

    it('is hidden when drive summaries are exempt (buildCatalog(false))', async () => {
      await renderScreen({ catalog: buildCatalog(false) });
      await loaded();
      expect(screen.queryByTestId('prefs-cap')).toBeNull();
    });
  });

  describe('errors', () => {
    it('a failed load shows an inline error, and Try again reloads', async () => {
      const server = createFakePrefsServer([{ user_id: UID, quiet_enabled: false }]);
      server.offline = true;
      await renderScreen({ server });
      await waitFor(() => expect(screen.getByTestId('prefs-load-error')).toBeTruthy());
      expect(screen.queryByTestId('prefs-categories')).toBeNull();
      server.offline = false;
      await act(async () => {
        fireEvent.press(screen.getByText(copy.retry));
      });
      await loaded();
      expect(screen.getByTestId('prefs-quiet-toggle').props.value).toBe(false);
      expect(screen.queryByTestId('prefs-load-error')).toBeNull();
    });

    it('a failed save reverts the switch, says so, and Try again re-sends it', async () => {
      const { server } = await renderScreen({ rows: [{ user_id: UID }] });
      await loaded();
      server.fail.update = { code: '500' };
      await toggle('prefs-category-recording', false);
      expect(screen.getByTestId('prefs-save-error')).toHaveTextContent(copy.saveError, { exact: false });
      expect(screen.getByTestId('prefs-category-recording').props.value).toBe(true);
      await act(async () => {
        fireEvent.press(screen.getByText(copy.retry));
      });
      await waitFor(() => expect(screen.queryByTestId('prefs-save-error')).toBeNull());
      expect(screen.getByTestId('prefs-category-recording').props.value).toBe(false);
      expect(server.rows[0]?.categories).toEqual({ recording: false });
    });

    it('switches are disabled while a save is in flight', async () => {
      const { server } = await renderScreen({ rows: [{ user_id: UID }] });
      await loaded();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const original = server.client.from.bind(server.client) as unknown as (t: string) => unknown;
      (server.client as { from: unknown }).from = (t: string) => {
        const b = original(t) as unknown as { then: (...a: unknown[]) => unknown };
        const then = b.then.bind(b);
        b.then = (...a: unknown[]) => gate.then(() => then(...a));
        return b;
      };
      await act(async () => {
        fireEvent(screen.getByTestId('prefs-category-recording'), 'valueChange', false);
      });
      expect(screen.getByTestId('prefs-category-trip_summaries').props.disabled).toBe(true);
      expect(screen.getByTestId('prefs-quiet-start-later').props.accessibilityState).toMatchObject({
        disabled: true,
      });
      await act(async () => release());
      await waitFor(() =>
        expect(screen.getByTestId('prefs-category-trip_summaries').props.disabled).toBe(false)
      );
    });
  });

  describe("the phone's own permission", () => {
    it('says when the OS has notifications off, and opens Settings', async () => {
      const os = fakeOs('denied');
      await renderScreen({ os });
      await waitFor(() => expect(screen.getByTestId('prefs-os-denied')).toHaveTextContent(copy.os.denied, { exact: false }));
      await act(async () => {
        fireEvent.press(screen.getByText(copy.os.openSettings));
      });
      expect(os.openSettings).toHaveBeenCalledTimes(1);
    });

    it('re-reads on a return to the foreground', async () => {
      const os = fakeOs('denied');
      const { appState } = await renderScreen({ os });
      await waitFor(() => expect(screen.getByTestId('prefs-os-denied')).toBeTruthy());
      os.access = 'granted';
      await act(async () => appState.emit('active'));
      await waitFor(() => expect(screen.queryByTestId('prefs-os-denied')).toBeNull());
    });

    it('offers to ask when it has never been asked, only on a tap', async () => {
      const os = fakeOs('undetermined');
      const { db } = await renderScreen({ os });
      await waitFor(() => expect(screen.getByTestId('prefs-os-undetermined')).toBeTruthy());
      expect(os.request).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.press(screen.getByText(copy.os.allow));
      });
      await waitFor(() => expect(screen.queryByTestId('prefs-os-undetermined')).toBeNull());
      expect(os.request).toHaveBeenCalledTimes(1);
      expect(await readPromptHistory(createSettingsRepo(db))).toEqual({
        notifications: Date.parse('2026-09-22T21:00:00Z'),
      });
    });

    it('granted shows no banner', async () => {
      await renderScreen();
      await loaded();
      expect(screen.queryByTestId('prefs-os-denied')).toBeNull();
      expect(screen.queryByTestId('prefs-os-undetermined')).toBeNull();
    });
  });

  it('has no primary action button', async () => {
    await renderScreen();
    await loaded();
    expect(screen.queryByText('Save')).toBeNull();
  });
});
