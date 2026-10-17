import { useEffect, useRef } from 'react';
import { AccessibilityInfo, View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { STEP_SETTLED_MS } from './StepTransition';

/**
 * A step's title: a header whose label carries the step number ("Step 2 of 3. Aim DashPal at your
 * face"), taking the screen reader's focus once the step has slid in (at once under Reduce Motion).
 */
export function StepTitle({ children, step, testID }: { children: string; step?: string | null; testID?: string }) {
  const th = useTheme();
  const ref = useRef<View>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        if (ref.current) AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
      },
      th.reduceMotion ? 0 : STEP_SETTLED_MS
    );
    return () => clearTimeout(timer);
    // Once per step: a new title text on the same step does not move the focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <View ref={ref} accessible accessibilityRole="header" accessibilityLabel={step ? `${step}. ${children}` : children} testID={testID}>
      <Text variant="title2">
        {children}
      </Text>
    </View>
  );
}

/** Say `text` to a screen reader (connecting, connected, done, a failure). */
export function announce(text: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(text);
  } catch {
    // no screen reader bridge (tests, web)
  }
}
