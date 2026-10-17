import { useState, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from 'react-native-reanimated';

import { useTheme } from '../theme';
import { Text } from './Text';

/**
 * Step-to-step motion for a wizard (a sheet that walks through steps): the new step slides in
 * from the side it comes from while the old one leaves the other way, both fading. Forward moves
 * left, back moves right. Under Reduce Motion it is a plain crossfade.
 *
 * Key the content by its step: `<StepTransition step={step} index={i}>…</StepTransition>`. The
 * direction is worked out from `index` going up or down, so a back button needs nothing extra.
 */
export function StepTransition({
  step,
  index,
  children,
  style,
}: {
  /** Identifies the step; a change animates. */
  step: string;
  /** The step's position, so the slide knows forward from back. */
  index: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const [last, setLast] = useState({ step, index, forward: true });
  if (last.step !== step) setLast({ step, index, forward: index >= last.index });
  const forward = last.forward;
  const duration = t.motion.slow;
  const ease = Easing.out(Easing.cubic);

  const entering = t.reduceMotion
    ? FadeIn.duration(t.motion.base)
    : (forward ? SlideInRight : SlideInLeft).duration(duration).easing(ease);
  const exiting = t.reduceMotion
    ? FadeOut.duration(t.motion.fast)
    : (forward ? SlideOutLeft : SlideOutRight).duration(Math.round(duration * 0.7)).easing(Easing.in(Easing.cubic));

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <Animated.View key={step} entering={entering} exiting={exiting}>
        {children}
      </Animated.View>
    </View>
  );
}

/**
 * A step counter as a row of pills: done steps filled ink, the current one long, the rest faint.
 * Speaks "Step 2 of 4".
 */
export function StepDots({ count, current, testID }: { count: number; current: number; testID?: string }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${current + 1} of ${count}`}
      accessibilityValue={{ min: 1, max: count, now: current + 1 }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}
    >
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{
            height: 6,
            width: i === current ? 22 : 6,
            borderRadius: 3,
            backgroundColor: i <= current ? t.colors.primary : t.colors.border,
          }}
        />
      ))}
      <Text variant="caption" tone="muted" style={{ marginLeft: t.space.xs }} accessible={false}>
        {current + 1}/{count}
      </Text>
    </View>
  );
}
