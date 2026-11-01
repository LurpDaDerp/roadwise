// The "Welcome" line as a drive ends at a saved place (the car stopped there, under 5 mph): a dark
// scrim of the screen's own ground fades in over everything but the emergency button, with one large
// centred line ("Welcome home", "Welcome to work", "Welcome to school", "Welcome to {name}"), read
// out to screen readers; a long place name shrinks the line rather than being cut off. It fades in over 500 ms, or shows at once under Reduce Motion. It takes no
// touch. The screen holds its way out (the recap, or Home) until it has shown for `ARRIVAL_HOLD_MS`.
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';

import type { DriveArrival } from '@/drive/host';
import type { HudPalette } from '@/ui/drive';
import { fontFamilies } from '@/ui/fonts';

import { hudCopy } from './hudCopy';

/** How long the line shows before the screen leaves for the recap (or Home). */
export const ARRIVAL_HOLD_MS = 2500;
/** The fade in. */
export const ARRIVAL_FADE_MS = 500;
/** A long place name shrinks the line (two lines at most) down to this share of its 44 pt. */
export const ARRIVAL_MIN_FONT_SCALE = 0.6;
/** The scrim: the screen's ground at this strength. */
export const ARRIVAL_SCRIM_OPACITY = 0.8;

/** The line for a place. */
export function arrivalLine(a: Pick<DriveArrival, 'kind' | 'name'>): string {
  if (a.kind === 'home' || a.kind === 'work' || a.kind === 'school') return hudCopy.arrival[a.kind];
  return hudCopy.arrival.custom(a.name.trim());
}

export function ArrivalOverlay({ arrival, palette: p, reduceMotion }: { arrival: DriveArrival; palette: HudPalette; reduceMotion: boolean }) {
  const line = arrivalLine(arrival);
  const [opacity] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(line);
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const fade = Animated.timing(opacity, { toValue: 1, duration: ARRIVAL_FADE_MS, useNativeDriver: true });
    fade.start();
    return () => fade.stop();
    // once per arrival: a later Reduce Motion change or re-render never replays it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrival.clientTripId]);

  return (
    <Animated.View testID="hud-arrival" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.root, { opacity }]}>
      <View testID="hud-arrival-scrim" style={[StyleSheet.absoluteFill, { backgroundColor: p.ground, opacity: ARRIVAL_SCRIM_OPACITY }]} />
      <Text
        testID="hud-arrival-line"
        allowFontScaling={false}
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={ARRIVAL_MIN_FONT_SCALE}
        style={[styles.line, { color: p.ink }]}
      >
        {line}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  line: { fontFamily: fontFamilies.fieldBold, fontSize: 44, lineHeight: 52, textAlign: 'center' },
});
