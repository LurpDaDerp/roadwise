import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { useTheme } from '../theme';
import { Text } from './Text';
import { useCountUp } from './useCountUp';

export type CountUpProps = {
  value: number;
  /** Count up from this number on mount (e.g. 0 for a fresh score). Omit to show `value` at once. */
  from?: number;
  /** `hero` (the drive score, the Safety Rating) · `display` · `stat`. Default `display`. */
  size?: 'hero' | 'display' | 'stat';
  /** The number's ink. Default the theme's text. */
  color?: string;
  /** Printed small after the number (e.g. "/100"). */
  suffix?: string;
  /** Spoken before the number, e.g. "Drive score". */
  label?: string;
  /** Land the count with one soft pulse. Default true. Never moves under reduce motion. */
  pulse?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A whole number that counts up to its value and lands with one soft pulse. There is no loss
 * reaction: it never turns red and never shakes. Under reduce motion the final number shows at
 * once. VoiceOver hears the final value at once, never the count.
 */
export function CountUp({ value, from, size = 'display', color, suffix, label, pulse = true, style, testID }: CountUpProps) {
  const t = useTheme();
  const m = t.motion;
  const still = t.reduceMotion;
  const scale = useSharedValue(1);

  // `useCountUp` keeps the latest `onDone`, so this reads this render's `pulse`.
  const shown = useCountUp(value, {
    from: from ?? value,
    duration: m.countUp,
    enabled: !still,
    onDone: (start: number) => {
      if (!pulse || still || start === value) return;
      scale.set(withSequence(withTiming(1.1, { duration: m.pulse / 2 }), withSpring(1, m.spring.bouncy)));
    },
  });

  // Gone mid-pulse: the shared value needs no cleanup, but a later remount starts at rest.
  useEffect(() => () => scale.set(1), [scale]);

  const motion = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const final = Math.round(value);

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${label ? `${label} ` : ''}${final}${suffix ?? ''}`}
      style={[{ alignSelf: 'flex-start' }, style]}
    >
      <Animated.View style={[{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs }, motion]}>
        <Text variant={size} style={{ color: color ?? t.colors.text }}>
          {Math.round(shown)}
        </Text>
        {suffix ? (
          <Text variant={size === 'stat' ? 'footnote' : 'headline'} tone="muted">
            {suffix}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}
