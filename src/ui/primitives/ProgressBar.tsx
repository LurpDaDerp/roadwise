import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme } from '../theme';
import { clamp01, progressColor, progressTrack, type ProgressTone } from './progress';

export type ProgressBarProps = {
  /** 0–1. */
  value: number;
  /** Default `primary` (gold). */
  tone?: ProgressTone;
  /** Bar thickness in pt. Default 10. */
  height?: number;
  /** What the bar measures, e.g. "Level 7 progress". The percent is added as the value. */
  accessibilityLabel: string;
  /** Spoken instead of the percent, e.g. "340 of 500 clean miles". */
  accessibilityValueText?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** A chunky rounded bar that fills with an ease-out on change (instantly under reduce motion). */
export function ProgressBar({
  value,
  tone = 'primary',
  height = 10,
  accessibilityLabel,
  accessibilityValueText,
  style,
  testID,
}: ProgressBarProps) {
  const t = useTheme();
  const v = clamp01(value);
  const p = useSharedValue(t.reduceMotion ? v : 0);

  useEffect(() => {
    p.value = t.reduceMotion
      ? v
      : withTiming(v, { duration: t.motion.slow * 1.5, easing: Easing.out(Easing.cubic) });
  }, [v, t.reduceMotion, t.motion.slow, p]);

  const fill = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={
        accessibilityValueText
          ? { text: accessibilityValueText }
          : { min: 0, max: 100, now: Math.round(v * 100) }
      }
      style={[
        {
          height,
          borderRadius: height / 2,
          backgroundColor: progressTrack(t.colors, t.scheme),
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <Animated.View
        style={[
          { height: '100%', borderRadius: height / 2, backgroundColor: progressColor(t.colors, tone) },
          fill,
        ]}
      />
    </View>
  );
}
