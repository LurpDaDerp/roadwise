// Where everything on the driving screen goes (drive-screen design §3), as absolute rects from one
// pure function, so "End is always on screen" and "nothing overlaps" are tests, not hopes.
//
// - Portrait: a top row (the sign at its left, the navigation button at its right), the 56 pt band
//   under it (with a DashPal paired its right 88 pt are the chip's slot), the halo centred
//   on the screen (as near as the shortest top row and End allow) and the End swipe across the
//   bottom. The top row takes the height above the band (up to 144 pt: a bigger sign); a points line
//   sits under the halo when it fits above End (so the halo never moves when the car stops).
// - Landscape: three columns over the End swipe across the bottom: the sign on the left (the band
//   above it), the halo in the middle, the navigation button on the right (the points line above
//   it), the sign and the button level with the halo's centre.
// - Compact (a window too small for a 220 pt halo: split screen, a small freeform window): an 88 pt
//   top row (the navigation circle back at 64 pt) with the band between the sign and the navigation button, bare numerals in the middle,
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
  /** the navigation button's list of apps: never over the button or End */
  panel: Rect;
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
/** The navigation button: an 80 pt circle (64 pt at least in a narrow slot); its slot holds it and its one-line caption. */
export const HUD_NAV_BUTTON_PT = 80;
export const HUD_NAV_W_PT = 96;
export const HUD_NAV_H_PT = HUD_NAV_BUTTON_PT + 24;
/** A compact window's navigation slot: the 64 pt circle and its caption. */
export const HUD_COMPACT_NAV_H_PT = HUD_MIN_TARGET_PT + 24;
/** The top row: at least the navigation slot and a little air, at most 144 pt (a bigger sign). */
export const HUD_ROW_MIN_PT = HUD_NAV_H_PT + 8;
export const HUD_ROW_MAX_PT = 144;
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
 * start-aligned, the navigation button (`navH` tall) end-aligned, both centred vertically.
 */
function rowItems(row: Rect, units: 'mi' | 'km', maxSlot = Infinity, navH = HUD_NAV_H_PT): { sign: Rect; nav: Rect } {
  const sideW = Math.min(row.w / 3, maxSlot);
  const s = signFor(units, row.h, sideW);
  const navW = Math.min(HUD_NAV_W_PT, sideW);
  const mid = row.y + row.h / 2;
  return {
    sign: { x: row.x, y: mid - s.h / 2, w: s.w, h: s.h },
    nav: { x: row.x + row.w - navW, y: mid - navH / 2, w: navW, h: navH },
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

/** The navigation list's panel between the top row and End, across the frame. */
function panelUnder(row: Rect, end: Rect): Rect {
  const y = row.y + row.h + 8;
  return { x: row.x, y, w: row.w, h: Math.max(0, end.y - 8 - y) };
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
      const g = haloGeometry(B);
      // The lit ring's outer edge at rest; the band clears it by a gap (only the glow's faint edge
      // reaches past it).
      const ringR = g.r + g.W / 2;
      const end = endAt(left, frameW, bottom);
      // The halo centred on the screen, held between the shortest top row and End.
      const highest = top + HUD_ROW_MIN_PT + GAP + HUD_BAND_PT + GAP + ringR - B / 2;
      const lowest = end.y - GAP - B;
      const haloY = Math.min(lowest, Math.max(highest, height / 2 - B / 2));
      const rowH = Math.max(HUD_ROW_MIN_PT, Math.min(HUD_ROW_MAX_PT, Math.floor(haloY + B / 2 - ringR - GAP - HUD_BAND_PT - GAP - top)));
      const pointsLine = haloY + B + GAP + HUD_POINTS_LINE_PT + GAP <= end.y;
      const row: Rect = { x: left, y: top, w: frameW, h: rowH };
      const band: Rect = { x: left, y: top + rowH + GAP, w: frameW, h: HUD_BAND_PT };
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + (frameW - B) / 2, y: haloY, w: B, h: B, ring: true },
        points: pointsLine ? { x: left, y: haloY + B + GAP, w: frameW, h: HUD_POINTS_LINE_PT } : 'line',
        row,
        ...rowItems(row, i.units),
        end,
        panel: panelUnder(row, end),
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  } else {
    // End across the foot; above it the halo in the middle, each side column at least the 96 pt
    // navigation slot wide.
    const end = endAt(left, frameW, bottom);
    const above = end.y - GAP - top;
    const B = Math.floor(Math.min(HALO_MAX_BOX_PT, above, frameW - 2 * (HUD_NAV_W_PT + 16)));
    const side = (frameW - B - 32) / 2;
    if (B >= HALO_MIN_RING_BOX_PT) {
      const g = haloGeometry(B);
      const haloY = top + (above - B) / 2;
      const mid = haloY + B / 2;
      const rx = left + frameW - side;
      // Left: the band at the top, the sign under it, level with the halo's centre (as tall as
      // that allows, at most 144 pt).
      const band: Rect = { x: left, y: top, w: side, h: HUD_BAND_PT };
      const s = signFor(i.units, Math.min(HUD_ROW_MAX_PT, 2 * (mid - (top + HUD_BAND_PT + GAP))), side);
      const sign: Rect = { x: left + (side - s.w) / 2, y: mid - s.h / 2, w: s.w, h: s.h };
      // Right: the navigation button level with the halo's centre, the points line above it when it fits.
      const navW = Math.min(HUD_NAV_W_PT, side);
      const nav: Rect = { x: rx + (side - navW) / 2, y: mid - HUD_NAV_H_PT / 2, w: navW, h: HUD_NAV_H_PT };
      const pointsLine = top + HUD_POINTS_LINE_PT + GAP <= nav.y;
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + side + 16, y: haloY, w: B, h: B, ring: true },
        points: pointsLine ? { x: rx, y: top, w: side, h: HUD_POINTS_LINE_PT } : 'line',
        row: { x: left, y: top, w: frameW, h: above },
        sign,
        nav,
        end,
        // Over the sign and the halo: the navigation button and End stay reachable beside and under it.
        panel: { x: left, y: top, w: rx - 16 - left, h: end.y - 8 - top },
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  }

  // Compact: no ring; the band between the sign and the navigation button; End pinned to the bottom
  // whatever is left for the numerals.
  const row: Rect = { x: left, y: top, w: frameW, h: HUD_COMPACT_NAV_H_PT };
  const sideW = Math.min(frameW / 3, HUD_NAV_W_PT);
  const band: Rect = { x: left + sideW + COMPACT_GAP, y: top, w: Math.max(0, frameW - 2 * (sideW + COMPACT_GAP)), h: HUD_COMPACT_NAV_H_PT };
  const room = frameH - HUD_COMPACT_NAV_H_PT - 2 * COMPACT_GAP - SPEED_UNIT_GAP_PT - unitLineHeight(unitPt) - COMPACT_DIGITS_MIN_PT;
  const end = endAt(left, frameW, bottom, Math.max(COMPACT_END_MIN_PT, Math.min(END_SWIPE_H_PT, Math.floor(room))));
  const regionTop = top + HUD_COMPACT_NAV_H_PT + COMPACT_GAP;
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
    ...rowItems(row, i.units, HUD_NAV_W_PT, HUD_COMPACT_NAV_H_PT),
    end,
    panel: panelUnder(row, end),
    numeralPt2: pt2,
    numeralPt3: pt3,
    unitPt,
  };
}
