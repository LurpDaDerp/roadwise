// Type-only: it makes the compiler prove the app client fits the seam, and loads nothing.
import type { SupabaseClient } from '@supabase/supabase-js';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { createElement, type ReactNode } from 'react';

import {
  APP_CONFIG_KEY,
  AppConfigRefreshRefused,
  APP_CONFIG_REFRESH_INTERVAL_MS,
  APP_CONFIG_SCHEMAS,
  APP_CONFIG_TABLE,
  CONFIG_DEFAULTS,
  CONFIG_KEYS,
  createAppConfigRefresher,
  readConfig,
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

/** The public row `0001_core.sql` seeds, as PostgREST returns it. */
const SEEDED = [{ key: 'min_app_version', value: '2.0.0' }];

test('the app Supabase client satisfies the seam', () => {
  const asSeam = (client: SupabaseClient<Database>): AppConfigSupabase => client;
  expect(typeof asSeam).toBe('function');
});

test('a refresh reads the public config once and stores the rows it knows', async () => {
  // A row this build does not read (an older server's `feature_flags`) is ignored.
  const { supabase, calls } = fakeSupabase({ data: [...SEEDED, { key: 'feature_flags', value: { auto_detect: true } }], error: null });

  await refreshAppConfig(supabase, db, () => NOW);

  expect(calls).toEqual([{ table: APP_CONFIG_TABLE, columns: 'key,value' }]);
  expect(await createSettingsRepo(db).get(APP_CONFIG_KEY)).toEqual({
    fetchedAt: NOW,
    values: { min_app_version: '2.0.0' },
  });
});

const NEWER = [{ key: 'min_app_version', value: '3.1.0' }];

test('a failed request rejects and keeps what was stored', async () => {
  await refreshAppConfig(fakeSupabase({ data: NEWER, error: null }).supabase, db, () => NOW);

  await expect(
    refreshAppConfig(
      fakeSupabase({ data: null, error: { message: 'Failed to fetch' } }).supabase,
      db,
      () => NOW + 1
    )
  ).rejects.toThrow('app config');

  expect((await readConfig(db)).min_app_version).toBe('3.1.0');
});

test('an answer that is not a list of rows rejects and keeps what was stored', async () => {
  await refreshAppConfig(fakeSupabase({ data: NEWER, error: null }).supabase, db, () => NOW);
  await expect(
    refreshAppConfig(
      fakeSupabase({ data: { oops: true }, error: null }).supabase,
      db,
      () => NOW + 1
    )
  ).rejects.toThrow('app config');
  expect((await readConfig(db)).min_app_version).toBe('3.1.0');
});

// ---------------------------------------------------------------------------------------------
// The typed rows on the `config.app` cache.
// ---------------------------------------------------------------------------------------------

/** Every row this build reads, at its default (the seed itself sets `min_app_version` only). */
const MIGRATED = [
  ...SEEDED,
  {
    key: 'onboarding',
    value: { tos_version: '2026-09-21', privacy_version: '2026-09-21' },
  },
  { key: 'legal_urls', value: {} },
  { key: 'store_urls', value: {} },
];

const refreshWith = (rows: unknown[], at = NOW) =>
  refreshAppConfig(fakeSupabase({ data: rows, error: null }).supabase, db, () => at);

describe('the compiled defaults', () => {
  test('match the seed', () => {
    expect(CONFIG_DEFAULTS).toEqual({
      min_app_version: '2.0.0',
      onboarding: { tos_version: '2026-09-21', privacy_version: '2026-09-21' },
      legal_urls: {},
      store_urls: {},
    });
  });

  test('pass their own schemas, so a server echoing them reads back unchanged', () => {
    for (const key of CONFIG_KEYS) {
      expect(APP_CONFIG_SCHEMAS[key].safeParse(CONFIG_DEFAULTS[key]).success).toBe(true);
    }
  });

  test('leave the Terms and Privacy Policy unpublished (ruling I7)', () => {
    expect(legalState(CONFIG_DEFAULTS).published).toBe(false);
  });
});

describe('readConfig', () => {
  test('with nothing fetched is the compiled defaults, marked as never fetched', async () => {
    expect(await readConfig(db)).toEqual({
      fetchedAt: null,
      ...CONFIG_DEFAULTS,
    });
  });

  test('reads back every row after a refresh', async () => {
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
      values: {},
    });
  });

  test('valid rows are kept, with unknown keys inside them dropped', async () => {
    await refreshWith([
      { key: 'min_app_version', value: '3.3.0' },
      {
        key: 'store_urls',
        value: { ios: 'https://apps.apple.com/app/id1', web: 'https://x.test' },
      },
    ]);
    const config = await readConfig(db);
    expect(config.min_app_version).toBe('3.3.0');
    expect(config.store_urls).toEqual({
      ios: 'https://apps.apple.com/app/id1',
    });
  });

  test('a row the server stops sending goes back to its default at the next refresh', async () => {
    await refreshWith([{ key: 'min_app_version', value: '3.3.0' }]);
    await refreshWith([], NOW + 1);
    expect((await readConfig(db)).min_app_version).toBe('2.0.0');
  });

  test('a stored value from an older build, or tampered with, is re-checked on read', async () => {
    // An older build's shape: flags, and no `values` at all.
    await createSettingsRepo(db).set(APP_CONFIG_KEY, {
      fetchedAt: NOW,
      flags: { auto_detect: false },
    });
    let config = await readConfig(db);
    expect(config).toEqual({ fetchedAt: NOW, ...CONFIG_DEFAULTS });

    await createSettingsRepo(db).set(APP_CONFIG_KEY, {
      fetchedAt: 'yesterday',
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

describe('refreshAppConfig dedupe (review m2)', () => {
  test('two refreshes of one database at once make one request', async () => {
    let answer: (v: { data: unknown; error: unknown }) => void = () => {};
    let requests = 0;
    const supabase: AppConfigSupabase = {
      from: () => ({
        select: () => {
          requests += 1;
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      }),
    };
    const daily = refreshAppConfig(supabase, db, () => NOW);
    const hourly = refreshAppConfig(supabase, db, () => NOW);
    answer({ data: MIGRATED, error: null });
    await Promise.all([daily, hourly]);
    expect(requests).toBe(1);
    // Once it has settled, the next refresh is a new request.
    const next = refreshAppConfig(supabase, db, () => NOW + 1);
    answer({ data: MIGRATED, error: null });
    await next;
    expect(requests).toBe(2);
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

  test('a refusal (booting, mid-drive) is not stamped: the next foreground tries again', async () => {
    const refresher = createAppConfigRefresher();
    const refresh = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new AppConfigRefreshRefused('app config: no runtime yet'))
      .mockRejectedValueOnce(new AppConfigRefreshRefused('app config: a drive is under way'))
      .mockImplementation(() => refreshWith(MIGRATED, NOW + 2));
    await expect(refresher.maybeRefresh(db, refresh, () => NOW)).resolves.toBe(false);
    await expect(refresher.maybeRefresh(db, refresh, () => NOW + 1)).resolves.toBe(false);
    await expect(refresher.maybeRefresh(db, refresh, () => NOW + 2)).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(3);
    // …and the refresh that ran is stamped as usual.
    await expect(refresher.maybeRefresh(db, refresh, () => NOW + 3)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(3);
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
  /**
   * One `now` for every render. The hook's refresh effect depends on `now`, so an inline `() => NOW` is a
   * new function each render: the query's own re-render then re-ran the effect and made a second attempt,
   * which after a refusal (never stamped) called `refresh` again. Whether that re-render landed before
   * `waitFor`'s first check depended on scheduling, so "called once" failed under load (the full-suite flake,
   * caught as `Received number of calls: 2`). With a stable `now` the effect runs once per mount.
   */
  const fixedNow = () => NOW;

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
          now: fixedNow,
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
      () => useAppConfig({ appState, refresh, refresher, now: fixedNow }),
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
      () => useAppConfig({ appState, refresh, refresher, now: fixedNow }),
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

  test('a config written by another path (the daily job) shows in a mounted screen', async () => {
    const appState = fakeAppState('background');
    const refresh = jest.fn(async () => {});
    const refresher = createAppConfigRefresher();
    const { result } = await renderHook(
      () => useAppConfig({ appState, refresh, refresher, now: fixedNow }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.config.legal_urls).toEqual({});
    await act(async () => {
      await refreshWith([
        { key: 'legal_urls', value: { terms: 'https://t.test/', privacy: 'https://p.test/' } },
      ]);
    });
    await waitFor(() => expect(result.current.config.legal_urls.terms).toBe('https://t.test/'));
    expect(refresh).not.toHaveBeenCalled();
  });

  test('refused at first launch, it retries at the next return to the front', async () => {
    const appState = fakeAppState('active');
    const refresh = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new AppConfigRefreshRefused('app config: no runtime yet'))
      .mockImplementation(() =>
        refreshWith([
          { key: 'legal_urls', value: { terms: 'https://t.test/', privacy: 'https://p.test/' } },
        ])
      );
    const refresher = createAppConfigRefresher();
    const { result } = await renderHook(
      () => useAppConfig({ appState, refresh, refresher, now: fixedNow }),
      { wrapper }
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await act(async () => appState.set('background'));
    await act(async () => appState.set('active'));
    await waitFor(() => expect(result.current.config.legal_urls.terms).toBe('https://t.test/'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test('a re-render makes no second attempt: the refresh effect runs once per mount', async () => {
    const appState = fakeAppState('active');
    const refresh = jest
      .fn<Promise<void>, []>()
      .mockRejectedValue(new AppConfigRefreshRefused('app config: no runtime yet'));
    const refresher = createAppConfigRefresher();
    const { result, rerender } = await renderHook(
      () => useAppConfig({ appState, refresh, refresher, now: fixedNow }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await rerender({});
    });
    expect(refresh).toHaveBeenCalledTimes(1);
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
      () => useAppConfig({ appState, refresh, refresher, now: fixedNow }),
      { wrapper }
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.config.fetchedAt).toBe(earlier);
  });
});
