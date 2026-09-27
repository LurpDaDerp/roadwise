import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fontFamilies } from '@/ui/fonts';
import { hudPalette } from '@/ui/drive';

import { hudCopy } from './hudCopy';
import type { WeatherHazard } from './weather';

/** The top bar's height: the room it keeps whether or not there is a hazard, so nothing shifts. */
export const HAZARD_BAR_PT = 52;
const WORDS_PT = 18;

const ICON: Record<WeatherHazard, keyof typeof MaterialCommunityIcons.glyphMap> = {
  thunderstorm: 'weather-lightning',
  icy_rain: 'weather-snowy-rainy',
  heavy_snow: 'weather-snowy-heavy',
  dense_fog: 'weather-fog',
  heavy_rain: 'weather-pouring',
  strong_wind: 'weather-windy',
};

/**
 * The top bar: empty, or one weather hazard — a drawn mark in the attention colour and two words
 * on a navy pill. Only dangerous weather earns it; an ordinary day leaves the bar dark.
 */
export const HazardBar = memo(function HazardBar({
  hazard,
  night,
}: {
  hazard: WeatherHazard | null;
  night: boolean;
}) {
  const p = hudPalette(night);
  return (
    <View testID="hud-hazard-bar" style={styles.bar}>
      {hazard ? (
        <View
          testID="hud-hazard"
          accessible
          accessibilityRole="text"
          accessibilityLabel={hudCopy.hazard.label(hudCopy.hazard[hazard])}
          style={[styles.pill, { backgroundColor: p.chrome, borderColor: p.chromeEdge }]}
        >
          <MaterialCommunityIcons
            testID="hud-hazard-icon"
            name={ICON[hazard]}
            size={26}
            color={p.attention}
          />
          <Text allowFontScaling={false} numberOfLines={1} style={[styles.words, { color: p.ink }]}>
            {hudCopy.hazard[hazard]}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  bar: { height: HAZARD_BAR_PT, alignItems: 'center', justifyContent: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  words: {
    fontFamily: fontFamilies.fieldBold,
    fontSize: WORDS_PT,
    lineHeight: Math.round(WORDS_PT * 1.2),
  },
});
