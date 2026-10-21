import type { MeritTier } from '@scoring';
import Svg, { Circle, Path } from 'react-native-svg';

/** The glyphs' drawing grid: a 24-unit square, scaled to `size` (the same footprint as an Ionicons glyph). */
const GRID = 24;

/** A 5-point star's outline, centred at (12, 12.6): outer radius 10, inner 4.4. */
function starPath(): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 10 : 4.4;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12.6 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/**
 * The five tiers' shapes, each better than the last: a pebble, a sprout, a star, a gem, a crown.
 * Filled in the tier's ink; the gem and the crown carry a cut-out detail so they read at 22 pt.
 */
export const MERIT_GLYPH: Readonly<Record<MeritTier, { fill: string; detail?: string }>> = {
  // A smooth, slightly lopsided stone resting low in the square.
  1: { fill: 'M4.5 15.2C4.5 11.6 7.6 8.6 11.8 8.4C16.3 8.2 19.8 10.9 19.6 14.6C19.4 18 16.3 19.8 12.2 19.8C7.8 19.8 4.5 18.4 4.5 15.2Z' },
  // Two leaves on a stem, rising from a little mound.
  2: {
    fill:
      'M11.2 20.2V11H12.8V20.2Z' +
      'M11.6 13.2C7.6 13.4 4.6 11 4.4 7C8.4 6.8 11.6 9.2 11.6 13.2Z' +
      'M12.4 11.2C12.4 6.8 15.6 4.2 19.8 4.4C19.8 8.6 16.8 11.2 12.4 11.2Z' +
      'M5.6 21.4C6.6 19.8 9 19 12 19C15 19 17.4 19.8 18.4 21.4Z',
  },
  3: { fill: starPath() },
  // A cut gem: a table on top and a point below, with its facets drawn as cut-outs.
  4: {
    fill: 'M7.2 4.2H16.8L21.4 9.6L12 20.8L2.6 9.6L7.2 4.2Z',
    detail: 'M4.9 9.6H19.1M12 20.2L8.8 9.6L10.6 4.6M12 20.2L15.2 9.6L13.4 4.6',
  },
  // A three-point crown on its band.
  5: {
    fill: 'M3 7.6L7.6 11.4L12 4.6L16.4 11.4L21 7.6L19.2 17.4H4.8L3 7.6Z' + 'M4.8 18.8H19.2V20.6H4.8Z',
  },
};

/** The crown's three jewels, round tips on its points so it reads as a crown, not a zigzag. */
const CROWN_JEWELS = [
  { cx: 3, cy: 7.6 },
  { cx: 12, cy: 4.6 },
  { cx: 21, cy: 7.6 },
];

/**
 * A drive's merit tier as a glyph that gets better with the tier: pebble, sprout, star, gem, crown.
 * Decorative: what it sits beside speaks the tier ("merit 4 of 5"); the tier has no name.
 */
export function MeritIcon({ tier, size, color, testID }: { tier: MeritTier; size: number; color: string; testID?: string }) {
  const g = MERIT_GLYPH[tier];
  return (
    <Svg
      testID={testID}
      width={size}
      height={size}
      viewBox={`0 0 ${GRID} ${GRID}`}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path d={g.fill} fill={color} />
      {g.detail ? <Path d={g.detail} fill="none" stroke="#000000" strokeOpacity={0.28} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {tier === 5 ? CROWN_JEWELS.map((j) => <Circle key={j.cx} cx={j.cx} cy={j.cy} r={1.5} fill={color} />) : null}
    </Svg>
  );
}
