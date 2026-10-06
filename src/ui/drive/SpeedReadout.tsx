import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { hudLabelScale } from './hudTokens';

export type SpeedReadoutProps = {
  /** Whole mph from `useDriveLive`, or null for "—". */
  mph: number | null;
  /** The numerals' colour: the ink, or the speeding tier's colour. */
  color: string;
  unitColor: string;
  /** Numeral size in pt (`speedNumeralPt`). */
  size: number;
  /** Spoken only: over the limit right now. */
  speeding?: boolean;
};

const UNIT_PT = 20;

/**
 * The current speed, large and tabular so the number never shifts sideways as it changes. Over the
 * limit the numerals take the tier's colour; nothing flashes. Silent to screen readers apart from
 * its label: no live region, since continuous speech is itself a distraction.
 */
function SpeedReadoutView({ mph, color, unitColor, size, speeding = false }: SpeedReadoutProps) {
  const { fontScale } = useWindowDimensions();
  const label =
    mph === null ? 'Speed unknown' : `Speed ${mph} miles per hour${speeding ? ', over the limit' : ''}`;
  return (
    <View testID="hud-speed" accessible accessibilityRole="text" accessibilityLabel={label}>
      <Text
        testID="hud-speed-numeral"
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.numeral, { color, fontSize: size, lineHeight: Math.round(size * 1.05) }]}
      >
        {mph === null ? t('common.unknown') : String(mph)}
      </Text>
      <Text
        allowFontScaling={false}
        style={[styles.unit, { color: unitColor, fontSize: UNIT_PT * hudLabelScale(fontScale) }]}
      >
        mph
      </Text>
    </View>
  );
}

export const SpeedReadout = memo(SpeedReadoutView);

const styles = StyleSheet.create({
  numeral: {
    fontFamily: fontFamilies.numeralsBold,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
    textAlign: 'center',
  },
  unit: {
    fontFamily: fontFamilies.field,
    letterSpacing: 1,
    textAlign: 'center',
  },
});
