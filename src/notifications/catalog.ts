// The notification catalog (product spec §11): the single source of truth for every P0
// notification's type, category, cap class, delivery, timing and copy.
//
// It runs in three places: the app (Metro), Jest (Node) and the edge functions (Deno), where
// `scripts/sync-catalog.js` copies it to `supabase/functions/_shared/catalog.ts` under a generated
// header. So it must stay self-contained: `zod` only — no `@/` alias, no React Native, no Node
// built-ins, no `expo-router` types (urls are plain path strings; Expo Router's groups drop out of
// them, so `/trips/<id>/summary` is the D1 route `/(app)/trips/[clientTripId]/summary`).
//
// Delivery (cross-plan ruling, rev1: C1): the drive summary is LOCAL — scheduled on the phone at
// finalize by M3's `summaryNotifier`, which takes its words from `renderLocal` and nothing else.
// `push-sender` refuses every `delivery: 'local'` type. Pushed types take their words from
// `renderPush`. Non-live rows are reserved for the milestone that builds their producer and carry
// no copy until then: a notification for a feature that does not exist would promise it.
//
// Honesty: no string here may assert what the data does not support. The drive summary names no
// score (it is provisional at finalize) and no place (§11.1 rule 5, the lock screen).
import { z } from 'zod';

// ——— vocabulary ———

/** Every P0 row of §11.2. */
export type NotificationType =
  | 'trip_summary'
  | 'permission_lapsed'
  | 'missed_drive'
  | 'streak_milestone'
  | 'goal_completed'
  | 'level_up'
  | 'referral_qualified'
  | 'family_membership'
  | 'family_sharing_changed'
  | 'family_digest'
  | 'data_export_ready'
  | 'transparency_reminder';

/**
 * H6's switches; `recording` is the §11.1 rule 3 addition (every category individually switchable).
 * The runtime list, so the server's category-key validation can be asserted against it.
 */
export const NOTIFICATION_CATEGORIES = [
  'trip_summaries',
  'recording',
  'rewards',
  'family',
  'safety',
  'product',
  'weekly_recap',
  'crews',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * How §11.1 rule 2 treats a type. `standard` and `promo` count toward the daily cap; `family`,
 * `critical` and `transactional` do not. `transactional` exists only for the drive summary when
 * `DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP` is false. Decide the cap with `countsTowardDailyCap`
 * (or `CAP_EXEMPT_CLASSES`), never by comparing against `family` alone.
 */
export type CapClass = 'standard' | 'family' | 'promo' | 'critical' | 'transactional';

/** The cap classes §11.1 rule 2 does not count. */
export const CAP_EXEMPT_CLASSES: readonly CapClass[] = ['family', 'critical', 'transactional'];

/** `local`: scheduled by the phone itself. `push`: sent by `push-sender`. */
export type Delivery = 'local' | 'push';

export type AndroidChannel = 'trips' | 'recording_problems' | 'family' | 'rewards';

export type Producer = 'M3' | 'M4' | 'M5' | 'M6' | 'M8' | 'unassigned';

/** A local-time window, `HH:MM` 24-hour. Delivery outside it is deferred to its next start. */
export interface DeliveryWindow {
  start: string;
  end: string;
}

export interface CatalogEntry {
  type: NotificationType;
  category: NotificationCategory;
  capClass: CapClass;
  priority: 'normal' | 'low';
  androidChannel: AndroidChannel;
  delivery: Delivery;
  producer: Producer;
  /** Produced and delivered in this build. Only live types have a payload schema and copy. */
  live: boolean;
  /** After this many hours undelivered, the item is stale and is never sent. */
  ttlHours: number;
  window?: DeliveryWindow;
  /** At most this many per rolling 7 days. */
  weeklyLimit?: number;
}

// ——— the cap (§11.1 rule 2) ———

/** "≤ 2 non-family notifications per day, ≤ 1 promotional/product per week." */
export const DAILY_CAP = { nonFamilyPerDay: 2, promoPer7Days: 1 } as const;

/**
 * OPEN PRODUCT QUESTION (pending with the user): does a drive summary count toward the daily cap?
 * The M4 ledger's reading of §11.1 is yes — rule 2 caps every non-family notification and exempts
 * only family and crash alerts, and §11.2 lists "Trip summary ready" as a notification — so a
 * driver with three drives in a day gets at most two summary notifications (batching keeps it
 * lower). Flip this one constant if the user rules drive summaries transactional.
 *
 * It lives in the catalog's DATA (ruling T4 I1): it sets `CATALOG.trip_summary.capClass`
 * (`standard` when true, `transactional` when false), so every reader of `capClass` — the phone's
 * `localDeliveryPlan` and day count, `push-sender`'s cap, the inbox's `countServerPushesToday` —
 * follows it with no code of its own.
 */
export const DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP = true;

// ——— the catalog ———

/** The drive summary's Android channel, stated once for the entry and for `renderLocal`. */
const TRIP_CHANNEL = 'trips' as const;

/**
 * Goal, class, badge and referral news arrives only in the daytime (rev1: R-I m5), so a settlement
 * at 02:05 never buzzes a user whose quiet hours are off; the 48 h TTL covers the wait to 09:00.
 */
const DAYTIME_WINDOW: DeliveryWindow = { start: '09:00', end: '20:30' };

const entry = <T extends NotificationType>(e: CatalogEntry & { type: T }): CatalogEntry & { type: T } => e;

export type Catalog = { readonly [K in NotificationType]: CatalogEntry & { type: K } };

/**
 * The catalog for one reading of the §11.1 question. The app and the edge functions use `CATALOG`
 * (built from `DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP`); tests build both readings.
 */
export const buildCatalog = (driveSummaryCountsTowardDailyCap: boolean): Catalog => ({
  // Live.
  trip_summary: entry({
    type: 'trip_summary',
    category: 'trip_summaries',
    capClass: driveSummaryCountsTowardDailyCap ? 'standard' : 'transactional',
    priority: 'normal',
    androidChannel: TRIP_CHANNEL,
    delivery: 'local',
    producer: 'M3',
    live: true,
    ttlHours: 12,
  }),
  permission_lapsed: entry({
    type: 'permission_lapsed',
    category: 'recording',
    capClass: 'standard',
    priority: 'normal',
    androidChannel: 'recording_problems',
    delivery: 'push',
    producer: 'M4',
    live: true,
    ttlHours: 48, // ruling T4 r1: a cap-deferred lapse survives to the next day's first slot
  }),
  // Reserved: no producer, no copy yet.
  missed_drive: entry({
    type: 'missed_drive',
    category: 'recording',
    capClass: 'standard',
    priority: 'low',
    androidChannel: 'recording_problems',
    delivery: 'push',
    producer: 'unassigned',
    live: false,
    ttlHours: 24,
    window: { start: '08:00', end: '11:00' },
    weeklyLimit: 1,
  }),
  // Live (M5): produced by settlement, at most one pushed per user per local day (§R9).
  streak_milestone: entry({
    type: 'streak_milestone',
    category: 'rewards',
    capClass: 'standard',
    priority: 'low',
    androidChannel: 'rewards',
    delivery: 'push',
    producer: 'M5',
    live: true,
    ttlHours: 24,
    window: { start: '18:00', end: '20:30' },
  }),
  goal_completed: entry({
    type: 'goal_completed',
    category: 'rewards',
    capClass: 'standard',
    priority: 'low',
    androidChannel: 'rewards',
    delivery: 'push',
    producer: 'M5',
    live: true,
    ttlHours: 48,
    window: DAYTIME_WINDOW,
  }),
  level_up: entry({
    type: 'level_up',
    category: 'rewards',
    capClass: 'standard',
    priority: 'low',
    androidChannel: 'rewards',
    delivery: 'push',
    producer: 'M5',
    live: true,
    ttlHours: 48,
    window: DAYTIME_WINDOW,
  }),
  referral_qualified: entry({
    type: 'referral_qualified',
    category: 'rewards',
    capClass: 'standard',
    priority: 'normal',
    androidChannel: 'rewards',
    delivery: 'push',
    producer: 'M5',
    live: true,
    ttlHours: 48,
    window: DAYTIME_WINDOW,
  }),
  // Reserved: no producer, no copy yet.
  family_membership: entry({
    type: 'family_membership',
    category: 'family',
    capClass: 'family',
    priority: 'normal',
    androidChannel: 'family',
    delivery: 'push',
    producer: 'M6',
    live: false,
    ttlHours: 72,
  }),
  family_sharing_changed: entry({
    type: 'family_sharing_changed',
    category: 'family',
    capClass: 'family',
    priority: 'normal',
    androidChannel: 'family',
    delivery: 'push',
    producer: 'M6',
    live: false,
    ttlHours: 72,
  }),
  family_digest: entry({
    type: 'family_digest',
    category: 'family',
    capClass: 'family',
    priority: 'normal',
    androidChannel: 'family',
    delivery: 'push',
    producer: 'M6',
    live: false,
    ttlHours: 72,
  }),
  data_export_ready: entry({
    type: 'data_export_ready',
    category: 'product',
    capClass: 'standard',
    priority: 'normal',
    androidChannel: 'trips',
    delivery: 'push',
    producer: 'M8',
    live: false,
    ttlHours: 72,
  }),
  transparency_reminder: entry({
    type: 'transparency_reminder',
    category: 'family',
    capClass: 'promo',
    priority: 'low',
    androidChannel: 'family',
    delivery: 'push',
    producer: 'M6',
    live: false,
    ttlHours: 168,
  }),
});

export const CATALOG: Catalog = buildCatalog(DRIVE_SUMMARY_COUNTS_TOWARD_DAILY_CAP);

/** The live types, in catalog order. Equals the `inbox.type` CHECK (Task 20 asserts it). */
export const LIVE_TYPES = [
  'trip_summary',
  'permission_lapsed',
  'streak_milestone',
  'goal_completed',
  'level_up',
  'referral_qualified',
] as const;
export type LiveType = (typeof LIVE_TYPES)[number];

/**
 * Whether a notification of `type` uses up one of the day's `DAILY_CAP.nonFamilyPerDay`. Reads
 * `capClass` and nothing else, so it and every other reader of `capClass` agree.
 */
export function countsTowardDailyCap(type: NotificationType, catalog: Catalog = CATALOG): boolean {
  return !CAP_EXEMPT_CLASSES.includes(catalog[type].capClass);
}

// ——— payloads (live types only) ———

/*
 * The rewards vocabulary, written out here because the catalog imports nothing but `zod` (its Deno
 * copy needs no import rewrite). `src/notifications/__tests__/rewardsParity.test.ts` pins each list
 * to the rewards rules in `packages/scoring` (`GOAL_CATEGORIES`, `CHALLENGES`, `BADGES`, `LEVELS`).
 */

/** The weekly goal's categories, in the rules' tie order. */
export const REWARD_GOAL_CATEGORIES = ['phone', 'speeding', 'braking', 'cornering', 'accel'] as const;
/** The four personal challenges. */
export const REWARD_CHALLENGE_IDS = ['phone_down', 'within_limit', 'smooth_ride', 'safe_run'] as const;
/** The 16 badges. An id this build does not know (a newer server) fails the schema: no copy. */
export const REWARD_BADGE_IDS = [
  'safe_days_7',
  'safe_days_30',
  'safe_days_100',
  'phone_free_days_10',
  'phone_free_days_50',
  'phone_free_days_200',
  'smooth_days_7',
  'smooth_days_30',
  'smooth_days_100',
  'weekly_goals_1',
  'weekly_goals_5',
  'weekly_goals_20',
  'challenges_1',
  'challenges_3',
  'challenges_10',
  'referrals_1',
] as const;
export const REWARD_BADGE_TIERS = ['bronze', 'silver', 'gold'] as const;
/** The six classes, level 1 first; `REWARD_LEVEL_NAMES[level - 1]` is a level's name. */
export const REWARD_LEVEL_NAMES = ['Learner', 'Steady', 'Smooth', 'Focused', 'Road-wise', 'Mentor'] as const;

const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pointsSchema = z.number().int().min(1).max(1000);

export const PayloadSchemas = {
  trip_summary: z
    .object({
      clientTripId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      startedAt: z.string(),
      endedAt: z.string(),
      distanceM: z.number().min(0),
      status: z.enum(['provisional', 'final', 'unscored']),
      roleUnknown: z.boolean(),
      /**
       * `TripSummaryFacts.scorableIfDriver`, when the producer knows it. Absent reads as false: the
       * copy then makes no scoring promise (ruling T4 I2).
       */
      scorableIfDriver: z.boolean().optional(),
    })
    .strict(),
  permission_lapsed: z
    .object({
      permission: z.enum(['location_always', 'location', 'motion']),
      platform: z.enum(['ios', 'android']),
      deviceId: z.string().max(128),
    })
    .strict(),
  streak_milestone: z
    .object({
      days: z.number().int().min(1).max(10000),
      reachedOn: dayKeySchema,
    })
    .strict(),
  goal_completed: z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('weekly_goal'),
        category: z.enum(REWARD_GOAL_CATEGORIES),
        weekStart: dayKeySchema,
        points: pointsSchema,
        /** Met on every day driven rather than on four (§R5's prorated close). */
        prorated: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('challenge'),
        challengeId: z.enum(REWARD_CHALLENGE_IDS),
        points: pointsSchema,
      })
      .strict(),
  ]),
  level_up: z
    .discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('level'),
          level: z.number().int().min(2).max(6),
          name: z.enum(REWARD_LEVEL_NAMES),
        })
        .strict(),
      z
        .object({
          kind: z.literal('badge'),
          badgeId: z.enum(REWARD_BADGE_IDS),
          tier: z.enum(REWARD_BADGE_TIERS),
        })
        .strict(),
    ])
    // A class is announced by its own name: a mismatched pair has nothing true to say.
    .refine((p) => p.kind !== 'level' || REWARD_LEVEL_NAMES[p.level - 1] === p.name),
  referral_qualified: z
    .object({
      role: z.enum(['invitee', 'referrer']),
      points: pointsSchema,
    })
    .strict(),
} as const;

export type TripSummaryPayload = z.infer<typeof PayloadSchemas.trip_summary>;
export type PermissionLapsedPayload = z.infer<typeof PayloadSchemas.permission_lapsed>;
export type StreakMilestonePayload = z.infer<typeof PayloadSchemas.streak_milestone>;
export type GoalCompletedPayload = z.infer<typeof PayloadSchemas.goal_completed>;
export type LevelUpPayload = z.infer<typeof PayloadSchemas.level_up>;
export type ReferralQualifiedPayload = z.infer<typeof PayloadSchemas.referral_qualified>;

// ——— copy ———

export interface LocalCopy {
  title: string;
  body: string;
  url: string;
  /** The *I drove / Passenger* action category, only when the driver must say who drove. */
  categoryId?: 'trip_role';
  channelId: typeof TRIP_CHANNEL;
}

export interface PushCopy {
  title: string;
  body: string;
  url: string;
  channelId: AndroidChannel;
}

export interface InboxCopy {
  title: string;
  body: string;
  url: string;
}

export interface TripSummaryFacts {
  clientTripId: string;
  distanceM: number;
  roleUnknown: boolean;
  /**
   * Whether this drive would be scored if the driver says *I drove*: not too short and not grade C
   * (ruling T4 I2). `role_unknown` masks both in the scorer, so the notifier finds out by re-running
   * the gate with `role: 'driver'`. Only when true may the copy say "so it can be scored".
   */
  scorableIfDriver: boolean;
  /** How many drives this notification announces (M3 batches drives that end close together). */
  count: number;
}

const METERS_PER_MILE = 1609.344;

/** "3.2" under ten miles, whole miles above; null when there is no distance worth naming. */
function miles(distanceM: number): string | null {
  const mi = distanceM / METERS_PER_MILE;
  if (!Number.isFinite(mi) || mi < 0.05) return null;
  return mi < 9.95 ? mi.toFixed(1) : String(Math.round(mi));
}

/**
 * The drive-summary notification, the one copy M3's notifier shows. No score (provisional at
 * finalize), no places. A batch goes to the list, where each drive — role-unknown ones included —
 * is answered on its own.
 */
export function renderLocal(type: 'trip_summary', facts: TripSummaryFacts): LocalCopy {
  void type;
  if (facts.count >= 2) {
    return {
      title: `${facts.count} drives are ready`,
      body: 'Tap to see how they went.',
      url: '/trips',
      channelId: TRIP_CHANNEL,
    };
  }
  const mi = miles(facts.distanceM);
  const url = `/trips/${facts.clientTripId}/summary`;
  if (facts.roleUnknown) {
    return {
      title: 'Were you driving?',
      body: `Tell us who drove ${mi === null ? 'this trip' : `your ${mi} mi trip`}${
        facts.scorableIfDriver ? ' so it can be scored' : ''
      }.`,
      url,
      categoryId: 'trip_role',
      channelId: TRIP_CHANNEL,
    };
  }
  return {
    title: 'Drive summary ready',
    body:
      mi === null
        ? 'Your drive is ready. Tap to see how it went.'
        : `Your ${mi} mi drive is ready. Tap to see how it went.`,
    url,
    channelId: TRIP_CHANNEL,
  };
}

const LAPSE_COPY: Record<PermissionLapsedPayload['permission'], { title: string; body: string }> = {
  location_always: {
    title: 'Automatic recording is off',
    body: "RoadWise can't start drives on its own right now. Tap to fix it.",
  },
  location: {
    title: 'Drive recording is off',
    body: "Location access is off, so drives can't be recorded. Tap to fix it.",
  },
  motion: {
    title: 'Drive detection needs attention',
    body: 'Motion access is off, so drives are harder to detect. Tap to fix it.',
  },
};

/**
 * The rewards notifications' words and screens. Each names a settled value only (settlement is
 * final, so the words never go stale), and no place, drive or person (§11.1 rule 5).
 */
function rewardsCopy(type: NotificationType, payload: unknown): { title: string; body: string; url: string } | null {
  switch (type) {
    case 'streak_milestone': {
      const p = PayloadSchemas.streak_milestone.safeParse(payload);
      if (!p.success) return null;
      const n = p.data.days;
      return { title: `${n}-day safe streak`, body: `Your safe-day streak just reached ${n}. Tap to see it.`, url: '/rewards' };
    }
    case 'goal_completed': {
      const p = PayloadSchemas.goal_completed.safeParse(payload);
      if (!p.success) return null;
      if (p.data.kind === 'challenge') {
        return {
          title: 'Challenge complete',
          body: `You finished a challenge. +${p.data.points} points.`,
          url: '/rewards/challenges',
        };
      }
      return {
        title: 'Weekly goal done',
        body: p.data.prorated
          ? `You met your goal on every day you drove this week. +${p.data.points} points.`
          : `You met this week's goal. +${p.data.points} points.`,
        url: '/rewards/goal',
      };
    }
    case 'level_up': {
      const p = PayloadSchemas.level_up.safeParse(payload);
      if (!p.success) return null;
      if (p.data.kind === 'badge') {
        return {
          title: 'New badge',
          body: `You earned a ${p.data.tier} badge. Tap to see it.`,
          url: '/rewards/badges',
        };
      }
      return {
        title: `New class: ${p.data.name}`,
        body: `Your RoadWise card now shows ${p.data.name}.`,
        url: '/rewards',
      };
    }
    case 'referral_qualified': {
      const p = PayloadSchemas.referral_qualified.safeParse(payload);
      if (!p.success) return null;
      return p.data.role === 'invitee'
        ? {
          title: "Your friend's code counts",
          body: `You finished 3 scored drives. +${p.data.points} points.`,
          url: '/rewards/invite',
        }
        : {
          title: 'An invite counts',
          body: `One of your invites counts now. +${p.data.points} points.`,
          url: '/rewards/invite',
        };
    }
    default:
      return null;
  }
}

/**
 * Push copy for a live `delivery: 'push'` type. Null for a local type (never pushed), a non-live
 * type (no copy yet) and a payload that fails its schema (nothing true to say).
 */
export function renderPush(type: NotificationType, payload: unknown, catalog: Catalog = CATALOG): PushCopy | null {
  const e = catalog[type];
  if (!e.live || e.delivery !== 'push') return null;
  if (type === 'permission_lapsed') {
    const p = PayloadSchemas.permission_lapsed.safeParse(payload);
    if (!p.success) return null;
    return { ...LAPSE_COPY[p.data.permission], url: '/permissions', channelId: e.androidChannel };
  }
  const words = rewardsCopy(type, payload);
  return words === null ? null : { ...words, channelId: e.androidChannel };
}

/**
 * The inbox row's base copy. A drive summary is built from `renderLocal` with `count: 1`, so the
 * words match the notification the driver saw; the inbox (Task 6) then replaces the variant from
 * the trip's current state. Null where `renderPush` would be null for a pushed type.
 */
export function renderInboxBase(type: NotificationType, payload: unknown): InboxCopy | null {
  if (type === 'trip_summary') {
    const p = PayloadSchemas.trip_summary.safeParse(payload);
    if (!p.success) return null;
    const { title, body, url } = renderLocal('trip_summary', {
      clientTripId: p.data.clientTripId,
      distanceM: p.data.distanceM,
      roleUnknown: p.data.roleUnknown,
      scorableIfDriver: p.data.scorableIfDriver ?? false,
      count: 1,
    });
    return { title, body, url };
  }
  const pushed = renderPush(type, payload);
  return pushed === null ? null : { title: pushed.title, body: pushed.body, url: pushed.url };
}

/**
 * Promises and claims no notification may make (rev1: m, narrowed to promises): score guarantees,
 * deletion and export (M8 is not built), streak pressure (§11.1 rule 6), points as money or
 * anything redeemable (Global Constraints, honesty b: points track progress, they aren't money),
 * and exclamation marks (factual and warm, not loud). Rewards and points themselves are named
 * freely now that M5 builds them.
 */
export const BANNED_COPY: readonly RegExp[] = [
  /never lowers|driving less|nothing is lost|can(no|')t go down|never decays/i,
  /(can|will) delete|delete (everything|your)|export your|download your data/i,
  /lose your streak|about to lose|hurry|last chance/i,
  // "money" is refused everywhere except inside the one sentence that denies it, the rewards copy's
  // NOT_MONEY, "Points track your progress in RoadWise. They aren't money." (M5 T7 ruling 2). The
  // allowance is exact: that sentence word for word, and no other mention of money.
  /\$|\bcash\b|(?<!Points track your progress in RoadWise\. They aren't )money|(?<=Points track your progress in RoadWise\. They aren't )money(?!\.)|dollars?|gift ?cards?|redeem|prizes?|insurance|discounts?|\bworth\b|\bwin\b/i,
  /!/,
];
