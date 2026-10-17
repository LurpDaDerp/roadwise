import { useEffect, type ReactNode } from 'react';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme } from '@/ui';

import { AIM_BORDER, AIM_BORDER_GOOD, AIM_INPUT, AIM_SMOOTH_MS, AIM_STOPS } from '../../aim';

/**
 * The frame around the aiming picture: its colour shades from the bad colour through a neutral grey
 * to the good one with DashPal's score (`level`, 0..1), following it over 0.3 s (at once under Reduce
 * Motion: a colour change is not motion, but the shading would be), and is the theme's strong border
 * with no reading (`level` null: no verdict). It is wider while the good latch is on, so the verdict
 * never rests on colour alone. Local to the wizard, on the theme's hooks only.
 */
export function AimBorder({ level, good, children }: { level: number | null; good: boolean; children: ReactNode }) {
  const th = useTheme();
  const s = useSharedValue(level ?? 0);
  useEffect(() => {
    if (level === null) return;
    s.value = th.reduceMotion ? level : withTiming(level, { duration: AIM_SMOOTH_MS });
  }, [level, th.reduceMotion, s]);
  const neutral = level === null;
  const stops = AIM_STOPS[th.scheme];
  const strong = th.colors.borderStrong;
  const colour = useAnimatedStyle(() => ({ borderColor: neutral ? strong : interpolateColor(s.value, [...AIM_INPUT], [...stops]) }), [neutral, strong, stops]);
  return (
    <Animated.View
      style={[
        {
          borderWidth: good && !neutral ? AIM_BORDER_GOOD : AIM_BORDER,
          borderRadius: th.radius.lg,
          borderCurve: 'continuous',
          overflow: 'hidden',
        },
        colour,
      ]}
      testID="aim-border"
    >
      {children}
    </Animated.View>
  );
}
