/**
 * The share composer's harness: a real sql.js database (trips, the app config, the rewards and
 * referral caches in settings), a real `QueryClient`, the theme, server doubles for the rewards
 * snapshot and the referral code, and a share-sheet double. Suites mock `expo-router`, the
 * session and the Supabase client themselves.
 */
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { APP_CONFIG_KEY } from '@/data/config/appConfig';
import type { TripRow } from '@/data/db/types';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb, seedTrips, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { testQueryClient } from '@/features/inbox/__fixtures__/harness';
import type { RewardsApi, RewardsSnapshot } from '@/features/rewards/api';
import { writeCachedRewards } from '@/features/rewards/cache';
import { NOW, snapshot as rewardsSnapshot, UID } from '@/features/rewards/__fixtures__/rows';
import { ReferralError, type ReferralApi } from '@/features/referral/api';
import { ThemeProvider } from '@/ui/theme';

import type { ShareComposerDeps } from '../ShareComposerScreen';

export { NOW, UID };

export function fakeRewardsApi(snap: RewardsSnapshot = rewardsSnapshot()): RewardsApi {
  return {
    fetchSnapshot: jest.fn(async () => ({ ...snap, fetchedAt: NOW })),
    fetchRewardDay: jest.fn(async () => null),
    openMyWeek: jest.fn(),
    setWeeklyFocus: jest.fn(),
    joinChallenge: jest.fn(),
    leaveChallenge: jest.fn(),
  } as unknown as RewardsApi;
}

export function fakeReferralApi(opts: { fail?: boolean } = {}): ReferralApi {
  return {
    getMyReferralCode: jest.fn(async () => {
      if (opts.fail) throw new ReferralError('unknown');
      return 'ABCD2345';
    }),
    fetchMyReferrals: jest.fn(),
    redeemReferralCode: jest.fn(),
  } as unknown as ReferralApi;
}

export async function shareWorld(
  opts: { trips?: TripRow[]; referral?: boolean; cachedRewards?: RewardsSnapshot } = {}
) {
  const db = await createTestDb();
  await seedTrips(db, opts.trips ?? []);
  const settings = createSettingsRepo(db);
  await settings.set(APP_CONFIG_KEY, {
    fetchedAt: NOW,
    flags: opts.referral === undefined ? {} : { referral: opts.referral },
    values: {},
  });
  if (opts.cachedRewards) await writeCachedRewards(settings, UID, opts.cachedRewards);
  const client = testQueryClient();
  const Data = wrapperFor(db, client, () => NOW);
  return {
    db,
    client,
    render: (ui: ReactElement) =>
      render(
        <ThemeProvider>
          <Data>{ui}</Data>
        </ThemeProvider>
      ),
  };
}

/** A share-sheet double and the deps a composer gets in tests. */
export function composerDeps(over: Partial<ShareComposerDeps> = {}, platform = 'android') {
  const sheet = jest.fn(async (_c: { message?: string; url?: string }) => ({ action: 'sharedAction' }));
  const deps: ShareComposerDeps = {
    rewardsApi: fakeRewardsApi(),
    api: fakeReferralApi(),
    refreshConfig: async () => undefined,
    share: { platform, share: sheet },
    ...over,
  };
  return { deps, sheet };
}
