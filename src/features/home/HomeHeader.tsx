import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import { formatRating } from '@/lib/rating';
import { distanceWord, formatDistanceProgress } from '@/lib/units';
import {
  Button,
  Card,
  formatPointsValue,
  ProgressBar,
  ProgressRing,
  Skeleton,
  StreakFlame,
  Text,
  useTheme,
} from '@/ui';

import { RANKED_MIN_MILES } from '@scoring';

type Progress = MySummary['progress'];

/** Share of the way from this level's floor to the next (1 at the cap); the level follows the points total. */
export function levelProgress(p: Pick<Progress, 'points' | 'level_floor' | 'level_next'>): number {
  if (p.level_next === null) return 1;
  const span = p.level_next - p.level_floor;
  return span > 0 ? Math.min(1, Math.max(0, (p.points - p.level_floor) / span)) : 0;
}

/** Points still to earn for the next level; null at the top level. */
export function pointsToNext(p: Pick<Progress, 'points' | 'level_next'>): number | null {
  return p.level_next === null ? null : Math.max(0, p.level_next - p.points);
}

/** The card's main block: the level big, how far to the next one, and the bar toward it. */
function LevelBlock({ progress }: { progress: Progress }) {
  const t = useTheme();
  const toNext = pointsToNext(progress);
  const next = progress.level + 1;
  const line = toNext === null ? 'Top level' : `${formatPointsValue(toNext)} pts to level ${next}`;
  return (
    <View
      style={{ gap: t.space.xs }}
      testID="level"
      accessible
      accessibilityLabel={`Level ${progress.level}${toNext === null ? ', top level' : `, ${formatPointsValue(toNext)} points to level ${next}`}`}
    >
      <Text variant="label" tone="muted">
        Level
      </Text>
      <Text variant="hero" testID="level-value">
        {progress.level}
      </Text>
      <Text variant="subhead" tone="muted" testID="level-next">
        {line}
      </Text>
      <ProgressBar value={levelProgress(progress)} accessibilityLabel={`Level ${progress.level} progress`} height={6} style={{ maxWidth: 200 }} />
    </View>
  );
}

/**
 * The Safety Rating in the card's corner: a ring round the whole number (the rating out of 100),
 * or "—" with the distance still to drive before there is one. One tap opens Analytics.
 */
function RatingBadge({ progress, onPress }: { progress: Progress; onPress: () => void }) {
  const t = useTheme();
  const units = useUnits();
  const ranked = progress.ranked && progress.safety_rating !== null;
  const toRank = formatDistanceProgress(progress.miles_30d, RANKED_MIN_MILES, units);
  const value = ranked ? formatRating(progress.safety_rating, true) : '—';
  const label = ranked
    ? `Safety Rating ${value} out of 100`
    : `Safety Rating: none yet. ${toRank.done} of ${toRank.target} ${distanceWord(units)} in the last 30 days to get one`;
  return (
    <Pressable
      onPress={onPress}
      testID="rating-badge"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens Analytics"
      hitSlop={t.space.sm}
      style={({ pressed }) => ({ alignItems: 'center', gap: t.space.xs, opacity: pressed ? 0.8 : 1, minWidth: t.size.touch, maxWidth: 104 })}
    >
      <View style={{ borderRadius: 36, backgroundColor: t.colors.surfaceRaised }}>
        <ProgressRing
          value={ranked ? (progress.safety_rating ?? 0) / 100 : toRank.target > 0 ? toRank.done / toRank.target : 0}
          size={72}
          strokeWidth={5}
          tone="accent"
          accessibilityLabel={ranked ? 'Safety Rating' : 'Distance toward a Safety Rating'}
        >
          <Text
            variant="stat"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.6}
            style={{ maxWidth: 72 - 2 * 5 - 4, textAlign: 'center' }}
            testID="rating-value"
          >
            {value}
          </Text>
        </ProgressRing>
      </View>
      <Text variant="label" tone="muted" style={{ textAlign: 'center' }} testID="rating">
        Safety Rating
      </Text>
      {ranked ? null : (
        <Text variant="caption" tone="muted" style={{ textAlign: 'center' }} testID="rating-to-rank">
          {toRank.text}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Home's drive card, the screen's hero: the hour's sky with your level big and the bar to the
 * next, the Safety Rating in the corner (it opens Analytics), and Start drive across its foot.
 * While progress loads or fails the card says so; Start stays in it either way.
 */
export function HomeHeader({
  summary,
  loading,
  error,
  onRating,
  onRetry,
  start,
}: {
  summary: MySummary | undefined;
  loading: boolean;
  error: boolean;
  /** The Safety Rating badge opens Analytics. */
  onRating: () => void;
  onRetry: () => void;
  /** Start drive, at the foot of the card (absent while a drive records). */
  start?: ReactNode;
}) {
  const t = useTheme();

  const top = !summary ? (
    loading || !error ? (
      <View style={{ gap: t.space.md }} testID="home-header-loading">
        <Skeleton width={120} height={14} />
        <Skeleton width={160} height={56} />
      </View>
    ) : (
      <View style={{ gap: t.space.md }} testID="home-header-error">
        <Text variant="headline">{"Couldn't load your progress"}</Text>
        <Text variant="subhead" tone="muted">
          Your drives still record. Check your connection and try again.
        </Text>
        <Button label="Try again" variant="secondary" size="sm" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
      </View>
    )
  ) : (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space.md }}>
      <View style={{ flex: 1 }}>
        <LevelBlock progress={summary.progress} />
      </View>
      <RatingBadge progress={summary.progress} onPress={onRating} />
    </View>
  );

  return (
    <Card variant="hero" testID="home-header" style={{ minHeight: start ? 280 : 200 }}>
      {top}
      <View style={{ flex: 1, minHeight: t.space.xl }} />
      {start}
    </Card>
  );
}

/** One stat pill in the progress row: paper, round-ended, the number in the display face. */
function StatPill({ children, accessibilityLabel, testID }: { children: ReactNode; accessibilityLabel?: string; testID?: string }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      style={{
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.sm,
        paddingHorizontal: t.space.lg,
        paddingVertical: t.space.sm,
        borderRadius: t.radius.pill,
        borderCurve: 'continuous',
        backgroundColor: t.colors.surface,
        borderWidth: t.scheme === 'dark' ? 1 : 0,
        borderColor: t.colors.divider,
        boxShadow: t.elevation.card,
      }}
    >
      {children}
    </View>
  );
}

/**
 * The progress row under the greeting: two paper pills, the streak with its multiplier and your
 * points. The at-risk line follows when the streak needs a clean drive, on its own paper ground:
 * on a short phone or at large text it reaches the sky's fade, where no ink is repaired.
 */
export function ProgressStrip({ summary }: { summary: MySummary }) {
  const t = useTheme();
  const p = summary.progress;
  const streakState = p.at_risk ? 'atRisk' : 'active';
  const atRisk = p.at_risk ? <AtRiskLine /> : null;
  return (
    <View style={{ gap: t.space.sm }} testID="home-progress">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -t.space.lg, overflow: 'visible' }}
        contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.lg, paddingVertical: t.space.xs }}
      >
        <StatPill>
          <StreakFlame count={p.streak} multiplier={p.next_mult} state={streakState} testID="home-streak" />
        </StatPill>
        <StatPill accessibilityLabel={`${formatPointsValue(p.points)} points`}>
          <Text variant="title2" testID="home-points" style={{ fontVariant: ['tabular-nums'] }}>
            {formatPointsValue(p.points)}
          </Text>
          <Text variant="label" tone="muted">
            Points
          </Text>
        </StatPill>
      </ScrollView>
      {atRisk}
    </View>
  );
}

function AtRiskLine() {
  const t = useTheme();
  return (
    <View
      testID="home-at-risk-line"
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.xs,
        paddingHorizontal: t.space.md,
        paddingVertical: t.space.sm,
        borderRadius: t.radius.lg,
        borderCurve: 'continuous',
        backgroundColor: t.colors.surface,
        borderWidth: t.scheme === 'dark' ? 1 : 0,
        borderColor: t.colors.divider,
        boxShadow: t.elevation.card,
      }}
    >
      <Ionicons name="warning" size={t.size.iconSm} color={t.colors.warning} accessible={false} />
      <Text variant="footnote" tone="warning" testID="home-at-risk" style={{ flexShrink: 1 }}>
        Streak at risk: make your next drive clean to keep it.
      </Text>
    </View>
  );
}
