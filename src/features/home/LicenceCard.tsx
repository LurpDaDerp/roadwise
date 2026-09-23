import { Ionicons } from '@expo/vector-icons';
import { CONSTANTS } from '@scoring';
import { useRouter, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { useDataSource, useLongTermScore, useTrips, type LongTermScoreView } from '@/data/queries';
import { pointsText } from '@/features/rewards/copy/common';
import { RewardsOfflineError } from '@/features/rewards/api';
import { useRewards } from '@/features/rewards/useRewards';
import { classView, streakView, type ClassView, type StreakView } from '@/features/rewards/viewModel';
import { Field, FieldText } from '@/features/trips';
import { deviceZone } from '@/lib/deviceZone';
import { dayKey } from '@/lib/time';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';
import { bandLabel, formatScore, Stamp } from '@/ui/charts';

import { homeCopy } from './copy';
import { formatAsOfDay } from './format';

const copy = homeCopy.card;

/** Scored drives before the long-term score exists (§9.6). */
const DRIVES_NEEDED = CONSTANTS.LONG_TERM_MIN_TRIPS;

/** The rewards tab (F1). */
const REWARDS_HREF = '/rewards' as Href;

/**
 * The learning period (product spec §10: the first drives, while the long-term score is still
 * provisional). Decided only from what is known: never while a restore is owed, since the device
 * does not yet know the driver's history, and a score the server has printed ends it.
 */
export function inLearningPeriod(view: LongTermScoreView): boolean {
  switch (view.state) {
    case 'restoring':
      return false;
    case 'building':
      return true;
    case 'waiting':
      return view.scoredDrives < CONSTANTS.LEARNING_PERIOD_TRIPS;
    case 'score':
      return view.provisional;
  }
}

/** The score field's printed lines and its one spoken label, per state (R9). */
function scoreText(view: LongTermScoreView, now: number) {
  switch (view.state) {
    case 'score': {
      const numeral = view.score === null ? '—' : formatScore(view.score);
      const band = view.band === null ? '' : bandLabel(view.band);
      const day = view.asOfDay === null ? null : formatAsOfDay(view.asOfDay, now);
      const pending = view.pendingDrives > 0 ? copy.pending(view.pendingDrives) : null;
      return {
        numeral,
        band,
        lines: [day ? copy.asOf(day.printed) : null, pending].filter((l): l is string => !!l),
        spoken: [copy.spoken.score(numeral, band, day?.spoken ?? ''), pending]
          .filter(Boolean)
          .join('. '),
      };
    }
    case 'building': {
      const text =
        view.scoredDrives >= DRIVES_NEEDED
          ? copy.buildingTime
          : homeCopy.building(view.scoredDrives, DRIVES_NEEDED);
      const pending = view.pendingDrives > 0 ? copy.pending(view.pendingDrives) : null;
      return {
        numeral: '—',
        band: '',
        lines: [text, pending].filter((l): l is string => !!l),
        spoken: [copy.spoken.building(text), pending].filter(Boolean).join('. '),
      };
    }
    case 'waiting':
      return { numeral: '—', band: '', lines: [copy.waiting], spoken: copy.spoken.waiting };
    case 'restoring':
      return { numeral: '—', band: '', lines: [copy.restoring], spoken: copy.spoken.restoring };
  }
}

function ScoreField({ view }: { view: LongTermScoreView }) {
  const th = useTheme();
  const { now } = useDataSource();
  const text = scoreText(view, now());
  const scored = view.state === 'score';

  return (
    <Field label={copy.score} style={{ flexGrow: 2, flexBasis: 160 }}>
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={text.spoken}
        testID="licence-score"
        style={{ gap: th.space.xs }}
      >
        {scored ? (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: th.space.sm }}>
            <FieldText face="numeral" variant="display" testID="licence-score-value">
              {text.numeral}
            </FieldText>
            <Text variant="headline">{text.band}</Text>
          </View>
        ) : (
          <FieldText face="numeral" variant="display" tone="subtle">
            {text.numeral}
          </FieldText>
        )}
        {text.lines.map((line) => (
          <Text key={line} variant="footnote" tone="muted">
            {line}
          </Text>
        ))}
      </View>
    </Field>
  );
}

/** The rewards snapshot as the card's fields read it: still loading, unreadable, or the values. */
type RewardsFields =
  | { state: 'loading' }
  | { state: 'unread'; offline: boolean; retry: () => void }
  | {
      state: 'ready';
      safeDays: number;
      /** `progress.rewards_start` (a day key): settled days count only from it. */
      rewardsStart: string | null;
      klass: ClassView;
      streak: StreakView;
      points: number;
    };

/**
 * The card's rewards values, straight from the server's settled `progress` row (or this phone's
 * saved copy of it when offline). Nothing is counted here: SAFE DAYS is `progress.safe_days`
 * (Decision D13, so the card and the badges agree), the streak is `progress.streak_days`, and a
 * driver with no progress row yet is a Learner with nothing — which is true, not a guess.
 */
function useRewardsFields(): RewardsFields {
  const rewards = useRewards();
  if (rewards.data) {
    const progress = rewards.data.snapshot.progress;
    return {
      state: 'ready',
      safeDays: progress?.safe_days ?? 0,
      rewardsStart: progress?.rewards_start ?? null,
      klass: classView(progress),
      streak: streakView(progress),
      points: progress?.points ?? 0,
    };
  }
  if (rewards.error) {
    return {
      state: 'unread',
      offline: rewards.error instanceof RewardsOfflineError,
      retry: () => void rewards.refetch(),
    };
  }
  return { state: 'loading' };
}

const unreadReason = (fields: { offline: boolean }) =>
  fields.offline ? copy.rewardsOffline : copy.rewardsError;

/** The latest instant a trip can start and still fall on a day before `day` in any zone (UTC+14). */
const beforeDayBound = (day: string) => Date.parse(`${day}T00:00:00Z`) + 14 * 3_600_000;

/**
 * Whether this phone holds a drive from before `rewardsStart` (a day key, in the device's zone):
 * then SAFE DAYS, which counts settled days only from that day, says "since" so a new count never
 * reads as a lifetime one (review m1, ruled a). The drives read are the few just before the day.
 */
function useDrivesBefore(rewardsStart: string | null): boolean {
  const trips = useTrips(rewardsStart === null ? { to: -1, limit: 0 } : { to: beforeDayBound(rewardsStart), limit: 20 });
  if (rewardsStart === null || !trips.data) return false;
  return trips.data.some((t) => dayKey(new Date(t.startedAt), deviceZone()) < rewardsStart);
}

function SafeDaysField({ rewards }: { rewards: RewardsFields }) {
  const { now } = useDataSource();
  const rewardsStart = rewards.state === 'ready' ? rewards.rewardsStart : null;
  const since = useDrivesBefore(rewardsStart) && rewardsStart !== null ? formatAsOfDay(rewardsStart, now()) : null;
  let body;
  if (rewards.state === 'ready') {
    body = (
      <View
        accessible
        accessibilityLabel={copy.spoken.safeDays(rewards.safeDays, since?.spoken ?? null)}
        testID="licence-safe-days"
      >
        <FieldText face="numeral" variant="title1">
          {String(rewards.safeDays)}
        </FieldText>
        {since ? (
          <Text variant="footnote" tone="muted" testID="licence-safe-days-since">
            {copy.since(since.printed)}
          </Text>
        ) : null}
      </View>
    );
  } else if (rewards.state === 'unread') {
    // The score beside it still stands; only this field says it could not be read, and why.
    body = (
      <View
        accessible
        accessibilityLabel={copy.spoken.safeDaysUnread(unreadReason(rewards))}
        testID="licence-safe-days"
      >
        <FieldText face="numeral" variant="title1" tone="subtle">
          —
        </FieldText>
      </View>
    );
  } else {
    body = <Skeleton width={48} height={34} testID="licence-safe-days-loading" />;
  }

  return (
    <Field label={copy.safeDays} style={{ flexGrow: 1, flexBasis: 96 }}>
      {body}
    </Field>
  );
}

/** One of the three printed rewards fields; the region's own label speaks for all of them. */
function RewardField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Field label={label} style={{ flexGrow: 1, flexBasis: 72 }}>
      {children}
    </Field>
  );
}

/** A value that could not be read: an honest dash, never a zero. */
function Dash() {
  return (
    <FieldText face="numeral" variant="title2" tone="subtle">
      —
    </FieldText>
  );
}

/**
 * CLASS, STREAK and POINTS: one pressable region, bled to the card's edges along its foot, that
 * opens the rewards tab (§7.B B1 item 4). The streak is printed as a count with its shields as
 * words beside the glyph — never colour alone, never a flame (plan C17).
 */
function RewardsRegion({ rewards }: { rewards: RewardsFields }) {
  const th = useTheme();
  const router = useRouter();

  const foot: ViewStyle = {
    marginHorizontal: -th.space.lg,
    marginBottom: -th.space.lg,
    paddingHorizontal: th.space.lg,
    paddingTop: th.space.md,
    paddingBottom: th.space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: th.colors.divider,
    gap: th.space.md,
  };
  const row: ViewStyle = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: th.space.lg };

  if (rewards.state === 'loading') {
    return (
      <View style={foot} testID="licence-rewards-loading">
        <View style={row}>
          {[copy.class, copy.streak, copy.points].map((label) => (
            <RewardField key={label} label={label}>
              <Skeleton width={56} height={28} />
            </RewardField>
          ))}
        </View>
      </View>
    );
  }

  if (rewards.state === 'unread') {
    return (
      <View style={foot} testID="licence-rewards-error">
        <View style={row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[copy.class, copy.streak, copy.points].map((label) => (
            <RewardField key={label} label={label}>
              <Dash />
            </RewardField>
          ))}
        </View>
        <Banner
          tone={rewards.offline ? 'info' : 'warning'}
          message={unreadReason(rewards)}
          action={{ label: homeCopy.retry, onPress: rewards.retry }}
          testID="licence-rewards-banner"
        />
      </View>
    );
  }

  const { klass, streak, points } = rewards;
  const best = streak.restarted ? streak.best : null;
  const spoken = copy.spoken.rewards({
    className: klass.name,
    streak: streak.days,
    best,
    shields: streak.shields,
    points: pointsText(points),
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      onPress={() => router.push(REWARDS_HREF)}
      testID="licence-rewards"
      style={({ pressed }) => [foot, pressed ? { backgroundColor: th.colors.surfaceRaised } : null]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm }}>
        <View style={[row, { flex: 1 }]}>
          <RewardField label={copy.class}>
            <FieldText variant="title2">
              {klass.name}
            </FieldText>
          </RewardField>
          <RewardField label={copy.streak}>
            <FieldText face="numeral" variant="title2">
              {String(streak.days)}
            </FieldText>
            {best !== null ? (
              <Text variant="footnote" tone="muted">
                {copy.best(best)}
              </Text>
            ) : null}
            {streak.shields > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }}>
                <Ionicons name="shield-checkmark-outline" size={14} color={th.colors.textMuted} />
                <Text variant="footnote" tone="muted">
                  {copy.shields(streak.shields)}
                </Text>
              </View>
            ) : null}
          </RewardField>
          <RewardField label={copy.points}>
            <FieldText face="numeral" variant="title2">
              {new Intl.NumberFormat('en-US').format(points)}
            </FieldText>
          </RewardField>
        </View>
        <Ionicons name="chevron-forward" size={18} color={th.colors.textSubtle} />
      </View>
    </Pressable>
  );
}

/**
 * The licence card on Home (§7.B B1, direction contract FIRST VIEWPORT): the driver's name with
 * the learning-period stamp while it lasts; the long-term SCORE as the largest numeral beside
 * SAFE DAYS; and along its foot CLASS, STREAK and POINTS as one region that opens the rewards tab.
 * The score is this phone's copy of the server's (R9), always printed with the day it was computed
 * for. SAFE DAYS, CLASS, STREAK and POINTS are the server's settled rewards (M5, D13): they load,
 * fail and go offline on their own, and never take the score with them. The weekly goal is printed
 * below the card, in the RECORD (`WeeklyFocusField`).
 */
export function LicenceCard({ name }: { name: string | null | undefined }) {
  const th = useTheme();
  const longTerm = useLongTermScore();
  const rewards = useRewardsFields();

  const view = longTerm.data;
  const learning = view ? inLearningPeriod(view) : false;
  const printedName = name?.trim() ? name.trim() : copy.noName;

  return (
    <Card variant="license" testID="licence-card">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: th.space.md,
        }}
      >
        <FieldText
          variant="title2"
          accessibilityRole="header"
          style={{ flexShrink: 1 }}
          testID="licence-name"
        >
          {printedName}
        </FieldText>
        {learning ? <Stamp kind="provisional" size="sm" testID="learning-stamp" /> : null}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
        {view ? (
          <ScoreField view={view} />
        ) : longTerm.error ? (
          <Field label={copy.score} style={{ flexGrow: 2, flexBasis: 160 }}>
            <Banner
              tone="warning"
              message={copy.readError}
              action={{ label: homeCopy.retry, onPress: () => void longTerm.refetch() }}
              testID="licence-score-error"
            />
          </Field>
        ) : (
          <Field label={copy.score} style={{ flexGrow: 2, flexBasis: 160 }}>
            <Skeleton width={96} height={46} />
          </Field>
        )}
        <SafeDaysField rewards={rewards} />
      </View>

      <RewardsRegion rewards={rewards} />
    </Card>
  );
}
