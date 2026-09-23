/**
 * The rewards reads and the four client RPCs (migrations 0009 and 0010).
 *
 * - **Server-authoritative.** Every value here — points, class, streak, settled days, goals,
 *   badges, enrolments — is written only by the server's settlement. The client reads its own rows
 *   under RLS and can call exactly four RPCs, none of which can create a point.
 * - **Columns are listed, never `*`.** `reward_days` is granted per column (0009: `checked_through`
 *   is bookkeeping, not readable); the other tables are listed too, so a column the server adds
 *   later never reaches a strict schema by surprise.
 * - **Rows are validated strictly** (`.strict()`): a row carrying a column this build did not ask
 *   for, or a value outside the server's CHECKs, refuses the WHOLE snapshot (`RewardsDataError`)
 *   rather than dropping the row. A dropped `reward_days` row would read as "not settled yet", and
 *   the screens must never say that about a settled day (honesty rule).
 * - **A transport failure is not a server error.** supabase-js reports a request that never reached
 *   the server as `status: 0`; reads throw `RewardsOfflineError` (the hook answers from the phone's
 *   cache), RPCs throw `RewardsRpcError` with `code: 'offline'`.
 * - **RPC refusals** carry fixed messages and SQLSTATEs; `RPC_ERROR_MESSAGES` maps each to a code the
 *   screens word. `55P03` (lock timeout, rev1: R-G) is `busy`: "Busy right now. Try again."
 */
import { z } from 'zod';

import type { supabase as AppClient } from '@/data/supabase/client';

// ---------------------------------------------------------------------------------------------
// Row schemas: exactly the columns selected, each `.strict()`
// ---------------------------------------------------------------------------------------------

const timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a timestamp');
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'not a day');
const count = z.number().int().min(0);

export const GOAL_CATEGORY_VALUES = ['phone', 'speeding', 'braking', 'accel', 'cornering'] as const;
export const GoalCategorySchema = z.enum(GOAL_CATEGORY_VALUES);
export type GoalCategory = z.infer<typeof GoalCategorySchema>;

export const PREDICATE_KEYS = ['phone', 'speeding', 'braking', 'accel', 'cornering', 'smooth', 'safe'] as const;
export type PredicateKey = (typeof PREDICATE_KEYS)[number];
export const PredicateResultSchema = z.enum(['pass', 'fail', 'neutral']);
export type PredicateResult = z.infer<typeof PredicateResultSchema>;

export const DayPredicatesSchema = z
  .object({
    phone: PredicateResultSchema,
    speeding: PredicateResultSchema,
    braking: PredicateResultSchema,
    accel: PredicateResultSchema,
    cornering: PredicateResultSchema,
    smooth: PredicateResultSchema,
    safe: PredicateResultSchema,
  })
  .strict();
export type DayPredicates = z.infer<typeof DayPredicatesSchema>;

/** `progress` (0009): every column is granted. */
export const PROGRESS_COLUMNS =
  'user_id,points,xp,level,streak_days,best_streak,safe_days,phone_free_days,smooth_days,goals_achieved,challenges_completed,referrals_rewarded,shields,next_focus,settled_through,streak_started,rewards_start,created_at,updated_at';

export const ProgressRowSchema = z
  .object({
    user_id: z.string().uuid(),
    points: count,
    xp: count,
    level: z.number().int().min(1).max(6),
    streak_days: count,
    best_streak: count,
    safe_days: count,
    phone_free_days: count,
    smooth_days: count,
    goals_achieved: count,
    challenges_completed: count,
    referrals_rewarded: count,
    shields: z.number().int().min(0).max(2),
    next_focus: GoalCategorySchema.nullable(),
    settled_through: dayKey.nullable(),
    streak_started: dayKey.nullable(),
    rewards_start: dayKey.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type Progress = z.infer<typeof ProgressRowSchema>;

/** `reward_days` (0009): the per-column grant (never `checked_through`). */
export const REWARD_DAY_COLUMNS =
  'user_id,day,outcome,outcome_reason,tier,phone_free,camera,predicates,points,streak_after,wall_close,settled_at,source_updated_at,created_at,updated_at';

export const RewardDayRowSchema = z
  .object({
    user_id: z.string().uuid(),
    day: dayKey,
    outcome: z.enum(['safe', 'neutral', 'unsafe']),
    // 'late' (6b361bf): a day that reached the server behind the settlement frontier, frozen without value
    outcome_reason: z.enum(['safe', 'no_drive', 'learning', 'short', 'unsafe', 'zone_hop', 'late']),
    tier: z.enum(['safe', 'good', 'none']),
    phone_free: z.boolean(),
    camera: z.boolean(),
    predicates: DayPredicatesSchema,
    points: z.number().int().min(0).max(1000),
    // null only inside the settling transaction; a client never sees it, but the column allows it
    streak_after: count.nullable(),
    wall_close: timestamp,
    settled_at: timestamp,
    source_updated_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type RewardDay = z.infer<typeof RewardDayRowSchema>;

/** `weekly_goals` (0009): every column is granted. */
export const WEEKLY_GOAL_COLUMNS =
  'user_id,week_start,category,source,target_days,pass_days,fail_days,state,prorated,closed_at,created_at,updated_at';

const goalFields = {
  week_start: dayKey,
  category: GoalCategorySchema,
  source: z.enum(['chosen', 'weakest']),
  target_days: z.number().int().min(1).max(7),
  pass_days: z.number().int().min(0).max(7),
  fail_days: z.number().int().min(0).max(7),
  state: z.enum(['active', 'achieved', 'ended', 'no_drives']),
  prorated: z.boolean(),
};

export const WeeklyGoalRowSchema = z
  .object({
    user_id: z.string().uuid(),
    ...goalFields,
    closed_at: timestamp.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type WeeklyGoal = z.infer<typeof WeeklyGoalRowSchema>;

/** The goal as `open_my_week` and `set_weekly_focus` return it (0009): no owner, no timestamps. */
export const WeeklyGoalSummarySchema = z.object(goalFields).strict();
export type WeeklyGoalSummary = z.infer<typeof WeeklyGoalSummarySchema>;

/** `user_badges` (0010). */
export const USER_BADGE_COLUMNS = 'user_id,badge_id,earned_at,created_at';

const badgeId = z.string().regex(/^[a-z_]+_[0-9]+$/).max(40);
const challengeDefId = z.string().regex(/^[a-z_]{1,40}$/);
const BadgeMetricSchema = z.enum(['safe_days', 'phone_free_days', 'smooth_days', 'weekly_goals', 'challenges', 'referrals']);

export const UserBadgeRowSchema = z
  .object({
    user_id: z.string().uuid(),
    badge_id: badgeId,
    earned_at: timestamp,
    created_at: timestamp,
  })
  .strict();
export type EarnedBadge = z.infer<typeof UserBadgeRowSchema>;

/** `user_challenges` (0010). */
export const USER_CHALLENGE_COLUMNS =
  'id,user_id,def_id,start_day,state,pass_days,fail_days,completed_at,ended_at,created_at,updated_at';

const enrolmentFields = {
  id: z.string().uuid(),
  def_id: challengeDefId,
  start_day: dayKey,
  state: z.enum(['active', 'completed', 'ended', 'left']),
  pass_days: count,
  fail_days: count,
};

export const UserChallengeRowSchema = z
  .object({
    ...enrolmentFields,
    user_id: z.string().uuid(),
    completed_at: timestamp.nullable(),
    ended_at: timestamp.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type Enrolment = z.infer<typeof UserChallengeRowSchema>;

/** The enrolment as `join_challenge` returns it (0010). */
export const EnrolmentSummarySchema = z.object(enrolmentFields).strict();
export type EnrolmentSummary = z.infer<typeof EnrolmentSummarySchema>;

/** `badge_defs` (0010), the columns a screen needs. */
export const BADGE_DEF_COLUMNS = 'id,family,tier,metric,threshold,sort';

export const BadgeDefRowSchema = z
  .object({
    id: badgeId,
    family: BadgeMetricSchema,
    tier: z.enum(['bronze', 'silver', 'gold']),
    metric: BadgeMetricSchema,
    threshold: z.number().int().min(1).max(100000),
    sort: z.number().int().min(1).max(1000),
  })
  .strict();
export type BadgeDef = z.infer<typeof BadgeDefRowSchema>;
export type BadgeMetric = z.infer<typeof BadgeMetricSchema>;

/** `challenge_defs` (0010), the columns a screen needs. */
export const CHALLENGE_DEF_COLUMNS = 'id,predicate,target_days,window_days,points,sort,active';

export const ChallengeDefRowSchema = z
  .object({
    id: challengeDefId,
    predicate: z.enum(PREDICATE_KEYS),
    target_days: z.number().int().min(1).max(60),
    window_days: z.number().int().min(1).max(60),
    points: z.number().int().min(100).max(300),
    sort: z.number().int().min(1).max(1000),
    active: z.boolean(),
  })
  .strict();
export type ChallengeDef = z.infer<typeof ChallengeDefRowSchema>;

// ---------------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------------

/** Settled days the snapshot carries (newest first). */
export const SNAPSHOT_DAYS = 35;
/** Weekly goals the snapshot carries: this week's (once opened) and the one before. */
export const SNAPSHOT_GOALS = 2;
/** Enrolments that are not active the snapshot carries (newest first), besides every active one. */
export const SNAPSHOT_PAST_CHALLENGES = 20;

export const RewardsSnapshotSchema = z
  .object({
    progress: ProgressRowSchema.nullable(),
    currentGoal: WeeklyGoalRowSchema.nullable(),
    lastGoal: WeeklyGoalRowSchema.nullable(),
    days: z.array(RewardDayRowSchema),
    badges: z.array(UserBadgeRowSchema),
    badgeDefs: z.array(BadgeDefRowSchema),
    challenges: z.array(UserChallengeRowSchema),
    challengeDefs: z.array(ChallengeDefRowSchema),
    fetchedAt: z.number(),
  })
  .strict();

/**
 * Everything the rewards surfaces read, in one fetch.
 *
 * - `progress`: null for an account the settlement has not reached yet (a new user).
 * - `currentGoal`: the NEWEST goal row, which is this week's once `open_my_week` has run (or the
 *   settlement created it); until then it may be last week's. Check `week_start` against
 *   `isoWeekStart(today)` (viewModel) before calling it "this week's". `lastGoal`: the one before.
 * - `days`: the newest 35 settled days, newest first. A day missing from them is not settled —
 *   unless it is older than the oldest one here (`useRewardDay` then asks the server).
 * - `challenges`: every active enrolment, then the newest 20 others.
 */
export type RewardsSnapshot = z.infer<typeof RewardsSnapshotSchema>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** The request never reached the server (no connection, DNS, a dropped socket). */
export class RewardsOfflineError extends Error {
  override readonly name = 'RewardsOfflineError';
  constructor(readonly cause?: unknown) {
    super('rewards: the server could not be reached');
  }
}

/** The server answered with rows this build cannot read in full; nothing of the answer is used. */
export class RewardsDataError extends Error {
  override readonly name = 'RewardsDataError';
  constructor(readonly table: string, readonly issues?: unknown) {
    super(`rewards: ${table} returned a row this build cannot read`);
  }
}

export type RewardsRpcCode =
  | 'offline'
  | 'busy'
  | 'limit'
  | 'not_available'
  | 'invalid'
  | 'two_active'
  | 'already_active'
  | 'unknown';

/** An RPC refusal, as a code the screens word (never the server's own text). */
export class RewardsRpcError extends Error {
  override readonly name = 'RewardsRpcError';
  constructor(readonly code: RewardsRpcCode, readonly cause?: unknown) {
    super(`rewards rpc: ${code}`);
  }
}

/**
 * The fixed messages the four RPCs raise (0009 `open_my_week`, `set_weekly_focus`; 0010
 * `join_challenge`, `leave_challenge`), each to its code. The "requires an authenticated user"
 * refusals are a signed-out call, which no screen makes: `unknown`.
 */
export const RPC_ERROR_MESSAGES: Readonly<Record<string, RewardsRpcCode>> = {
  'account not eligible': 'not_available',
  'challenge not found': 'not_available',
  'focus limit reached': 'limit',
  'challenge limit reached': 'limit',
  'unknown focus': 'invalid',
  'unknown challenge': 'invalid',
  'two challenges at a time': 'two_active',
  'challenge already active': 'already_active',
  'open_my_week requires an authenticated user': 'unknown',
  'set_weekly_focus requires an authenticated user': 'unknown',
  'join_challenge requires an authenticated user': 'unknown',
  'leave_challenge requires an authenticated user': 'unknown',
};

/** SQLSTATE of a lock timeout: every client RPC pins `lock_timeout = '2s'` (rev1: R-G). */
export const LOCK_TIMEOUT_SQLSTATE = '55P03';

/** The code for an RPC reply's error. */
export function rpcErrorCode(error: unknown, status: number): RewardsRpcCode {
  if (status === 0) return 'offline';
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === LOCK_TIMEOUT_SQLSTATE) return 'busy';
  if (typeof message === 'string') return RPC_ERROR_MESSAGES[message] ?? 'unknown';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

/** The slice of the Supabase client these calls use; a test passes a fake. */
export type RewardsClient = Pick<typeof AppClient, 'from' | 'rpc'>;

/**
 * The app client, loaded on first call rather than at import: a screen, or a test, that imports the
 * rewards layer without calling the server never loads the client (or needs its env).
 */
function appClient(): RewardsClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when used
  return (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase;
}

interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}

function check(reply: Reply): void {
  if (!reply.error) return;
  if (reply.status === 0) throw new RewardsOfflineError(reply.error);
  throw reply.error;
}

/** Every row through `schema`, or `RewardsDataError` for the table: never a partial answer. */
function parseRows<T>(schema: z.ZodType<T>, data: unknown, table: string): T[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw new RewardsDataError(table);
  return data.map((raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new RewardsDataError(table, parsed.error.issues);
    return parsed.data;
  });
}

/**
 * The caller's rewards, in parallel selects (RLS: own rows; the defs are readable by every
 * signed-in user). Throws `RewardsOfflineError` when the server could not be reached, the server's
 * own error when it refused, and `RewardsDataError` when an answer cannot be read in full.
 */
export async function fetchRewardsSnapshot(
  client: RewardsClient = appClient(),
  now: () => number = Date.now
): Promise<RewardsSnapshot> {
  const [progress, goals, days, badges, badgeDefs, active, past, challengeDefs] = await Promise.all([
    client.from('progress').select(PROGRESS_COLUMNS).limit(1),
    client.from('weekly_goals').select(WEEKLY_GOAL_COLUMNS).order('week_start', { ascending: false }).limit(SNAPSHOT_GOALS),
    client.from('reward_days').select(REWARD_DAY_COLUMNS).order('day', { ascending: false }).limit(SNAPSHOT_DAYS),
    client.from('user_badges').select(USER_BADGE_COLUMNS).order('earned_at', { ascending: true }),
    client.from('badge_defs').select(BADGE_DEF_COLUMNS).order('sort', { ascending: true }),
    client.from('user_challenges').select(USER_CHALLENGE_COLUMNS).eq('state', 'active').order('created_at', { ascending: false }),
    client
      .from('user_challenges')
      .select(USER_CHALLENGE_COLUMNS)
      .neq('state', 'active')
      .order('created_at', { ascending: false })
      .limit(SNAPSHOT_PAST_CHALLENGES),
    client.from('challenge_defs').select(CHALLENGE_DEF_COLUMNS).order('sort', { ascending: true }),
  ]);
  // Offline anywhere is offline: checked before any refusal is rethrown.
  const replies: Reply[] = [progress, goals, days, badges, badgeDefs, active, past, challengeDefs];
  const unreachable = replies.find((r) => r.error && r.status === 0);
  if (unreachable) throw new RewardsOfflineError(unreachable.error);
  for (const reply of replies) check(reply);

  const goalRows = parseRows(WeeklyGoalRowSchema, goals.data, 'weekly_goals');
  return {
    progress: parseRows(ProgressRowSchema, progress.data, 'progress')[0] ?? null,
    currentGoal: goalRows[0] ?? null,
    lastGoal: goalRows[1] ?? null,
    days: parseRows(RewardDayRowSchema, days.data, 'reward_days'),
    badges: parseRows(UserBadgeRowSchema, badges.data, 'user_badges'),
    badgeDefs: parseRows(BadgeDefRowSchema, badgeDefs.data, 'badge_defs'),
    challenges: [
      ...parseRows(UserChallengeRowSchema, active.data, 'user_challenges'),
      ...parseRows(UserChallengeRowSchema, past.data, 'user_challenges'),
    ],
    challengeDefs: parseRows(ChallengeDefRowSchema, challengeDefs.data, 'challenge_defs'),
    fetchedAt: now(),
  };
}

/** One settled day of the caller's (RLS), or null when that day has not settled. */
export async function fetchRewardDay(day: string, client: RewardsClient = appClient()): Promise<RewardDay | null> {
  const reply = await client.from('reward_days').select(REWARD_DAY_COLUMNS).eq('day', day).limit(1);
  check(reply);
  return parseRows(RewardDayRowSchema, reply.data, 'reward_days')[0] ?? null;
}

async function callRpc<T>(
  reply: PromiseLike<Reply>,
  schema: z.ZodType<T> | null
): Promise<T> {
  let answer: Reply;
  try {
    answer = await reply;
  } catch (error) {
    // supabase-js answers a failed fetch as `status: 0`; a throw is the same thing.
    throw new RewardsRpcError('offline', error);
  }
  if (answer.error) throw new RewardsRpcError(rpcErrorCode(answer.error, answer.status), answer.error);
  if (schema === null) return undefined as T;
  const parsed = schema.safeParse(answer.data);
  if (!parsed.success) throw new RewardsRpcError('unknown', parsed.error.issues);
  return parsed.data;
}

/** This week's goal, materialised on the server if it does not exist yet (and earlier ones closed). */
export function openMyWeek(client: RewardsClient = appClient()): Promise<WeeklyGoalSummary> {
  return callRpc(client.rpc('open_my_week'), WeeklyGoalSummarySchema);
}

export const FocusResultSchema = z
  .object({ applied: z.enum(['this_week', 'next_week']), goal: WeeklyGoalSummarySchema })
  .strict();
export type FocusApplied = z.infer<typeof FocusResultSchema>['applied'];

/**
 * The driver's chosen focus: this week while nothing has counted yet (`this_week`), otherwise next
 * week (`next_week`). The goal returned is this week's either way.
 */
export function setWeeklyFocus(
  category: GoalCategory,
  client: RewardsClient = appClient()
): Promise<{ applied: FocusApplied; goal: WeeklyGoalSummary }> {
  return callRpc(client.rpc('set_weekly_focus', { p_category: category }), FocusResultSchema);
}

/** Join a challenge; counting starts the day after. */
export function joinChallenge(defId: string, client: RewardsClient = appClient()): Promise<EnrolmentSummary> {
  return callRpc(client.rpc('join_challenge', { p_def_id: defId }), EnrolmentSummarySchema);
}

/** Leave an active enrolment (no points; final). */
export function leaveChallenge(id: string, client: RewardsClient = appClient()): Promise<void> {
  return callRpc(client.rpc('leave_challenge', { p_id: id }), null);
}

/** The calls the hooks make, as one injectable object. */
export interface RewardsApi {
  fetchSnapshot(): Promise<RewardsSnapshot>;
  fetchRewardDay(day: string): Promise<RewardDay | null>;
  openMyWeek(): Promise<WeeklyGoalSummary>;
  setWeeklyFocus(category: GoalCategory): Promise<{ applied: FocusApplied; goal: WeeklyGoalSummary }>;
  joinChallenge(defId: string): Promise<EnrolmentSummary>;
  leaveChallenge(id: string): Promise<void>;
}

export const defaultRewardsApi: RewardsApi = {
  fetchSnapshot: () => fetchRewardsSnapshot(),
  fetchRewardDay: (day) => fetchRewardDay(day),
  openMyWeek: () => openMyWeek(),
  setWeeklyFocus: (category) => setWeeklyFocus(category),
  joinChallenge: (defId) => joinChallenge(defId),
  leaveChallenge: (id) => leaveChallenge(id),
};
