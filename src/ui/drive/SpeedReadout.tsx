import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';

import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { DIGIT_HEIGHT_EM } from './halo';
import { hudLabelScale } from './hudTokens';

export type SpeedReadoutProps = {
  /** The whole-number speed in `unit`, or null for "—". */
  speed: number | null;
  /** Default mph. */
  unit?: 'mph' | 'km/h';
  /** The numerals' colour when no `numeralStyle` drives it. */
  color: string;
  unitColor: string;
  /** Numeral size in pt (`haloNumeralPt`). */
  size: number;
  /** The halo's animated colour for the numerals (it follows the ring). */
  numeralStyle?: AnimatedStyle<TextStyle>;
  /** Spoken only: over the limit right now. */
  speeding?: boolean;
};

/** The unit label's size at Dynamic Type 1x (it follows Dynamic Type up to 2x). */
export const SPEED_UNIT_PT = 20;
/** The numerals' text box: ascent + descent of the numeral font, so both platforms set the baseline at 1.0 pt. */
export const numeralLineHeight = (size: number): number => Math.round(1.2 * size);
/** Moves the digits' centre (0.643 pt from the box top) onto the box centre (0.6 pt). */
export const numeralShift = (size: number): number => -0.043 * size;
/** Where the unit label starts below the box top: under the digits, 6 pt clear. */
export const unitTop = (size: number): number => numeralLineHeight(size) / 2 + (DIGIT_HEIGHT_EM / 2) * size + 6;

/**
 * The current speed, large and tabular so the number never shifts sideways as it changes. Its box is
 * the numerals alone, with the digits optically centred in it, so the parent can centre the digits
 * in the halo; the unit label hangs under them. The colour comes from the halo (`numeralStyle`).
 * Nothing flashes. Silent to screen readers apart from its label: no live region, since continuous
 * speech is itself a distraction.
 */
function SpeedReadoutView({ speed, unit = 'mph', color, unitColor, size, numeralStyle, speeding = false }: SpeedReadoutProps) {
  const { fontScale } = useWindowDimensions();
  const spokenUnit = unit === 'km/h' ? 'kilometers per hour' : 'miles per hour';
  const label =
    speed === null ? 'Speed unknown' : `Speed ${speed} ${spokenUnit}${speeding ? ', over the limit' : ''}`;
  const lineHeight = numeralLineHeight(size);
  const unitPt = SPEED_UNIT_PT * hudLabelScale(fontScale);
  return (
    <View testID="hud-speed" accessible accessibilityRole="text" accessibilityLabel={label} style={[styles.box, { height: lineHeight }]}>
      <Animated.Text
        testID="hud-speed-numeral"
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.numeral, { color, fontSize: size, lineHeight, transform: [{ translateY: numeralShift(size) }] }, numeralStyle]}
      >
        {speed === null ? t('common.unknown') : String(speed)}
      </Animated.Text>
      <View pointerEvents="none" style={[styles.unitRow, { top: unitTop(size) }]}>
        <Text
          testID="hud-speed-unit"
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.unit, { color: unitColor, fontSize: unitPt, lineHeight: Math.round(1.2 * unitPt) }]}
        >
          {unit}
        </Text>
      </View>
    </View>
  );
}

export const SpeedReadout = memo(SpeedReadoutView);

const styles = StyleSheet.create({
  box: { overflow: 'visible', justifyContent: 'center' },
  numeral: {
    fontFamily: fontFamilies.numeralsBold,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
    textAlign: 'center',
  },
  unitRow: { position: 'absolute', left: -60, right: -60, alignItems: 'center' },
  unit: {
    fontFamily: fontFamilies.field,
    letterSpacing: 1,
    textAlign: 'center',
    includeFontPadding: false,
  },
});
