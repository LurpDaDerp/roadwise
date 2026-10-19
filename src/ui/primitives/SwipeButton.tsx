import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { IconName } from './Button';

export type SwipeButtonColors = {
  /** The capsule at rest. */
  track: string;
  /** What the knob reveals behind it as it slides (an accent). */
  fill: string;
  /** The disc and the icon on it. */
  knob: string;
  knobInk: string;
  /** The trailing chevron. */
  hint: string;
};

export type SwipeButtonProps = {
  /** The printed words, to the right of the knob: drawn by the caller in its own type. */
  label: ReactNode;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** The icon on the knob. */
  icon: IconName;
  colors: SwipeButtonColors;
  /** The capsule's height in pt; the knob is this less 12. Default 64. */
  height?: number;
  /** The action is under way: the knob sits at the end with a spinner and takes no swipe. */
  busy?: boolean;
  disabled?: boolean;
  onSwipe: () => void;
  testID?: string;
};

/** How far (of the knob's full travel) a swipe must reach to count. */
export const SWIPE_COMMIT = 0.85;
/** After a swipe whose action never reports busy, the knob slides home after this long. */
export const SWIPE_SETTLE_MS = 800;
const PAD = 6;
const SPRING = { damping: 18, stiffness: 220, mass: 0.6 } as const;

/**
 * Swipe-to-confirm: a capsule with a knob at its left carrying the icon and the words to its right.
 * The driver drags the knob right; an accent fill opens behind it as it goes. Past
 * `SWIPE_COMMIT` of the way a light tick says it will count; letting go there snaps it to the end
 * with a success haptic and fires `onSwipe`. Letting go short of it springs the knob home and does
 * nothing, so a knock or a brush cannot fire it. The drag runs on the UI thread. A screen reader's
 * double-tap is a deliberate act, so the `activate` action fires straight away.
 *
 * While `busy` the knob stays at the end with a spinner; when `busy` clears (the action failed) it
 * springs home. A swipe whose action never goes busy slides home after `SWIPE_SETTLE_MS`.
 */
export function SwipeButton({
  label,
  accessibilityLabel,
  accessibilityHint,
  icon,
  colors,
  height = 64,
  busy = false,
  disabled = false,
  onSwipe,
  testID,
}: SwipeButtonProps) {
  const knob = height - PAD * 2;
  const x = useSharedValue(0);
  const travel = useSharedValue(0);
  const armed = useSharedValue(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inactive = busy || disabled;

  const home = useCallback(() => {
    x.set(withSpring(0, SPRING));
  }, [x]);

  const tick = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const commit = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onSwipe();
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      if (!busyRef.current) home();
    }, SWIPE_SETTLE_MS);
  }, [onSwipe, home]);

  useEffect(
    () => () => {
      if (settle.current !== null) clearTimeout(settle.current);
    },
    []
  );

  // Busy holds the knob at the end; its clearing (a failed action) sends it home.
  useEffect(() => {
    if (busy) x.set(withTiming(travel.get(), { duration: 160 }));
    else home();
  }, [busy, x, travel, home]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .withTestId(testID ? `${testID}-pan` : 'swipe-pan')
        .enabled(!inactive)
        .activeOffsetX(8)
        .failOffsetY([-16, 16])
        .onUpdate((e) => {
          const m = travel.get();
          const nx = Math.min(Math.max(e.translationX, 0), m);
          x.set(nx);
          const over = m > 0 && nx >= m * SWIPE_COMMIT;
          if (over !== armed.get()) {
            armed.set(over);
            if (over) scheduleOnRN(tick);
          }
        })
        .onEnd((_e, success) => {
          const m = travel.get();
          armed.set(false);
          if (success && m > 0 && x.get() >= m * SWIPE_COMMIT) {
            x.set(withTiming(m, { duration: 120 }));
            scheduleOnRN(commit);
          } else x.set(withSpring(0, SPRING));
        }),
    [testID, inactive, travel, x, armed, tick, commit]
  );

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      travel.set(Math.max(0, e.nativeEvent.layout.width - knob - PAD * 2));
    },
    [travel, knob]
  );

  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const fillStyle = useAnimatedStyle(() => ({
    width: x.get() + knob + PAD * 2,
    opacity: interpolate(x.get(), [0, 24], [0, 1], 'clamp'),
  }));
  const labelStyle = useAnimatedStyle(() => {
    const m = travel.get();
    return { opacity: m > 0 ? interpolate(x.get(), [0, m * 0.6], [1, 0], 'clamp') : 1 };
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        testID={testID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: inactive, busy }}
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate' && !inactive) commit();
        }}
        onLayout={onLayout}
        style={[
          styles.track,
          { height, borderRadius: height / 2, backgroundColor: colors.track, opacity: disabled && !busy ? 0.5 : 1 },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[styles.fill, { borderRadius: height / 2, backgroundColor: colors.fill }, fillStyle]}
        />
        <Animated.View pointerEvents="none" style={[styles.label, { left: knob + PAD * 2, right: PAD + 28 }, labelStyle]}>
          {label}
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.hint, { right: PAD + 6 }, labelStyle]}>
          <Ionicons name="chevron-forward" size={20} color={colors.hint} />
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.knob,
            { left: PAD, width: knob, height: knob, borderRadius: knob / 2, backgroundColor: colors.knob },
            knobStyle,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.knobInk} />
          ) : (
            <Ionicons name={icon} size={Math.round(knob * 0.5)} color={colors.knobInk} />
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  track: { borderCurve: 'continuous', overflow: 'hidden', justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  label: { position: 'absolute', top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  knob: { position: 'absolute', alignItems: 'center', justifyContent: 'center', boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.25)' },
});
