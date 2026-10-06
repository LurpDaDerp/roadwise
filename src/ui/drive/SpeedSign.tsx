import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import { type HudPalette, SIGN_DIAMETER_PT, SIGN_NUMERAL_PT, SIGN_RING_PT } from './hudTokens';

export type SpeedSignProps = {
  /** The limit from `useDriveLive`; null (unknown, low-confidence or a poor fix) prints "—". */
  limitMph: number | null;
  palette: HudPalette;
};

/**
 * The limit on a round sign — a white face inside a red ring — next to the speed. An unknown limit
 * keeps the sign and prints "—": a wrong limit shown confidently is worse than none. A sign graphic,
 * so its numeral holds its size under Dynamic Type like a real sign would.
 */
function SpeedSignView({ limitMph, palette: p }: SpeedSignProps) {
  const label = limitMph === null ? 'Speed limit unknown' : `Speed limit ${limitMph}`;
  return (
    <View
      testID="hud-limit"
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.face, { backgroundColor: p.signFace, borderColor: p.signRing }]}
    >
      <Text
        testID="hud-limit-value"
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.value, { color: p.signInk }]}
      >
        {limitMph === null ? t('common.unknown') : String(limitMph)}
      </Text>
    </View>
  );
}

export const SpeedSign = memo(SpeedSignView);

const styles = StyleSheet.create({
  face: {
    width: SIGN_DIAMETER_PT,
    height: SIGN_DIAMETER_PT,
    borderRadius: SIGN_DIAMETER_PT / 2,
    borderWidth: SIGN_RING_PT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontFamily: fontFamilies.numeralsBold,
    fontSize: SIGN_NUMERAL_PT,
    lineHeight: Math.round(SIGN_NUMERAL_PT * 1.1),
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
  },
});
