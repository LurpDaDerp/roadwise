// Type-only: it makes the compiler prove the app client fits the seam, and loads nothing.
import type { SupabaseClient } from '@supabase/supabase-js';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { createElement, type ReactNode } from 'react';

import {
  APP_CONFIG_KEY,
  APP_CONFIG_REFRESH_INTERVAL_MS,
  APP_CONFIG_SCHEMAS,
  APP_CONFIG_TABLE,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  createAppConfigRefresher,
  readConfig,
  readFlag,
  refreshAppConfig,
  useAppConfig,
  type AppConfigSupabase,
} from '@/data/config/appConfig';
import type { AppStateLike } from '@/data/foreground';
import { createQueryClient } from '@/data/queries/client';
import { DataProvider } from '@/data/queries/context';
import { legalState } from '@/features/auth/legal';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import type { Database } from '@/data/supabase/types';

const NOW = 1_790_000_000_000;

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

/** The one read `refreshAppConfig` makes, answered with `reply`, and every call recorded. */
function fakeSupabase(reply: { data: unknown; error: unknown }) {
  const calls: { table: string; columns: string }[] = [];
  const supabase: AppConfigSupabase = {
    from(table) {
      return {
        select(columns) {
          calls.push({ table, columns });
          return Promise.resolve(reply);
        },
      };
    },
  };
  return { supabase, calls };
}

/** What `supabase/seed.sql` holds, as PostgREST returns it. */
const SEEDED = [
  {
    key: 'feature_flags',
    value: { camera_beta: true, auto_detect: true, referral: false },
  },
  { key: 'min_app_version', value: '2.0.0' },
];

test('the app Supabase client satisfies the seam', () => {
  const asSeam = (client: SupabaseClient<Database>): AppConfigSupabase => client;
  expect(typeof asSeam).toBe('function');
});

test('with nothing fetched yet, every flag is its fallback', async () => {
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
  await expect(readFlag(db, 'auto_detect', true)).resolves.toBe(true);
  await expect(readFlag(db, 'camera_beta', false)).resolves.toBe(false);
  await expect(readFlag(db, 'referral', true)).resolves.toBe(true);
});

test('a refresh reads the public config once and the flags follow it', async () => {
  const { supabase, calls } = fakeSupabase({ data: SEEDED, error: null });

  await refreshAppConfig(supabase, db, () => NOW);

  expect(calls).toEqual([{ table: APP_CONFIG_TABLE, columns: 'key,value' }]);
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(true);
  await expect(readFlag(db, 'camera_beta', false)).resolves.toBe(true);
  await expect(readFlag(db, 'referral', true)).resolves.toBe(false);
  expect(await createSettingsRepo(db).get(APP_CONFIG_KEY)).toEqual({
    fetchedAt: NOW,
    flags: { camera_beta: true, auto_detect: true, referral: false },
    // Task 16: the other public rows ride in the same stored value, validated.
    values: { min_app_version: '2.0.0' },
  });
});

test('a flag the server does not send, or sends as something other than a boolean, falls back', async () => {
  const { supabase } = fakeSupabase({
    data: [
      {
        key: 'feature_flags',
        value: { auto_detect: 'yes', camera_beta: 1, unknown_flag: true },
      },
    ],
    error: null,
  });
  await refreshAppConfig(supabase, db, () => NOW);

  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
  await expect(readFlag(db, 'camera_beta', true)).resolves.toBe(true);
  await expect(readFlag(db, 'referral', false)).resolves.toBe(false);
  expect(await createSettingsRepo(db).get(APP_CONFIG_KEY)).toEqual({
    fetchedAt: NOW,
    flags: {},
    values: {},
  });
});

test('a flag switched off on the server is switched off here at the next refresh', async () => {
  await refreshAppConfig(fakeSupabase({ data: SEEDED, error: null }).supabase, db, () => NOW);
  await refreshAppConfig(
    fakeSupabase({
      data: [{ key: 'feature_flags', value: { auto_detect: false } }],
      error: null,
    }).supabase,
    db,
    () => NOW + 1
  );
  await expect(readFlag(db, 'auto_detect', true)).resolves.toBe(false);
  // Gone from the server's row: back to the caller's fallback, not the old value.
  await expect(readFlag(db, 'camera_beta', false)).resolves.toBe(false);
});

test('a failed request rejects and keeps what was stored', async () => {
  await refreshAppConfig(fakeSupabase({ data: SEEDED, error: null }).supabase, db, () => NOW);

  await expect(
    refreshAppConfig(
      fakeSupabase({ data: null, error: { message: 'Failed to fetch' } }).supabase,
      db,
      () => NOW + 1
    )
  ).rejects.toThrow('app config');

  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(true);
});

test('an answer that is not a list of rows rejects and keeps what was stored', async () => {
  await refreshAppConfig(fakeSupabase({ data: SEEDED, error: null }).supabase, db, () => NOW);
  await expect(
    refreshAppConfig(
      fakeSupabase({ data: { oops: true }, error: null }).supabase,
      db,
      () => NOW + 1
    )
  ).rejects.toThrow('app config');
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(true);
});

test('a stored value this build cannot read falls back rather than throwing', async () => {
  await db.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
    APP_CONFIG_KEY,
    '{not json',
  ]);
  await expect(readFlag(db, 'auto_detect', true)).resolves.toBe(true);
  await createSettingsRepo(db).set(APP_CONFIG_KEY, { flags: 'nope' });
  await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
});

// ---------------------------------------------------------------------------------------------
// Task 16: the typed onboarding config on the same `config.app` cache.
// ---------------------------------------------------------------------------------------------

/** Every public row as the migrations leave them (0005's flags, then 0006's and 0007's rows). */
const MIGRATED = [
  {
    key: 'feature_flags',
    value: {
      camera_beta: true,
      auto_detect: true,
      referral: true,
      guardian_invites: false,
    },
  },
  { key: 'min_app_version', value: '2.0.0' },
  { key: 'minor_consent_mode', value: 'guardian_link_optional' },
  {
    key: 'onboarding',
    value: { tos_version: '2026-09-21', privacy_version: '2026-09-21' },
  },
  { key: 'legal_urls', value: {} },
  { key: 'store_urls', value: {} },
  { key: 'oem_battery_guides', value: CONFIG_DEFAULTS.oem_battery_guides },
  {
    key: 'notification_defaults',
    value: {
      quiet_enabled: true,
      quiet_start: '22:00',
      quiet_end: '07:00',
      tz: 'America/Los_Angeles',
    },
  },
];

const refreshWith = (rows: unknown[], at = NOW) =>
  refreshAppConfig(fakeSupabase({ data: rows, error: null }).supabase, db, () => at);

describe('the compiled defaults', () => {
  test('equal the values the migrations write', () => {
    expect(CONFIG_DEFAULTS.flags).toEqual({
      auto_detect: true,
      camera_beta: true,
      referral: true,
      guardian_invites: false,
    });
    expect(CONFIG_DEFAULTS.min_app_version).toBe('2.0.0');
    expect(CONFIG_DEFAULTS.minor_consent_mode).toBe('guardian_link_optional');
    expect(CONFIG_DEFAULTS.onboarding).toEqual({
      tos_version: '2026-09-21',
      privacy_version: '2026-09-21',
    });
    expect(CONFIG_DEFAULTS.legal_urls).toEqual({});
    expect(CONFIG_DEFAULTS.store_urls).toEqual({});
    expect(CONFIG_DEFAULTS.notification_defaults).toEqual({
      quiet_enabled: true,
      quiet_start: '22:00',
      quiet_end: '07:00',
      tz: 'America/Los_Angeles',
    });
    expect(Object.keys(CONFIG_DEFAULTS.oem_battery_guides).sort()).toEqual([
      'default',
      'google',
      'oneplus',
      'samsung',
      'xiaomi',
    ]);
  });

  test('pass their own schemas, so a server echoing them reads back unchanged', () => {
    for (const key of CONFIG_KEYS) {
      expect(APP_CONFIG_SCHEMAS[key].safeParse(CONFIG_DEFAULTS[key]).success).toBe(true);
    }
  });

  test('every battery guide has a title and one to eight steps', () => {
    for (const guide of Object.values(CONFIG_DEFAULTS.oem_battery_guides)) {
      expect(guide?.title.length).toBeGreaterThan(0);
      expect(guide?.steps.length).toBeGreaterThanOrEqual(1);
      expect(guide?.steps.length).toBeLessThanOrEqual(8);
    }
  });

  test('leave the Terms and Privacy Policy unpublished (ruling I7)', () => {
    expect(legalState(CONFIG_DEFAULTS).published).toBe(false);
  });
});

describe('guardian_invites', () => {
  test('defaults to false, with or without a stored config', async () => {
    await expect(readFlag(db, 'guardian_invites')).resolves.toBe(false);
    await refreshWith([{ key: 'feature_flags', value: { auto_detect: true } }]);
    await expect(readFlag(db, 'guardian_invites')).resolves.toBe(false);
    expect((await readConfig(db)).flags.guardian_invites).toBe(false);
  });

  test('follows the server once it says true', async () => {
    await refreshWith([{ key: 'feature_flags', value: { guardian_invites: true } }]);
    await expect(readFlag(db, 'guardian_invites')).resolves.toBe(true);
    expect((await readConfig(db)).flags.guardian_invites).toBe(true);
  });

  test("a caller's explicit fallback still wins over the compiled default", async () => {
    await expect(readFlag(db, 'guardian_invites', true)).resolves.toBe(true);
    await expect(readFlag(db, 'auto_detect', false)).resolves.toBe(false);
  });
});

describe('readConfig', () => {
  test('with nothing fetched is the compiled defaults, marked as never fetched', async () => {
    expect(await readConfig(db)).toEqual({
      fetchedAt: null,
      ...CONFIG_DEFAULTS,
    });
  });

  test('reads back every migrated row after a refresh', async () => {
    await refreshWith(MIGRATED);
    expect(await readConfig(db)).toEqual({
      fetchedAt: NOW,
      ...CONFIG_DEFAULTS,
    });
  });

  test('carries a published Terms and Privacy Policy through to legalState', async () => {
    await refreshWith([
      ...MIGRATED.filter((r) => r.key !== 'legal_urls'),
      {
        key: 'legal_urls',
        value: {
          terms: 'https://roadwise.app/terms',
          privacy: 'https://roadwise.app/privacy',
        },
      },
    ]);
    const config = await readConfig(db);
    expect(config.legal_urls).toEqual({
      terms: 'https://roadwise.app/terms',
      privacy: 'https://roadwise.app/privacy',
    });
    expect(legalState(config)).toEqual({
      published: true,
      tos: { version: '2026-09-21', url: 'https://roadwise.app/terms' },
      privacy: { version: '2026-09-21', url: 'https://roadwise.app/privacy' },
    });
  });

  test('an invalid row falls back to its compiled default and nothing invalid is kept', async () => {
    await refreshWith([
      { key: 'min_app_version', value: 'two' },
      { key: 'minor_consent_mode', value: 'anything_goes' },
      {
        key: 'onboarding',
        value: { tos_version: '', privacy_version: '2026-10-01' },
      },
      {
        key: 'legal_urls',
        value: { terms: 'javascript:alert(1)', privacy: 'https://x.test/p' },
      },
      { key: 'store_urls', value: { ios: 42 } },
      {
        key: 'oem_battery_guides',
        value: { samsung: { title: 'Samsung', steps: ['One'] } },
      },
      {
        key: 'notification_defaults',
        value: {
          quiet_enabled: true,
          quiet_start: '25:00',
          quiet_end: '07:00',
          tz: 'UTC',
        },
      },
      {
        key: 'store_urls_typo',
        value: { ios: 'https://apps.apple.com/app/id1' },
      },
    ]);
    expect(await readConfig(db)).toEqual({
      fetchedAt: NOW,
      ...CONFIG_DEFAULTS,
    });
    expect(await createSettingsRepo(db).get(APP_CONFIG_KEY)).toEqual({
      fetchedAt: NOW,
      flags: {},
      values: {},
    });
  });

  test('valid rows are kept, with unknown keys inside them dropped', async () => {
    await refreshWith([
      { key: 'min_app_version', value: '2.3.0' },
      { key: 'minor_consent_mode', value: 'guardian_consent_required' },
      {
        key: 'store_urls',
        value: { ios: 'https://apps.apple.com/app/id1', web: 'https://x.test' },
      },
      {
        key: 'oem_battery_guides',
        value: {
          default: {
            title: 'Let RoadWise run',
            steps: ['Open Settings'],
            icon: 'battery',
          },
          nokia: { title: 'Nokia', steps: ['One'] },
        },
      },
      {
        key: 'notification_defaults',
        value: {
          quiet_enabled: false,
          quiet_start: '21:30',
          quiet_end: '06:45',
          tz: 'Europe/London',
          extra: 1,
        },
      },
    ]);
    const config = await readConfig(db);
    expect(config.min_app_version).toBe('2.3.0');
    expect(config.minor_consent_mode).toBe('guardian_consent_required');
    expect(config.store_urls).toEqual({
      ios: 'https://apps.apple.com/app/id1',
    });
    expect(config.oem_battery_guides).toEqual({
      default: { title: 'Let RoadWise run', steps: ['Open Settings'] },
    });
    expect(config.notification_defaults).toEqual({
      quiet_enabled: false,
      quiet_start: '21:30',
      quiet_end: '06:45',
      tz: 'Europe/London',
    });
  });

  test('a battery guide with more than eight steps is refused as a whole', async () => {
    const steps = Array.from({ length: 9 }, (_, i) => `Step ${i + 1}`);
    await refreshWith([
      {
        key: 'oem_battery_guides',
        value: { default: { title: 'Too long', steps } },
      },
    ]);
    expect((await readConfig(db)).oem_battery_guides).toEqual(CONFIG_DEFAULTS.oem_battery_guides);
  });

  test('a row the server stops sending goes back to its default at the next refresh', async () => {
    await refreshWith([{ key: 'min_app_version', value: '2.3.0' }]);
    await refreshWith([], NOW + 1);
    expect((await readConfig(db)).min_app_version).toBe('2.0.0');
  });

  test('a stored value from an older build, or tampered with, is re-checked on read', async () => {
    // D2's shape, with no `values` at all.
    await createSettingsRepo(db).set(APP_CONFIG_KEY, {
      fetchedAt: NOW,
      flags: { auto_detect: false },
    });
    let config = await readConfig(db);
    expect(config.flags.auto_detect).toBe(false);
    expect(config.min_app_version).toBe('2.0.0');

    await createSettingsRepo(db).set(APP_CONFIG_KEY, {
      fetchedAt: 'yesterday',
      flags: { auto_detect: 'no' },
      values: {
        min_app_version: 7,
        legal_urls: { terms: 'file:///etc/passwd' },
      },
    });
    config = await readConfig(db);
    expect(config).toEqual({ fetchedAt: null, ...CONFIG_DEFAULTS });
  });

  test('an unparseable stored value is the defaults, never a throw', async () => {
    await db.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
      APP_CONFIG_KEY,
      '{not json',
    ]);
    expect(await readConfig(db)).toEqual({
      fetchedAt: null,
      ...CONFIG_DEFAULTS,
    });
  });
});

describe('the refresh throttle', () => {
  const HOUR = APP_CONFIG_REFRESH_INTERVAL_MS;

  test('is one hour', () => {
    expect(HOUR).toBe(60 * 60_000);
  });

  test('refreshes when nothing was ever fetched, then not again within the hour', async () => {
    const refresher = createAppConfigRefresher();
    let clock = NOW;
    const refresh = jest.fn(() => refreshWith(MIGRATED, clock));

    await expect(refresher.maybeRefresh(db, refresh, () => clock)).resolves.toBe(true);
    clock += HOUR - 1;
    await expect(refresher.maybeRefresh(db, refresh, () => clock)).resolves.toBe(false);
    clock += 1;
    await expect(refresher.maybeRefresh(db, refresh, () => clock)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test('skips when the foreground job fetched less than an hour ago', async () => {
    await refreshWith(MIGRATED, NOW);
    const refresher = createAppConfigRefresher();
    const refresh = jest.fn(async () => {});
    await expect(refresher.maybeRefresh(db, refresh, () => NOW + HOUR - 1)).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  test('a failed attempt counts: no retry within the hour, and never a rejection', async () => {
    const refresher = createAppConfigRefresher();
    const refresh = jest.fn(async () => {
      throw new Error('offline');
    });
    await expect(refresher.maybeRefresh(db, refresh, () => NOW)).resolves.toBe(false);
    await expect(refresher.maybeRefresh(db, refresh, () => NOW + 60_000)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('two callers at once share one request', async () => {
    const refresher = createAppConfigRefresher();
    let release: () => void = () => {};
    const refresh = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const a = refresher.maybeRefresh(db, refresh, () => NOW);
    const b = refresher.maybeRefresh(db, refresh, () => NOW);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release();
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('a clock that went backwards is treated as due rather than stuck', async () => {
    await refreshWith(MIGRATED, NOW);
    const refresher = createAppConfigRefresher();
    const refresh = jest.fn(async () => {});
    await expect(refresher.maybeRefresh(db, refresh, () => NOW - HOUR)).resolves.toBe(true);
  });
});

describe('useAppConfig', () => {
  let client: QueryClient;

  /** An AppState whose transitions the test drives. */
  function fakeAppState(initial: string) {
    const listeners = new Set<(s: string) => void>();
    return {
      currentState: initial as string | null,
      addEventListener(_type: 'change', listener: (s: string) => void) {
        listeners.add(listener);
        return { remove: () => void listeners.delete(listener) };
      },
      set(s: string) {
        this.currentState = s;
        for (const l of [...listeners]) l(s);
      },
      count: () => listeners.size,
    } satisfies AppStateLike & { set(s: string): void; count(): number };
  }

  // A .ts file, so no JSX; DataProvider's props require `children`, hence the prop form.
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      // eslint-disable-next-line react/no-children-prop
      createElement(DataProvider, { db, children })
    );

  beforeEach(() => {
    client = createQueryClient();
  });
  afterEach(() => client.clear());

  test('reads the cache: defaults and not ready at first, then the stored config', async () => {
    await refreshWith(
      MIGRATED.map((r) => (r.key === 'min_app_version' ? { ...r, value: '2.1.0' } : r))
    );
    const appState = fakeAppState('background');
    const refresh = jest.fn(async () => {});
    const refresher = createAppConfigRefresher();
    const seen: { ready: boolean; config: unknown }[] = [];
    const { result } = await renderHook(
      () => {
        const value = useAppConfig({
          appState,
          refresh,
          refresher,
          now: () => NOW,
        });
        seen.push(value);
        return value;
      },
      { wrapper }
    );
    expect(seen[0]).toEqual({
      ready: false,
      config: { fetchedAt: null, ...CONFIG_DEFAULTS },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.config.min_app_version).toBe('2.1.0');
    expect(result.current.config.fetchedAt).toBe(NOW);
  });

  test('never refreshes while the app is not in front', async () => {
    const appState = fakeAppState('background');
    const refresh = jest.fn(async () => {});
    const refresher = createAppConfigRefresher();
    const { result } = await renderHook(
      () => useAppConfig({ appState, refresh, refresher, now: () => NOW }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => appState.set('inactive'));
    expect(refresh).not.toHaveBeenCalled();
  });

  test('refreshes in front when stale, and shows the new config', async () => {
    const appState = fakeAppState('active');
    const refresh = jest.fn(() =>
      refreshWith([
        {
          key: 'legal_urls',
          value: { terms: 'https://t.test/', privacy: 'https://p.test/' },
        },
      ])
    );
    const refresher = createAppConfigRefresher();
    const { result } = await renderHook(
      () => useAppConfig({ appState, refresh, refresher, now: () => NOW }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.config.legal_urls.terms).toBe('https://t.test/'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('coming to the front refreshes at most hourly, across remounts', async () => {
    const appState = fakeAppState('background');
    let clock = NOW;
    const refresher = createAppConfigRefresher();
    const refresh = jest.fn(() => refreshWith(MIGRATED, clock));
    const now = () => clock;
    const useHook = () => useAppConfig({ appState, refresh, refresher, now });

    const first = await renderHook(useHook, { wrapper });
    await act(async () => appState.set('active'));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await first.unmount();
    expect(appState.count()).toBe(0);

    const second = await renderHook(useHook, { wrapper });
    await act(async () => appState.set('background'));
    clock += 10 * 60_000;
    await act(async () => appState.set('active'));
    await waitFor(() => expect(second.result.current.ready).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => appState.set('background'));
    clock = NOW + APP_CONFIG_REFRESH_INTERVAL_MS;
    await act(async () => appState.set('active'));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await second.unmount();
  });

  test('a failed refresh keeps the cached config', async () => {
    const earlier = NOW - 2 * APP_CONFIG_REFRESH_INTERVAL_MS;
    await refreshWith(MIGRATED, earlier);
    const appState = fakeAppState('active');
    const refresh = jest.fn(async () => {
      throw new Error('offline');
    });
    const refresher = createAppConfigRefresher();
    const { result } = await renderHook(
      () => useAppConfig({ appState, refresh, refresher, now: () => NOW }),
      { wrapper }
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.config.fetchedAt).toBe(earlier);
  });
});
