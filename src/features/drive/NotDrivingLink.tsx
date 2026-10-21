// "Not driving?" on the driving screen (modes plan §3.6): a small underlined link near the bottom
// that discards the drive (a passenger, a bus, a train). It shows while the drive's 2-minute budget
// lasts (time with the driving screen in front, the host's count) and is gone for good once it is
// spent. Quiet print, not a button: it must be findable, never inviting. Its touch box reaches the
// HUD's 64 pt through the hit slop. A touch that starts while the screen is dimmed only wakes it.
import { memo, useRef } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';
import { HUD_NOT_DRIVING_PT } from './hudLayout';

/** The link's touch box: at least this wide (centred), and the HUD's 64 pt tall through the slop. */
export const NOT_DRIVING_TOUCH_W_PT = 160;
const SLOP_PT = (HUD_MIN_TARGET_PT - HUD_NOT_DRIVING_PT) / 2;

function NotDrivingLinkView({
  palette: p,
  dimmed,
  onPress,
}: {
  palette: HudPalette;
  /** The screen is dimmed: a touch that starts now only wakes it (the screen's own touch handler). */
  dimmed: boolean;
  onPress(): void;
}) {
  // A touch that began on a dimmed screen: its press is the wake, never the link.
  const woke = useRef(false);
  return (
    <Pressable
      testID="hud-not-driving"
      accessibilityRole="button"
      accessibilityLabel={hudCopy.notDrivingLabel}
      accessibilityHint={hudCopy.notDrivingHint}
      hitSlop={{ top: SLOP_PT, bottom: SLOP_PT }}
      onPressIn={() => {
        woke.current = dimmed;
      }}
      onPress={() => {
        if (woke.current) {
          woke.current = false;
          return;
        }
        onPress();
      }}
      style={({ pressed }) => [styles.box, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text allowFontScaling={false} numberOfLines={1} style={[styles.words, { color: p.inkMuted, textDecorationColor: p.inkMuted }]}>
        {hudCopy.notDriving}
      </Text>
    </Pressable>
  );
}

export const NotDrivingLink = memo(NotDrivingLinkView);

const styles = StyleSheet.create({
  box: {
    minWidth: NOT_DRIVING_TOUCH_W_PT,
    minHeight: HUD_NOT_DRIVING_PT,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  words: { fontFamily: fontFamilies.field, fontSize: 18, lineHeight: 22, textDecorationLine: 'underline' },
});
