import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { weatherAction, weatherCopy, weatherLabel, weatherTitle } from '@/features/weather/copy';
import type { DangerAlert } from '@/features/weather/danger';
import type { Units } from '@/lib/units';
import { fontFamilies } from '@/ui/fonts';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';

/** The ✕'s drawn disc; its touch target reaches the HUD's 64 pt through the hit slop. */
export const WEATHER_CLOSE_PT = 34;

const OUTLINE_PT = 2;
const BAR_MIN_PT = 40;
/** The two lines' type: the full band (56 pt), and a compact window's 40 pt band. */
const TYPE = {
  full: { title: 20, titleLine: 24, action: 15, actionLine: 18, pad: 3 },
  compact: { title: 16, titleLine: 19, action: 13, actionLine: 16, pad: 0 },
} as const;

/** The banner's height at most: its two lines, padding and outline, or its floor (the band must hold it). */
export function weatherBannerPt(compact: boolean): number {
  const t = TYPE[compact ? 'compact' : 'full'];
  return Math.max(BAR_MIN_PT, t.titleLine + t.actionLine + 2 * t.pad + 2 * OUTLINE_PT);
}

/**
 * The dangerous-weather banner at the top of the driving screen (plan D14): a yellow outline, the
 * warning glyph, the alert's title (one to three words) and under it the warning, what to do in
 * four words at most. The full line is spoken with it. Its ✕ shows only while stopped (≤ 5 mph):
 * while moving, End and the navigation button are the only controls that take a touch.
 */
function WeatherBannerView({
  alert,
  units,
  palette: p,
  compact,
  canDismiss,
  onDismiss,
}: {
  alert: DangerAlert;
  units: Units;
  palette: HudPalette;
  /** A compact window's 40 pt band: smaller type. */
  compact: boolean;
  /** The car is stopped: the ✕ shows. */
  canDismiss: boolean;
  onDismiss(): void;
}) {
  const slop = (HUD_MIN_TARGET_PT - WEATHER_CLOSE_PT) / 2;
  const t = TYPE[compact ? 'compact' : 'full'];
  return (
    <View testID="hud-weather" style={[styles.bar, { backgroundColor: p.chrome, borderColor: p.minor, paddingVertical: t.pad }]}>
      <View accessible accessibilityRole="alert" accessibilityLabel={weatherLabel(alert, units)} style={styles.words}>
        {/* The HUD's warning yellow: this banner shows only when the weather is dangerous. */}
        <Ionicons testID="hud-weather-icon" name="warning" size={22} color={p.minor} />
        <View style={styles.lines}>
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            style={[styles.title, { color: p.ink, fontSize: t.title, lineHeight: t.titleLine }]}
          >
            {weatherTitle(alert)}
          </Text>
          <Text
            testID="hud-weather-action"
            allowFontScaling={false}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            style={[styles.action, { color: p.inkMuted, fontSize: t.action, lineHeight: t.actionLine }]}
          >
            {weatherAction(alert)}
          </Text>
        </View>
      </View>
      {canDismiss ? (
        <Pressable
          testID="hud-weather-close"
          accessibilityRole="button"
          accessibilityLabel={weatherCopy.dismiss}
          accessibilityHint={weatherCopy.dismissDriveHint}
          hitSlop={slop}
          onPress={onDismiss}
          style={({ pressed }) => [styles.close, { borderColor: p.chromeEdge, opacity: pressed ? 0.7 : 1 }]}
        >
          <Ionicons name="close" size={22} color={p.ink} />
        </Pressable>
      ) : null}
    </View>
  );
}

export const WeatherBanner = memo(WeatherBannerView);

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    maxWidth: '100%',
    gap: 10,
    minHeight: BAR_MIN_PT,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 22,
    borderWidth: OUTLINE_PT,
  },
  words: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, paddingRight: 8, minHeight: 36 },
  lines: { flexShrink: 1 },
  title: { fontFamily: fontFamilies.fieldBold },
  action: { fontFamily: fontFamilies.field },
  close: {
    width: WEATHER_CLOSE_PT,
    height: WEATHER_CLOSE_PT,
    borderRadius: WEATHER_CLOSE_PT / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
