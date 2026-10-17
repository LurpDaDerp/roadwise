import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../theme';
import { Pill } from './Pill';
import { Text } from './Text';

export type StreakFlameState = 'active' | 'atRisk' | 'frozen';

export type StreakFlameProps = {
  /** Streak length in drives. */
  count: number;
  /** Current streak multiplier, e.g. 1.2 → "×1.20". Omit to hide. */
  multiplier?: number;
  /**
   * `atRisk` after a net-negative drive with no freeze; `frozen` when a freeze just held it.
   * Default `active`.
   */
  state?: StreakFlameState;
  /** `md` for the Home header row, `lg` for the summary. Default `md`. */
  size?: 'md' | 'lg';
  testID?: string;
};

export const formatMultiplier = (m: number) => `×${m.toFixed(2)}`;

/**
 * The streak: a gold disc with a flame, the drive count in the display face, and the multiplier.
 * When the count goes up the disc pops once (bouncy spring; still under reduce motion).
 */
export function StreakFlame({
  count,
  multiplier,
  state = 'active',
  size = 'md',
  testID,
}: StreakFlameProps) {
  const t = useTheme();
  const c = t.colors;
  const d = size === 'lg' ? 48 : 36;
  const pop = useSharedValue(1);
  const prev = useRef(count);

  useEffect(() => {
    if (count > prev.current && !t.reduceMotion) {
      pop.value = withSequence(
        withTiming(1.25, { duration: 120 }),
        withSpring(1, t.motion.spring.bouncy)
      );
    }
    prev.current = count;
  }, [count, t.reduceMotion, t.motion.spring.bouncy, pop]);

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  const lit = state === 'active' && count > 0;
  const disc =
    state === 'atRisk'
      ? c.warningFaint
      : state === 'frozen'
        ? c.infoFaint
        : lit
          ? c.gold
          : c.surfaceRaised;
  const glyphColor =
    state === 'atRisk'
      ? c.warning
      : state === 'frozen'
        ? c.freeze
        : lit
          ? c.onGold
          : c.textSubtle;
  const glyph = state === 'frozen' ? 'snow' : lit ? 'flame' : 'flame-outline';

  const spoken = [
    `Streak ${count} ${count === 1 ? 'drive' : 'drives'}`,
    multiplier !== undefined ? `multiplier ${multiplier.toFixed(2)}` : null,
    state === 'atRisk' ? 'at risk' : state === 'frozen' ? 'freeze used' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={spoken}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.space.sm,
        alignSelf: 'flex-start',
      }}
    >
      <Animated.View
        style={[
          {
            width: d,
            height: d,
            borderRadius: d / 2,
            backgroundColor: disc,
            alignItems: 'center',
            justifyContent: 'center',
          },
          popStyle,
        ]}
      >
        <Ionicons name={glyph} size={Math.round(d * 0.56)} color={glyphColor} />
      </Animated.View>
      <Text variant={size === 'lg' ? 'display' : 'stat'}>{count}</Text>
      {state === 'atRisk' ? (
        <Pill label="At risk" tone="moderate" icon="alert-circle" accessible={false} />
      ) : state === 'frozen' ? (
        <Pill label="Freeze used" tone="info" icon="snow" accessible={false} />
      ) : multiplier !== undefined ? (
        <Pill label={formatMultiplier(multiplier)} tone="gold" accessible={false} />
      ) : null}
    </View>
  );
}
