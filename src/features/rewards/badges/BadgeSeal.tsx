import type { Ionicons } from '@expo/vector-icons';
import type { BadgeId } from '@scoring';
import { Pressable, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import type { BadgeDef, BadgeMetric, EarnedBadge } from '../api';
import { BADGE_COPY, badgesCopy } from '../copy/badges';
import { BADGE_TIER_LABEL } from '../copy/common';
import { Seal } from '../ui/Seal';

/** Each family's mark inside an earned seal. */
export const FAMILY_GLYPH: Readonly<Record<BadgeMetric, keyof typeof Ionicons.glyphMap>> = {
  safe_days: 'shield-checkmark-outline',
  phone_free_days: 'eye-outline',
  smooth_days: 'water-outline',
  weekly_goals: 'flag-outline',
  challenges: 'ribbon-outline',
  referrals: 'people-outline',
};

/**
 * An earned date as printed ("Sep 21") and spoken ("September 21"), in the phone's zone. The year
 * joins in only when it is not the current one.
 */
export function formatEarnedDate(at: string, tz: string, now: number): { printed: string; spoken: string } {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return { printed: at, spoken: at };
  const year = (ms: number) => new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: tz }).format(ms);
  const thisYear = year(date.getTime()) === year(now);
  const opts = (month: 'short' | 'long'): Intl.DateTimeFormatOptions => ({
    month,
    day: 'numeric',
    timeZone: tz,
    ...(thisYear ? null : { year: 'numeric' }),
  });
  return {
    printed: new Intl.DateTimeFormat('en-US', opts('short')).format(date),
    spoken: new Intl.DateTimeFormat('en-US', opts('long')).format(date),
  };
}

/** A known badge id (the copy is exhaustive over `BadgeId`); a def the build has no words for is skipped. */
export const isKnownBadge = (id: string): id is BadgeId => Object.prototype.hasOwnProperty.call(BADGE_COPY, id);

export interface BadgeLines {
  name: string;
  tier: string;
  /** "Earned Sep 21", or "Reach 30 safe days · 12 so far". */
  line: string;
  /** The seal's own label (name, tier, earned date or locked). */
  sealLabel: string;
  /** The whole cell, read in one swipe. */
  spoken: string;
}

export function badgeLines(
  def: BadgeDef & { id: BadgeId },
  earned: EarnedBadge | undefined,
  current: number,
  tz: string,
  now: number
): BadgeLines {
  const copy = BADGE_COPY[def.id];
  const tier = BADGE_TIER_LABEL[def.tier];
  if (earned) {
    const date = formatEarnedDate(earned.earned_at, tz, now);
    return {
      name: copy.name,
      tier,
      line: badgesCopy.earned(date.printed),
      sealLabel: badgesCopy.seal.earned(copy.name, tier, date.spoken),
      spoken: badgesCopy.seal.earned(copy.name, tier, date.spoken),
    };
  }
  const line = badgesCopy.lockedLine(copy.criterion(def.threshold), current);
  return {
    name: copy.name,
    tier,
    line,
    sealLabel: badgesCopy.seal.locked(copy.name, tier),
    spoken: `${badgesCopy.seal.locked(copy.name, tier)}. ${line}`,
  };
}

/**
 * One cell of the F3 grid: the seal, the badge's name, and under it the date it was earned or the
 * criterion with the progress so far. The whole cell is one button that opens the badge.
 */
export function BadgeSeal({
  def,
  earned,
  current,
  tz,
  now,
  animate,
  onPress,
}: {
  def: BadgeDef & { id: BadgeId };
  earned: EarnedBadge | undefined;
  current: number;
  tz: string;
  now: number;
  animate: boolean;
  onPress: () => void;
}) {
  const th = useTheme();
  const lines = badgeLines(def, earned, current, tz, now);
  return (
    <Pressable
      testID={`badge-${def.id}`}
      accessibilityRole="button"
      accessibilityLabel={lines.spoken}
      onPress={onPress}
      style={({ pressed }) => ({
        flexGrow: 1,
        flexBasis: 140,
        minHeight: 44,
        alignItems: 'center',
        gap: th.space.sm,
        paddingVertical: th.space.md,
        paddingHorizontal: th.space.sm,
        borderRadius: th.radius.md,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <Seal
        tier={def.tier}
        earned={earned !== undefined}
        glyph={FAMILY_GLYPH[def.family]}
        label={lines.sealLabel}
        accessible={false}
        animate={animate}
        testID={`seal-${def.id}`}
      />
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text variant="subhead" style={{ textAlign: 'center', fontWeight: '600' }}>
          {lines.name}
        </Text>
        <Text variant="footnote" tone="muted" style={{ textAlign: 'center' }}>
          {lines.line}
        </Text>
      </View>
    </Pressable>
  );
}
