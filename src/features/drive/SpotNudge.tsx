// A problem spot's nudge on the driving screen (spots design §7.5): as the car comes up to a place
// where the same thing keeps happening, one silent line in the band for 4 s ("Watch your speed
// here"). The host decides when (in front only, at 10 mph and over, never over another alert, at
// most 3 a drive); this draws it. A static bar with a place-pin glyph in the screen's ink, never a
// tier colour: it is advice about a place, not an event. No sound, no haptic, no touch target.
import { Ionicons } from '@expo/vector-icons';
import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SPOT_NUDGE_MS } from '@/core/spots/constants';
import type { SpotNudge } from '@/core/spots/types';
import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import { useFlash } from './EventBanner';
import { hudCopy } from './hudCopy';

const OUTLINE_PT = 2;
const BAR_MIN_PT = 40;
/**
 * The line's type: the full band, and a compact window's narrow band (as the weather banner). The line is a
 * whole number of points and sits on whole points in the bar's 36 pt content box ((36 − line) / 2); the text
 * never scales itself (a long line gets a tail ellipsis).
 */
const TYPE = { full: { size: 20, line: 24 }, compact: { size: 16, line: 20 } } as const;

/** A nudge on screen, with the JS time its 4 s end. */
export type ShownNudge = SpotNudge & { until: number };

/**
 * The nudge to show right now: each new one (by its key) for what is left of `SPOT_NUDGE_MS` (4 s)
 * on the row clock, then nothing. Never the one standing when the screen mounts, and never one
 * already 4 s old when it reaches the screen.
 */
export function useSpotNudgeFlash(nudge: SpotNudge | null, rowTs: number | null, now: () => number = Date.now): ShownNudge | null {
  const f = useFlash(nudge?.key ?? null, nudge?.at ?? null, rowTs, SPOT_NUDGE_MS, now);
  return useMemo(() => (f === null || nudge === null ? null : { ...nudge, until: f.until }), [f, nudge]);
}

/** The nudge's line: the place pin and up to four words, read out as an alert. */
function SpotNudgeLineView({ nudge, palette: p, compact }: { nudge: SpotNudge; palette: HudPalette; compact: boolean }) {
  const words = hudCopy.spot[nudge.kind];
  const t = TYPE[compact ? 'compact' : 'full'];
  return (
    <View
      testID="hud-spot"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={words}
      style={[styles.bar, { backgroundColor: p.chrome, borderColor: p.chromeEdge }]}
    >
      <Ionicons testID="hud-spot-icon" name="location" size={22} color={p.ink} />
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.words, { color: p.ink, fontSize: t.size, lineHeight: t.line }]}
      >
        {words}
      </Text>
    </View>
  );
}

export const SpotNudgeLine = memo(SpotNudgeLineView);

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '100%',
    gap: 8,
    minHeight: BAR_MIN_PT,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: OUTLINE_PT,
  },
  words: { fontFamily: fontFamilies.fieldBold, flexShrink: 1 },
});
