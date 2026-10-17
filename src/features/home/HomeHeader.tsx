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

/** The league in the card's corner: a round paper button holding the tier badge, the rank under it. */
function LeagueButton({ league, onLeagues }: { league: MySummary['league']; onLeagues: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onLeagues}
      testID="league-badge"
      accessibilityRole="button"
      accessibilityLabel={`${TIER_LABEL[league.tier]} league${league.rank ? `, rank ${league.rank} of ${league.size}` : ''}`}
      accessibilityHint="Opens Leagues"
      hitSlop={t.space.sm}
      style={({ pressed }) => ({ alignItems: 'center', gap: t.space.xs, opacity: pressed ? 0.8 : 1, minWidth: t.size.touch })}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: t.colors.surfaceRaised,
          borderWidth: 1,
          borderColor: t.colors.divider,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TierBadge tier={league.tier} size="md" showLabel={false} />
      </View>
      <Text variant="label" tone="muted">
        {TIER_LABEL[league.tier]}
      </Text>
      <Text variant="headline">{league.rank ? `#${league.rank}` : '—'}</Text>
    </Pressable>
  );
}

/**
 * Home's drive card, the screen's hero: the hour's sky with the Safety Rating big (or how far from
 * ranked) and the league in the corner, and Start drive across its foot. While progress loads or
 * fails the card says so; Start stays in it either way.
 */
export function HomeHeader({
  summary,
  loading,
  error,
  onLeagues,
  onRetry,
  start,
}: {
  summary: MySummary | undefined;
  loading: boolean;
  error: boolean;
  onLeagues: () => void;
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
        <Rating progress={summary.progress} />
      </View>
      <LeagueButton league={summary.league} onLeagues={onLeagues} />
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
 * The progress row under the greeting, in pills that scroll sideways: the streak with its
 * multiplier, freezes, points and the level with its bar. The at-risk line follows when the
 * streak needs a clean drive.
 */
export function ProgressStrip({ summary }: { summary: MySummary }) {
  const t = useTheme();
  const p = summary.progress;
  const toNext = p.level_next === null ? null : Math.max(0, p.level_next - p.lifetime);
  const streakState = p.at_risk ? 'atRisk' : 'active';
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
        <StatPill>
          <FreezeCount count={p.freezes} testID="home-freezes" />
        </StatPill>
        <StatPill accessibilityLabel={`${formatPointsValue(p.points)} points`}>
          <Text variant="title2" testID="home-points" style={{ fontVariant: ['tabular-nums'] }}>
            {formatPointsValue(p.points)}
          </Text>
          <Text variant="label" tone="muted">
            Points
          </Text>
        </StatPill>
        <StatPill accessibilityLabel={`Level ${p.level}${toNext === null ? ', top level' : `, ${toNext} points to level ${p.level + 1}`}`}>
          <View style={{ gap: t.space.xs, minWidth: 112 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs }}>
              <Text variant="title3">Lvl {p.level}</Text>
              <Text variant="footnote" tone="muted">
                {toNext === null ? 'Top level' : `${formatPointsValue(toNext)} to ${p.level + 1}`}
              </Text>
            </View>
            <ProgressBar value={levelProgress(p)} accessibilityLabel={`Level ${p.level} progress`} height={6} />
          </View>
        </StatPill>
      </ScrollView>
      {p.at_risk ? (
        <Text variant="footnote" tone="warning" testID="home-at-risk">
          Streak at risk: make your next drive clean to keep it.
        </Text>
      ) : null}
    </View>
  );
}
