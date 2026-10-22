import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t } from '@/i18n';

import { fontFamilies } from '../fonts';
import type { HudPalette } from './hudTokens';
import { numeralInkEm, numeralWidthEm, TEXT_SLACK_PT } from './SpeedReadout';

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

/** The R2-1's black border is drawn this far in from the face's edge. */
export const SIGN_BORDER_INSET_PT = 2;
/** Barlow Semi Condensed (both weights): capitals are 0.7 em tall; ascent + descent is 1.2 em (ascent 1.0). */
const CAP_EM = 0.7;
const LINE_EM = 1.2;

/**
 * A sign `Text`'s line: never under the face's own ascent + descent, so both platforms put the
 * glyphs where `baselineAt` says (React Native centres the face in a taller line). The nudge keeps a
 * float hair over a whole number (1.2 × 45) from adding a point.
 */
const lineFor = (pt: number): number => Math.ceil(LINE_EM * pt - 1e-9);
/** The baseline's depth below the top of a `line`-tall line set in `pt`: the line's middle, then 0.4 em (ascent 1.0 less half of 1.2). */
const baselineAt = (pt: number, line: number): number => line / 2 + 0.4 * pt;

/** The sign's print for its height and its string (pt, all whole numbers): what the drawing uses, and what the tests pin. */
export interface SignMetrics {
  /** The face: the R2-1 is `0.8 H` wide; the round sign is `D` both ways. */
  width: number;
  height: number;
  /** The border's width (miles, drawn `SIGN_BORDER_INSET_PT` in from the edge) or the red ring's (kilometres). */
  edge: number;
  /** The legend (miles only: "SPEED", "LIMIT"): its size, its line, and each line's top; 0, 0 and none for the round sign. */
  legendPt: number;
  legendLine: number;
  legendTops: number[];
  /** The number: its size for this string (the sign's full size unless the string needs less), its line and its line's top. */
  numeralPt: number;
  /** The sign's full number size (one or two digits always get it). */
  numeralFullPt: number;
  numeralLine: number;
  numeralTop: number;
  /** The print's box: from `textLeft`, `textW` wide (centred on the face); each line's box is its line plus `TEXT_SLACK_PT` tall. */
  textLeft: number;
  textW: number;
  /** The space the number's ink is centred in, top to bottom (miles: the foot of "LIMIT" to the border; kilometres: inside the ring). */
  region: { top: number; bottom: number };
}

/** The number set in `pt` with its ink centred on `mid` (a whole-point top): its line, its line's top and its ink's top and foot. */
function placeNumber(pt: number, ink: { top: number; bottom: number }, mid: number): { line: number; top: number; inkTop: number; inkBottom: number } {
  const line = lineFor(pt);
  const top = Math.round(mid - (baselineAt(pt, line) - ((ink.top + ink.bottom) / 2) * pt));
  const base = top + baselineAt(pt, line);
  return { line, top, inkTop: base - ink.top * pt, inkBottom: base - ink.bottom * pt };
}

/** The largest whole pt from `from` down to 1 whose placement `fits` (1 when none does). */
function largestFitting(from: number, fits: (pt: number) => boolean): number {
  for (let pt = Math.floor(from); pt > 1; pt -= 1) if (fits(pt)) return pt;
  return 1;
}

/**
 * The sign's print, worked out for its height and the exact string it shows, so nothing on the sign
 * is ever sized by the text system (React Native 0.86's `adjustsFontSizeToFit` drew the number at
 * 4 pt on a frame a hair short of its line: RN #52642). Every top, line and box is a whole number of
 * points.
 *
 * - Miles (the R2-1): "SPEED" and "LIMIT" stacked from the top, the capitals of "SPEED" 5% of the
 *   height (3 pt at least) under the border; the number 46% of the height (its digits a third of the
 *   sign, as on the real 24 × 30 in sign), its ink centred between the foot of "LIMIT" and the
 *   border and at least 4% of the height (3 pt) clear of both.
 * - Kilometres (the round sign): the number 40% of the diameter, its ink centred on the face; a
 *   three-digit number shrinks until its corners clear the ring by 6% of the diameter (4 pt at least).
 * - Any string shrinks, a whole point at a time, until it fits its box and those clearances, never
 *   below 1 pt; one or two digits and "-" never need to on any sign the screen lays out.
 */
export function signMetrics(units: 'mi' | 'km', height: number, value = '88'): SignMetrics {
  const text = value.length > 0 ? value : '-';
  const H = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const widthEm = numeralWidthEm(text);
  const ink = numeralInkEm(text);
  if (units === 'km') {
    const D = H;
    const ring = Math.round(0.09 * D);
    const full = Math.round(0.4 * D);
    // Even, so the box sits at a whole point either side.
    const textW = Math.max(2, D - 2 * ring - 8);
    const mid = D / 2;
    // The ink's corners (half its width across, its farthest edge up or down) inside the ring, clear of it.
    const clearR = D / 2 - ring - Math.max(4, Math.round(0.06 * D));
    const pt = largestFitting(Math.min(full, textW / widthEm), (n) => {
      const at = placeNumber(n, ink, mid);
      return Math.hypot((widthEm * n) / 2, Math.max(mid - at.inkTop, at.inkBottom - mid)) <= clearR;
    });
    const at = placeNumber(pt, ink, mid);
    return {
      width: D,
      height: D,
      edge: ring,
      legendPt: 0,
      legendLine: 0,
      legendTops: [],
      numeralPt: pt,
      numeralFullPt: full,
      numeralLine: at.line,
      numeralTop: at.top,
      textLeft: Math.floor((D - textW) / 2),
      textW,
      region: { top: ring, bottom: D - ring },
    };
  }
  const W = Math.round(R2_1_ASPECT * H);
  const edge = Math.max(2, Math.round(0.025 * W));
  const inner = SIGN_BORDER_INSET_PT + edge;
  const legendPt = Math.round(0.167 * H);
  const legendLine = lineFor(legendPt);
  const capTop = baselineAt(legendPt, legendLine) - CAP_EM * legendPt;
  const top1 = Math.round(inner + Math.max(3, Math.round(0.05 * H)) - capTop);
  const top2 = top1 + legendLine;
  const region = { top: top2 + baselineAt(legendPt, legendLine), bottom: H - inner };
  const mid = (region.top + region.bottom) / 2;
  const textW = Math.max(2, W - 2 * (edge + 6));
  const full = Math.round(0.46 * H);
  const minGap = Math.max(3, Math.round(0.04 * H));
  const pt = largestFitting(Math.min(full, textW / widthEm), (n) => {
    const at = placeNumber(n, ink, mid);
    return at.inkTop - region.top >= minGap && region.bottom - at.inkBottom >= minGap;
  });
  const at = placeNumber(pt, ink, mid);
  return {
    width: W,
    height: H,
    edge,
    legendPt,
    legendLine,
    legendTops: [top1, top2],
    numeralPt: pt,
    numeralFullPt: full,
    numeralLine: at.line,
    numeralTop: at.top,
    textLeft: Math.floor((W - textW) / 2),
    textW,
    region,
  };
}

/**
 * The speed limit as a real sign, so it is spotted at a glance: in miles the US white rectangle
 * with "SPEED LIMIT" over the number, in kilometres the round white face in a red ring. An unknown
 * limit keeps the sign and prints "-": a wrong limit shown confidently is worse than none. A sign
 * graphic, so its print holds its size under Dynamic Type like a real sign would; it never moves
 * or changes colour. Every line of print sits at a whole-point top from `signMetrics`, in a box
 * whole points taller and wider than it needs, so the text system never shrinks or drops it.
 */
function SpeedSignView({ limit, palette: p, units, height }: SpeedSignProps) {
  const label = limit === null ? 'Speed limit unknown' : `Speed limit ${limit}`;
  const value = limit === null ? t('common.unknown') : String(limit);
  const m = signMetrics(units, height, value);
  /** The number; `inset` is the face's border (absolute children are placed from inside it). */
  const number = (inset: number) => (
    <Text
      testID="hud-limit-value"
      allowFontScaling={false}
      numberOfLines={1}
      style={[
        styles.print,
        styles.value,
        {
          color: p.signInk,
          fontSize: m.numeralPt,
          lineHeight: m.numeralLine,
          top: m.numeralTop - inset,
          left: m.textLeft - inset,
          width: m.textW,
          height: m.numeralLine + TEXT_SLACK_PT,
        },
      ]}
    >
      {value}
    </Text>
  );
  if (units === 'km') {
    const D = m.width;
    return (
      <View
        testID="hud-limit"
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.face, { width: D, height: D, borderRadius: D / 2, borderWidth: m.edge, backgroundColor: p.signFace, borderColor: p.signRing }]}
      >
        {number(m.edge)}
      </View>
    );
  }
  const radius = Math.round(0.06 * m.width);
  const legend = (word: string, top: number) => (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      style={[
        styles.print,
        styles.legend,
        { color: p.signInk, fontSize: m.legendPt, lineHeight: m.legendLine, top, left: m.textLeft, width: m.textW, height: m.legendLine + TEXT_SLACK_PT },
      ]}
    >
      {word}
    </Text>
  );
  return (
    <View
      testID="hud-limit"
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.face, { width: m.width, height: m.height, borderRadius: radius, backgroundColor: p.signFace }]}
    >
      <View
        testID="hud-limit-border"
        pointerEvents="none"
        style={[styles.border, { borderWidth: m.edge, borderColor: p.signInk, borderRadius: Math.max(0, radius - SIGN_BORDER_INSET_PT) }]}
      />
      <View testID="hud-limit-words" pointerEvents="none" style={styles.words}>
        {legend('SPEED', m.legendTops[0] ?? 0)}
        {legend('LIMIT', m.legendTops[1] ?? 0)}
      </View>
      {number(0)}
    </View>
  );
}

export const SpeedSign = memo(SpeedSignView);

const styles = StyleSheet.create({
  face: { overflow: 'visible' },
  border: { position: 'absolute', top: SIGN_BORDER_INSET_PT, left: SIGN_BORDER_INSET_PT, right: SIGN_BORDER_INSET_PT, bottom: SIGN_BORDER_INSET_PT },
  words: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  print: { position: 'absolute', textAlign: 'center', textAlignVertical: 'top', includeFontPadding: false },
  legend: { fontFamily: fontFamilies.fieldBold, letterSpacing: 0.5 },
  value: { fontFamily: fontFamilies.numeralsBold, fontVariant: ['tabular-nums'] },
});
