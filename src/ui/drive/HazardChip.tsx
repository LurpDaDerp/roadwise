import { MaterialCommunityIcons } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { fontFamilies } from '../fonts';
import { hudLabelScale, hudPalette } from './hudTokens';

/** M3 has one hazard source: night. The C3 priority list grows here as sources arrive. */
export type HudHazard = 'night';

export type HazardChipProps = {
  kind: HudHazard | null;
  night: boolean;
};

const HAZARD: Record<
  HudHazard,
  {
    icon: keyof typeof MaterialCommunityIcons.glyphMap;
    words: string;
    label: string;
  }
> = {
  night: {
    icon: 'weather-night',
    words: 'Night',
    label: 'Hazard: night driving',
  },
};

const WORDS_PT = 17;

/**
 * The single hazard chip (C3 item 4): at most one at a time, a drawn mark and one or two words.
 * An outlined chip, not a filled one, so it never competes with an alert band for attention.
 */
function HazardChipView({ kind, night }: HazardChipProps) {
  const { fontScale } = useWindowDimensions();
  if (kind === null) return null;
  const p = hudPalette(night);
  const h = HAZARD[kind];
  return (
    <View
      testID="hud-hazard"
      accessible
      accessibilityRole="text"
      accessibilityLabel={h.label}
      style={[styles.chip, { borderColor: p.inkMuted }]}
    >
      <MaterialCommunityIcons testID="hud-hazard-icon" name={h.icon} size={22} color={p.ink} />
      <Text
        allowFontScaling={false}
        style={[styles.words, { color: p.ink, fontSize: WORDS_PT * hudLabelScale(fontScale) }]}
      >
        {h.words}
      </Text>
    </View>
  );
}

export const HazardChip = memo(HazardChipView);

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    borderWidth: 2,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  words: {
    fontFamily: fontFamilies.fieldBold,
  },
});
