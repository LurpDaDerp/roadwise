import Svg, { Circle, G, Path } from 'react-native-svg';

import type { PatternId } from '@/data/server/wrapped';

/** The glyphs' drawing grid: a 24-unit square, as the merit icons (`MeritIcon`). */
const GRID = 24;
/** With a disc behind it, the glyph fills this much of the square, centred. */
const IN_DISC = 0.64;

interface Dot {
  cx: number;
  cy: number;
  r: number;
}

/**
 * Each pattern's drawing, in the merit icons' language: one filled shape in the ink, round dots in
 * the ink, and a few cut-out details (lines and dots drawn in black at 28 %) so it reads at 22 pt.
 */
export interface ArchetypeGlyph {
  fill: string;
  dots?: readonly Dot[];
  /** Cut-out lines. */
  detail?: string;
  /** Cut-out dots (windows, an eye, wheel hubs). */
  holes?: readonly Dot[];
}

export const ARCHETYPE_GLYPH: Readonly<Record<PatternId, ArchetypeGlyph>> = {
  // Two rounded peaks with a sun over them, a snow line on the big one.
  road_tripper: {
    fill: 'M1.8 19.6L8.3 9.5C8.7 8.9 9.5 8.9 9.9 9.5L13.4 14.7L15.2 12.1C15.6 11.5 16.4 11.5 16.8 12.1L22.2 19.6Z',
    dots: [{ cx: 17.4, cy: 5.6, r: 2.4 }],
    detail: 'M6.5 12.6L7.9 13.6L9.1 12.5L10.5 13.7',
  },
  // A little skyline, three towers with lit windows.
  commuter: {
    fill: 'M3 20.5V11.2C3 10.7 3.4 10.3 3.9 10.3H7.2V6.4C7.2 5.9 7.6 5.5 8.1 5.5H11.8C12.3 5.5 12.7 5.9 12.7 6.4V12H14.4V3.9C14.4 3.4 14.8 3 15.3 3H19.6C20.1 3 20.5 3.4 20.5 3.9V20.5Z',
    holes: [
      { cx: 5.1, cy: 13.4, r: 0.8 },
      { cx: 5.1, cy: 16.6, r: 0.8 },
      { cx: 9.95, cy: 8.6, r: 0.8 },
      { cx: 9.95, cy: 11.8, r: 0.8 },
      { cx: 9.95, cy: 15, r: 0.8 },
      { cx: 17.45, cy: 6.2, r: 0.8 },
      { cx: 17.45, cy: 9.4, r: 0.8 },
      { cx: 17.45, cy: 12.6, r: 0.8 },
      { cx: 17.45, cy: 15.8, r: 0.8 },
    ],
  },
  // A round little bird with its beak up, a wing and a bright eye.
  early_bird: {
    fill:
      'M4 14.2C4 10.3 7.1 7.4 11 7.4C13.4 7.4 15.4 8.5 16.6 10.2L21.2 10.9L17.3 12.9C17.1 17 14 20 10.2 20C6.6 20 4 17.6 4 14.2Z' +
      'M4.9 12.2L1.9 10.4L2.6 14.8Z',
    dots: [{ cx: 5.2, cy: 4.4, r: 1.6 }],
    detail: 'M7.6 14C9 16 11.6 16.6 13.8 15.2',
    holes: [{ cx: 14, cy: 10.7, r: 0.95 }],
  },
  // Sunglasses, with a glint on each lens.
  weekend_cruiser: {
    fill:
      'M2 9.2C2 8.8 2.3 8.5 2.7 8.5H21.3C21.7 8.5 22 8.8 22 9.2V10.2C22 10.5 21.8 10.8 21.5 10.9C21.2 14.5 19.3 16.6 16.4 16.6' +
      'C13.8 16.6 12.4 14.6 12.4 12.3H11.6C11.6 14.6 10.2 16.6 7.6 16.6C4.7 16.6 2.8 14.5 2.5 10.9C2.2 10.8 2 10.5 2 10.2Z',
    detail: 'M5.4 11.7L7.3 13.6M14.7 11.7L16.6 13.6',
  },
  // A big pin and a little one, with the hop between them dotted in.
  city_hopper: {
    fill:
      'M8.5 6C5.7 6 3.5 8.2 3.5 10.9C3.5 14.6 8.5 20.5 8.5 20.5C8.5 20.5 13.5 14.6 13.5 10.9C13.5 8.2 11.3 6 8.5 6Z' +
      'M17.5 9.5C15.8 9.5 14.4 10.9 14.4 12.5C14.4 14.8 17.5 18.5 17.5 18.5C17.5 18.5 20.6 14.8 20.6 12.5C20.6 10.9 19.2 9.5 17.5 9.5Z',
    dots: [
      { cx: 10.2, cy: 4.3, r: 0.75 },
      { cx: 12.7, cy: 3.4, r: 0.75 },
      { cx: 15.2, cy: 4.2, r: 0.75 },
      { cx: 17.1, cy: 6, r: 0.75 },
    ],
    holes: [
      { cx: 8.5, cy: 10.9, r: 1.8 },
      { cx: 17.5, cy: 12.5, r: 1.1 },
    ],
  },
  // A little car from the side, its windows and wheel hubs cut out.
  cruiser: {
    fill: 'M2.4 15.6C2.4 13.9 3.4 12.8 5 12.5L7.6 9.4C8.2 8.7 9 8.3 9.9 8.3H14.4C15.3 8.3 16.1 8.7 16.7 9.4L19.2 12.4C20.8 12.7 21.6 13.7 21.6 15.3V16.4C21.6 16.9 21.2 17.3 20.7 17.3H3.3C2.8 17.3 2.4 16.9 2.4 16.4Z',
    dots: [
      { cx: 7.2, cy: 17.4, r: 2.5 },
      { cx: 16.8, cy: 17.4, r: 2.5 },
    ],
    detail: 'M8.4 12.3H15.8M12.1 9.2V12.3M4.4 17.1A2.9 2.9 0 0 1 10 17.1M14 17.1A2.9 2.9 0 0 1 19.6 17.1',
    holes: [
      { cx: 7.2, cy: 17.4, r: 0.9 },
      { cx: 16.8, cy: 17.4, r: 0.9 },
    ],
  },
};

const CUT = { color: '#000000', opacity: 0.28 } as const;

/**
 * A Wrapped archetype's pattern as a playful glyph: peaks, a skyline, a bird, sunglasses, two pins, a
 * car. Filled in `color`; with `disc`, it sits centred on a round disc of that colour. Decorative:
 * the archetype's name always sits beside it.
 */
export function ArchetypeIcon({ pattern, size, color = '#FFFFFF', disc, testID }: { pattern: PatternId; size: number; color?: string; disc?: string; testID?: string }) {
  const g = ARCHETYPE_GLYPH[pattern] ?? ARCHETYPE_GLYPH.cruiser;
  const s = disc ? IN_DISC : 1;
  const off = (GRID * (1 - s)) / 2;
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
      {disc ? <Circle cx={GRID / 2} cy={GRID / 2} r={GRID / 2} fill={disc} testID={testID ? `${testID}-disc` : undefined} /> : null}
      <G transform={`translate(${off} ${off}) scale(${s})`}>
        <Path d={g.fill} fill={color} />
        {(g.dots ?? []).map((d) => (
          <Circle key={`d${d.cx}-${d.cy}`} cx={d.cx} cy={d.cy} r={d.r} fill={color} />
        ))}
        {g.detail ? <Path d={g.detail} fill="none" stroke={CUT.color} strokeOpacity={CUT.opacity} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" /> : null}
        {(g.holes ?? []).map((d) => (
          <Circle key={`h${d.cx}-${d.cy}`} cx={d.cx} cy={d.cy} r={d.r} fill={CUT.color} fillOpacity={CUT.opacity} />
        ))}
      </G>
    </Svg>
  );
}
