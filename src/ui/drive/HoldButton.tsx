import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { fontFamilies } from '../fonts';
import { END_BUTTON_PT, END_RING_PT, HOLD_TO_END_MS } from './hudTokens';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export type HoldButtonProps = {
  /** The printed word: "End". */
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Face, print, the ring's fill and its track, from the HUD palette. */
  face: string;
  ink: string;
  ring: string;
  track: string;
  /** Outer diameter in pt, ring included. Default `END_BUTTON_PT`. */
  size?: number;
  /** How long the finger must stay down. Default `HOLD_TO_END_MS`. */
  holdMs?: number;
  /** While true nothing starts (e.g. the drive is already ending). */
  disabled?: boolean;
  onHold: () => void;
  testID?: string;
};

/**
 * Hold-to-confirm: the finger goes down, a ring fills around the button for `holdMs`, and the action
 * fires — with one haptic tick — the moment the ring closes. Lifting or sliding off before then
 * empties the ring and does nothing, so a knock or a grab of the mount cannot fire it, which is what
 * lets it stay live while the car moves. The fill is one linear timing on the UI thread; the commit
 * is a single JS timer that exists only while a finger is down. A screen reader's double-tap is a
 * deliberate act, so the `activate` action fires straight away.
 */
export function HoldButton({
  label,
  accessibilityLabel,
  accessibilityHint,
  face,
  ink,
  ring,
  track,
  size = END_BUTTON_PT,
  holdMs = HOLD_TO_END_MS,
  disabled = false,
  onHold,
  testID,
}: HoldButtonProps) {
  const progress = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    cancelAnimation(progress);
    progress.set(0);
  }, [progress]);

  const fire = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onHold();
  }, [onHold]);

  const begin = useCallback(() => {
    reset();
    if (disabled) return;
    progress.set(withTiming(1, { duration: holdMs, easing: Easing.linear }));
    timer.current = setTimeout(() => {
      timer.current = null;
      fire();
    }, holdMs);
  }, [reset, disabled, progress, holdMs, fire]);

  useEffect(() => reset, [reset]);

  const r = (size - END_RING_PT) / 2;
  const circ = 2 * Math.PI * r;
  const arc = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - progress.get()) }));
  const inner = size - END_RING_PT * 2 - 6;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate' && !disabled) fire();
      }}
      onPressIn={begin}
      onPressOut={reset}
      pressRetentionOffset={16}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg
        width={size}
        height={size}
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { transform: [{ rotate: '-90deg' }] }]}
      >
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={END_RING_PT} fill="none" />
        <AnimatedCircle
          testID={testID ? `${testID}-ring` : undefined}
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={ring}
          strokeWidth={END_RING_PT}
          strokeLinecap="round"
          strokeDasharray={`${circ} ${circ}`}
          animatedProps={arc}
          fill="none"
        />
      </Svg>
      <View
        pointerEvents="none"
        style={[
          styles.face,
          { width: inner, height: inner, borderRadius: inner / 2, backgroundColor: face, opacity: disabled ? 0.5 : 1 },
        ]}
      >
        <Text allowFontScaling={false} numberOfLines={1} style={[styles.label, { color: ink }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const LABEL_PT = 22;

const styles = StyleSheet.create({
  face: { alignItems: 'center', justifyContent: 'center' },
  label: {
    fontFamily: fontFamilies.fieldBold,
    fontSize: LABEL_PT,
    lineHeight: Math.round(LABEL_PT * 1.2),
    letterSpacing: 0.5,
  },
});
