import {
  BadgeDefRowSchema,
  ChallengeDefRowSchema,
  fetchRewardDay,
  fetchRewardsSnapshot,
  joinChallenge,
  leaveChallenge,
  openMyWeek,
  ProgressRowSchema,
  REWARD_DAY_COLUMNS,
  RewardDayRowSchema,
  RewardsDataError,
  RewardsOfflineError,
  RewardsRpcError,
  RPC_ERROR_MESSAGES,
  rpcErrorCode,
  setWeeklyFocus,
  SNAPSHOT_DAYS,
  UserBadgeRowSchema,
  UserChallengeRowSchema,
  WeeklyGoalRowSchema,
} from '../api';
import { fakeRewardsClient, offline, ok, refused, type Op } from '../__fixtures__/client';
import {
  badgeDefRows,
  badgeRow,
  challengeDefRows,
  enrolmentRow,
  goalRow,
  NOW,
  progressRow,
  rewardDayRow,
} from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

describe('schemas are strict: an unexpected column fails', () => {
  test.each([
    ['progress', ProgressRowSchema, progressRow()],
    ['reward_days', RewardDayRowSchema, rewardDayRow('2026-09-22')],
    ['weekly_goals', WeeklyGoalRowSchema, goalRow('2026-09-21')],
    ['user_badges', UserBadgeRowSchema, badgeRow('safe_days_7')],
    ['user_challenges', UserChallengeRowSchema, enrolmentRow('phone_down')],
    ['badge_defs', BadgeDefRowSchema, badgeDefRows()[0]],
    ['challenge_defs', ChallengeDefRowSchema, challengeDefRows()[0]],
  ] as const)('%s', (_table, schema, row) => {
    expect((schema as { safeParse(v: unknown): { success: boolean } }).safeParse(row).success).toBe(true);
    expect((schema as { safeParse(v: unknown): { success: boolean } }).safeParse({ ...row, surprise: 1 }).success).toBe(false);
  });

  test("reward_days never selects the bookkeeping column (it isn't granted)", () => {
    expect(REWARD_DAY_COLUMNS.split(',')).not.toContain('checked_through');
    expect(RewardDayRowSchema.safeParse({ ...rewardDayRow('2026-09-22'), checked_through: 'x' }).success).toBe(false);
  });

  test('values outside the server CHECKs fail', () => {
    expect(ProgressRowSchema.safeParse(progressRow({ level: 7 as never })).success).toBe(false);
    expect(ProgressRowSchema.safeParse(progressRow({ shields: 3 })).success).toBe(false);
    expect(RewardDayRowSchema.safeParse(rewardDayRow('2026-09-22', { tier: 'gold' as never })).success).toBe(false);
    expect(
      RewardDayRowSchema.safeParse({ ...rewardDayRow('2026-09-22'), predicates: { phone: 'pass' } }).success
    ).toBe(false);
  });
});

/** Each table's reply, by what the chain asked for. */
function world(over: Partial<Record<string, (ops: Op[]) => ReturnType<typeof ok>>> = {}) {
  const tables: Record<string, (ops: Op[]) => ReturnType<typeof ok>> = {
    progress: () => ok([progressRow()]),
    weekly_goals: () => ok([goalRow('2026-09-21'), goalRow('2026-09-14', { state: 'achieved', pass_days: 4 })]),
    reward_days: () => ok([rewardDayRow('2026-09-22'), rewardDayRow('2026-09-21')]),
    user_badges: () => ok([badgeRow('safe_days_7')]),
    badge_defs: () => ok(badgeDefRows()),
    user_challenges: (ops) =>
      ops.some((o) => o[0] === 'eq')
        ? ok([enrolmentRow('phone_down')])
        : ok([enrolmentRow('safe_run', { state: 'completed', pass_days: 7 })]),
    challenge_defs: () => ok(challengeDefRows()),
    ...over,
  };
  return fakeRewardsClient({ reply: (table, ops) => (tables[table] ?? (() => ok([])))(ops) });
}

describe('fetchRewardsSnapshot', () => {
  test('assembles the snapshot from parallel selects', async () => {
    const { client, selects } = world();
    const s = await fetchRewardsSnapshot(client, () => NOW);
    expect(s.progress?.points).toBe(1250);
    expect(s.currentGoal?.week_start).toBe('2026-09-21');
    expect(s.lastGoal?.week_start).toBe('2026-09-14');
    expect(s.days.map((d) => d.day)).toEqual(['2026-09-22', '2026-09-21']);
    expect(s.badges.map((b) => b.badge_id)).toEqual(['safe_days_7']);
    expect(s.badgeDefs).toHaveLength(16);
    expect(s.challenges.map((c) => [c.def_id, c.state])).toEqual([
      ['phone_down', 'active'],
      ['safe_run', 'completed'],
    ]);
    expect(s.challengeDefs).toHaveLength(4);
    expect(s.fetchedAt).toBe(NOW);

    const byTable = (t: string) => selects.filter((q) => q.table === t).map((q) => q.ops);
    expect(byTable('reward_days')[0]).toEqual([
      ['select', REWARD_DAY_COLUMNS],
      ['order', 'day', { ascending: false }],
      ['limit', SNAPSHOT_DAYS],
    ]);
    expect(byTable('weekly_goals')[0]).toContainEqual(['limit', 2]);
    // Active enrolments all, the others the newest 20.
    expect(byTable('user_challenges')).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([['eq', 'state', 'active']]),
        expect.arrayContaining([['neq', 'state', 'active'], ['limit', 20]]),
      ])
    );
    // Never `*`.
    for (const q of selects) expect(q.ops[0]?.[1]).not.toBe('*');
  });

  test('a new user: no progress row, no goals, nothing settled', async () => {
    const { client } = world({ progress: () => ok([]), weekly_goals: () => ok([]), reward_days: () => ok([]) });
    const s = await fetchRewardsSnapshot(client, () => NOW);
    expect(s.progress).toBeNull();
    expect(s.currentGoal).toBeNull();
    expect(s.lastGoal).toBeNull();
    expect(s.days).toEqual([]);
  });

  test('a transport failure on any select is RewardsOfflineError', async () => {
    const { client } = world({ badge_defs: () => offline() });
    await expect(fetchRewardsSnapshot(client)).rejects.toBeInstanceOf(RewardsOfflineError);
  });

  test('a server refusal is rethrown as it is (the screen shows its error)', async () => {
    const error = { code: '42501', message: 'permission denied' };
    const { client } = world({ progress: () => ({ data: null, error, status: 403 }) });
    await expect(fetchRewardsSnapshot(client)).rejects.toBe(error);
  });

  test('one unreadable row refuses the whole snapshot, never a partial one (a dropped day would read as unsettled)', async () => {
    const { client } = world({ reward_days: () => ok([rewardDayRow('2026-09-22'), { ...rewardDayRow('2026-09-21'), extra: true }]) });
    await expect(fetchRewardsSnapshot(client)).rejects.toBeInstanceOf(RewardsDataError);
  });
});

describe('fetchRewardDay', () => {
  test('one owner select of that day', async () => {
    const { client, selects } = fakeRewardsClient({ reply: () => ok([rewardDayRow('2026-07-01')]) });
    await expect(fetchRewardDay('2026-07-01', client)).resolves.toMatchObject({ day: '2026-07-01' });
    expect(selects[0]).toEqual({
      table: 'reward_days',
      ops: [
        ['select', REWARD_DAY_COLUMNS],
        ['eq', 'day', '2026-07-01'],
        ['limit', 1],
      ],
    });
  });

  test('no row: null (not settled)', async () => {
    const { client } = fakeRewardsClient({ reply: () => ok([]) });
    await expect(fetchRewardDay('2026-07-01', client)).resolves.toBeNull();
  });

  test('offline: RewardsOfflineError, never null', async () => {
    const { client } = fakeRewardsClient({ reply: () => offline() });
    await expect(fetchRewardDay('2026-07-01', client)).rejects.toBeInstanceOf(RewardsOfflineError);
  });
});

describe('RPC error mapping: every fixed server message', () => {
  test.each([
    ['account not eligible', '42501', 'not_available'],
    ['challenge not found', '42501', 'not_available'],
    ['focus limit reached', '42501', 'limit'],
    ['challenge limit reached', '42501', 'limit'],
    ['unknown focus', '22023', 'invalid'],
    ['unknown challenge', '22023', 'invalid'],
    ['two challenges at a time', '42501', 'two_active'],
    ['challenge already active', '22023', 'already_active'],
    ['open_my_week requires an authenticated user', '42501', 'unknown'],
    ['set_weekly_focus requires an authenticated user', '42501', 'unknown'],
    ['join_challenge requires an authenticated user', '42501', 'unknown'],
    ['leave_challenge requires an authenticated user', '42501', 'unknown'],
  ] as const)('%s → %s', (message, code, expected) => {
    expect(rpcErrorCode({ code, message }, 400)).toBe(expected);
  });

  test('the table names exactly those messages', () => {
    expect(Object.keys(RPC_ERROR_MESSAGES)).toHaveLength(12);
  });

  test('55P03 (a lock timeout, rev1: R-G) is busy, whatever the message', () => {
    expect(rpcErrorCode({ code: '55P03', message: 'canceling statement due to lock timeout' }, 500)).toBe('busy');
  });

  test('status 0 is offline; anything else unknown', () => {
    expect(rpcErrorCode({ message: 'TypeError: Network request failed' }, 0)).toBe('offline');
    expect(rpcErrorCode({ code: 'XX000', message: 'something new' }, 500)).toBe('unknown');
    expect(rpcErrorCode(null, 500)).toBe('unknown');
  });
});

describe('the RPC wrappers', () => {
  const summary = { week_start: '2026-09-21', category: 'braking', source: 'chosen', target_days: 4, pass_days: 0, fail_days: 0, state: 'active', prorated: false };

  test('openMyWeek calls open_my_week with no arguments and returns the goal', async () => {
    const { client, rpcs } = fakeRewardsClient({ rpc: () => ok(summary) });
    await expect(openMyWeek(client)).resolves.toEqual(summary);
    expect(rpcs).toEqual([{ fn: 'open_my_week', args: undefined }]);
  });

  test('setWeeklyFocus sends p_category and returns where it applied', async () => {
    const { client, rpcs } = fakeRewardsClient({ rpc: () => ok({ applied: 'next_week', goal: summary }) });
    await expect(setWeeklyFocus('braking', client)).resolves.toEqual({ applied: 'next_week', goal: summary });
    expect(rpcs).toEqual([{ fn: 'set_weekly_focus', args: { p_category: 'braking' } }]);
  });

  test('joinChallenge sends p_def_id; leaveChallenge p_id', async () => {
    const enrolment = { id: '00000000-0000-4000-8000-000000000099', def_id: 'phone_down', start_day: '2026-09-24', state: 'active', pass_days: 0, fail_days: 0 };
    const { client, rpcs } = fakeRewardsClient({ rpc: (fn) => ok(fn === 'join_challenge' ? enrolment : null) });
    await expect(joinChallenge('phone_down', client)).resolves.toEqual(enrolment);
    await expect(leaveChallenge(enrolment.id, client)).resolves.toBeUndefined();
    expect(rpcs).toEqual([
      { fn: 'join_challenge', args: { p_def_id: 'phone_down' } },
      { fn: 'leave_challenge', args: { p_id: enrolment.id } },
    ]);
  });

  test('a refusal becomes RewardsRpcError with its code', async () => {
    const { client } = fakeRewardsClient({ rpc: () => refused('42501', 'two challenges at a time', 403) });
    await expect(joinChallenge('safe_run', client)).rejects.toMatchObject({ name: 'RewardsRpcError', code: 'two_active' });
  });

  test('busy and offline', async () => {
    const busy = fakeRewardsClient({ rpc: () => refused('55P03', 'lock timeout', 500) });
    await expect(setWeeklyFocus('phone', busy.client)).rejects.toMatchObject({ code: 'busy' });
    const down = fakeRewardsClient({ rpc: () => offline() });
    await expect(openMyWeek(down.client)).rejects.toMatchObject({ code: 'offline' });
    const thrown = fakeRewardsClient({ rpc: () => Promise.reject(new Error('socket')) });
    await expect(openMyWeek(thrown.client)).rejects.toMatchObject({ code: 'offline' });
  });

  test('an answer this build cannot read is unknown, not a success', async () => {
    const { client } = fakeRewardsClient({ rpc: () => ok({ ...summary, extra: 1 }) });
    const error = await openMyWeek(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RewardsRpcError);
    expect((error as RewardsRpcError).code).toBe('unknown');
  });
});
