import { Ionicons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import type { HudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';

/** One line, only while an active weather alert covers the area ("Icy rain", "Dense fog"). */
function WeatherBannerView({ label, palette: p }: { label: string; palette: HudPalette }) {
  return (
    <View
      testID="hud-weather"
      accessible
      accessibilityLabel={hudCopy.weatherLabel(label)}
      style={[styles.bar, { backgroundColor: p.chrome, borderColor: p.chromeEdge }]}
    >
      <Ionicons name="warning" size={20} color={p.minor} />
      <Text allowFontScaling={false} numberOfLines={1} style={[styles.text, { color: p.ink }]}>
        {label}
      </Text>
    </View>
  );
}

export const WeatherBanner = memo(WeatherBannerView);

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
  },
  text: { fontFamily: fontFamilies.fieldBold, fontSize: 20, lineHeight: 24 },
});
