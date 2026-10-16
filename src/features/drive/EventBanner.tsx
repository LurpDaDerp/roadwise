import { Ionicons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';
import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ALERT_GLOW_MS } from '@/core/alerts/policy';
import { fontFamilies } from '@/ui/fonts';
import { type HudPalette, tierColor } from '@/ui/drive';

import { hudCopy } from './hudCopy';

export interface HudAlert {
  type: EventType;
  tier: Tier;
  at: number;
}

const ICON: Record<EventType, keyof typeof Ionicons.glyphMap> = {
  speeding: 'speedometer',
  hard_brake: 'stop-circle',
  hard_accel: 'flash',
  hard_corner: 'return-up-forward',
  phone_pickup: 'phone-portrait',
  phone_handling: 'phone-portrait',
  eyes_off: 'eye-off',
  drowsy: 'moon',
};

const keyOf = (a: HudAlert | null): string | null => (a === null ? null : `${a.type}:${a.at}`);

/** An alert on screen, with the JS time its flash ends. */
export type HudFlash = HudAlert & { until: number };

/**
 * The alert to show right now: each new `lastAlert` for what is left of its `ms` (1.5 s) on the
 * row clock (`rowTs − at`; a live alert is raised on the row it carries, so it shows the full
 * 1.5 s), then nothing. One already 1.5 s old when it reaches the screen (raised while RoadWise was
 * in the background) is never shown, and neither is the alert standing when the screen mounts.
 */
export function useAlertFlash(alert: HudAlert | null, rowTs: number | null, ms: number = ALERT_GLOW_MS, now: () => number = Date.now): HudFlash | null {
  const key = keyOf(alert);
  // The alert standing when the screen mounts is old news.
  const [mountKey] = useState(key);
  const [expired, setExpired] = useState<string | null>(null);
  // Read once, as the alert arrives: its age on the row clock and the JS time it was first seen.
  const arrival = useMemo(
    () => ({ key, left: alert === null ? 0 : ms - (rowTs === null ? 0 : Math.max(0, rowTs - alert.at)), seenAt: now() }),
    // `key` names the alert (the object may be a fresh copy of the same one); `rowTs` and the clock
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
  const flash = useMemo(() => (alert === null || !live ? null : { ...alert, until: arrival.seenAt + arrival.left }), [alert, live, arrival]);
  return flash === null || key === expired ? null : flash;
}

/**
 * The event chip at the top: the tier's colour, an icon and one or two words. Static — it appears
 * and goes; the halo's pulses carry it peripherally.
 */
function EventBannerView({ alert, palette }: { alert: HudAlert; palette: HudPalette }) {
  const words = hudCopy.alert[alert.type];
  return (
    <View
      testID="hud-alert"
      accessible
      accessibilityRole="alert"
      accessibilityLabel={words}
      style={[styles.chip, { backgroundColor: tierColor(palette, alert.tier) }]}
    >
      <Ionicons name={ICON[alert.type]} size={28} color={palette.ground} />
      <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.words, { color: palette.ground }]}>
        {words}
      </Text>
    </View>
  );
}

export const EventBanner = memo(EventBannerView);

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
  words: { fontFamily: fontFamilies.fieldBold, fontSize: 28, lineHeight: 34, flexShrink: 1 },
});
