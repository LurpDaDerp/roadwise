import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/ui';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The tick's path length in the 64-unit box. */
const TICK_LENGTH = 40;
/** The stroke draws in this long. */
export const CHECK_DRAW_MS = 420;

/**
 * The check mark of a finished step: a disc that scales up and a tick whose stroke draws in
 * (420 ms). Static, drawn at once, under Reduce Motion or with `still`.
 */
export function Checkmark({ size = 72, still = false, testID }: { size?: number; still?: boolean; testID?: string }) {
  const th = useTheme();
  const quiet = still || th.reduceMotion;
  const draw = useSharedValue(quiet ? 1 : 0);
  const scale = useSharedValue(quiet ? 1 : 0.8);

  useEffect(() => {
    if (quiet) {
      draw.value = 1;
      scale.value = 1;
      return;
    }
    draw.value = withTiming(1, { duration: CHECK_DRAW_MS, easing: Easing.out(Easing.cubic) });
    scale.value = withSpring(1, th.motion.spring.bouncy);
  }, [quiet, draw, scale, th.motion.spring.bouncy]);

  const tick = useAnimatedProps(() => ({ strokeDashoffset: TICK_LENGTH * (1 - draw.value) }));
  const grow = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={testID}>
      <Animated.View style={[{ width: size, height: size }, grow]}>
        <Svg width={size} height={size} viewBox="0 0 64 64">
          <Circle cx={32} cy={32} r={30} fill={th.colors.successFaint} stroke={th.colors.success} strokeWidth={3} />
          <AnimatedPath
            d="M19 33 L28 42 L46 23"
            fill="none"
            stroke={th.colors.success}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={TICK_LENGTH}
            animatedProps={tick}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}
