import { memo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';

import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { DIGIT_HEIGHT_EM } from './halo';
import { hudLabelScale } from './hudTokens';

export type SpeedReadoutProps = {
  /** The whole-number speed in `unit`, or null for "-". */
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

/**
 * Barlow Semi Condensed ExtraBold (the numerals' face, read from its TTF), in em: the widest digit
 * ("4"; the tabular digits drawn are 0.535, so this holds even without tabular figures), the hyphen
 * that stands for an unknown value, and anything else at a generous 0.6.
 */
export const NUMERAL_DIGIT_MAX_EM = 0.566;
export const NUMERAL_DASH_EM = 0.376;
const NUMERAL_OTHER_EM = 0.6;
/** The hyphen's ink, in em above the baseline (the digits run from 0 to `DIGIT_HEIGHT_EM`). */
export const DASH_INK_EM = { bottom: 0.219, top: 0.361 };
/** Where the ink's centre sits above the baseline, in em: the digits' and the hyphen's. */
export const DIGIT_CENTRE_EM = DIGIT_HEIGHT_EM / 2;
export const DASH_CENTRE_EM = (DASH_INK_EM.bottom + DASH_INK_EM.top) / 2;

/** The width of `text` in the numerals' face, in em, never less than the real drawing. */
export function numeralWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) em += ch >= '0' && ch <= '9' ? NUMERAL_DIGIT_MAX_EM : ch === '-' ? NUMERAL_DASH_EM : NUMERAL_OTHER_EM;
  return em;
}

/** `text`'s ink, in em above the baseline: a dash (an unknown value) sits low; anything else is taken as digits. */
export const numeralInkEm = (text: string): { bottom: number; top: number } =>
  /^[-‐‑–—]+$/.test(text) ? DASH_INK_EM : { bottom: 0, top: DIGIT_HEIGHT_EM };

/** How far above the baseline `text`'s ink is centred, in em ("-" sits lower than the digits). */
export const numeralCentreEm = (text: string): number => {
  const ink = numeralInkEm(text);
  return (ink.bottom + ink.top) / 2;
};

/**
 * The spare height every numeral `Text` gets under its line, pt. iOS lays a line out only when it
 * fits its frame, and React Native 0.86 can hand a `Text` a frame a hair shorter than its line (Yoga
 * rounds each edge to the pixel grid on its own; RN #52642), so each frame is a whole number of
 * points taller than its line. The glyphs draw from the frame's top, so this moves nothing.
 */
export const TEXT_SLACK_PT = 2;

/**
 * The width a numeral `Text` is given for `text` at `size`: the string's widest drawing plus the
 * slack on both sides, in whole points, so the string can never be cut short or wrapped. No `Text`
 * here scales its own font (`adjustsFontSizeToFit` collapses to 4 pt on that same short frame).
 */
export const numeralBoxWidth = (text: string, size: number): number => Math.ceil(numeralWidthEm(text) * size) + 2 * TEXT_SLACK_PT;

/** The unit label's size at Dynamic Type 1x (it follows Dynamic Type up to 2x). */
export const SPEED_UNIT_PT = 20;
/** The numerals' text box: ascent + descent of the numeral font, so both platforms set the baseline at 1.0 pt. */
export const numeralLineHeight = (size: number): number => Math.round(1.2 * size);
/**
 * Moves the ink's centre onto the box centre (0.6 pt from its top): the digits' centre is 0.643 pt
 * from the top, the hyphen's 0.71 pt, so an unknown speed's "-" sits where the digits would.
 */
export const numeralShift = (size: number, text = '0'): number => -(0.4 - numeralCentreEm(text)) * size;
/** The clear space between the digits and the unit label under them. */
export const SPEED_UNIT_GAP_PT = 6;
/** Where the unit label starts below the box top: under the digits, 6 pt clear. */
export const unitTop = (size: number): number => numeralLineHeight(size) / 2 + (DIGIT_HEIGHT_EM / 2) * size + SPEED_UNIT_GAP_PT;
/** The unit label's line height at `unitPt`. */
export const unitLineHeight = (unitPt: number): number => Math.round(1.2 * unitPt);

/**
 * The current speed, large and tabular so the number never shifts sideways as it changes. Its box is
 * the numerals alone, with the digits optically centred in it, so the parent can centre the digits
 * in the halo; the unit label hangs under them. The colour comes from the halo (`numeralStyle`).
 * Nothing flashes. Silent to screen readers apart from its label: no live region, since continuous
 * speech is itself a distraction. The numerals' size comes from the layout (`haloNumeralPt` for the
 * string's digit count), never from the text system shrinking them.
 */
function SpeedReadoutView({ speed, unit = 'mph', color, unitColor, size, numeralStyle, speeding = false }: SpeedReadoutProps) {
  const { fontScale } = useWindowDimensions();
  const spokenUnit = unit === 'km/h' ? 'kilometers per hour' : 'miles per hour';
  const label =
    speed === null ? 'Speed unknown' : `Speed ${speed} ${spokenUnit}${speeding ? ', over the limit' : ''}`;
  const text = speed === null ? t('common.unknown') : String(speed);
  const lineHeight = numeralLineHeight(size);
  const boxW = numeralBoxWidth(text, size);
  const unitPt = SPEED_UNIT_PT * hudLabelScale(fontScale);
  const unitLine = unitLineHeight(unitPt);
  return (
    <View testID="hud-speed" accessible accessibilityRole="text" accessibilityLabel={label} style={[styles.box, { width: boxW, height: lineHeight }]}>
      <Animated.Text
        testID="hud-speed-numeral"
        allowFontScaling={false}
        numberOfLines={1}
        style={[
          styles.numeral,
          { color, fontSize: size, lineHeight, width: boxW, height: lineHeight + TEXT_SLACK_PT, transform: [{ translateY: numeralShift(size, text) }] },
          numeralStyle,
        ]}
      >
        {text}
      </Animated.Text>
      <View pointerEvents="none" style={[styles.unitRow, { top: unitTop(size) }]}>
        <Text
          testID="hud-speed-unit"
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.unit, { color: unitColor, fontSize: unitPt, lineHeight: unitLine, height: unitLine + TEXT_SLACK_PT }]}
        >
          {unit}
        </Text>
      </View>
    </View>
  );
}

export const SpeedReadout = memo(SpeedReadoutView);

const styles = StyleSheet.create({
  // The numerals' frame runs TEXT_SLACK_PT past the box's foot (empty, drawn over nothing).
  box: { overflow: 'visible', justifyContent: 'flex-start', alignItems: 'center' },
  numeral: {
    fontFamily: fontFamilies.numeralsBold,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
    textAlign: 'center',
    textAlignVertical: 'top',
  },
  // The label's frame is the row's full width (whole points wider than the word), so it is never cut short.
  unitRow: { position: 'absolute', left: -60, right: -60, alignItems: 'stretch' },
  unit: {
    fontFamily: fontFamilies.field,
    letterSpacing: 1,
    textAlign: 'center',
    textAlignVertical: 'top',
    includeFontPadding: false,
  },
});
