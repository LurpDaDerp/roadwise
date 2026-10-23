import { memo, useEffect, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type AnimatedStyle } from 'react-native-reanimated';

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
  /** A changed digit crossfades (`SPEED_FADE_MS`); false (Reduce Motion; the default) swaps it at once. */
  fade?: boolean;
};

/**
 * Barlow Semi Condensed ExtraBold (the numerals' face, read from its TTF), in em: the widest digit
 * ("4"; the tabular digits drawn are 0.535, so this holds even without tabular figures), the hyphen
 * that stands for an unknown value, and anything else at a generous 0.6.
 */
export const NUMERAL_DIGIT_MAX_EM = 0.566;
/** The face's tabular digits' advance (its `.tf` figures), in em: each digit's cell. */
export const NUMERAL_DIGIT_ADVANCE_EM = 0.535;
export const NUMERAL_DASH_EM = 0.376;
const NUMERAL_OTHER_EM = 0.6;
/** The hyphen's ink, in em above the baseline (the digits run from 0 to `DIGIT_HEIGHT_EM`). */
export const DASH_INK_EM = { bottom: 0.219, top: 0.361 };
/** Where the ink's centre sits above the baseline, in em: the digits' and the hyphen's. */
export const DIGIT_CENTRE_EM = DIGIT_HEIGHT_EM / 2;
export const DASH_CENTRE_EM = (DASH_INK_EM.bottom + DASH_INK_EM.top) / 2;

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/** One character's cell in the numerals' row, in em: a digit's tabular advance, the hyphen's own, anything else 0.6. */
export const numeralAdvanceEm = (ch: string): number => (isDigit(ch) ? NUMERAL_DIGIT_ADVANCE_EM : ch === '-' ? NUMERAL_DASH_EM : NUMERAL_OTHER_EM);

/** The width of `text` in the numerals' face, in em, never less than the real drawing. */
export function numeralWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) em += isDigit(ch) ? NUMERAL_DIGIT_MAX_EM : ch === '-' ? NUMERAL_DASH_EM : NUMERAL_OTHER_EM;
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

/** A changed digit's crossfade: the old one out and the new one in, together, over this long. */
export const SPEED_FADE_MS = 200;
const FADE = { duration: SPEED_FADE_MS, easing: Easing.inOut(Easing.quad) };

/** Two strings share a layout (a digit-for-digit change): the same number of digits and nothing else in either. */
export const sameShape = (a: string, b: string): boolean => a.length === b.length && /^\d+$/.test(a) && /^\d+$/.test(b);

type DigitMode = 'still' | 'in' | 'out';

type DigitProps = {
  ch: string;
  /** Read at mount: shown at once, fading in from nothing, or fading out from full. */
  mode: DigitMode;
  size: number;
  lineHeight: number;
  color: string;
  numeralStyle?: AnimatedStyle<TextStyle>;
  testID: string;
};

/**
 * One character in its cell (its advance wide), its `Text` the character's widest drawing plus the
 * slack wide and centred on the cell, so it is never cut short. A fade runs on the UI thread from
 * the frame it mounts: an incoming digit mounts at 0, so it never shows at full first.
 */
const Digit = memo(function Digit({ ch, mode, size, lineHeight, color, numeralStyle, testID }: DigitProps) {
  const [from] = useState(mode);
  const opacity = useSharedValue(from === 'in' ? 0 : 1);
  useEffect(() => {
    if (from === 'in') opacity.set(withTiming(1, FADE));
    else if (from === 'out') opacity.set(withTiming(0, FADE));
  }, [from, opacity]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  const cell = numeralAdvanceEm(ch) * size;
  const textW = numeralBoxWidth(ch, size);
  return (
    <View style={{ width: cell, height: lineHeight + TEXT_SLACK_PT }}>
      <Animated.Text
        testID={testID}
        allowFontScaling={false}
        numberOfLines={1}
        style={[
          styles.numeral,
          { color, fontSize: size, lineHeight, width: textW, height: lineHeight + TEXT_SLACK_PT, left: (cell - textW) / 2 },
          numeralStyle,
          from === 'still' ? null : fadeStyle,
        ]}
      >
        {ch}
      </Animated.Text>
    </View>
  );
});

/**
 * The current speed, large and tabular so the number never shifts sideways as it changes: each
 * character in its own cell (a digit's is the face's tabular advance), the row centred in a box that
 * is the numerals alone, with the digits optically centred in it, so the parent can centre the
 * digits in the halo; the unit label hangs under them. The colour comes from the halo
 * (`numeralStyle`). Like the lock screen's number, a change is a soft crossfade, digit by digit:
 * with `fade`, each digit that changes fades out as its new one fades in, together, over
 * `SPEED_FADE_MS` (one change per new whole number, at most 4 a second as the halo carries the
 * speed), while the digits that stay never move or dim. A change in the number of digits, to or
 * from "-", and every change without `fade` (Reduce Motion) swap at once. The fades run on the UI
 * thread; the JS side renders once per new number. Nothing flashes. Silent to screen readers apart
 * from its label: no live region, since continuous speech is itself a distraction. The numerals'
 * size comes from the layout (`haloNumeralPt` for the string's digit count), never from the text
 * system shrinking them.
 */
function SpeedReadoutView({ speed, unit = 'mph', color, unitColor, size, numeralStyle, speeding = false, fade = false }: SpeedReadoutProps) {
  const { fontScale } = useWindowDimensions();
  const spokenUnit = unit === 'km/h' ? 'kilometers per hour' : 'miles per hour';
  const label =
    speed === null ? 'Speed unknown' : `Speed ${speed} ${spokenUnit}${speeding ? ', over the limit' : ''}`;
  const text = speed === null ? t('common.unknown') : String(speed);
  // The number shown before this one, while its changed digits fade out (null: nothing fades), and
  // a count of changes, so each change's fade-outs are new ones (React's state-from-props pattern).
  const [trail, setTrail] = useState<{ text: string; prev: string | null; n: number }>({ text, prev: null, n: 0 });
  if (trail.text !== text) setTrail({ text, prev: fade && sameShape(trail.text, text) ? trail.text : null, n: trail.n + 1 });
  const prev = trail.text === text ? trail.prev : null;
  const lineHeight = numeralLineHeight(size);
  const boxW = numeralBoxWidth(text, size);
  const unitPt = SPEED_UNIT_PT * hudLabelScale(fontScale);
  const unitLine = unitLineHeight(unitPt);
  const row = [styles.row, { width: boxW, height: lineHeight + TEXT_SLACK_PT, transform: [{ translateY: numeralShift(size, text) }] }];
  const digit = { size, lineHeight, color, numeralStyle };
  const chars = [...text];
  return (
    <View testID="hud-speed" accessible accessibilityRole="text" accessibilityLabel={label} style={[styles.box, { width: boxW, height: lineHeight }]}>
      {prev !== null ? (
        <View testID="hud-speed-fading" pointerEvents="none" style={row}>
          {[...prev].map((ch, i) =>
            ch === chars[i] ? (
              <View key={`${trail.n}:${i}`} style={{ width: numeralAdvanceEm(ch) * size }} />
            ) : (
              <Digit key={`${trail.n}:${i}`} ch={ch} mode="out" testID="hud-speed-digit-out" {...digit} />
            )
          )}
        </View>
      ) : null}
      <View key={`${chars.length}${/^\d+$/.test(text) ? 'd' : 'x'}`} testID="hud-speed-numeral" style={row}>
        {chars.map((ch, i) => (
          <Digit key={`${i}:${ch}`} ch={ch} mode={prev !== null && prev[i] !== ch ? 'in' : 'still'} testID="hud-speed-digit" {...digit} />
        ))}
      </View>
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
  // The numerals' frames run TEXT_SLACK_PT past the box's foot (empty, drawn over nothing).
  box: { overflow: 'visible', justifyContent: 'flex-start', alignItems: 'center' },
  // Each row lies over the box from its top-left and centres its cells.
  row: { position: 'absolute', top: 0, left: 0, flexDirection: 'row', justifyContent: 'center', overflow: 'visible' },
  numeral: {
    position: 'absolute',
    top: 0,
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
