// Where everything on the driving screen goes (drive-screen design §3), as absolute rects from one
// pure function, so "End is always on screen" and "nothing overlaps" are tests, not hopes.
//
// - Portrait: the top band (56 pt; with a DashPal paired its right 88 pt are the chip's slot), the
//   halo in the middle, a bottom row of three equal slots (sign · End · navigation). Spare height
//   goes to a points line under the halo (so the halo never moves when the car stops), then to a
//   bigger bottom row (up to 128 pt: a bigger sign), then evenly above and below.
// - Landscape: the halo on the left; the band, the points line and the bottom row on the right.
// - Compact (a window too small for a 220 pt halo: split screen, a small freeform window): a 40 pt
//   band, a 96 pt bottom row, bare numerals in between; End stays pinned to the bottom.
import { END_BUTTON_PT, HALO_MAX_BOX_PT, HALO_MIN_RING_BOX_PT, haloGeometry, haloNumeralPt, hudLabelScale, signSize, SPEED_UNIT_PT } from '@/ui/drive';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudLayout {
  orientation: 'portrait' | 'landscape';
  compact: boolean;
  /** the top band: alert banners take all of it */
  band: Rect;
  /** inside the band: the failed-end, points (when they have no line of their own) and weather line */
  line: Rect;
  /** inside the band, right: the DashPal chip's slot, when one is paired */
  chip: Rect | null;
  /** the halo's square box; `ring` false: bare numerals */
  halo: Rect & { ring: boolean };
  /** the points' own line under the halo, or 'line' (the band's line) */
  points: Rect | 'line';
  /** the bottom row and its three items */
  row: Rect;
  sign: Rect;
  end: Rect;
  nav: Rect;
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
export const HUD_COMPACT_BAND_PT = 40;
export const HUD_CHIP_SLOT_PT = 88;
export const HUD_POINTS_LINE_PT = 46;
export const HUD_ROW_MAX_PT = 128;
/** The navigation button's slot: the 64 pt circle and its one-line caption. */
export const HUD_NAV_W_PT = 96;
export const HUD_NAV_H_PT = 88;
const GAP = 12;
const COMPACT_GAP = 8;
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
 * The bottom row's items: sign start-aligned, End centred, navigation end-aligned, all centred
 * vertically. The side slots are a third of the row, or what End leaves them in a narrow window.
 */
function rowItems(row: Rect, units: 'mi' | 'km'): { sign: Rect; end: Rect; nav: Rect } {
  const sideW = Math.max(0, Math.min(row.w / 3, (row.w - END_BUTTON_PT) / 2 - 4));
  const s = signFor(units, row.h, sideW);
  const navW = Math.min(HUD_NAV_W_PT, sideW);
  const mid = row.y + row.h / 2;
  return {
    sign: { x: row.x, y: mid - s.h / 2, w: s.w, h: s.h },
    end: { x: row.x + row.w / 2 - END_BUTTON_PT / 2, y: mid - END_BUTTON_PT / 2, w: END_BUTTON_PT, h: END_BUTTON_PT },
    nav: { x: row.x + row.w - navW, y: mid - HUD_NAV_H_PT / 2, w: navW, h: HUD_NAV_H_PT },
  };
}

function bandParts(band: Rect, chip: boolean): { line: Rect; chip: Rect | null } {
  if (!chip) return { line: band, chip: null };
  return {
    line: { x: band.x, y: band.y, w: Math.max(0, band.w - HUD_CHIP_SLOT_PT), h: band.h },
    chip: { x: band.x + band.w - HUD_CHIP_SLOT_PT, y: band.y, w: HUD_CHIP_SLOT_PT, h: band.h },
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
    const region = frameH - HUD_BAND_PT - END_BUTTON_PT - 2 * GAP;
    const B = Math.floor(Math.min(HALO_MAX_BOX_PT, frameW, region));
    if (B >= HALO_MIN_RING_BOX_PT) {
      let slack = region - B;
      const pointsLine = slack >= HUD_POINTS_LINE_PT + GAP;
      if (pointsLine) slack -= HUD_POINTS_LINE_PT + GAP;
      const rowH = Math.min(HUD_ROW_MAX_PT, END_BUTTON_PT + slack);
      slack -= rowH - END_BUTTON_PT;
      const band: Rect = { x: left, y: top, w: frameW, h: HUD_BAND_PT };
      const groupTop = top + HUD_BAND_PT + GAP + slack / 2;
      const halo = { x: left + (frameW - B) / 2, y: groupTop, w: B, h: B, ring: true };
      const row: Rect = { x: left, y: bottom - rowH, w: frameW, h: rowH };
      const g = haloGeometry(B);
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo,
        points: pointsLine ? { x: left, y: groupTop + B + GAP, w: frameW, h: HUD_POINTS_LINE_PT } : 'line',
        row,
        ...rowItems(row, i.units),
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  } else {
    const colW = (frameW - 16) / 2;
    const B = Math.floor(Math.min(HALO_MAX_BOX_PT, colW, frameH));
    const rowSpace = frameH - HUD_BAND_PT - GAP - HUD_POINTS_LINE_PT - GAP;
    if (B >= HALO_MIN_RING_BOX_PT && rowSpace >= END_BUTTON_PT && colW / 3 >= END_BUTTON_PT) {
      const rx = left + colW + 16;
      const band: Rect = { x: rx, y: top, w: colW, h: HUD_BAND_PT };
      const rowH = Math.min(HUD_ROW_MAX_PT, rowSpace);
      const row: Rect = { x: rx, y: bottom - rowH, w: colW, h: rowH };
      const g = haloGeometry(B);
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + (colW - B) / 2, y: top + (frameH - B) / 2, w: B, h: B, ring: true },
        points: { x: rx, y: top + HUD_BAND_PT + GAP, w: colW, h: HUD_POINTS_LINE_PT },
        row,
        ...rowItems(row, i.units),
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  }

  // Compact: no ring; End pinned to the bottom whatever is left for the numerals.
  const band: Rect = { x: left, y: top, w: frameW, h: HUD_COMPACT_BAND_PT };
  const row: Rect = { x: left, y: bottom - END_BUTTON_PT, w: frameW, h: END_BUTTON_PT };
  const regionTop = top + HUD_COMPACT_BAND_PT + COMPACT_GAP;
  const regionH = Math.max(0, row.y - COMPACT_GAP - regionTop);
  const side = Math.max(0, Math.min(frameW, regionH));
  // Two digits are 1.07 em wide (three 1.6 em), plus a little air; the digits and the unit label
  // under them take about 0.75 em plus the label.
  const tall = (regionH - 6 - 0.92 * unitPt) / 0.75;
  const pt2 = Math.max(1, Math.min(168, Math.floor(Math.min(frameW / 1.13, tall))));
  const pt3 = Math.max(1, Math.min(168, Math.floor(Math.min(frameW / 1.665, tall))));
  return {
    orientation,
    compact: true,
    band,
    ...bandParts(band, i.chip),
    halo: { x: left + (frameW - side) / 2, y: regionTop + (regionH - side) / 2, w: side, h: side, ring: false },
    points: 'line',
    row,
    ...rowItems(row, i.units),
    numeralPt2: pt2,
    numeralPt3: pt3,
    unitPt,
  };
}
