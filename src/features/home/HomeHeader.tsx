import { RANKED_MIN_MILES } from '@scoring';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useUnits } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import { formatRating } from '@/lib/rating';
import { distanceWord, formatDistanceProgress, type Units } from '@/lib/units';
import { Button, Card, ProgressRing, Skeleton, Text, TrendArrow, useFontScale, useTheme, type TrendDirection } from '@/ui';

import type { Conditions } from '@/features/weather/conditions';

import { homeCopy } from './copy';
import { WeatherReadout } from './WeatherReadout';

type Progress = MySummary['progress'];

/** Above this text size the rating's words sit under the ring instead of beside it. */
export const RATING_STACK_FONT_SCALE = 1.35;
/** The rating ring's diameter and stroke. */
const RING = 104;
const STROKE = 6;

/** The week's change in whole numbers (the rating's own rounding), or null when unknown. */
export function ratingTrend(trend: number | null | undefined): { direction: TrendDirection; line: string; word: string } | null {
  if (trend === null || trend === undefined || !Number.isFinite(trend)) return null;
  const d = Math.round(trend);
  if (d === 0) return { direction: 'flat', line: homeCopy.rating.steady, word: 'Steady' };
  return d > 0
    ? { direction: 'up', line: homeCopy.rating.up(d), word: `Up ${d}` }
    : { direction: 'down', line: homeCopy.rating.down(-d), word: `Down ${-d}` };
}

/** The distance still to drive before there is a rating ("4 of 10 mi"), or null before any drive. */
export function toRating(miles90d: number, units: Units): { fill: number; text: string; spoken: string } | null {
  if (!(miles90d > 0)) return null;
  const p = formatDistanceProgress(miles90d, RANKED_MIN_MILES, units);
  return {
    fill: p.target > 0 ? p.done / p.target : 0,
    text: homeCopy.rating.toRating(`${p.done} of ${p.target} ${units}`),
    spoken: homeCopy.rating.toRating(`${p.done} of ${p.target} ${distanceWord(units)}`),
  };
}

/**
 * The drive card's main block: the Safety Rating big in a ring, its change this week in words with
 * an arrow, and the window it covers. Unrated, the ring fills with the distance driven toward a
 * rating and holds a dash. One tap opens Analytics.
 */
export function RatingBlock({ progress, onPress }: { progress: Progress; onPress: () => void }) {
  const t = useTheme();
  const units = useUnits();
  const stacked = useFontScale() > RATING_STACK_FONT_SCALE;
  const ranked = progress.ranked && progress.safety_rating !== null;
  const value = ranked ? formatRating(progress.safety_rating, true) : '—';
  const trend = ranked ? ratingTrend(progress.rating_trend) : null;
  const toward = ranked ? null : toRating(progress.miles_90d ?? 0, units);
  const label = ranked
    ? `${homeCopy.rating.spoken(value)}.${trend ? ` ${trend.line}.` : ''}`
    : `${homeCopy.rating.none}. ${toward ? toward.spoken : homeCopy.rating.afterFirst}`;
  return (
    <Pressable
      onPress={onPress}
      testID="rating-block"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={homeCopy.rating.hint}
      style={({ pressed }) => ({
        flexDirection: stacked ? 'column' : 'row',
        alignItems: stacked ? 'flex-start' : 'center',
        gap: t.space.lg,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <ProgressRing
        value={ranked ? (progress.safety_rating ?? 0) / 100 : (toward?.fill ?? 0)}
        size={RING}
        strokeWidth={STROKE}
        tone="accent"
        accessibilityLabel={ranked ? homeCopy.rating.label : 'Distance toward a Safety Rating'}
      >
        <Text
          variant="hero"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          style={{ maxWidth: RING - 2 * STROKE - 8, textAlign: 'center' }}
          testID="rating-value"
        >
          {value}
        </Text>
      </ProgressRing>
      <View style={{ flex: stacked ? undefined : 1, gap: t.space.xs }}>
        <Text variant="label" tone="muted" testID="rating-label">
          {homeCopy.rating.label}
        </Text>
        {ranked ? (
          trend ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: t.space.xs,
              }}
              testID="rating-trend"
            >
              <TrendArrow direction={trend.direction} better="up" size={16} accessible={false} />
              <Text variant="subhead">{trend.line}</Text>
            </View>
          ) : null
        ) : (
          <>
            <Text variant="headline" testID="rating-none">
              {homeCopy.rating.none}
            </Text>
            <Text variant="subhead" tone="muted" testID="rating-to-rank">
              {toward ? toward.text : homeCopy.rating.afterFirst}
            </Text>
          </>
        )}
        <Text variant="footnote" tone="muted">
          {homeCopy.rating.window}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Home's drive card, the screen's hero: the hour's sky with the Safety Rating big in its ring, its
 * change this week, the weather now (once known) and Start drive across its foot with, on an iPhone set up for automatic
 * drives, one quiet line under it. While progress loads or fails the card says so; Start stays in
 * it either way.
 */
export function HomeHeader({
  summary,
  loading,
  error,
  onRating,
  onRetry,
  start,
  caption,
  conditions,
}: {
  summary: MySummary | undefined;
  loading: boolean;
  error: boolean;
  /** The rating block opens Analytics. */
  onRating: () => void;
  onRetry: () => void;
  /** Start drive, at the foot of the card (absent while a drive records or waits). */
  start?: ReactNode;
  /** The muted line under Start ("Or just drive…"), only with automatic drives on. */
  caption?: string | null;
  /** The weather now, above Start drive; absent until it is known. */
  conditions?: Conditions | null;
}) {
  const t = useTheme();

  const top = !summary ? (
    loading || !error ? (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.lg }} testID="home-header-loading">
        <Skeleton width={RING} height={RING} radius={RING / 2} />
        <View style={{ gap: t.space.sm }}>
          <Skeleton width={120} height={14} />
          <Skeleton width={140} height={18} />
        </View>
      </View>
    ) : (
      <View style={{ gap: t.space.md }} testID="home-header-error">
        <Text variant="headline">{"Couldn't load your rating"}</Text>
        <Text variant="subhead" tone="muted">
          Your drives still record. Check your connection and try again.
        </Text>
        <Button label="Try again" variant="secondary" size="sm" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
      </View>
    )
  ) : (
    <RatingBlock progress={summary.progress} onPress={onRating} />
  );

  return (
    <Card variant="hero" testID="home-header" style={{ minHeight: start ? 300 : 220 }}>
      {top}
      <View style={{ flex: 1, minHeight: t.space.xl }} />
      {conditions ? <WeatherReadout conditions={conditions} /> : null}
      {start}
      {start && caption ? (
        <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }} testID="start-caption">
          {caption}
        </Text>
      ) : null}
    </Card>
  );
}
