import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { weatherCopy, weatherLabel, weatherTitle } from '@/features/weather/copy';
import type { DangerAlert } from '@/features/weather/danger';
import type { Units } from '@/lib/units';
import { fontFamilies } from '@/ui/fonts';
import { HUD_MIN_TARGET_PT, type HudPalette } from '@/ui/drive';

/** The ✕'s drawn disc; its touch target reaches the HUD's 64 pt through the hit slop. */
export const WEATHER_CLOSE_PT = 34;

/**
 * The dangerous-weather banner at the top of the driving screen (plan D14): a yellow outline, the
 * warning glyph and the alert's title (one to three words, all a moving driver should read). The
 * line of what to do is spoken with it. Its ✕ shows only while stopped (≤ 5 mph): while moving,
 * End and the navigation button are the only controls that take a touch.
 */
function WeatherBannerView({
  alert,
  units,
  palette: p,
  canDismiss,
  onDismiss,
}: {
  alert: DangerAlert;
  units: Units;
  palette: HudPalette;
  /** The car is stopped: the ✕ shows. */
  canDismiss: boolean;
  onDismiss(): void;
}) {
  const slop = (HUD_MIN_TARGET_PT - WEATHER_CLOSE_PT) / 2;
  return (
    <View testID="hud-weather" style={[styles.bar, { backgroundColor: p.chrome, borderColor: p.minor }]}>
      <View accessible accessibilityRole="alert" accessibilityLabel={weatherLabel(alert, units)} style={styles.words}>
        {/* The HUD's warning yellow: this banner shows only when the weather is dangerous. */}
        <Ionicons testID="hud-weather-icon" name="warning" size={22} color={p.minor} />
        <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.text, { color: p.ink }]}>
          {weatherTitle(alert)}
        </Text>
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
    minHeight: 40,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 22,
    borderWidth: 2,
  },
  words: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, paddingRight: 8, minHeight: 36 },
  text: { flexShrink: 1, fontFamily: fontFamilies.fieldBold, fontSize: 20, lineHeight: 24 },
  close: {
    width: WEATHER_CLOSE_PT,
    height: WEATHER_CLOSE_PT,
    borderRadius: WEATHER_CLOSE_PT / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
