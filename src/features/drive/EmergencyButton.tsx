// The driving screen's emergency button: a quiet round button with a red call glyph on the same
// sky-tinted face as the navigation button (never a solid red disc), in a 64 pt target. It always
// works: never locked for speed or greyed out, also while the screen is dimmed, while a Start drive
// waits and while the drive saves, and nothing on the screen covers it. A tap opens the emergency
// panel (911 and the driver's contacts); the call itself takes a tap there and the phone's own
// confirmation, which is the guard against a pocket or an elbow.
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ensureGround } from '@/ui';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';

import type { HudButtonColors } from './hudButtons';
import { hudCopy } from './hudCopy';

/** The round face inside the 64 pt target: smaller than the navigation button's 80, so it stays quiet. */
export const SOS_FACE_PT = 56;
/** The red glyph against the face (a graphic: 4.5:1, past the 3:1 a glyph needs). */
export const SOS_GLYPH_MIN = 4.5;

/** The glyph's red: the sign ring's, deepened toward black until it reads on the (always light) face. */
export function sosGlyphColor(p: HudPalette, colors: HudButtonColors): string {
  return ensureGround(p.signRing, [colors.paper], SOS_GLYPH_MIN, '#000000');
}

export const EmergencyButton = memo(function EmergencyButton({
  palette,
  colors,
  open,
  onPress,
}: {
  palette: HudPalette;
  /** The navigation button's face (`hudButtonColors`). */
  colors: HudButtonColors;
  /** The panel is showing (screen readers hear it as expanded). */
  open: boolean;
  onPress(): void;
}) {
  const glyph = useMemo(() => sosGlyphColor(palette, colors), [palette, colors]);
  return (
    <Pressable
      testID="hud-sos"
      accessibilityRole="button"
      accessibilityLabel={hudCopy.sos.label}
      accessibilityHint={hudCopy.sos.hint}
      accessibilityState={{ expanded: open }}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      style={styles.target}
    >
      {({ pressed }) => (
        <View testID="hud-sos-face" style={[styles.face, { backgroundColor: colors.paper, opacity: pressed ? 0.8 : 1 }]}>
          <Ionicons name="call" size={26} color={glyph} />
        </View>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  target: { width: HUD_MIN_TARGET_PT, height: HUD_MIN_TARGET_PT, borderRadius: HUD_MIN_TARGET_PT / 2, alignItems: 'center', justifyContent: 'center' },
  face: { width: SOS_FACE_PT, height: SOS_FACE_PT, borderRadius: SOS_FACE_PT / 2, alignItems: 'center', justifyContent: 'center' },
});
