import { Ionicons } from '@expo/vector-icons';
import type { EventType } from '@scoring';
import Svg, { Polyline } from 'react-native-svg';

import { EVENT_ICON } from './format';

/** The glyph's drawing grid: a 24-unit square, scaled to `size`. */
const GRID = 24;
const MID = GRID / 2;
/** Stroke in grid units: about 1.4 pt at 14 pt, the same for all three chevrons. */
const STROKE = 2.4;
/** The tallest chevron's height in grid units; the other two are 40 % and 70 % of it. */
const TALL = 20;
const HEIGHTS = [0.4 * TALL, 0.7 * TALL, TALL] as const;
/** How far a chevron's point reaches past its open ends, per unit of its half height (the same angle on all three). */
const DEPTH = 0.8;
/** The horizontal step between the chevrons' points. */
const STEP = 7.6;

/** Three open chevrons growing left to right, centred in the grid: the points of each `>`. */
export function accelChevrons(): string[] {
  const back = (HEIGHTS[0] / 2) * DEPTH; // the first chevron's open ends sit this far left of its point
  const span = back + 2 * STEP; // first chevron's open ends to the last one's point
  const firstTip = MID - span / 2 + back;
  return HEIGHTS.map((h, i) => {
    const tip = firstTip + i * STEP;
    const d = (h / 2) * DEPTH;
    const pt = (x: number, y: number) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    return `${pt(tip - d, MID - h / 2)} ${pt(tip, MID)} ${pt(tip - d, MID + h / 2)}`;
  });
}

const CHEVRONS = accelChevrons();

/**
 * Hard acceleration's glyph: three chevrons growing left to right (Ionicons has no such icon).
 * Drawn on the same square footprint as an Ionicons glyph of the same `size`, decorative: the row,
 * pin or card around it names the event.
 */
export function AccelGlyph({ size, color, testID = 'accel-glyph' }: { size: number; color: string; testID?: string }) {
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
      {CHEVRONS.map((points) => (
        <Polyline key={points} points={points} fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

/** An event's icon wherever events are listed or pinned: `EVENT_ICON`, except hard acceleration's own glyph. */
export function EventIcon({ type, size, color }: { type: EventType; size: number; color: string }) {
  if (type === 'hard_accel') return <AccelGlyph size={size} color={color} />;
  return <Ionicons name={EVENT_ICON[type]} size={size} color={color} />;
}
