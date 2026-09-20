import type { ScoreBand } from '@scoring';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, G } from 'react-native-svg';

import { Text } from '../primitives/Text';
import { useTheme } from '../theme';
import { bandLabel, clamp, describeScore, formatScore } from './format';
import { useFontScale } from './scale';
import { Stamp } from './Stamp';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export const SCORE_RING_SIZE = 160;

/**
 * How far the ring may grow with Dynamic Type. The numeral starts at 30 % of the diameter (48 dp
 * at the default size), so 1.5× already puts it at 72 dp; a full 2× ring (320 dp) would not fit a
 * card face on a 375-dp phone once the screen and card padding are taken off. The band label
 * inside the ring is ordinary `Text` and scales the full 2×.
 */
const RING_MAX_SCALE = 1.5;

export type ScoreRingProps = {
  /** 0–100. */
  score: number;
  band: ScoreBand;
  /** Diameter in dp at the default text size. */
  size?: number;
  /** Not yet confirmed by the server: the ring carries the PROVISIONAL stamp and says so. */
  provisional?: boolean;
  testID?: string;
};

/**
 * The score as a printed gauge: a hairline track, one arc of ID blue drawn to the score, and the
 * numeral as the largest text on the card. No glow, no gradient, one colour whatever the band —
 * the band is a word under the number, never a colour the driver has to decode. The arc draws in
 * over 600 ms; with reduce motion on it is drawn already.
 */
export function ScoreRing({
  score,
  band,
  size = SCORE_RING_SIZE,
  provisional = false,
  testID,
}: ScoreRingProps) {
  const t = useTheme();
  const fs = Math.max(1, useFontScale(RING_MAX_SCALE));
  const d = Math.round(size * fs);
  const stroke = Math.max(6, Math.round(d / 16));
  const r = (d - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const centre = d / 2;
  const fraction = clamp(score, 0, 100) / 100;
  const still = t.reduceMotion;

  const progress = useSharedValue(still ? fraction : 0);
  useEffect(() => {
    if (still) {
      progress.value = fraction;
      return;
    }
    progress.value = withTiming(fraction, {
      duration: t.motion.slow * 2,
      easing: Easing.out(Easing.exp),
    });
  }, [fraction, still, progress, t.motion.slow]);
  const drawn = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
  }));

  const numeral = Math.round(d * 0.3);
  const arc = {
    cx: centre,
    cy: centre,
    r,
    stroke: t.colors.accent,
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    fill: 'none',
    strokeDasharray: [circumference, circumference],
    testID: testID ? `${testID}-arc` : undefined,
  };

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={describeScore(score, band, provisional)}
      style={{ width: d, height: d, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg width={d} height={d} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Circle
          cx={centre}
          cy={centre}
          r={r}
          stroke={t.colors.border}
          strokeWidth={stroke}
          fill="none"
        />
        {fraction > 0 ? (
          // Rotated so the arc starts at twelve o'clock and runs clockwise, the way a dial reads.
          <G rotation={-90} originX={centre} originY={centre}>
            {still ? (
              <Circle {...arc} strokeDashoffset={circumference * (1 - fraction)} />
            ) : (
              <AnimatedCircle {...arc} animatedProps={drawn} />
            )}
          </G>
        ) : null}
      </Svg>
      <Text variant="display" style={{ fontSize: numeral, lineHeight: Math.round(numeral * 1.1) }}>
        {formatScore(score)}
      </Text>
      <Text variant="subhead" tone="muted" style={{ textAlign: 'center', maxWidth: d * 0.72 }}>
        {bandLabel(band)}
      </Text>
      {provisional ? (
        <Stamp
          kind="provisional"
          size="sm"
          style={{ position: 'absolute', bottom: 0, alignSelf: 'center' }}
        />
      ) : null}
    </View>
  );
}
