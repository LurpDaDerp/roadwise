/**
 * The rewards screen harness (Task 8): a real sql.js database (settings, the day cache), a rewards
 * server double, and a render inside the theme and the data providers. Suites mock `expo-router`,
 * the session and the Supabase client themselves (Jest hoists `jest.mock` per file).
 */
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { APP_CONFIG_KEY } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb, seedDay, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { testQueryClient } from '@/features/inbox/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import type { RewardsApi, RewardsSnapshot } from '../../api';
import { writeCachedRewards } from '../../cache';
import { NOW, snapshot as baseSnapshot, UID } from '../../__fixtures__/rows';

export { NOW, UID };

/** A server double for the rewards reads and RPCs; `server.fail` makes the next fetch throw. */
export function fakeRewardsApi(initial: RewardsSnapshot = baseSnapshot()) {
  const server = { snapshot: initial, fail: null as unknown, hold: null as Promise<void> | null };
  const api: RewardsApi = {
    fetchSnapshot: jest.fn(async () => {
      if (server.hold) await server.hold;
      if (server.fail) throw server.fail;
      return server.snapshot;
    }),
    fetchRewardDay: jest.fn(async () => null),
    // A refusal: the week stays as the snapshot has it (the screen must cope either way).
    openMyWeek: jest.fn(async () => {
      throw new Error('not opened in the double');
    }),
    setWeeklyFocus: jest.fn(async () => {
      throw new Error('not used here');
    }),
    joinChallenge: jest.fn(async () => {
      throw new Error('not used here');
    }),
    leaveChallenge: jest.fn(async () => undefined),
  };
  return { api, server };
}

export interface WorldSeed {
  /** `[day, payload]` rows for the day cache (today's line). */
  days?: readonly [string, unknown][];
  /** The cached app config's `referral` flag; absent means never fetched (off). */
  referral?: boolean;
  /** A snapshot cached for this uid (for offline). */
  cached?: RewardsSnapshot;
  /** Settings rows to write before render. */
  settings?: Record<string, unknown>;
}

export async function rewardsWorld(seed: WorldSeed = {}) {
  const db = await createTestDb();
  for (const [day, payload] of seed.days ?? []) await seedDay(db, day, payload, NOW);
  const settings = createSettingsRepo(db);
  if (seed.referral !== undefined) {
    await settings.set(APP_CONFIG_KEY, { flags: { referral: seed.referral }, values: {}, fetchedAt: NOW });
  }
  if (seed.cached) await writeCachedRewards(settings, UID, seed.cached);
  for (const [key, value] of Object.entries(seed.settings ?? {})) await settings.set(key, value);
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

/** Every string rendered under `root` (text nodes and accessibility labels), for copy audits. */
/** The shape of a rendered element this audit reads (RNTL's host instances). */
interface RenderedNode {
  props: { accessibilityLabel?: unknown };
  children: readonly (RenderedNode | string)[];
}

export function renderedStrings(root: RenderedNode): string[] {
  const out: string[] = [];
  const walk = (node: RenderedNode | string) => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    const label = node.props?.accessibilityLabel;
    if (typeof label === 'string' && label.length > 0) out.push(label);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** A day-cache payload as `finalize-trip` returns it. */
export function dayPayload(over: Record<string, unknown> = {}) {
  return {
    safeDay: false,
    goodDay: false,
    phoneFreeDay: false,
    cameraDay: false,
    drivingS: 1800,
    tripsScored: 1,
    tripsAll: 1,
    severeEvents: 0,
    exposure: 1,
    longTermScore: null,
    band: null,
    provisional: false,
    ...over,
  };
}
