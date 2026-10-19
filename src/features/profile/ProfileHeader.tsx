import type { ReactNode } from 'react';
import { View } from 'react-native';

import { MAX_FREEZES, RANKED_MIN_MILES } from '@scoring';

import { useUnits } from '@/data/queries/units';
import { formatRating } from '@/lib/rating';
import { formatDistanceProgress } from '@/lib/units';
import { Avatar, Card, Divider, formatPointsValue, FreezeCount, ProgressBar, StreakFlame, Text, useFontScale, useTheme } from '@/ui';

import { profileCopy as copy } from './copy';

export interface ProfileHeaderProps {
  username: string;
  level: number;
  safetyRating: number | null;
  ranked: boolean;
  streak: number;
  /** The tab's own card adds the way to the next level, points, freezes and the way to being ranked; others' don't. */
  own?: {
    points: number;
    lifetime: number;
    levelFloor: number;
    levelNext: number | null;
    miles30d: number;
    nextMult: number;
    atRisk: boolean;
    freezes: number;
  };
  testID?: string;
}

/**
 * The public card: avatar from the username (never a photo), username and level, then the numbers
 * that matter: Safety Rating (or Unranked) and streak, plus points and freezes on your own card.
 * The same card, without your own extras, is what friends see on `/u/<username>`.
 */
export function ProfileHeader({ username, level, safetyRating, ranked, streak, own, testID }: ProfileHeaderProps) {
  const th = useTheme();
  const scale = useFontScale();
  const stack = scale > 1.35;
  const units = useUnits();
  const rated = ranked && safetyRating !== null;
  const ratingText = formatRating(safetyRating, ranked);
  const span = own && own.levelNext !== null ? own.levelNext - own.levelFloor : 0;
  const levelProgress = own && span > 0 ? Math.min(1, Math.max(0, (own.lifetime - own.levelFloor) / span)) : 1;
  const toNext = own && own.levelNext !== null ? copy.toNext(Math.max(0, own.levelNext - own.lifetime), level + 1) : copy.maxLevel;
  const freezes = own ? Math.max(0, Math.min(own.freezes, MAX_FREEZES)) : 0;
  const toRank = own && !rated ? copy.unrankedMiles(formatDistanceProgress(own.miles30d, RANKED_MIN_MILES, units).text) : null;
  const unrankedLabel = toRank ? `${copy.rating}: ${copy.unranked}, ${toRank}` : `${copy.rating}: ${copy.unranked}`;
  const row = { flexDirection: stack ? 'column' : 'row', gap: th.space.lg, alignItems: stack ? 'flex-start' : 'flex-end' } as const;

  return (
    <Card variant="hero" testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg }}>
        <Avatar username={username} size="xl" />
        <View style={{ flex: 1, gap: th.space.xs }}>
          <Text variant="title1" numberOfLines={1} adjustsFontSizeToFit accessibilityRole="header" testID="profile-username">
            {username}
          </Text>
          <Text variant="headline" tone="muted" testID="profile-level">
            {copy.level(level)}
          </Text>
        </View>
      </View>

      {own ? (
        <View style={{ gap: th.space.xs }}>
          <ProgressBar value={levelProgress} tone="accent" accessibilityLabel={copy.level(level)} accessibilityValueText={toNext} />
          <Text variant="footnote" tone="muted">
            {toNext}
          </Text>
        </View>
      ) : null}

      <Divider />

      <View style={{ gap: th.space.lg }}>
        <View style={row}>
          <Stat
            stack={stack}
            wide
            label={toRank ?? copy.rating}
            accessibilityLabel={rated ? `${copy.rating} ${ratingText}` : unrankedLabel}
            testID="profile-rating"
          >
            {rated ? <Text variant="display">{ratingText}</Text> : <Text variant="title2">{copy.unranked}</Text>}
          </Stat>
          <Stat stack={stack} label={copy.streak} accessibilityLabel={`${copy.streak} ${streak}`} testID="profile-streak">
            <StreakFlame count={streak} multiplier={own?.nextMult} state={own?.atRisk ? 'atRisk' : 'active'} />
          </Stat>
        </View>

        {own ? (
          <View style={row}>
            <Stat
              stack={stack}
              wide
              label={copy.points}
              accessibilityLabel={`${copy.points} ${formatPointsValue(own.points)}`}
              testID="profile-points"
            >
              <Text variant="stat" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} testID="profile-points-value">
                {formatPointsValue(own.points)}
              </Text>
            </Stat>
            <Stat
              stack={stack}
              label={copy.freezes}
              accessibilityLabel={`${copy.freezes} ${copy.freezesHeld(freezes, MAX_FREEZES)}`}
              testID="profile-freezes"
            >
              {/* Wraps so "N of 3" drops under the snowflakes when the column is narrow (320 pt, large text). */}
              <View
                testID="profile-freezes-row"
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  columnGap: th.space.sm,
                  rowGap: th.space.xs,
                  minHeight: th.type.stat.lineHeight,
                }}
              >
                <FreezeCount count={freezes} max={MAX_FREEZES} />
                <Text variant="title3" numberOfLines={1} style={{ flexShrink: 1, fontVariant: ['tabular-nums'] }}>
                  {copy.freezesHeld(freezes, MAX_FREEZES)}
                </Text>
              </View>
            </Stat>
          </View>
        ) : null}
      </View>
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
  /** The left column, a little wider (the Safety Rating's big number and the points sit there). */
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
