import { Pressable, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import { formatRating } from '@/lib/rating';
import { distanceWord, formatDistanceProgress } from '@/lib/units';
import {
  Button,
  Card,
  formatPointsValue,
  FreezeCount,
  ProgressBar,
  Skeleton,
  StreakFlame,
  Text,
  TierBadge,
  TIER_LABEL,
  TrendArrow,
  useTheme,
  type TrendDirection,
} from '@/ui';

import { RANKED_MIN_MILES } from '@scoring';

/** Rating change over 7 days → an arrow; under 0.1 reads as no change. Null → no arrow. */
export function ratingTrend(delta: number | null): TrendDirection | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  if (Math.abs(delta) < 0.1) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

/** Share of the way from this level's floor to the next (1 at the cap). */
export function levelProgress(p: Pick<MySummary['progress'], 'lifetime' | 'level_floor' | 'level_next'>): number {
  if (p.level_next === null) return 1;
  const span = p.level_next - p.level_floor;
  return span > 0 ? (p.lifetime - p.level_floor) / span : 0;
}

function Rating({ progress }: { progress: MySummary['progress'] }) {
  const t = useTheme();
  const units = useUnits();
  const trend = ratingTrend(progress.rating_trend);
  if (!progress.ranked || progress.safety_rating === null) {
    const toRank = formatDistanceProgress(progress.miles_30d, RANKED_MIN_MILES, units);
    return (
      <View style={{ gap: t.space.xs }} testID="rating-unranked" accessible accessibilityLabel={`Safety Rating: unranked. ${toRank.done} of ${toRank.target} ${distanceWord(units)} in the last 30 days to get ranked`}>
        <Text variant="label" tone="muted">
          Safety Rating
        </Text>
        <Text variant="display">Unranked</Text>
        <Text variant="subhead" tone="muted">
          {toRank.text} to get ranked
        </Text>
        <ProgressBar value={toRank.done / toRank.target} accessibilityLabel="Distance toward a Safety Rating" height={6} style={{ maxWidth: 200 }} />
      </View>
    );
  }
  const rating = formatRating(progress.safety_rating, true);
  const delta = progress.rating_trend ?? 0;
  const trendWords = trend === null ? '' : trend === 'flat' ? ', no change this week' : `, ${trend} ${Math.abs(delta).toFixed(1)} this week`;
  return (
    <View style={{ gap: t.space.xs }} testID="rating" accessible accessibilityLabel={`Safety Rating ${rating} out of 100${trendWords}`}>
      <Text variant="label" tone="muted">
        Safety Rating
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Text variant="hero" testID="rating-value">
          {rating}
        </Text>
        {trend ? <TrendArrow direction={trend} better="up" accessible={false} testID={`rating-trend-${trend}`} /> : null}
      </View>
    </View>
  );
}

/**
 * The top of Home: how am I doing, at a glance. Safety Rating big (or how far from ranked),
 * then points, level, streak with its multiplier, freezes, and the league badge with rank.
 */
export function HomeHeader({
  summary,
  loading,
  error,
  onLeagues,
  onRetry,
}: {
  summary: MySummary | undefined;
  loading: boolean;
  error: boolean;
  onLeagues: () => void;
  onRetry: () => void;
}) {
  const t = useTheme();

  if (!summary) {
    return (
      <Card variant="hero" testID="home-header">
        {loading || !error ? (
          <View style={{ gap: t.space.md }} testID="home-header-loading">
            <Skeleton width={120} height={14} />
            <Skeleton width={160} height={56} />
            <Skeleton width="100%" height={44} />
          </View>
        ) : (
          <View style={{ gap: t.space.md }} testID="home-header-error">
            <Text variant="headline">{"Couldn't load your progress"}</Text>
            <Text variant="subhead" tone="muted">
              Your drives still record. Check your connection and try again.
            </Text>
            <Button label="Try again" variant="secondary" size="sm" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
          </View>
        )}
      </Card>
    );
  }

  const p = summary.progress;
  const lg = summary.league;
  const toNext = p.level_next === null ? null : Math.max(0, p.level_next - p.lifetime);
  const streakState = p.at_risk ? 'atRisk' : 'active';

  return (
    <Card variant="hero" testID="home-header">
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space.md }}>
        <View style={{ flex: 1 }}>
          <Rating progress={p} />
        </View>
        <Pressable
          onPress={onLeagues}
          testID="league-badge"
          accessibilityRole="button"
          accessibilityLabel={`${TIER_LABEL[lg.tier]} league${lg.rank ? `, rank ${lg.rank} of ${lg.size}` : ''}`}
          accessibilityHint="Opens Leagues"
          hitSlop={t.space.sm}
          style={({ pressed }) => ({ alignItems: 'center', gap: t.space.xs, opacity: pressed ? 0.8 : 1, minWidth: t.size.touch })}
        >
          <TierBadge tier={lg.tier} size="lg" showLabel={false} />
          <Text variant="label" tone="muted">
            {TIER_LABEL[lg.tier]}
          </Text>
          <Text variant="headline">{lg.rank ? `#${lg.rank}` : '—'}</Text>
        </Pressable>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.lg, paddingTop: t.space.sm }}>
        <View accessible accessibilityLabel={`${formatPointsValue(p.points)} points`} style={{ minWidth: 88 }}>
          <Text variant="stat" testID="home-points">
            {formatPointsValue(p.points)}
          </Text>
          <Text variant="label" tone="muted">
            Points
          </Text>
        </View>
        <View
          accessible
          accessibilityLabel={`Level ${p.level}${toNext === null ? ', top level' : `, ${toNext} points to level ${p.level + 1}`}`}
          style={{ flex: 1, minWidth: 120, gap: t.space.xs }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs }}>
            <Text variant="stat">Lvl {p.level}</Text>
            <Text variant="footnote" tone="muted">
              {toNext === null ? 'Top level' : `${formatPointsValue(toNext)} to ${p.level + 1}`}
            </Text>
          </View>
          <ProgressBar value={levelProgress(p)} accessibilityLabel={`Level ${p.level} progress`} height={6} />
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: t.space.md }}>
        <StreakFlame count={p.streak} multiplier={p.next_mult} state={streakState} testID="home-streak" />
        <FreezeCount count={p.freezes} testID="home-freezes" />
      </View>
      {p.at_risk ? (
        <Text variant="footnote" tone="warning" testID="home-at-risk">
          Streak at risk: make your next drive clean to keep it.
        </Text>
      ) : null}
    </Card>
  );
}
