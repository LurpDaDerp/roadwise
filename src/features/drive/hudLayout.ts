// Where everything on the driving screen goes (drive-screen design §3), as absolute rects from one
// pure function, so "End is always on screen" and "nothing overlaps" are tests, not hopes.
//
// - Portrait: a top row (the sign at its left, the navigation button at its right), the 56 pt band
//   under it (with a DashPal paired its right 88 pt are the chip's slot), the halo straight under
//   the band and the End swipe across the bottom. Spare height goes to a points line under the halo (so the halo
//   never moves when the car stops), then to a taller top row (up to 144 pt: a bigger sign), then
//   evenly above and below the halo.
// - Landscape: the halo on the left; the top row, the band, the points line and End on the right.
// - Compact (a window too small for a 220 pt halo: split screen, a small freeform window): an 88 pt
//   top row with the band between the sign and the navigation button, bare numerals in the middle,
//   the unit label under them inside the same space (never over End); End stays pinned to the
//   bottom. End is 76 pt tall everywhere except a compact window too short for it and a readable
//   speed, where it gives back down to the 64 pt target.
import {
  DIGIT_HEIGHT_EM,
  END_SWIPE_H_PT,
  END_SWIPE_MAX_W_PT,
  HALO_MAX_BOX_PT,
  HALO_MIN_RING_BOX_PT,
  haloGeometry,
  haloNumeralPt,
  HUD_MIN_TARGET_PT,
  hudLabelScale,
  signSize,
  SPEED_UNIT_GAP_PT,
  SPEED_UNIT_PT,
  unitLineHeight,
} from '@/ui/drive';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudLayout {
  orientation: 'portrait' | 'landscape';
  compact: boolean;
  /** the band under the top row: alert banners take all of it */
  band: Rect;
  /** inside the band: the failed-end, points (when they have no line of their own) and weather line */
  line: Rect;
  /** inside the band, right: the DashPal chip's slot, when one is paired */
  chip: Rect | null;
  /**
   * the halo's square box; `ring` false: the bare numerals' box, the region's full width, with the
   * digits centred in it and the unit label hanging just below it (still above End)
   */
  halo: Rect & { ring: boolean };
  /** the points' own line under the halo, or 'line' (the band's line) */
  points: Rect | 'line';
  /** the top row and its two items */
  row: Rect;
  sign: Rect;
  nav: Rect;
  /** the End swipe across the bottom */
  end: Rect;
  /** the speed numerals for one or two digits, and for three */
  numeralPt2: number;
  numeralPt3: number;
  unitPt: number;
}

export interface HudLayoutInput {
  width: number;
  height: number;
  insets: { top: number; bottom: number; left: number; right: number };
  /** the OS font scale (the unit label follows Dynamic Type up to 2x) */
  fontScale: number;
  /** a DashPal is paired: the band keeps a slot for its chip */
  chip: boolean;
  units: 'mi' | 'km';
}

export const HUD_BAND_PT = 56;
export const HUD_CHIP_SLOT_PT = 88;
export const HUD_POINTS_LINE_PT = 46;
/** The top row: at least the navigation slot and a little air, at most 144 pt (a bigger sign). */
export const HUD_ROW_MIN_PT = 96;
export const HUD_ROW_MAX_PT = 144;
/** The navigation button's slot: the 64 pt circle and its one-line caption. */
export const HUD_NAV_W_PT = 96;
export const HUD_NAV_H_PT = 88;
const GAP = 12;
const COMPACT_GAP = 8;
/** A compact window's End never shrinks under the 64 pt target… */
const COMPACT_END_MIN_PT = HUD_MIN_TARGET_PT;
/** …and shrinks only to keep the digits at least this tall (48 pt numerals). */
const COMPACT_DIGITS_MIN_PT = 34;
const ROUND_SIGN_MAX_PT = 116;

/** The sign for a slot `slotW` wide in a row `rowH` tall. */
function signFor(units: 'mi' | 'km', rowH: number, slotW: number): { w: number; h: number } {
  if (units === 'km') {
    const d = Math.floor(Math.min(rowH, slotW, ROUND_SIGN_MAX_PT));
    return { w: d, h: d };
  }
  const H = Math.floor(Math.min(rowH, slotW / 0.8));
  const s = signSize('mi', H);
  return { w: s.width, h: s.height };
}

/**
 * The top row's items, each in a side slot a third of the row wide (at most `maxSlot`): the sign
 * start-aligned, the navigation button end-aligned, both centred vertically.
 */
function rowItems(row: Rect, units: 'mi' | 'km', maxSlot = Infinity): { sign: Rect; nav: Rect } {
  const sideW = Math.min(row.w / 3, maxSlot);
  const s = signFor(units, row.h, sideW);
  const navW = Math.min(HUD_NAV_W_PT, sideW);
  const mid = row.y + row.h / 2;
  return {
    sign: { x: row.x, y: mid - s.h / 2, w: s.w, h: s.h },
    nav: { x: row.x + row.w - navW, y: mid - HUD_NAV_H_PT / 2, w: navW, h: HUD_NAV_H_PT },
  };
}

/** The End swipe centred across a column from `x`, `w` wide, `h` tall, its foot at `bottom`. */
function endAt(x: number, w: number, bottom: number, h: number = END_SWIPE_H_PT): Rect {
  const endW = Math.min(w, END_SWIPE_MAX_W_PT);
  return { x: x + (w - endW) / 2, y: bottom - h, w: endW, h };
}

function bandParts(band: Rect, chip: boolean): { line: Rect; chip: Rect | null } {
  if (!chip) return { line: band, chip: null };
  // A compact band narrower than the slot is all the chip's.
  const chipW = Math.min(HUD_CHIP_SLOT_PT, band.w);
  return {
    line: { x: band.x, y: band.y, w: band.w - chipW, h: band.h },
    chip: { x: band.x + band.w - chipW, y: band.y, w: chipW, h: band.h },
  };
}

const num = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

export function hudLayout(i: HudLayoutInput): HudLayout {
  const width = Math.max(0, num(i.width));
  const height = Math.max(0, num(i.height));
  const ins = { top: num(i.insets.top), bottom: num(i.insets.bottom), left: num(i.insets.left), right: num(i.insets.right) };
  const unitPt = SPEED_UNIT_PT * hudLabelScale(i.fontScale);
  const left = ins.left + 16;
  const right = width - ins.right - 16;
  const top = ins.top + 12;
  const bottom = height - ins.bottom - 16;
  const frameW = Math.max(0, right - left);
  const frameH = Math.max(0, bottom - top);
  const orientation: HudLayout['orientation'] = width > height ? 'landscape' : 'portrait';

  if (orientation === 'portrait') {
    const region = frameH - HUD_ROW_MIN_PT - GAP - HUD_BAND_PT - GAP - GAP - END_SWIPE_H_PT;
    const B = Math.floor(Math.min(HALO_MAX_BOX_PT, frameW, region));
    if (B >= HALO_MIN_RING_BOX_PT) {
      let slack = region - B;
      const pointsLine = slack >= HUD_POINTS_LINE_PT + GAP;
      if (pointsLine) slack -= HUD_POINTS_LINE_PT + GAP;
      const rowH = Math.min(HUD_ROW_MAX_PT, HUD_ROW_MIN_PT + slack);
      slack -= rowH - HUD_ROW_MIN_PT;
      const row: Rect = { x: left, y: top, w: frameW, h: rowH };
      const band: Rect = { x: left, y: top + rowH + GAP, w: frameW, h: HUD_BAND_PT };
      // The halo sits right under the band (its glow fades well inside its box); the gap it would
      // leave goes under the points line instead.
      const groupTop = band.y + HUD_BAND_PT + slack / 2;
      const g = haloGeometry(B);
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + (frameW - B) / 2, y: groupTop, w: B, h: B, ring: true },
        points: pointsLine ? { x: left, y: groupTop + B + GAP, w: frameW, h: HUD_POINTS_LINE_PT } : 'line',
        row,
        ...rowItems(row, i.units),
        end: endAt(left, frameW, bottom),
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  } else {
    const colW = (frameW - 16) / 2;
    const B = Math.floor(Math.min(HALO_MAX_BOX_PT, colW, frameH));
    // The right column: the top row, the band, the points line when there is room, End at the foot.
    const avail = frameH - GAP - HUD_BAND_PT - GAP - GAP - END_SWIPE_H_PT;
    const pointsLine = avail - HUD_POINTS_LINE_PT - GAP >= HUD_ROW_MIN_PT;
    const rowSpace = pointsLine ? avail - HUD_POINTS_LINE_PT - GAP : avail;
    // It holds the top row when its side slots take the 64 pt navigation circle.
    if (B >= HALO_MIN_RING_BOX_PT && rowSpace >= HUD_ROW_MIN_PT && colW / 3 >= HUD_MIN_TARGET_PT) {
      const rx = left + colW + 16;
      const rowH = Math.min(HUD_ROW_MAX_PT, rowSpace);
      const row: Rect = { x: rx, y: top, w: colW, h: rowH };
      const band: Rect = { x: rx, y: top + rowH + GAP, w: colW, h: HUD_BAND_PT };
      const g = haloGeometry(B);
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + (colW - B) / 2, y: top + (frameH - B) / 2, w: B, h: B, ring: true },
        points: pointsLine ? { x: rx, y: band.y + HUD_BAND_PT + GAP, w: colW, h: HUD_POINTS_LINE_PT } : 'line',
        row,
        ...rowItems(row, i.units),
        end: endAt(rx, colW, bottom),
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  }

  // Compact: no ring; the band between the sign and the navigation button; End pinned to the bottom
  // whatever is left for the numerals.
  const row: Rect = { x: left, y: top, w: frameW, h: HUD_NAV_H_PT };
  const sideW = Math.min(frameW / 3, HUD_NAV_W_PT);
  const band: Rect = { x: left + sideW + COMPACT_GAP, y: top, w: Math.max(0, frameW - 2 * (sideW + COMPACT_GAP)), h: HUD_NAV_H_PT };
  const room = frameH - HUD_NAV_H_PT - 2 * COMPACT_GAP - SPEED_UNIT_GAP_PT - unitLineHeight(unitPt) - COMPACT_DIGITS_MIN_PT;
  const end = endAt(left, frameW, bottom, Math.max(COMPACT_END_MIN_PT, Math.min(END_SWIPE_H_PT, Math.floor(room))));
  const regionTop = top + HUD_NAV_H_PT + COMPACT_GAP;
  const regionH = Math.max(0, end.y - COMPACT_GAP - regionTop);
  // The readout centres the digits in the box and hangs the label 6 pt under them, so the box is the
  // region less the gap and the label, and the digits are at most its height.
  const boxH = Math.max(0, regionH - SPEED_UNIT_GAP_PT - unitLineHeight(unitPt));
  // Two digits are 1.07 em wide (three 1.6 em), plus a little air.
  const tall = boxH / DIGIT_HEIGHT_EM;
  const pt2 = Math.max(1, Math.min(168, Math.floor(Math.min(frameW / 1.13, tall))));
  const pt3 = Math.max(1, Math.min(168, Math.floor(Math.min(frameW / 1.665, tall))));
  return {
    orientation,
    compact: true,
    band,
    ...bandParts(band, i.chip),
    halo: { x: left, y: regionTop, w: frameW, h: boxH, ring: false },
    points: 'line',
    row,
    ...rowItems(row, i.units, HUD_NAV_W_PT),
    end,
    numeralPt2: pt2,
    numeralPt3: pt3,
    unitPt,
  };
}
