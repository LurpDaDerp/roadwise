// The driving screen's navigation button (product spec v3 "Driving screen · Navigation"): an 80-pt
// round paper button (64 pt at least in a narrow slot) with the saved app's short name, or
// "Navigate". Live at any speed. For the first 30 s of a drive (row clock) it wears a static ring in
// the sky's accent when an app is saved, so a driver who
// came from the navigation app goes back through it. A tap opens the saved app, or the list when
// none is saved. A long press (500 ms) always opens the list: to change the saved app, or to pick
// one; screen readers get the change as the "Change navigation app" action once an app is saved.
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { NO_EVENTS_FIRST_S } from '@scoring';

import { navCopy } from '@/features/navigation/copy';
import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import type { HudButtonColors } from './hudButtons';
import { HUD_NAV_BUTTON_PT, HUD_NAV_H_PT, HUD_NAV_W_PT } from './hudLayout';

/** The highlight shows while the drive is younger than this on the row clock. */
export const NAV_HIGHLIGHT_MS = NO_EVENTS_FIRST_S * 1000;
const RING_PT = 4;
/** The caption's line and the gap above it. */
const CAPTION_PT = 24;
/** The long press that reopens the list (the platform's standard hold). */
export const NAV_LONG_PRESS_MS = 500;

/** Whether the button wears its highlight: an app is saved and the drive's rows are under 30 s old. */
export function navHighlight(saved: boolean, startedAt: number | null, lastRowTs: number | null): boolean {
  if (!saved || startedAt === null) return false;
  return lastRowTs === null || lastRowTs - startedAt < NAV_HIGHLIGHT_MS;
}

export const NavigationButton = memo(function NavigationButton({
  caption,
  appLabel,
  highlight,
  disabled,
  palette,
  colors,
  width = HUD_NAV_W_PT,
  height = HUD_NAV_H_PT,
  onPress,
  onLongPress,
}: {
  /** The saved app's short name (≤ 12 characters), or null for "Navigate". */
  caption: string | null;
  /** The saved app's full name, for the screen reader. */
  appLabel: string | null;
  highlight: boolean;
  disabled: boolean;
  palette: HudPalette;
  /** The button's paper, ink and accent (the app's, following the sky). */
  colors: HudButtonColors;
  /** The slot's width (the screen's layout); the caption shrinks to fit it. */
  width?: number;
  /** The slot's height: the circle is what it leaves above the caption, at most 80 pt. */
  height?: number;
  onPress(): void;
  /** The long press: the list, to change the saved app or, with none saved, to pick one. */
  onLongPress?: () => void;
}) {
  const canHold = onLongPress !== undefined && !disabled;
  const canChange = canHold && appLabel !== null;
  const d = Math.min(HUD_NAV_BUTTON_PT, width, height - CAPTION_PT);
  const buzz = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  return (
    <View style={[styles.slot, { width }]}>
      <Pressable
        testID="hud-nav"
        accessibilityRole="button"
        accessibilityLabel={appLabel === null ? navCopy.chooseLabel : navCopy.openLabel(appLabel)}
        accessibilityHint={canChange ? navCopy.changeHint : undefined}
        accessibilityActions={canChange ? [{ name: 'change', label: navCopy.changeLabel }] : undefined}
        onAccessibilityAction={(e) => {
          if (canChange && e.nativeEvent.actionName === 'change') onLongPress?.();
        }}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        delayLongPress={NAV_LONG_PRESS_MS}
        onPress={() => {
          buzz();
          onPress();
        }}
        onLongPress={
          canHold
            ? () => {
                buzz();
                onLongPress?.();
              }
            : undefined
        }
        style={({ pressed }) => [
          styles.button,
          { width: d, height: d, borderRadius: d / 2, backgroundColor: colors.paper, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        ]}
      >
        <Ionicons name="navigate" size={Math.round(d * 0.42)} color={colors.ink} />
        {highlight ? <View testID="hud-nav-highlight" pointerEvents="none" style={[styles.ring, { borderRadius: (d + 2 * RING_PT + 4) / 2, borderColor: colors.accent }]} /> : null}
      </Pressable>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} allowFontScaling={false} style={[styles.caption, { color: palette.inkMuted, maxWidth: width }]}>
        {caption ?? navCopy.button}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: { alignItems: 'center', gap: 6 },
  button: { alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    top: -RING_PT - 2,
    left: -RING_PT - 2,
    right: -RING_PT - 2,
    bottom: -RING_PT - 2,
    borderWidth: RING_PT,
  },
  caption: { fontFamily: fontFamilies.label, fontSize: 15, lineHeight: 18 },
});
