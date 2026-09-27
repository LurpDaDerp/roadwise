import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '../fonts';
import { HOLD_TO_ACT_MS, HUD_MIN_TARGET_PT } from './hudTokens';

export type HoldButtonProps = {
  /** The printed word(s): "SOS", "End drive". */
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Face, print and (optional) edge colours from the HUD palette. */
  face: string;
  ink: string;
  edge?: string;
  /** A circle (SOS) or a pill (End). */
  shape: 'circle' | 'pill';
  /** How long the finger must stay down. Default `HOLD_TO_ACT_MS`. */
  holdMs?: number;
  onHold: () => void;
  testID?: string;
};

const CIRCLE_PT = 76;
const PILL_WIDTH_PT = 128;
const LABEL_PT = 20;
const FILL = 'rgba(255, 255, 255, 0.42)';

/**
 * A control that acts only after a sustained hold: the finger goes down, a fill rises through the
 * face for `holdMs`, and the action fires when the fill completes. Lifting, sliding off or a
 * cancelled touch before then resets the fill and does nothing — so a knock, a grab of the mount
 * or a palm cannot trigger it, which is what lets it stay live while the car moves. The timer
 * exists only while a finger is down; the fill is one linear timing on the native thread, never a
 * loop.
 */
export function HoldButton({
  label,
  accessibilityLabel,
  accessibilityHint,
  face,
  ink,
  edge,
  shape,
  holdMs = HOLD_TO_ACT_MS,
  onHold,
  testID,
}: HoldButtonProps) {
  const [progress] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fill = useRef<Animated.CompositeAnimation | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    fill.current?.stop();
    fill.current = null;
    progress.setValue(0);
  }, [progress]);

  const begin = useCallback(() => {
    cancel();
    fill.current = Animated.timing(progress, {
      toValue: 1,
      duration: holdMs,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    fill.current.start();
    timer.current = setTimeout(() => {
      timer.current = null;
      fill.current = null;
      progress.setValue(0);
      onHold();
    }, holdMs);
  }, [cancel, holdMs, onHold, progress]);

  useEffect(() => cancel, [cancel]);

  const circle = shape === 'circle';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPressIn={begin}
      onPressOut={cancel}
      style={[
        styles.button,
        circle ? styles.circle : styles.pill,
        { backgroundColor: face, borderColor: edge ?? face },
      ]}
    >
      <Animated.View
        testID={testID ? `${testID}-fill` : undefined}
        pointerEvents="none"
        style={[styles.fill, { transform: [{ scaleY: progress }] }]}
      />
      <View pointerEvents="none">
        <Text allowFontScaling={false} numberOfLines={1} style={[styles.label, { color: ink }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
  },
  circle: {
    width: CIRCLE_PT,
    height: CIRCLE_PT,
    borderRadius: CIRCLE_PT / 2,
  },
  pill: {
    minWidth: PILL_WIDTH_PT,
    height: HUD_MIN_TARGET_PT,
    borderRadius: HUD_MIN_TARGET_PT / 2,
    paddingHorizontal: 20,
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: FILL,
    transformOrigin: 'bottom',
  },
  label: {
    fontFamily: fontFamilies.fieldBold,
    fontSize: LABEL_PT,
    lineHeight: Math.round(LABEL_PT * 1.2),
    letterSpacing: 0.5,
  },
});
