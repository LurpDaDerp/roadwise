import { RANKED_MIN_MILES } from '@scoring';
import { useState, type ReactNode } from 'react';
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
 * rating and holds a dash. One tap on the ring or the words opens Analytics; the screen reader
 * hears them as one button. `aside` (the weather now) sits at the foot of the words' column,
 * right-aligned beside the ring, the words then at its top; with no aside the words are centred on
 * the ring. Stacked (large text) the ring is above the words and `aside` is not drawn here.
 */
export function RatingBlock({ progress, onPress, aside }: { progress: Progress; onPress: () => void; aside?: ReactNode }) {
  const t = useTheme();
  const units = useUnits();
  const stacked = useFontScale() > RATING_STACK_FONT_SCALE;
  // The ring and the words are two touch targets with one pressed look.
  const [pressed, setPressed] = useState(false);
  const ranked = progress.ranked && progress.safety_rating !== null;
  const value = ranked ? formatRating(progress.safety_rating, true) : '—';
  const trend = ranked ? ratingTrend(progress.rating_trend) : null;
  const toward = ranked ? null : toRating(progress.miles_90d ?? 0, units);
  const label = ranked
    ? `${homeCopy.rating.spoken(value)}.${trend ? ` ${trend.line}.` : ''}`
    : `${homeCopy.rating.none}. ${toward ? toward.spoken : homeCopy.rating.afterFirst}`;
  const ring = (
    <ProgressRing
      value={ranked ? (progress.safety_rating ?? 0) / 100 : (toward?.fill ?? 0)}
      size={RING}
      strokeWidth={STROKE}
      tone="accent"
      accessibilityLabel={ranked ? homeCopy.rating.label : 'Progress toward your Safety Rating'}
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
  );
  const words = (
    <View style={{ gap: t.space.xs }}>
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
  );
  const button = { accessibilityRole: 'button' as const, accessibilityLabel: label, accessibilityHint: homeCopy.rating.hint };

  if (stacked) {
    return (
      <Pressable
        onPress={onPress}
        testID="rating-block"
        {...button}
        style={({ pressed: down }) => ({ alignItems: 'flex-start', gap: t.space.lg, opacity: down ? 0.8 : 1 })}
      >
        {ring}
        {words}
      </Pressable>
    );
  }

  const touch = { onPress, onPressIn: () => setPressed(true), onPressOut: () => setPressed(false) };
  const look = { opacity: pressed ? 0.8 : 1 };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.lg }}>
      {/* The words' button speaks for the ring, so the ring is touch only. */}
      <Pressable {...touch} testID="rating-ring" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={look}>
        {ring}
      </Pressable>
      <View style={{ flex: 1, minHeight: RING, justifyContent: aside ? 'space-between' : 'center', gap: t.space.sm }}>
        <Pressable {...touch} testID="rating-block" {...button} style={look}>
          {words}
        </Pressable>
        {aside ? <View style={{ alignSelf: 'flex-end' }}>{aside}</View> : null}
      </View>
    </View>
  );
}

/**
 * Home's drive card, the screen's hero: the hour's sky with the Safety Rating big in its ring, its
 * change this week, the weather now (once known) at the foot of the ring's right side, and Start
 * drive across the card's foot with, with automatic drives on, one quiet line under it. The card is
 * as tall as what it holds. With large text (the rating stacked) or the rating failed, the weather
 * takes its own row above Start instead. While progress loads or fails the card says so; Start
 * stays in it either way.
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
  /** The weather now, beside the ring (or above Start drive); absent until it is known. */
  conditions?: Conditions | null;
}) {
  const t = useTheme();
  const stacked = useFontScale() > RATING_STACK_FONT_SCALE;
  // The weather sits beside the ring (the rating's or its skeleton's) unless the text is stacked; otherwise it takes a row above Start.
  const ring = !!summary || loading || !error;
  const beside = conditions && ring && !stacked ? <WeatherReadout conditions={conditions} compact /> : null;
  const row = conditions && !beside ? <WeatherReadout conditions={conditions} /> : null;

  const top = !summary ? (
    loading || !error ? (
      <View style={{ flexDirection: 'row', alignItems: beside ? 'flex-start' : 'center', gap: t.space.lg }} testID="home-header-loading">
        <Skeleton width={RING} height={RING} radius={RING / 2} />
        <View style={beside ? { flex: 1, minHeight: RING, justifyContent: 'space-between', gap: t.space.sm } : undefined}>
          <View style={{ gap: t.space.sm }}>
            <Skeleton width={120} height={14} />
            <Skeleton width={140} height={18} />
          </View>
          {beside ? <View style={{ alignSelf: 'flex-end' }}>{beside}</View> : null}
        </View>
      </View>
    ) : (
      <View style={{ gap: t.space.md }} testID="home-header-error">
        <Text variant="headline">{"Couldn't load your rating"}</Text>
        <Text variant="subhead" tone="muted">
          RoadWise still records your drives. Check your connection and try again.
        </Text>
        <Button label="Try again" variant="secondary" size="sm" onPress={onRetry} style={{ alignSelf: 'flex-start' }} />
      </View>
    )
  ) : (
    <RatingBlock progress={summary.progress} onPress={onRating} aside={beside} />
  );

  return (
    <Card variant="hero" testID="home-header">
      {top}
      {row}
      {start ? <View style={{ marginTop: t.space.xs }}>{start}</View> : null}
      {start && caption ? (
        <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }} testID="start-caption">
          {caption}
        </Text>
      ) : null}
    </Card>
  );
}
