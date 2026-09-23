/**
 * The referral harness: a real sql.js database behind the data provider (the app config and the
 * referral cache live in its settings), a real `QueryClient`, the theme, and a server double for
 * the three referral RPCs that behaves like 0011 (a code is created once; using a code turns
 * `canRedeem` off and `myCode` to pending). Suites mock `expo-router`, the session and the
 * Supabase client themselves (Jest hoists `jest.mock` per file).
 */
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { APP_CONFIG_KEY, type StoredAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { testQueryClient } from '@/features/inbox/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import { ReferralError, type MyReferrals, type ReferralApi, type ReferralErrorCode } from '../api';
import { writeCachedReferrals } from '../useReferrals';

export const UID = '00000000-0000-4000-8000-00000000000a';
export const NOW = Date.parse('2026-09-23T12:00:00Z');
export const CODE = 'ABCD2345';

export function referrals(over: Partial<MyReferrals> = {}): MyReferrals {
  return {
    code: CODE,
    joined: 0,
    qualified: 0,
    rewardedThisYear: 0,
    cap: 20,
    canRedeem: false,
    myCode: 'none',
    ...over,
  };
}

type Call = 'code' | 'fetch' | 'redeem';

export function fakeReferralApi(initial: MyReferrals = referrals()) {
  const server = {
    state: initial,
    code: initial.code ?? CODE,
    fail: {} as Partial<Record<Call, ReferralErrorCode>>,
  };
  const api: ReferralApi = {
    getMyReferralCode: jest.fn(async () => {
      if (server.fail.code) throw new ReferralError(server.fail.code);
      server.state = { ...server.state, code: server.code };
      return server.code;
    }),
    fetchMyReferrals: jest.fn(async () => {
      if (server.fail.fetch) throw new ReferralError(server.fail.fetch);
      return { ...server.state };
    }),
    redeemReferralCode: jest.fn(async () => {
      if (server.fail.redeem) throw new ReferralError(server.fail.redeem);
      server.state = { ...server.state, canRedeem: false, myCode: 'pending' };
      return { status: 'pending' as const };
    }),
  };
  return { api, server };
}

/** The app config as a fetched cache: the referral flag and, optionally, the store links. */
export function storedConfig(opts: { referral?: boolean; store?: { ios?: string; android?: string } }): StoredAppConfig {
  return {
    fetchedAt: NOW,
    flags: opts.referral === undefined ? {} : { referral: opts.referral },
    values: opts.store ? { store_urls: opts.store } : {},
  };
}

/** A database with the config (and optionally this account's cached referrals), and a render inside every provider. */
export async function referralWorld(
  opts: { referral?: boolean; store?: { ios?: string; android?: string }; cached?: MyReferrals } = {}
) {
  const db = await createTestDb();
  const settings = createSettingsRepo(db);
  await settings.set(APP_CONFIG_KEY, storedConfig(opts));
  if (opts.cached) await writeCachedReferrals(settings, UID, opts.cached);
  const client = testQueryClient();
  const Data = wrapperFor(db, client, () => NOW);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ThemeProvider>
      <Data>{children}</Data>
    </ThemeProvider>
  );
  return {
    db,
    settings,
    client,
    wrapper,
    render: (ui: ReactElement) => render(ui, { wrapper }),
  };
}

/** The config refresh the screens get in tests: nothing to fetch. */
export const noRefresh = async () => undefined;
