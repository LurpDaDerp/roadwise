import { useCallback, useEffect, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../theme';
import { Text } from './Text';
import { useCountUp } from './useCountUp';

const MINUS = '−';

/** "1,234", or with `signed` "+167" / "−44" (a true minus sign). */
export function formatPointsValue(n: number, signed = false): string {
  const abs = Math.abs(Math.round(n)).toLocaleString('en-US');
  if (Math.round(n) < 0) return `${MINUS}${abs}`;
  return signed && Math.round(n) > 0 ? `+${abs}` : abs;
}

export type PointsCounterProps = {
  value: number;
  /**
   * Count up from this number on mount (e.g. 0 on a fresh drive summary). Omit to show `value`
   * straight away. Later changes to `value` always count from the number on screen.
   */
  from?: number;
  /** `hero` 64 italic (summary, Home) · `display` 44 · `stat` 28. Default `display`. */
  size?: 'hero' | 'display' | 'stat';
  /** Prefix positives with "+" (a drive's net). Default false (a running total). */
  signed?: boolean;
  /** Printed small after the number. Default "pts"; pass "" for none. */
  unit?: string;
  /** Spoken before the number, e.g. "Points earned". */
  label?: string;
  /**
   * Celebrate a change: a gain pulses green once, a loss turns red and shakes once. Default true.
   * Under reduce motion the colour still flashes; nothing moves or counts.
   */
  react?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The points number that lands: counts up, then a green pulse for a gain or a single red shake
 * for a loss. Negative values stay red. VoiceOver hears the final value at once, never the count.
 */
export function PointsCounter({
  value,
  from,
  size = 'display',
  signed = false,
  unit = 'pts',
  label,
  react = true,
  style,
  testID,
}: PointsCounterProps) {
  const t = useTheme();
  const m = t.motion;
  const still = t.reduceMotion;
  const [flash, setFlash] = useState<'gain' | 'loss' | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);

  const land = useCallback(
    (start: number) => {
      if (!react || start === value) return;
      const gain = value > start;
      setFlash(gain ? 'gain' : 'loss');
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), m.pulse * 3);
      if (still) return;
      if (gain) {
        scale.set(
          withSequence(withTiming(1.1, { duration: m.pulse / 2 }), withSpring(1, m.spring.bouncy))
        );
      } else {
        const d = m.shakeDistance;
        const step = m.shake / 5;
        x.set(
          withSequence(
            withTiming(-d, { duration: step }),
            withTiming(d, { duration: step }),
            withTiming(-d / 2, { duration: step }),
            withTiming(d / 2, { duration: step }),
            withTiming(0, { duration: step })
          )
        );
      }
    },
    [react, value, still, m, scale, x]
  );

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  const shown = useCountUp(value, {
    from: from ?? value,
    duration: m.countUp,
    enabled: !still,
    onDone: land,
  });

  const motion = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scale: scale.value }],
  }));

  const c = t.colors;
  const color =
    flash === 'gain'
      ? c.signal.clean.text
      : flash === 'loss' || value < 0
        ? c.signal.severe.text
        : c.text;
  const spokenUnit = unit === 'pts' ? 'points' : unit;

  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${label ? `${label}: ` : ''}${formatPointsValue(value, signed)}${spokenUnit ? ` ${spokenUnit}` : ''}`}
      style={[{ alignSelf: 'flex-start' }, style]}
    >
      <Animated.View
        style={[{ flexDirection: 'row', alignItems: 'baseline', gap: t.space.xs }, motion]}
      >
        <Text variant={size} style={{ color }}>
          {formatPointsValue(shown, signed)}
        </Text>
        {unit ? (
          <Text variant={size === 'stat' ? 'footnote' : 'headline'} tone="muted">
            {unit}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}
