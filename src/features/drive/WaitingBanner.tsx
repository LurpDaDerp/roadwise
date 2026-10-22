// The band while a Start drive swipe waits for the car to move (modes plan §3.7): "Ready to roll",
// and under it "Saved once you drive". The car is still, so this is the one band line that
// is not an alert: a quiet chrome bar with the screen's own outline, read out once as one sentence.
import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

const OUTLINE_PT = 2;
const BAR_MIN_PT = 40;
/**
 * The two lines' type: the full band (56 pt), and a compact window's narrow band (as the weather banner).
 * The lines are whole points and the compact pair (20 + 16) fills the bar's 36 pt content box, so every
 * Text frame lands on whole points in any band; the texts never scale themselves (a long line gets a tail ellipsis).
 */
const TYPE = {
  full: { title: 20, titleLine: 24, line: 15, lineLine: 18, pad: 3 },
  compact: { title: 16, titleLine: 20, line: 13, lineLine: 16, pad: 0 },
} as const;

function WaitingBannerView({ palette: p, compact }: { palette: HudPalette; compact: boolean }) {
  const t = TYPE[compact ? 'compact' : 'full'];
  return (
    <View
      testID="hud-waiting"
      accessible
      accessibilityLabel={hudCopy.waiting.spoken}
      style={[styles.bar, { backgroundColor: p.chrome, borderColor: p.chromeEdge, paddingVertical: t.pad }]}
    >
      <Ionicons name="car-sport" size={22} color={p.ink} />
      <View style={styles.lines}>
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.title, { color: p.ink, fontSize: t.title, lineHeight: t.titleLine }]}
        >
          {hudCopy.waiting.title}
        </Text>
        <Text
          testID="hud-waiting-line"
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.line, { color: p.inkMuted, fontSize: t.line, lineHeight: t.lineLine }]}
        >
          {hudCopy.waiting.line}
        </Text>
      </View>
    </View>
  );
}

export const WaitingBanner = memo(WaitingBannerView);

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '100%',
    gap: 10,
    minHeight: BAR_MIN_PT,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: OUTLINE_PT,
  },
  lines: { flexShrink: 1 },
  title: { fontFamily: fontFamilies.fieldBold },
  line: { fontFamily: fontFamilies.field },
});
