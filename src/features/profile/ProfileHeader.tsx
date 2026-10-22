import type { ReactNode } from 'react';
import { View } from 'react-native';

import { RANKED_MIN_MILES } from '@scoring';

import { useUnits } from '@/data/queries/units';
import { timeMetric } from '@/features/analytics/format';
import { ratingTrend } from '@/features/home/HomeHeader';
import { formatRating } from '@/lib/rating';
import { distanceIn, distanceWord, formatDistance, formatDistanceProgress } from '@/lib/units';
import { Avatar, Card, Divider, Text, TrendArrow, useFontScale, useTheme } from '@/ui';

import { profileCopy as copy } from './copy';

export interface ProfileTotals {
  drives: number;
  miles: number;
  durationS: number;
}

export interface ProfileHeaderProps {
  username: string;
  safetyRating: number | null;
  ranked: boolean;
  /** Your own card adds the week's change, the way to a rating and your totals; a friend's doesn't. */
  own?: {
    ratingTrend: number | null;
    miles90d: number;
    totals: ProfileTotals;
  };
  testID?: string;
}

/**
 * The profile card: the avatar (initials, never a photo) and the username, then the Safety Rating.
 * Your own card adds the rating's change this week (in words, with an
 * arrow) and your all-time drives, distance and time on the road. A friend's card is the same
 * without your extras: what friends see on `/u/<username>`.
 */
export function ProfileHeader({ username, safetyRating, ranked, own, testID }: ProfileHeaderProps) {
  const th = useTheme();
  const scale = useFontScale();
  const stack = scale > 1.35;
  const units = useUnits();
  const rated = ranked && safetyRating !== null;
  const ratingText = formatRating(safetyRating, ranked);
  const progress = own && !rated && own.miles90d > 0 ? formatDistanceProgress(own.miles90d, RANKED_MIN_MILES, units) : null;
  const toRating = progress ? copy.toRating(`${progress.done} of ${progress.target} ${units}`) : null;
  const toRatingSpoken = progress ? copy.toRating(`${progress.done} of ${progress.target} ${distanceWord(units)}`) : null;
  const trend = own && rated ? ratingTrend(own.ratingTrend) : null;
  const row = { flexDirection: stack ? 'column' : 'row', gap: th.space.lg, alignItems: stack ? 'flex-start' : 'flex-end' } as const;

  return (
    <Card variant="hero" testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg }}>
        <Avatar username={username} size="xl" />
        <View style={{ flex: 1, gap: th.space.xs }}>
          <Text variant="title1" numberOfLines={1} adjustsFontSizeToFit accessibilityRole="header" testID="profile-username">
            {username}
          </Text>
        </View>
      </View>

      <Divider />

      <View style={row}>
        <Stat
          stack={stack}
          wide
          label={toRating ?? copy.rating}
          accessibilityLabel={rated ? `${copy.rating} ${ratingText}` : `${copy.rating}: ${copy.noRating}${toRatingSpoken ? `, ${toRatingSpoken}` : ''}`}
          testID="profile-rating"
        >
          {rated ? <Text variant="display">{ratingText}</Text> : <Text variant="title2">{copy.noRating}</Text>}
        </Stat>
        {trend ? (
          <Stat stack={stack} label={copy.trend.label} accessibilityLabel={copy.trend.spoken(trend.word)} testID="profile-trend">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs, minHeight: th.type.stat.lineHeight }}>
              <TrendArrow direction={trend.direction} better="up" size={20} accessible={false} />
              <Text variant="title3">{trend.word}</Text>
            </View>
          </Stat>
        ) : null}
      </View>

      {own ? (
        <>
          <Divider />
          <View style={row} testID="profile-totals">
            <Stat stack={stack} label={copy.totals.drives} accessibilityLabel={`${copy.totals.drives} ${own.totals.drives}`} testID="profile-drives">
              <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                {own.totals.drives.toLocaleString('en-US')}
              </Text>
            </Stat>
            <Stat
              stack={stack}
              label={copy.totals.distance}
              accessibilityLabel={`${copy.totals.distance} ${formatDistance(own.totals.miles, units, { digits: distanceIn(own.totals.miles, units) >= 100 ? 0 : 1, spoken: true })}`}
              testID="profile-distance"
            >
              <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                {formatDistance(own.totals.miles, units, { digits: distanceIn(own.totals.miles, units) >= 100 ? 0 : 1 })}
              </Text>
            </Stat>
            <Stat stack={stack} label={copy.totals.time} accessibilityLabel={`${copy.totals.time} ${timeMetric(own.totals.durationS).spoken}`} testID="profile-time">
              <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                {`${timeMetric(own.totals.durationS).value} ${timeMetric(own.totals.durationS).unit}`}
              </Text>
            </Stat>
          </View>
        </>
      ) : null}
    </Card>
  );
}

/** One number on the card: the value, then its label under it, read out as one phrase. */
function Stat({
  stack,
  wide,
  label,
  accessibilityLabel,
  testID,
  children,
}: {
  stack: boolean;
  /** The left column, a little wider (the Safety Rating's big number sits there). */
  wide?: boolean;
  label: string;
  accessibilityLabel: string;
  testID?: string;
  children: ReactNode;
}) {
  const th = useTheme();
  return (
    <View style={{ flex: stack ? undefined : wide ? 1.2 : 1, minWidth: 0, gap: th.space.xs }} accessible accessibilityLabel={accessibilityLabel} testID={testID}>
      {children}
      <Text variant="label" tone="muted">
        {label}
      </Text>
    </View>
  );
}
