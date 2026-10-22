import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import type { HudPalette } from './hudTokens';

export type SpeedSignProps = {
  /** The limit in the driver's units, whole; null (unknown, low-confidence or a poor fix) prints "-". */
  limit: number | null;
  palette: HudPalette;
  /** Miles: the US white "SPEED LIMIT" rectangle (R2-1). Kilometres: the round red-ringed sign. */
  units: 'mi' | 'km';
  /** The sign's height in pt (the round sign's diameter), from the screen's layout. */
  height: number;
};

/** The R2-1's width for its height (the sign's 24 × 30 in). */
export const R2_1_ASPECT = 0.8;

/** The sign's size for its slot: the R2-1 is `0.8 H` wide; the round sign is `D` both ways. */
export function signSize(units: 'mi' | 'km', height: number): { width: number; height: number } {
  return units === 'km' ? { width: height, height } : { width: Math.round(R2_1_ASPECT * height), height };
}

/** The sign's print for its height (pt): what the drawing uses, and what the layout tests pin. */
export interface SignMetrics {
  /** The legend's size and line (miles only: "SPEED", "LIMIT"); 0 for the round sign. */
  legendPt: number;
  legendLine: number;
  /** The number's size and line. */
  numeralPt: number;
  numeralLine: number;
  /** The border (miles) or the red ring (kilometres), and the width the print has inside it. */
  edge: number;
  textW: number;
  /** The print's height, padding included: never more than the room inside the sign. */
  contentH: number;
  room: number;
}

const SIGN_PAD_PT = 4;

export function signMetrics(units: 'mi' | 'km', height: number): SignMetrics {
  if (units === 'km') {
    const D = height;
    const ring = Math.round(0.09 * D);
    const numeral = Math.round(0.4 * D);
    const numeralLine = Math.round(numeral * 1.1);
    return { legendPt: 0, legendLine: 0, numeralPt: numeral, numeralLine, edge: ring, textW: D - 2 * ring - 8, contentH: numeralLine, room: D - 2 * ring };
  }
  const H = height;
  const W = Math.round(R2_1_ASPECT * H);
  const legend = Math.round(0.167 * H);
  const numeral = Math.round(0.46 * H);
  const numeralLine = Math.round(numeral * 1.05);
  const line = Math.max(2, Math.round(0.025 * W));
  return {
    legendPt: legend,
    legendLine: legend + 2,
    numeralPt: numeral,
    numeralLine,
    edge: line,
    textW: W - 2 * (line + 6),
    contentH: 2 * SIGN_PAD_PT + 2 * (legend + 2) + numeralLine,
    room: H,
  };
}

/**
 * The speed limit as a real sign, so it is spotted at a glance: in miles the US white rectangle
 * with "SPEED LIMIT" over the number, in kilometres the round white face in a red ring. An unknown
 * limit keeps the sign and prints "-": a wrong limit shown confidently is worse than none. A sign
 * graphic, so its print holds its size under Dynamic Type like a real sign would; it never moves
 * or changes colour.
 */
function SpeedSignView({ limit, palette: p, units, height }: SpeedSignProps) {
  const label = limit === null ? 'Speed limit unknown' : `Speed limit ${limit}`;
  const value = limit === null ? t('common.unknown') : String(limit);
  const m = signMetrics(units, height);
  if (units === 'km') {
    const D = height;
    const ring = m.edge;
    const numeral = m.numeralPt;
    return (
      <View
        testID="hud-limit"
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.round, { width: D, height: D, borderRadius: D / 2, borderWidth: ring, backgroundColor: p.signFace, borderColor: p.signRing }]}
      >
        <Text
          testID="hud-limit-value"
          allowFontScaling={false}
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[styles.value, { color: p.signInk, fontSize: numeral, lineHeight: m.numeralLine, width: m.textW }]}
        >
          {value}
        </Text>
      </View>
    );
  }
  const H = height;
  const W = Math.round(R2_1_ASPECT * H);
  const legend = m.legendPt;
  const numeral = m.numeralPt;
  const line = m.edge;
  return (
    <View
      testID="hud-limit"
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.rect, { width: W, height: H, borderRadius: Math.round(0.06 * W), backgroundColor: p.signFace }]}
    >
      <View
        testID="hud-limit-border"
        pointerEvents="none"
        style={[styles.border, { borderWidth: line, borderColor: p.signInk, borderRadius: Math.max(0, Math.round(0.06 * W) - 2) }]}
      />
      <View testID="hud-limit-words" style={styles.words}>
        <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit style={[styles.legend, { color: p.signInk, fontSize: legend, lineHeight: m.legendLine, width: m.textW }]}>
          SPEED
        </Text>
        <Text allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit style={[styles.legend, { color: p.signInk, fontSize: legend, lineHeight: m.legendLine, width: m.textW }]}>
          LIMIT
        </Text>
      </View>
      <Text
        testID="hud-limit-value"
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.value, { color: p.signInk, fontSize: numeral, lineHeight: m.numeralLine, width: m.textW }]}
      >
        {value}
      </Text>
    </View>
  );
}

export const SpeedSign = memo(SpeedSignView);

const styles = StyleSheet.create({
  round: { alignItems: 'center', justifyContent: 'center' },
  rect: { alignItems: 'center', justifyContent: 'center', paddingVertical: SIGN_PAD_PT },
  border: { position: 'absolute', top: 2, left: 2, right: 2, bottom: 2 },
  words: { alignItems: 'center' },
  legend: { fontFamily: fontFamilies.fieldBold, letterSpacing: 0.5, textAlign: 'center', includeFontPadding: false },
  value: {
    fontFamily: fontFamilies.numeralsBold,
    fontVariant: ['tabular-nums'],
    includeFontPadding: false,
    textAlign: 'center',
  },
});
