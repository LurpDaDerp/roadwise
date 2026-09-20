import { useEffect } from 'react';
import type { DimensionValue } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../theme';

type Props = {
  width: DimensionValue;
  height: DimensionValue;
  radius?: number;
  testID?: string;
};

const DIM = 0.45;

/** A field on the card that has not been printed yet. Holds still when reduce motion is on. */
export function Skeleton({ width, height, radius, testID }: Props) {
  const t = useTheme();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (t.reduceMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(DIM, { duration: t.motion.slow * 2 }), -1, true);
  }, [opacity, t.reduceMotion, t.motion.slow]);

  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius ?? t.radius.sm,
          backgroundColor: t.colors.surfaceRaised,
        },
        pulse,
      ]}
    />
  );
}
