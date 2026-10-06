import { View } from 'react-native';

import type { LeagueTier } from '@/data/server/summary';
import { Avatar, Card, Divider, ProgressBar, StreakFlame, Text, TIER_LABEL, TierBadge, useFontScale, useTheme } from '@/ui';

import { profileCopy as copy } from './copy';

export interface ProfileHeaderProps {
  username: string;
  level: number;
  safetyRating: number | null;
  ranked: boolean;
  tier: LeagueTier;
  streak: number;
  /** The tab's own card shows the way to the next level and to being ranked; others' don't. */
  own?: {
    lifetime: number;
    levelFloor: number;
    levelNext: number | null;
    miles30d: number;
    nextMult: number;
    atRisk: boolean;
  };
  clanName?: string | null;
  testID?: string;
}

/**
 * The public card: avatar from the username (never a photo), username, level, and the three
 * numbers that matter — Safety Rating (or Unranked), streak and league. The same card is what
 * friends and clanmates see on `/u/<username>`.
 */
export function ProfileHeader({ username, level, safetyRating, ranked, tier, streak, own, clanName, testID }: ProfileHeaderProps) {
  const th = useTheme();
  const scale = useFontScale();
  const stack = scale > 1.35;
  const rated = ranked && safetyRating !== null;
  const span = own && own.levelNext !== null ? own.levelNext - own.levelFloor : 0;
  const levelProgress = own && span > 0 ? Math.min(1, Math.max(0, (own.lifetime - own.levelFloor) / span)) : 1;

  return (
    <Card variant="hero" testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.lg }}>
        <Avatar username={username} size="xl" tier={tier} />
        <View style={{ flex: 1, gap: th.space.xs }}>
          <Text variant="title1" numberOfLines={1} adjustsFontSizeToFit accessibilityRole="header" testID="profile-username">
            {username}
          </Text>
          <Text variant="headline" tone="muted">
            {clanName ? `${copy.level(level)} · ${copy.public.clan(clanName)}` : copy.level(level)}
          </Text>
        </View>
      </View>

      {own ? (
        <View style={{ gap: th.space.xs }}>
          <ProgressBar
            value={levelProgress}
            tone="accent"
            accessibilityLabel={copy.level(level)}
            accessibilityValueText={own.levelNext === null ? copy.maxLevel : copy.toNext(own.levelNext - own.lifetime, level + 1)}
          />
          <Text variant="footnote" tone="muted">
            {own.levelNext === null ? copy.maxLevel : copy.toNext(own.levelNext - own.lifetime, level + 1)}
          </Text>
        </View>
      ) : null}

      <Divider />

      <View style={{ flexDirection: stack ? 'column' : 'row', gap: th.space.lg, alignItems: stack ? 'flex-start' : 'flex-end' }}>
        <View
          style={{ flex: stack ? undefined : 1.2, gap: 2 }}
          accessible
          accessibilityLabel={rated ? `${copy.rating} ${safetyRating?.toFixed(1)}` : `${copy.rating}: ${copy.unranked}`}
          testID="profile-rating"
        >
          {rated ? (
            <Text variant="display">{(safetyRating as number).toFixed(1)}</Text>
          ) : (
            <Text variant="title2">{copy.unranked}</Text>
          )}
          <Text variant="label" tone="muted">
            {rated || !own ? copy.rating : copy.unrankedMiles(own.miles30d)}
          </Text>
        </View>
        <View style={{ flex: stack ? undefined : 1, gap: th.space.xs }} accessible accessibilityLabel={`${copy.streak} ${streak}`}>
          <StreakFlame count={streak} multiplier={own?.nextMult} state={own?.atRisk ? 'atRisk' : 'active'} />
          <Text variant="label" tone="muted">
            {copy.streak}
          </Text>
        </View>
        <View style={{ flex: stack ? undefined : 1, gap: th.space.xs }} accessible accessibilityLabel={`${copy.league} ${TIER_LABEL[tier]}`}>
          <TierBadge tier={tier} size="sm" />
          <Text variant="label" tone="muted">
            {copy.league}
          </Text>
        </View>
      </View>
    </Card>
  );
}
