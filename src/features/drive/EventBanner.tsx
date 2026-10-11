import { Ionicons } from '@expo/vector-icons';
import type { EventType, Tier } from '@scoring';
import { memo, useEffect, useRef, useState } from 'react';
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

/**
 * The alert to show right now: each new `lastAlert` for `ms` (1.5 s), then nothing. The alert
 * already standing when the screen mounts is old news and is not shown.
 */
export function useAlertFlash(alert: HudAlert | null, ms: number = ALERT_GLOW_MS): HudAlert | null {
  const [shown, setShown] = useState<HudAlert | null>(null);
  const seen = useRef(keyOf(alert));
  const key = keyOf(alert);
  useEffect(() => {
    if (key === null || key === seen.current) return;
    seen.current = key;
    setShown(alert);
    const timer = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(timer);
    // `key` names the alert; the object itself may be a fresh copy of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return shown;
}

/**
 * The event chip at the top: the tier's colour, an icon and one or two words. Static — it appears
 * and goes; the edge glow in the same colour carries it peripherally.
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
      <Text allowFontScaling={false} numberOfLines={1} style={[styles.words, { color: palette.ground }]}>
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
    gap: 10,
    minHeight: 56,
    paddingHorizontal: 22,
    borderRadius: 28,
  },
  words: { fontFamily: fontFamilies.fieldBold, fontSize: 28, lineHeight: 34 },
});
