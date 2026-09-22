import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { LimitSample } from '@/core/engine/types';
import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { hudLimitMph } from './hudSelectors';
import { hudPalette, SIGN_NUMERAL_PT } from './hudTokens';

export type SpeedSignProps = {
  /** The snapshot's `limit`, as the engine matched it. The sign decides whether it may show it. */
  limit: LimitSample | null;
  /** The snapshot's `speedKnown`: without a current fix the limit is the last road's, so "—". */
  speedKnown: boolean;
  night: boolean;
};

const WIDTH = 96;
const HEIGHT = 120; // the US regulatory sign's 4:5 (MUTCD R2-1, 24 × 30 in)
const LEGEND_PT = 15;

/**
 * Zone 2 of the HUD (C3): the limit on the shape drivers already read without thinking — a
 * white regulatory sign with an inset black rule, SPEED over LIMIT over the number. An unknown or
 * unconfident limit keeps the sign and prints "—" (§13.2: a wrong limit shown confidently is
 * worse than none). The gate is `hudLimitMph`; this component never prints a limit it didn't pass.
 * A sign graphic, so its legend holds its size under Dynamic Type like a real sign would.
 */
function SpeedSignView({ limit, speedKnown, night }: SpeedSignProps) {
  const p = hudPalette(night);
  const mph = hudLimitMph(limit, speedKnown);
  const label = mph === null ? 'Speed limit unknown' : `Speed limit ${mph} miles per hour`;

  return (
    <View
      testID="hud-limit"
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.face, { backgroundColor: p.signFace }]}
    >
      <View style={[styles.rule, { borderColor: p.signInk }]}>
        <Text allowFontScaling={false} style={[styles.legend, { color: p.signInk }]}>
          SPEED
        </Text>
        <Text allowFontScaling={false} style={[styles.legend, { color: p.signInk }]}>
          LIMIT
        </Text>
        <Text
          testID="hud-limit-value"
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.value, { color: p.signInk }]}
        >
          {mph === null ? t('common.unknown') : String(mph)}
        </Text>
      </View>
    </View>
  );
}

/** Re-renders only when the printed value or the palette changes, not per snapshot object. */
export function speedSignPropsEqual(a: SpeedSignProps, b: SpeedSignProps): boolean {
  return (
    a.night === b.night && hudLimitMph(a.limit, a.speedKnown) === hudLimitMph(b.limit, b.speedKnown)
  );
}

export const SpeedSign = memo(SpeedSignView, speedSignPropsEqual);

const styles = StyleSheet.create({
  face: {
    width: WIDTH,
    height: HEIGHT,
    borderRadius: 10,
    padding: 4,
  },
  rule: {
    flex: 1,
    borderWidth: 3,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 4,
  },
  legend: {
    fontFamily: fontFamilies.fieldBold,
    fontSize: LEGEND_PT,
    lineHeight: LEGEND_PT + 2,
    letterSpacing: 0.5,
  },
  value: {
    fontFamily: fontFamilies.numeralsBold,
    fontSize: SIGN_NUMERAL_PT,
    lineHeight: Math.round(SIGN_NUMERAL_PT * 1.1),
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
});
