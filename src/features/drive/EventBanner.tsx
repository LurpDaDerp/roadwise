import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';
import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ALERT_GLOW_MS } from '@/core/alerts/policy';
import type { RoadCondition } from '@/core/road';
import { fontFamilies } from '@/ui/fonts';
import { type HudPalette, tierColor } from '@/ui/drive';

import { hudCopy } from './hudCopy';
import { ROAD_MARK, roadColor } from './roadMark';

export interface HudAlert {
  type: EventType;
  tier: Tier;
  at: number;
  /** A weather warning's road condition (its icon and colour on the chip); absent on a regular alert. */
  road?: RoadCondition;
}

const ICON: Record<EventType, keyof typeof Ionicons.glyphMap> = {
  speeding: 'speedometer',
  hard_brake: 'stop-circle',
  hard_accel: 'flash',
  hard_corner: 'return-up-forward',
  phone_pickup: 'phone-portrait',
  eyes_off: 'eye-off',
  drowsy: 'moon',
};

const keyOf = (a: HudAlert | null): string | null => (a === null ? null : `${a.type}:${a.at}${a.road === undefined ? '' : `:${a.road}`}`);

/** An alert on screen, with the JS time its flash ends. */
export type HudFlash = HudAlert & { until: number };

/**
 * A flash on the row clock: the thing named `key`, raised on the row at `at`, shows for what is
 * left of its `ms` (`rowTs − at`; a live one is raised on the row it carries, so it shows the full
 * `ms`), then nothing. One already `ms` old when it reaches the screen (raised while RoadWise was
 * in the background) is never shown, and neither is the one standing when the screen mounts.
 * `until`: the JS time its flash ends.
 */
export function useFlash(
  key: string | null,
  at: number | null,
  rowTs: number | null,
  ms: number,
  now: () => number = Date.now
): { key: string; until: number } | null {
  // The one standing when the screen mounts is old news.
  const [mountKey] = useState(key);
  const [expired, setExpired] = useState<string | null>(null);
  // Read once, as it arrives: its age on the row clock and the JS time it was first seen.
  const arrival = useMemo(
    () => ({ key, left: at === null ? 0 : ms - (rowTs === null ? 0 : Math.max(0, rowTs - at)), seenAt: now() }),
    // `key` names it (the object may be a fresh copy of the same one); `rowTs`, `at` and the clock
    // are read as it arrives, never again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, ms]
  );
  const live = key !== null && key !== mountKey && arrival.left > 0;
  useEffect(() => {
    if (!live || key === null) return;
    const timer = setTimeout(() => setExpired(key), arrival.left);
    return () => clearTimeout(timer);
  }, [live, key, arrival]);
  return useMemo(() => (!live || key === null || key === expired ? null : { key, until: arrival.seenAt + arrival.left }), [live, key, expired, arrival]);
}

/**
 * The alert to show right now (`useFlash` over `lastAlert`): each new one for what is left of its
 * 1.5 s on the row clock, never a stale one, never the one standing at mount.
 */
export function useAlertFlash(alert: HudAlert | null, rowTs: number | null, ms: number = ALERT_GLOW_MS, now: () => number = Date.now): HudFlash | null {
  const f = useFlash(keyOf(alert), alert?.at ?? null, rowTs, ms, now);
  return useMemo(() => (f === null || alert === null ? null : { ...alert, until: f.until }), [f, alert]);
}

/**
 * The event chip at the top: the tier's colour, an icon and one or two words. A weather warning's
 * chip has the same words in its road condition's colour, the condition's icon after the event's
 * (`roadMark.ts`), and its screen-reader label names the condition ("Hard brake, wet road"). Static:
 * it appears and goes; the halo's pulses carry it peripherally.
 */
function EventBannerView({ alert, palette }: { alert: HudAlert; palette: HudPalette }) {
  const words = hudCopy.alert[alert.type];
  const mark = alert.road === undefined ? null : ROAD_MARK[alert.road];
  return (
    <View
      testID="hud-alert"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={mark === null ? words : `${words}, ${mark.spoken}`}
      style={[styles.chip, mark === null ? null : styles.roadChip, { backgroundColor: alert.road === undefined ? tierColor(palette, alert.tier) : roadColor(palette, alert.road) }]}
    >
      {mark === null ? (
        <Ionicons testID="hud-alert-icon" name={ICON[alert.type]} size={ICON_PT} color={palette.ground} />
      ) : (
        <View style={styles.icons}>
          <Ionicons testID="hud-alert-icon" name={ICON[alert.type]} size={ROAD_ICON_PT} color={palette.ground} />
          <MaterialCommunityIcons testID="hud-alert-road" name={mark.icon} size={ROAD_ICON_PT} color={palette.ground} />
        </View>
      )}
      <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.words, { color: palette.ground }]}>
        {words}
      </Text>
    </View>
  );
}

export const EventBanner = memo(EventBannerView);

/** A regular chip's icon. */
const ICON_PT = 28;
/**
 * A weather chip's two icons, side by side with no gap (each glyph's own margin parts them), and its
 * tighter padding and gap: its fixed parts take no more width than a regular chip's (14 + 24 + 24 +
 * 6 + 14 = 22 + 28 + 10 + 22), so its words get the same room in the narrowest (160 pt) band.
 */
const ROAD_ICON_PT = 24;

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '100%',
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 22,
    borderRadius: 28,
  },
  roadChip: { gap: 6, paddingHorizontal: 14 },
  icons: { flexDirection: 'row', alignItems: 'center' },
  words: { fontFamily: fontFamilies.fieldBold, fontSize: 28, lineHeight: 34, flexShrink: 1 },
});
