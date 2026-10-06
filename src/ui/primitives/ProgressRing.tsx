import { useEffect, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useTheme } from '../theme';
import { clamp01, progressColor, progressTrack, type ProgressTone } from './progress';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type ProgressRingProps = {
  /** 0–1. */
  value: number;
  /** Diameter in pt. Default 96. */
  size?: number;
  /** Stroke in pt. Default size / 10. */
  strokeWidth?: number;
  /** Default `primary` (gold). */
  tone?: ProgressTone;
  /** Centred inside the ring: a number, an icon. */
  children?: ReactNode;
  accessibilityLabel: string;
  accessibilityValueText?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** A round progress gauge (clan goal, challenge, level) that draws in from the top. */
export function ProgressRing({
  value,
  size = 96,
  strokeWidth,
  tone = 'primary',
  children,
  accessibilityLabel,
  accessibilityValueText,
  style,
  testID,
}: ProgressRingProps) {
  const t = useTheme();
  const v = clamp01(value);
  const stroke = strokeWidth ?? Math.max(4, Math.round(size / 10));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const p = useSharedValue(t.reduceMotion ? v : 0);

  useEffect(() => {
    p.value = t.reduceMotion
      ? v
      : withTiming(v, { duration: t.motion.slow * 2, easing: Easing.out(Easing.exp) });
  }, [v, t.reduceMotion, t.motion.slow, p]);

  const arc = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - p.value) }));

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
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={progressTrack(t.colors, t.scheme)}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={progressColor(t.colors, tone)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circ} ${circ}`}
          strokeOpacity={v > 0 ? 1 : 0}
          animatedProps={arc}
          fill="none"
        />
      </Svg>
      {children}
    </View>
  );
}
