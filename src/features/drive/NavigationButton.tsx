// The driving screen's navigation button (product spec v3 "Driving screen · Navigation"): a 64-pt
// round button with the saved app's short name, or "Navigate". Live at any speed. For the first
// 30 s of a drive (row clock) it wears a static accent ring when an app is saved, so a driver who
// came from the navigation app goes back through it.
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { NO_EVENTS_FIRST_S } from '@scoring';

import { navCopy } from '@/features/navigation/copy';
import { fontFamilies } from '@/ui/fonts';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';

/** The highlight shows while the drive is younger than this on the row clock. */
export const NAV_HIGHLIGHT_MS = NO_EVENTS_FIRST_S * 1000;
const RING_PT = 4;

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
  width = 96,
  onPress,
}: {
  /** The saved app's short name (≤ 12 characters), or null for "Navigate". */
  caption: string | null;
  /** The saved app's full name, for the screen reader. */
  appLabel: string | null;
  highlight: boolean;
  disabled: boolean;
  palette: HudPalette;
  /** The slot's width (the screen's layout); the caption shrinks to fit it. */
  width?: number;
  onPress(): void;
}) {
  return (
    <View style={[styles.slot, { width }]}>
      <Pressable
        testID="hud-nav"
        accessibilityRole="button"
        accessibilityLabel={appLabel === null ? navCopy.chooseLabel : navCopy.openLabel(appLabel)}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={8}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          onPress();
        }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: palette.chrome, borderColor: palette.chromeEdge, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        ]}
      >
        <Ionicons name="navigate" size={28} color={palette.ink} />
        {highlight ? <View testID="hud-nav-highlight" pointerEvents="none" style={[styles.ring, { borderColor: palette.ink }]} /> : null}
      </Pressable>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} allowFontScaling={false} style={[styles.caption, { color: palette.inkMuted, maxWidth: width }]}>
        {caption ?? navCopy.button}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  slot: { alignItems: 'center', gap: 6 },
  button: {
    width: HUD_MIN_TARGET_PT,
    height: HUD_MIN_TARGET_PT,
    borderRadius: HUD_MIN_TARGET_PT / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    top: -RING_PT - 2,
    left: -RING_PT - 2,
    right: -RING_PT - 2,
    bottom: -RING_PT - 2,
    borderRadius: (HUD_MIN_TARGET_PT + 2 * RING_PT + 4) / 2,
    borderWidth: RING_PT,
  },
  caption: { fontFamily: fontFamilies.label, fontSize: 15, lineHeight: 18 },
});
