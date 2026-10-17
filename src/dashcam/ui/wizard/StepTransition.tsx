import type { ReactNode } from 'react';
import Animated, { Easing, FadeIn, FadeInRight, FadeOut, FadeOutLeft } from 'react-native-reanimated';

import { useTheme } from '@/ui';

/** The incoming step's slide (starting 120 ms into the outgoing one's 180 ms). */
export const STEP_IN_MS = 260;
export const STEP_IN_DELAY_MS = 120;
export const STEP_OUT_MS = 180;
/** Under Reduce Motion: a crossfade, no slide. */
export const STEP_FADE_MS = 150;
/** When the incoming step has settled: its title takes the screen reader's focus then. */
export const STEP_SETTLED_MS = STEP_IN_DELAY_MS + STEP_IN_MS;

/**
 * One wizard step's change: the outgoing step fades out moving left, the new one fades in from the
 * right; a plain crossfade under Reduce Motion. `stepKey` names the step (a new key is a new step).
 */
export function StepTransition({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  const th = useTheme();
  const entering = th.reduceMotion
    ? FadeIn.duration(STEP_FADE_MS)
    : FadeInRight.duration(STEP_IN_MS).delay(STEP_IN_DELAY_MS).easing(Easing.out(Easing.cubic));
  const exiting = th.reduceMotion ? FadeOut.duration(STEP_FADE_MS) : FadeOutLeft.duration(STEP_OUT_MS).easing(Easing.in(Easing.cubic));
  return (
    <Animated.View key={stepKey} entering={entering} exiting={exiting} testID={`wizard-step-${stepKey}`}>
      {children}
    </Animated.View>
  );
}
