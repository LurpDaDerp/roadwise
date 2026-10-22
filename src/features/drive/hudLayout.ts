// Where everything on the driving screen goes (drive-screen design §3), as absolute rects from one
// pure function, so "End is always on screen" and "nothing overlaps" are tests, not hopes.
//
// - Portrait: a top row (the sign at its left, the navigation button at its right), the 56 pt band
//   under it (with a DashPal paired its right 88 pt are the chip's slot), the halo centred
//   on the screen (as near as the shortest top row and End allow; the band clears its compass) and
//   the End swipe across the bottom. The top row takes the height above the band (up to 144 pt: a
//   bigger sign). The "Not driving?" link's 44 pt row is always kept directly above End, whether the
//   link shows or not, so the halo never moves when it appears or goes; a window that would lose
//   the ring for it (a small Android phone) puts the link in the band's line instead.
// - Landscape: three columns, the halo the full height in the middle: the sign on the left, level
//   with the halo's centre; on the right the band at the top, the "Not driving?" link, the
//   navigation button and the End swipe under it at the foot (a 160 pt column at least, so End
//   stays a swipe). The halo is centred on the screen when both side columns can be that wide. A
//   column too short for the link's row puts the link in the band's line.
// - Compact (a window too small for a 220 pt halo: split screen, a small freeform window): an 88 pt
//   top row (the navigation circle back at 64 pt) with the band between the sign and the navigation
//   button, bare numerals in the middle, the unit label under them inside the same space (never
//   over End); End stays pinned to the bottom; the link in the band's line. End is 76 pt tall
//   everywhere except a compact window too short for it and a readable speed, where it gives back
//   down to the 64 pt target.
import {
  compassGeometry,
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
  /** inside the band: the failed end, the waiting line, a spot's nudge, the weather banner, and the link when it has no row of its own */
  line: Rect;
  /** inside the band, right: the DashPal chip's slot, when one is paired */
  chip: Rect | null;
  /**
   * the halo's square box; `ring` false: the bare numerals' box, the region's full width, with the
   * digits centred in it and the unit label hanging just below it (still above End)
   */
  halo: Rect & { ring: boolean };
  /**
   * The "Not driving?" link's own row (portrait: directly above End; landscape: directly above the
   * navigation button), or 'line' (the band's line: compact windows, and windows with no room for it).
   */
  notDriving: Rect | 'line';
  /** the top row and its two items */
  row: Rect;
  sign: Rect;
  nav: Rect;
  /** the End swipe across the bottom */
  end: Rect;
  /** the navigation button's list of apps, and the waiting panels: never over the button, the link's row or End */
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
/** The "Not driving?" link's row: its 18/22 pt line with air above and below (the touch box reaches 64 pt). */
export const HUD_NOT_DRIVING_PT = 44;
/** The navigation button: an 80 pt circle (64 pt at least in a narrow slot); its slot holds it and its one-line caption. */
export const HUD_NAV_BUTTON_PT = 80;
export const HUD_NAV_W_PT = 96;
export const HUD_NAV_H_PT = HUD_NAV_BUTTON_PT + 24;
/** A compact window's navigation slot: the 64 pt circle and its caption. */
export const HUD_COMPACT_NAV_H_PT = HUD_MIN_TARGET_PT + 24;
/** The top row: at least the navigation slot and a little air, at most 144 pt (a bigger sign). */
export const HUD_ROW_MIN_PT = HUD_NAV_H_PT + 8;
export const HUD_ROW_MAX_PT = 144;
/** Landscape's right column (the band, the link, the navigation button and End): at least this wide. */
export const HUD_LAND_RIGHT_MIN_PT = 160;
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

/** The panel between the top row and `below` (the link's row or End), across the frame. */
function panelUnder(row: Rect, below: Rect): Rect {
  const y = row.y + row.h + 8;
  return { x: row.x, y, w: row.w, h: Math.max(0, below.y - 8 - y) };
}

const num = (v: number, d = 0): number => (Number.isFinite(v) ? v : d);

/**
 * A coordinate on the whole-point grid. The nudge settles values a float hair under .5 the same way
 * as .5 itself, so two edges that meet before snapping still meet after.
 */
const snapPt = (v: number): number => Math.round(v + 1e-7);

/**
 * A rect on whole points: each edge snapped on its own (rounding keeps every edge's order, so
 * nothing that was apart, inside or level is moved into another thing), a whole-point size kept as
 * it is (the halo stays square). React Native 0.86's text drawing on iOS can lose a line, or shrink
 * it to 4 pt, on a frame a hair off the pixel grid (RN #52642); whole-point rects keep every frame
 * on the screen exact.
 */
export function snapRect<R extends Rect>(r: R): R {
  const x = snapPt(r.x);
  const y = snapPt(r.y);
  const w = Number.isInteger(r.w) ? r.w : Math.max(0, snapPt(r.x + r.w) - x);
  const h = Number.isInteger(r.h) ? r.h : Math.max(0, snapPt(r.y + r.h) - y);
  return { ...r, x, y, w, h };
}

/** The layout with every rect on whole points (`snapRect`). */
function snapLayout(l: HudLayout): HudLayout {
  return {
    ...l,
    band: snapRect(l.band),
    line: snapRect(l.line),
    chip: l.chip === null ? null : snapRect(l.chip),
    halo: snapRect(l.halo),
    notDriving: l.notDriving === 'line' ? 'line' : snapRect(l.notDriving),
    row: snapRect(l.row),
    sign: snapRect(l.sign),
    nav: snapRect(l.nav),
    end: snapRect(l.end),
    panel: snapRect(l.panel),
  };
}

/** Where everything on the driving screen goes, every rect on whole points. */
export function hudLayout(i: HudLayoutInput): HudLayout {
  return snapLayout(layoutRects(i));
}

function layoutRects(i: HudLayoutInput): HudLayout {
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
    // The halo's room: the frame less the shortest top row, the band, End and their gaps; the link's
    // row comes out of it too unless that would cost the ring.
    const region = frameH - HUD_ROW_MIN_PT - GAP - HUD_BAND_PT - GAP - GAP - END_SWIPE_H_PT;
    const boxFor = (room: number) => Math.floor(Math.min(HALO_MAX_BOX_PT, frameW, room));
    const withLink = boxFor(region - HUD_NOT_DRIVING_PT) >= HALO_MIN_RING_BOX_PT;
    const B = boxFor(withLink ? region - HUD_NOT_DRIVING_PT : region);
    if (B >= HALO_MIN_RING_BOX_PT) {
      const g = haloGeometry(B);
      // The compass's outer edge (around the ring, just inside the box); the band clears it by a gap
      // (only the glow's faint edge reaches past it).
      const edgeR = compassGeometry(B).outer;
      const end = endAt(left, frameW, bottom);
      // The link's row sits a gap above End; the halo rests on it (the row's own air keeps the line
      // clear of the compass), or a gap above End when the link is in the band's line.
      const link: Rect | null = withLink ? { x: left, y: end.y - GAP - HUD_NOT_DRIVING_PT, w: frameW, h: HUD_NOT_DRIVING_PT } : null;
      const floor = link !== null ? link.y : end.y - GAP;
      // The halo centred on the screen, held between the shortest top row and the floor.
      const highest = top + HUD_ROW_MIN_PT + GAP + HUD_BAND_PT + GAP + edgeR - B / 2;
      const lowest = floor - B;
      const haloY = Math.min(lowest, Math.max(highest, height / 2 - B / 2));
      const rowH = Math.max(HUD_ROW_MIN_PT, Math.min(HUD_ROW_MAX_PT, Math.floor(haloY + B / 2 - edgeR - GAP - HUD_BAND_PT - GAP - top)));
      const row: Rect = { x: left, y: top, w: frameW, h: rowH };
      const band: Rect = { x: left, y: top + rowH + GAP, w: frameW, h: HUD_BAND_PT };
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + (frameW - B) / 2, y: haloY, w: B, h: B, ring: true },
        notDriving: link ?? 'line',
        row,
        ...rowItems(row, i.units),
        end,
        panel: panelUnder(row, link ?? end),
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
      // Right, top to bottom: the band, the link (when the column has room for its row), the
      // navigation button, End.
      const band: Rect = { x: rx, y: top, w: rightW, h: HUD_BAND_PT };
      const end = endAt(rx, rightW, bottom);
      const navW = Math.min(HUD_NAV_W_PT, rightW);
      const nav: Rect = { x: rx + (rightW - navW) / 2, y: end.y - GAP - HUD_NAV_H_PT, w: navW, h: HUD_NAV_H_PT };
      const linkFits = frameH >= HUD_BAND_PT + GAP + HUD_NOT_DRIVING_PT + GAP + HUD_NAV_H_PT + GAP + END_SWIPE_H_PT;
      return {
        orientation,
        compact: false,
        band,
        ...bandParts(band, i.chip),
        halo: { x: left + leftW + 16, y: haloY, w: B, h: B, ring: true },
        notDriving: linkFits ? { x: rx, y: nav.y - GAP - HUD_NOT_DRIVING_PT, w: rightW, h: HUD_NOT_DRIVING_PT } : 'line',
        row: { x: left, y: top, w: frameW, h: frameH },
        sign,
        nav,
        end,
        // Over the sign and the halo: the right column's link, navigation button and End stay reachable.
        panel: { x: left, y: top, w: rx - 16 - left, h: frameH },
        numeralPt2: haloNumeralPt(g.rc, 2, unitPt),
        numeralPt3: haloNumeralPt(g.rc, 3, unitPt),
        unitPt,
      };
    }
  }

  // Compact: no ring; the band between the sign and the navigation button; End pinned to the bottom
  // whatever is left for the numerals; the link in the band's line.
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
    notDriving: 'line',
    row,
    ...rowItems(row, i.units, HUD_NAV_W_PT, HUD_COMPACT_NAV_H_PT),
    end,
    panel: panelUnder(row, end),
    numeralPt2: pt2,
    numeralPt3: pt3,
    unitPt,
  };
}
