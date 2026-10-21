import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  /**
   * How far (pt) a finger may move up or down before the drag counts as horizontal and the swipe
   * gives way (only before it starts). Default 16: a swipe inside a scroll view leaves vertical drags
   * to it. Where nothing scrolls, wider forgives a diagonal start (End takes 24).
   */
  verticalSlop?: number;
};

/** How far (of the knob's full travel) a drag must reach to arm the swipe… */
export const SWIPE_COMMIT = 0.6;
/** …and never less than this (pt), so a short track still takes a deliberate drag (capped at the travel). */
export const SWIPE_COMMIT_MIN_PT = 72;
/** Armed, the knob stays at the end until the finger comes back this far (pt) under the commit point. */
export const SWIPE_DISARM_PT = 24;
/** A quick flick counts when let go at this speed (pt/s) or faster… */
export const SWIPE_FLING_PT_S = 800;
/** …past this much of the travel (and at least `SWIPE_FLING_MIN_PT`, capped at the travel). */
export const SWIPE_FLING_FROM = 0.4;
export const SWIPE_FLING_MIN_PT = 56;

/** Where a drag arms the swipe on a knob that travels `travel` pt: 60 % of it, at least 72 pt. */
export function swipeCommitAt(travel: number): number {
  'worklet';
  return Math.min(travel, Math.max(SWIPE_COMMIT * travel, SWIPE_COMMIT_MIN_PT));
}

/** How far a flick must have carried the knob to count: 40 % of the travel, at least 56 pt. */
export function swipeFlingFrom(travel: number): number {
  'worklet';
  return Math.min(travel, Math.max(SWIPE_FLING_FROM * travel, SWIPE_FLING_MIN_PT));
}
/** After a swipe, the knob slides home this long after its action is (or stops being) not busy. */
export const SWIPE_SETTLE_MS = 800;
const PAD = 6;
const SPRING = { damping: 18, stiffness: 220, mass: 0.6 } as const;

/**
 * Swipe-to-confirm: a capsule with a knob at its left carrying the icon and the words to its right.
 * The driver drags the knob right; an accent fill opens behind it as it goes. Past the commit point
 * (`swipeCommitAt`: 60 % of the way, at least 72 pt) a light tick says it will count and the knob
 * springs the rest of the way by itself; dragging back more than 24 pt under the point lets it go
 * again. Letting go while it is armed, or flicking it (800 pt/s or faster, past 40 % of the way and at
 * least 56 pt), fires `onSwipe` with a success haptic. Only letting go decides: letting go anywhere
 * else springs the knob home and does nothing, and a tap does nothing, so a knock or a brush cannot
 * fire it. The drag runs on the UI thread. A screen reader's double-tap is a deliberate act, so the
 * `activate` action fires straight away.
 *
 * While `busy` the knob stays at the end with a spinner. When `busy` clears (the action failed), or
 * when a swipe's action never goes busy, it springs home after `SWIPE_SETTLE_MS`.
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
  verticalSlop = 16,
}: SwipeButtonProps) {
  const knob = height - PAD * 2;
  const x = useSharedValue(0);
  const travel = useSharedValue(0);
  const armed = useSharedValue(false);
  // Swipes so far: the one just made waits a moment for its action to go busy before sliding home.
  const [swipes, setSwipes] = useState(0);
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
    setSwipes((n) => n + 1);
  }, [onSwipe]);

  // Busy holds the knob at the end. Not busy, it goes home: after a swipe, once the action has had a
  // moment to go busy (or, having failed, to stop being busy).
  useEffect(() => {
    if (busy) {
      x.set(withTiming(travel.get(), { duration: 160 }));
      return;
    }
    if (swipes === 0) {
      home();
      return;
    }
    const timer = setTimeout(home, SWIPE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [busy, swipes, x, travel, home]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .withTestId(testID ? `${testID}-pan` : 'swipe-pan')
        .enabled(!inactive)
        .activeOffsetX(8)
        .failOffsetY([-verticalSlop, verticalSlop])
        .onUpdate((e) => {
          const m = travel.get();
          const nx = Math.min(Math.max(e.translationX, 0), m);
          const at = swipeCommitAt(m);
          if (armed.get()) {
            // Armed: the knob sits at the end until the finger comes well back under the point.
            if (nx >= at - SWIPE_DISARM_PT) return;
            armed.set(false);
            x.set(nx);
            return;
          }
          if (m > 0 && nx >= at) {
            // The magnet: the knob springs on to the end by itself.
            armed.set(true);
            x.set(withSpring(m, SPRING));
            scheduleOnRN(tick);
            return;
          }
          x.set(nx);
        })
        .onEnd((e, success) => {
          const m = travel.get();
          const wasArmed = armed.get();
          armed.set(false);
          const dx = Math.min(Math.max(e.translationX, 0), m);
          const fling = e.velocityX >= SWIPE_FLING_PT_S && dx >= swipeFlingFrom(m);
          if (success && m > 0 && (wasArmed || fling)) {
            x.set(withTiming(m, { duration: 120 }));
            scheduleOnRN(commit);
          } else x.set(withSpring(0, SPRING));
        }),
    [testID, inactive, verticalSlop, travel, x, armed, tick, commit]
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
          testID={testID ? `${testID}-knob` : undefined}
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
