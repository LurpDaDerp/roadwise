import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import { createElement, type ReactNode } from 'react';

import { APP_CONFIG_KEY, createAppConfigRefresher } from '@/data/config/appConfig';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { createQueryClient } from '@/data/queries/client';
import { DataProvider } from '@/data/queries/context';
import {
  compareVersions,
  readServerMinAppVersion,
  updateStatus,
  useUpdateStatus,
} from '@/features/auth/version';

describe('compareVersions', () => {
  test.each([
    ['2.0.0', '2.0.0', 0],
    ['2.0.0', '2.0.1', -1],
    ['2.0.1', '2.0.0', 1],
    ['2.9.0', '2.10.0', -1], // numeric, not lexical
    ['10.0.0', '9.99.99', 1],
    ['1.2.3', '1.3.0', -1],
  ])('%s vs %s → %d', (a, b, expected) => expect(compareVersions(a, b)).toBe(expected));

  test.each([['2.0'], ['v2.0.0'], ['2.0.0-beta'], [''], ['a.b.c']])(
    'an unreadable version (%s) compares as NaN, never as equal',
    (bad) => {
      expect(compareVersions(bad, '2.0.0')).toBeNaN();
      expect(compareVersions('2.0.0', bad)).toBeNaN();
    }
  );
});

describe('updateStatus', () => {
  test.each<[string | null | undefined, string | null | undefined, string]>([
    ['2.0.0', '2.1.0', 'required'],
    ['2.0.9', '2.1.0', 'required'],
    ['2.1.0', '2.1.0', 'ok'],
    ['2.2.0', '2.1.0', 'ok'],
    ['2.10.0', '2.9.0', 'ok'],
    // Unknown never forces an update: no minimum fetched, or a version that cannot be read.
    ['2.0.0', undefined, 'unknown'],
    ['2.0.0', null, 'unknown'],
    [null, '9.0.0', 'unknown'],
    [undefined, '9.0.0', 'unknown'],
    ['2.0.0', 'garbage', 'unknown'],
    ['dev', '9.0.0', 'unknown'],
  ])('app %s, minimum %s → %s', (app, min, expected) =>
    expect(updateStatus(app, min)).toBe(expected)
  );
});

describe('the stored minimum', () => {
  let db: Db;
  let client: QueryClient;

  beforeEach(async () => {
    db = await createSqlJsDb();
    await migrate(db);
    client = createQueryClient();
  });
  afterEach(() => client.clear());

  const store = (value: unknown) => createSettingsRepo(db).set(APP_CONFIG_KEY, value);

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      // eslint-disable-next-line react/no-children-prop
      createElement(DataProvider, { db, children })
    );

  const background = {
    currentState: 'background' as string | null,
    addEventListener: () => ({ remove: () => {} }),
  };

  function status(appVersion: string | null) {
    return renderHook(
      () =>
        useUpdateStatus({
          appVersion,
          config: {
            appState: background,
            refresh: async () => {},
            refresher: createAppConfigRefresher(),
          },
        }),
      { wrapper }
    );
  }

  test('reads only what the server sent and passed its schema', async () => {
    await expect(readServerMinAppVersion(db)).resolves.toBeUndefined();
    await store({ fetchedAt: 1, flags: {}, values: {} });
    await expect(readServerMinAppVersion(db)).resolves.toBeUndefined();
    await store({ fetchedAt: 1, flags: {}, values: { min_app_version: '2.x' } });
    await expect(readServerMinAppVersion(db)).resolves.toBeUndefined();
    await store({ flags: {}, values: { min_app_version: '3.0.0' } }); // never fetched
    await expect(readServerMinAppVersion(db)).resolves.toBeUndefined();
    await store({ fetchedAt: 1, flags: {}, values: { min_app_version: '3.0.0' } });
    await expect(readServerMinAppVersion(db)).resolves.toBe('3.0.0');
  });

  test('a never-fetched config is unknown, not the compiled default (T16 m3)', async () => {
    // The compiled default is 2.0.0; an app older than it must still not be told to update.
    const { result } = await status('1.0.0');
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBe('unknown');
  });

  test('a fetch without a min_app_version row is unknown, not the compiled default', async () => {
    await store({ fetchedAt: 1, flags: {}, values: {} });
    const { result } = await status('1.0.0');
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBe('unknown');
  });

  test('a fetched minimum above this build is required; at or below it is ok', async () => {
    await store({ fetchedAt: 1, flags: {}, values: { min_app_version: '2.1.0' } });
    const older = await status('2.0.0');
    await waitFor(() => expect(older.result.current).toBe('required'));
    client.clear();
    const same = await status('2.1.0');
    await waitFor(() => expect(same.result.current).toBe('ok'));
  });

  test('an unreadable app version is unknown', async () => {
    await store({ fetchedAt: 1, flags: {}, values: { min_app_version: '9.0.0' } });
    const { result } = await status(null);
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toBe('unknown');
  });
});
