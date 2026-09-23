import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text, useTheme } from '@/ui';

import { badgesCopy } from '../copy/badges';
import { BADGE_TIER_LABEL } from '../copy/common';

export type SealTier = keyof typeof BADGE_TIER_LABEL;

/** The tier is drawn as a count of rings as well as named, so it never rides on colour. */
export const SEAL_RINGS: Readonly<Record<SealTier, number>> = { bronze: 1, silver: 2, gold: 3 };

/** The direction contract's stamp: it thumps in from 1.15× to rest in 250 ms, once. */
export const SEAL_THUMP_SCALE = 1.15;

const DIAMETER = { md: 72, lg: 128 } as const;
const RING_STEP = { md: 5, lg: 8 } as const;
const GLYPH = { md: 26, lg: 48 } as const;

export type SealProps = {
  tier: SealTier;
  earned: boolean;
  glyph: keyof typeof Ionicons.glyphMap;
  /** The one spoken label for the seal: name, tier by word, and earned or locked. */
  label: string;
  size?: 'md' | 'lg';
  /** Thump once on mount (a badge seen for the first time). Ignored under reduce motion. */
  animate?: boolean;
  /**
   * Off when the seal sits inside a pressable that speaks for it (a grid cell): a second
   * accessible element inside a button would be read twice or not at all.
   */
  accessible?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A badge seal on the licence (direction contract: "seals for badges"). An earned seal is pressed
 * in ID blue: its tier is the number of rings (one bronze, two silver, three gold) and the tier's
 * name printed under it. A locked seal is only an outline, dashed, with a lock and the word
 * "Locked". Colour never carries the meaning on its own.
 */
export function Seal({
  tier,
  earned,
  glyph,
  label,
  size = 'md',
  animate = false,
  accessible = true,
  style,
  testID,
}: SealProps) {
  const t = useTheme();
  const d = DIAMETER[size];
  const step = RING_STEP[size];
  const rings = SEAL_RINGS[tier];
  const ink = earned ? t.colors.accent : t.colors.textSubtle;

  const still = t.reduceMotion || !animate;
  const scale = useSharedValue(still ? 1 : SEAL_THUMP_SCALE);
  const thumped = useRef(false);
  useEffect(() => {
    if (still) {
      scale.value = 1;
      return;
    }
    if (thumped.current) return;
    thumped.current = true;
    scale.value = withTiming(1, { duration: t.motion.base, easing: Easing.out(Easing.exp) });
  }, [still, scale, t.motion.base]);
  const thump = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const face = (
    <View style={{ width: d, height: d, alignItems: 'center', justifyContent: 'center' }}>
      {Array.from({ length: rings }, (_, i) => {
        const inset = i * step;
        return (
          <View
            key={i}
            testID={testID ? `${testID}-ring-${i + 1}` : undefined}
            style={{
              position: 'absolute',
              top: inset,
              left: inset,
              right: inset,
              bottom: inset,
              borderRadius: d / 2,
              borderWidth: i === 0 ? 2 : StyleSheet.hairlineWidth * 2,
              borderColor: ink,
              borderStyle: earned ? 'solid' : 'dashed',
            }}
          />
        );
      })}
      <View
        style={{
          width: d - rings * step * 2 - step,
          height: d - rings * step * 2 - step,
          borderRadius: d,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: earned ? t.colors.accentFaint : 'transparent',
        }}
      >
        <Ionicons name={earned ? glyph : 'lock-closed-outline'} size={GLYPH[size]} color={ink} />
      </View>
    </View>
  );

  const caption = (
    <View style={{ alignItems: 'center' }}>
      <Text
        variant="caption"
        tone={earned ? 'accent' : 'subtle'}
        style={{ textTransform: 'uppercase', letterSpacing: 1.2 }}
      >
        {BADGE_TIER_LABEL[tier]}
      </Text>
      {earned ? null : (
        <Text variant="caption" tone="muted">
          {badgesCopy.locked}
        </Text>
      )}
    </View>
  );

  const a11y = accessible
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
    : { accessible: false, importantForAccessibility: 'no-hide-descendants' as const, accessibilityElementsHidden: true };

  const frame: ViewStyle = { alignItems: 'center', gap: t.space.xs };

  if (still) {
    return (
      <View {...a11y} testID={testID} style={[frame, style]}>
        {face}
        {caption}
      </View>
    );
  }
  return (
    <Animated.View {...a11y} testID={testID} style={[frame, thump, style]}>
      {face}
      {caption}
    </Animated.View>
  );
}
