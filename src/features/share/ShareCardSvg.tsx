import { forwardRef } from 'react';
import Svg, { Circle, Defs, G, Line, LinearGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { fontFamilies } from '@/ui/fonts';
import { tokens } from '@/ui/tokens';

import { spacedCode } from '../referral/copy';
import { type CardModel } from './cardModel';
import { shareCopy as copy } from './copy';
import { CARD_HEIGHT, CARD_WIDTH } from './shareAdapter';

/**
 * The card as one SVG, 1080 × 1350 (4:5). The licence world's card face — white on the desk grey,
 * the laminate sheen in one corner, ink navy print, ID blue for the wordmark, a stamp-ink seal for
 * a badge — and no ID styling at all: no photo box, no fields that read as a document, no MRZ
 * strip (rev1: R-I m9, C18). No base map and no images: text and shapes only.
 *
 * The art is fixed-size and always drawn in the light card colours: it is a picture that leaves
 * the phone, so it must not change with the sender's dark mode. Its text is also the caption, so
 * nothing on it is only visual.
 */
const INK = tokens.color.light.text;
const MUTED = tokens.color.light.textMuted;
const ACCENT = tokens.color.light.accent;
const STAMP = tokens.color.light.stamp;
const [SHEEN_A, SHEEN_B, SHEEN_C] = tokens.color.light.sheen;

const MARGIN = 60;
const PAD = 90;
const LEFT = MARGIN + PAD;
const TEXT_WIDTH = CARD_WIDTH - 2 * LEFT;

/**
 * Greedy word wrap by an estimated advance (B612 at ~0.6 em a character), at most `maxLines`
 * lines; a longer text keeps its last line whole rather than being cut mid-word.
 */
export function wrapText(text: string, fontSize: number, width = TEXT_WIDTH, maxLines = 4): string[] {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.6)));
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= perLine || current === '') current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
}

export const ShareCardSvg = forwardRef<Svg, { model: CardModel; width: number; testID?: string }>(function ShareCardSvg(
  { model, width, testID },
  ref
) {
  const height = (width * CARD_HEIGHT) / CARD_WIDTH;
  const primarySize = model.numeric ? 300 : model.primary.length > 18 ? 84 : 112;
  const primaryLines = model.numeric ? [model.primary] : wrapText(model.primary, primarySize);
  const lineHeight = primarySize * 1.12;

  let y = MARGIN + PAD + 60; // wordmark baseline
  const headingY = y + 150;
  y = headingY + 40 + primarySize;
  const primaryYs = primaryLines.map((_, i) => y + i * lineHeight);
  y = primaryYs[primaryYs.length - 1]! + (model.unit ? 90 : 20);
  const unitY = y;
  const detailYs = model.details.map((_, i) => unitY + 90 + i * 64);

  return (
    <Svg
      ref={ref}
      width={width}
      height={height}
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
      testID={testID}
      // The picture is described once, by the preview's own label (the caption).
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Defs>
        <LinearGradient id="sheen" x1="0.35" y1="1" x2="1" y2="0">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
          <Stop offset="0.6" stopColor={SHEEN_A} stopOpacity="0.28" />
          <Stop offset="0.82" stopColor={SHEEN_B} stopOpacity="0.32" />
          <Stop offset="1" stopColor={SHEEN_C} stopOpacity="0.36" />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={CARD_WIDTH} height={CARD_HEIGHT} fill={tokens.color.light.bg} />
      <Rect
        x={MARGIN}
        y={MARGIN}
        width={CARD_WIDTH - 2 * MARGIN}
        height={CARD_HEIGHT - 2 * MARGIN}
        rx={48}
        fill="#FFFFFF"
        stroke={tokens.color.light.border}
        strokeWidth={3}
      />
      <Rect
        x={MARGIN}
        y={MARGIN}
        width={CARD_WIDTH - 2 * MARGIN}
        height={CARD_HEIGHT - 2 * MARGIN}
        rx={48}
        fill="url(#sheen)"
      />

      <SvgText x={LEFT} y={MARGIN + PAD + 60} fill={ACCENT} fontFamily={fontFamilies.fieldBold} fontSize={64}>
        {model.wordmark}
      </SvgText>

      <G>
        <SvgText x={LEFT} y={headingY} fill={MUTED} fontFamily={fontFamilies.field} fontSize={40} letterSpacing={6}>
          {model.heading.toUpperCase()}
        </SvgText>
        <Line x1={LEFT} y1={headingY + 22} x2={LEFT + TEXT_WIDTH} y2={headingY + 22} stroke={tokens.color.light.borderStrong} strokeWidth={2} />
      </G>

      {primaryLines.map((line, i) => (
        <SvgText
          key={`p${i}`}
          x={LEFT}
          y={primaryYs[i]}
          fill={INK}
          fontFamily={model.numeric ? fontFamilies.numeralsBold : fontFamilies.fieldBold}
          fontSize={primarySize}
        >
          {line}
        </SvgText>
      ))}
      {model.unit ? (
        <SvgText x={LEFT} y={unitY} fill={INK} fontFamily={fontFamilies.field} fontSize={56}>
          {model.unit}
        </SvgText>
      ) : null}
      {model.details.map((line, i) => (
        <SvgText key={`d${i}`} x={LEFT} y={detailYs[i]} fill={MUTED} fontFamily={fontFamilies.field} fontSize={46}>
          {line}
        </SvgText>
      ))}

      {model.kind === 'badge' ? (
        // A seal, in stamp ink: the badge's mark, drawn rather than pictured.
        <G>
          <Circle cx={CARD_WIDTH - LEFT - 90} cy={MARGIN + PAD + 40} r={90} fill="none" stroke={STAMP} strokeWidth={8} />
          <Circle cx={CARD_WIDTH - LEFT - 90} cy={MARGIN + PAD + 40} r={72} fill="none" stroke={STAMP} strokeWidth={3} />
        </G>
      ) : null}

      {model.code ? (
        <G>
          <SvgText x={LEFT} y={CARD_HEIGHT - MARGIN - PAD - 90} fill={MUTED} fontFamily={fontFamilies.field} fontSize={36} letterSpacing={4}>
            {copy.card.codeLabel.toUpperCase()}
          </SvgText>
          <SvgText x={LEFT} y={CARD_HEIGHT - MARGIN - PAD} fill={INK} fontFamily={fontFamilies.numeralsBold} fontSize={72} letterSpacing={8}>
            {spacedCode(model.code)}
          </SvgText>
        </G>
      ) : null}
    </Svg>
  );
});
