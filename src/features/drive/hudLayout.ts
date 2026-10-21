// Where everything on the driving screen goes (drive-screen design §3), as absolute rects from one
// pure function, so "End is always on screen" and "nothing overlaps" are tests, not hopes.
//
// - Portrait: a top row (the sign at its left, the navigation button at its right), the 56 pt band
//   under it (with a DashPal paired its right 88 pt are the chip's slot), the halo centred
//   on the screen (as near as the shortest top row and End allow) and the End swipe across the
//   bottom. The top row takes the height above the band (up to 144 pt: a bigger sign); a points line
//   sits under the halo when it fits above End (so the halo never moves when the car stops).
// - Landscape: three columns, the halo the full height in the middle: the sign on the left, level
//   with the halo's centre; on the right the band at the top, the navigation button and the End
//   swipe under it at the foot (a 160 pt column at least, so End stays a swipe). The halo is
//   centred on the screen when both side columns can be that wide. The points sit inside the halo,
//   under the speed and its unit: the readout stack (digits, unit, points) is centred in the ring
//   whether the points show or not, so nothing moves when the car stops (a halo too small for that
//   with 96 pt numerals puts them in the band's line).
// - Compact (a window too small for a 220 pt halo: split screen, a small freeform window): an 88 pt
//   top row (the navigation circle back at 64 pt) with the band between the sign and the navigation button, bare numerals in the middle,
//   the unit label under them inside the same space (never over End); End stays pinned to the
//   bottom. End is 76 pt tall everywhere except a compact window too short for it and a readable
//   speed, where it gives back down to the 64 pt target.
import {
  DIGIT_ADVANCE_EM,
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
  /** the points' own line under the halo, 'line' (the band's line) or 'halo' (inside it: `haloPoints`) */
  points: Rect | 'line' | 'halo';
  /**
   * Landscape: the points inside the halo, under the unit label. `lift` raises the readout (digits
   * centre) above the halo's centre so the whole stack is centred; `pt` is the points' type size
   * and `w` the width they fit in (they shrink to fit it).
   */
  haloPoints: { lift: number; pt: number; w: number } | null;
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
/** Landscape's right column (the band, the navigation button and End): at least this wide. */
export const HUD_LAND_RIGHT_MIN_PT = 160;
/** Landscape: the points inside the halo, 8 % of the halo box (20 to 28 pt; the line 1.15 of it), this far under the unit label. */
export const haloPointsPt = (box: number): number => Math.max(20, Math.min(28, Math.round(0.08 * box)));
export const HALO_POINTS_GAP_PT = 4;
/** …and never narrower than this many of their em (they shrink to fit what is left). */
const HALO_POINTS_MIN_W_EM = 3.5;
/** The points go inside the halo only while its two-digit numerals stay at least this big. */
const HALO_POINTS_MIN_NUMERAL_PT = 96;
const pointsLineHeight = (pt: number): number => Math.round(1.15 * pt);

/**
 * The numerals for `digits` digits when the points sit inside the halo under the unit label: the
 * largest size whose stack (digits, unit, points), centred in the ring, keeps the digits' corners,
 * the unit and the points line inside 0.94 of the ring's inner radius, with the points line at
 * least `HALO_POINTS_MIN_W_EM` wide. Also the stack's lift and the points' width at its foot.
 */
export function haloStack(rc: number, digits: number, unitPt: number, pointsPt: number): { pt: number; lift: number; w: number } {
  const lim = (0.94 * rc) ** 2;
  const n = Math.max(1, digits);
  const below = SPEED_UNIT_GAP_PT + unitLineHeight(unitPt) + HALO_POINTS_GAP_PT + pointsLineHeight(pointsPt);
  // The digits' centre sits `lift` above the ring's centre: half of what hangs under the digits.
  const lift = below / 2;
  for (let pt = 168; pt > 1; pt -= 1) {
    const half = (n * DIGIT_ADVANCE_EM * pt) / 2;
    const digitTop = lift + (DIGIT_HEIGHT_EM / 2) * pt;
    if (half ** 2 + digitTop ** 2 > lim) continue;
    const unitBottom = -lift + (DIGIT_HEIGHT_EM / 2) * pt + SPEED_UNIT_GAP_PT + unitLineHeight(unitPt);
    if (unitPt ** 2 + unitBottom ** 2 > lim) continue;
    const pointsBottom = unitBottom + HALO_POINTS_GAP_PT + pointsLineHeight(pointsPt);
    if (pointsBottom ** 2 >= lim) continue;
    const w = 2 * Math.sqrt(lim - pointsBottom ** 2);
    if (w < HALO_POINTS_MIN_W_EM * pointsPt) continue;
    return { pt, lift, w: Math.floor(w) };
  }
  return { pt: 1, lift, w: 0 };
}
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
        haloPoints: null,
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
    // The halo the full height, between a sign column at least the 96 pt slot wide and a right
    // column wide enough for End; centred on the screen when the right column can spare it.
    const B = Math.floor(Math.min(HALO_MAX_BOX_PT, frameH, frameW - 32 - HUD_NAV_W_PT - HUD_LAND_RIGHT_MIN_PT));
    const even = (frameW - B - 32) / 2;
    const rightW = Math.min(END_SWIPE_MAX_W_PT, Math.max(HUD_LAND_RIGHT_MIN_PT, even));
    const leftW = frameW - B - 32 - rightW;
    // The right column holds the band, the navigation button and End.
    if (B >= HALO_MIN_RING_BOX_PT && frameH >= HUD_BAND_PT + GAP + HUD_NAV_H_PT + GAP + END_SWIPE_H_PT) {
      const g = haloGeometry(B);
      const haloY = top + (frameH - B) / 2;
      const mid = haloY + B / 2;
      const rx = left + frameW - rightW;
      // Left: the sign, level with the halo's centre.
      const s = signFor(i.units, Math.min(HUD_ROW_MAX_PT, frameH), leftW);
      const sign: Rect = { x: left + (leftW - s.w) / 2, y: mid - s.h / 2, w: s.w, h: s.h };
      // Right, top to bottom: the band, the navigation button, End.
      const band: Rect = { x: rx, y: top, w: rightW, h: HUD_BAND_PT };
      const end = endAt(rx, rightW, bottom);
      const navW = Math.min(HUD_NAV_W_PT, rightW);
      const nav: Rect = { x: rx + (rightW - navW) / 2, y: end.y - GAP - HUD_NAV_H_PT, w: navW, h: HUD_NAV_H_PT };
      // The points inside the halo; the numerals sized for the stack (the points line placed for two
      // digits, the lower and narrower of the two). A halo too small to keep 96 pt numerals with
      // them keeps its numerals and puts the points in the band's line.
      const pointsPt = haloPointsPt(B);
      const two = haloStack(g.rc, 2, unitPt, pointsPt);
      const three = haloStack(g.rc, 3, unitPt, pointsPt);
      const inHalo = two.pt >= HALO_POINTS_MIN_NUMERAL_PT;
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + leftW + 16, y: haloY, w: B, h: B, ring: true },
        points: inHalo ? 'halo' : 'line',
        haloPoints: inHalo ? { lift: two.lift, pt: pointsPt, w: Math.min(two.w, three.w) } : null,
        row: { x: left, y: top, w: frameW, h: frameH },
        sign,
        nav,
        end,
        // Over the sign and the halo: the right column's navigation button and End stay reachable.
        panel: { x: left, y: top, w: rx - 16 - left, h: frameH },
        numeralPt2: inHalo ? two.pt : haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: inHalo ? three.pt : haloNumeralPt(g.rc, 3, unitPt),
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
    haloPoints: null,
    row,
    ...rowItems(row, i.units, HUD_NAV_W_PT, HUD_COMPACT_NAV_H_PT),
    end,
    panel: panelUnder(row, end),
    numeralPt2: pt2,
    numeralPt3: pt3,
    unitPt,
  };
}
