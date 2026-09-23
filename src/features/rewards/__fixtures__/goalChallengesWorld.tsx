/**
 * The goal and challenge screens' harness (Task 9): a real sql.js database behind the data
 * provider (the rewards cache lives in its settings), a real `QueryClient`, the theme, and a
 * server double for the six rewards calls that behaves like the RPCs (a join adds an active
 * enrolment starting tomorrow; a leave marks it `left`). Suites mock `expo-router`, the session and
 * the Supabase client themselves (Jest hoists `jest.mock` per file).
 */
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb, wrapperFor } from '@/data/queries/__fixtures__/harness';
import { testQueryClient } from '@/features/inbox/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import type { GoalCategory, RewardsApi, RewardsSnapshot, WeeklyGoalSummary } from '../api';
import { writeCachedRewards } from '../cache';
import { enrolmentRow, NOW, snapshot, UID } from './rows';

type Failure = 'fetch' | 'open' | 'focus' | 'join' | 'leave';

export function fakeScreensApi(initial: RewardsSnapshot = snapshot()) {
  const server = {
    snapshot: initial,
    fail: {} as Partial<Record<Failure, unknown>>,
    focusApplied: 'this_week' as 'this_week' | 'next_week',
  };
  const summary = (category: GoalCategory): WeeklyGoalSummary => ({
    week_start: '2026-09-21',
    category,
    source: 'chosen',
    target_days: 4,
    pass_days: 0,
    fail_days: 0,
    state: 'active',
    prorated: false,
  });
  const api: RewardsApi = {
    fetchSnapshot: jest.fn(async () => {
      if (server.fail.fetch) throw server.fail.fetch;
      return { ...server.snapshot, fetchedAt: NOW };
    }),
    fetchRewardDay: jest.fn(async () => null),
    openMyWeek: jest.fn(async () => {
      if (server.fail.open) throw server.fail.open;
      return summary('phone');
    }),
    setWeeklyFocus: jest.fn(async (category: GoalCategory) => {
      if (server.fail.focus) throw server.fail.focus;
      return { applied: server.focusApplied, goal: summary(category) };
    }),
    joinChallenge: jest.fn(async (defId: string) => {
      if (server.fail.join) throw server.fail.join;
      const row = enrolmentRow(defId, { start_day: '2026-09-24', pass_days: 0, fail_days: 0 });
      server.snapshot = { ...server.snapshot, challenges: [row, ...server.snapshot.challenges] };
      return { id: row.id, def_id: defId, start_day: row.start_day, state: 'active' as const, pass_days: 0, fail_days: 0 };
    }),
    leaveChallenge: jest.fn(async (id: string) => {
      if (server.fail.leave) throw server.fail.leave;
      server.snapshot = {
        ...server.snapshot,
        challenges: server.snapshot.challenges.map((c) => (c.id === id ? { ...c, state: 'left' as const } : c)),
      };
    }),
  };
  return { api, server };
}

/** A database (optionally with this account's cached snapshot) and a render inside every provider. */
export async function screensWorld(opts: { cached?: RewardsSnapshot } = {}) {
  const db = await createTestDb();
  if (opts.cached) await writeCachedRewards(createSettingsRepo(db), UID, opts.cached);
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

interface JsonNode {
  props?: Record<string, unknown>;
  children?: (JsonNode | string)[] | null;
}

/**
 * Every string the tree shows or speaks: text children, and accessibility labels, hints and value
 * texts. Used for the rendered-copy rules (`BANNED_COPY`, no countdown words).
 */
export function renderedStrings(tree: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as JsonNode;
    const p = n.props ?? {};
    for (const key of ['accessibilityLabel', 'accessibilityHint'] as const) {
      if (typeof p[key] === 'string') out.push(p[key]);
    }
    const value = p.accessibilityValue as { text?: unknown } | undefined;
    if (value && typeof value.text === 'string') out.push(value.text);
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}
