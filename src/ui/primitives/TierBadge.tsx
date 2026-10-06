import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { useTheme } from '../theme';
import type { LeagueTier } from '../tokens';
import type { IconName } from './Button';
import { Text } from './Text';

export const TIER_ORDER: readonly LeagueTier[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];

export const TIER_LABEL: Record<LeagueTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
};

/** A different glyph per tier, so the badge reads without its colour. */
const TIER_GLYPH: Record<LeagueTier, IconName> = {
  bronze: 'shield-half',
  silver: 'medal',
  gold: 'trophy',
  platinum: 'star',
  diamond: 'diamond',
};

const SHIELD_PT = { sm: 24, md: 36, lg: 64 } as const;

export type TierBadgeProps = {
  tier: LeagueTier;
  /** sm 24 · md 36 · lg 64 (shield height). Default `md`. */
  size?: keyof typeof SHIELD_PT;
  /** Print the tier name beside the shield. Default true. */
  showLabel?: boolean;
  /** League rank, printed as "#4" after the name. */
  rank?: number;
  testID?: string;
};

/** The weekly-league tier as a gradient shield with its own glyph, plus the tier's name. */
export function TierBadge({ tier, size = 'md', showLabel = true, rank, testID }: TierBadgeProps) {
  const t = useTheme();
  const c = t.colors.tier[tier];
  const h = SHIELD_PT[size];
  const w = Math.round(h * (24 / 28));
  const name = `${TIER_LABEL[tier]} league`;
  const spoken = rank !== undefined ? `${name}, rank ${rank}` : name;
  const gid = `tier-${tier}`;

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={spoken}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, alignSelf: 'flex-start' }}
    >
      <View style={{ width: w, height: h, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={w} height={h} viewBox="0 0 24 28" style={{ position: 'absolute' }}>
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={c.face[0]} />
              <Stop offset="1" stopColor={c.face[1]} />
            </LinearGradient>
          </Defs>
          <Path
            d="M12 1 L22.5 5 V13 C22.5 20 17.8 24.6 12 27 C6.2 24.6 1.5 20 1.5 13 V5 Z"
            fill={`url(#${gid})`}
            stroke={c.face[1]}
            strokeWidth={1}
          />
        </Svg>
        <Ionicons name={TIER_GLYPH[tier]} size={Math.round(h * 0.42)} color={c.ink} style={{ marginTop: -h * 0.06 }} />
      </View>
      {showLabel ? (
        <Text variant={size === 'lg' ? 'title2' : 'label'} style={{ color: c.text }}>
          {TIER_LABEL[tier]}
          {rank !== undefined ? (
            <Text variant={size === 'lg' ? 'title2' : 'label'} tone="muted">{`  #${rank}`}</Text>
          ) : null}
        </Text>
      ) : null}
    </View>
  );
}
