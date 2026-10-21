// The driving screen's layout (drive-screen design §3, §5.12): worked phones, End always inside the
// window, nothing overlapping, the numerals large enough.
import { DIGIT_ADVANCE_EM, DIGIT_HEIGHT_EM, haloGeometry, numeralLineHeight, SPEED_UNIT_GAP_PT, unitLineHeight, unitTop } from '@/ui/drive';

import { HUD_COMPACT_NAV_H_PT, HUD_NAV_H_PT, HUD_NAV_W_PT, hudLayout, type HudLayout, type HudLayoutInput, type Rect } from '../hudLayout';

const ZERO = { top: 0, bottom: 0, left: 0, right: 0 };
const L = (o: Partial<HudLayoutInput> & { width: number; height: number }): HudLayout => hudLayout({ insets: ZERO, fontScale: 1, chip: false, units: 'mi', ...o });

const inside = (r: Rect, w: number, h: number) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= w + 1e-9 && r.y + r.h <= h + 1e-9;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
/** A rect meets the halo's lit ring (its outer edge at rest). */
function hitsCircle(r: Rect, halo: Rect): boolean {
  const cx = halo.x + halo.w / 2;
  const cy = halo.y + halo.h / 2;
  const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
  const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
  const g = haloGeometry(halo.w);
  return (nx - cx) ** 2 + (ny - cy) ** 2 < (g.r + g.W / 2) ** 2 - 1e-6;
}

describe('worked phones (§3.1, §3.2)', () => {
  test('iPhone SE 375 × 667 (status bar 20): halo 339 as near the centre as fits, the points in the band line, a 112 pt top row, the R2-1 at 90 × 112', () => {
    const l = L({ width: 375, height: 667, insets: { ...ZERO, top: 20 } });
    expect(l).toMatchObject({ orientation: 'portrait', compact: false });
    expect(l.halo.w).toBe(339);
    expect(l.points).toBe('line');
    expect(l.row).toMatchObject({ y: 32, h: 112 });
    expect([l.sign.w, l.sign.h]).toEqual([90, 112]);
    expect(l.numeralPt2).toBe(156);
  });

  test('top to bottom: the top row (sign left, navigation right), the band, the halo, End across the foot', () => {
    const l = L({ width: 393, height: 852, insets: { ...ZERO, top: 59, bottom: 34 } });
    expect(l.sign.x).toBe(l.row.x);
    expect(l.nav.x + l.nav.w).toBe(l.row.x + l.row.w);
    expect(l.band.y).toBeGreaterThanOrEqual(l.row.y + l.row.h);
    // the halo centred on the screen; its lit ring clears the band
    expect(l.halo.y + l.halo.h / 2).toBe(852 / 2);
    expect(hitsCircle(l.band, l.halo)).toBe(false);
    expect(l.end).toEqual({ x: 16, y: 852 - 34 - 16 - 76, w: 361, h: 76 });
    expect(l.end.y).toBeGreaterThanOrEqual(l.halo.y + l.halo.h);
  });

  test('360 × 640 Android (24 / 48): halo 260, the points in the band line, a 112 pt top row', () => {
    const l = L({ width: 360, height: 640, insets: { ...ZERO, top: 24, bottom: 48 } });
    expect(l.halo.w).toBe(260);
    expect(l.points).toBe('line');
    expect(l.row.h).toBe(112);
    expect(l.numeralPt2).toBe(118);
  });

  test('iPhone 13 mini, 15 and 15 Pro Max: halos 343, 361 and 398', () => {
    expect(L({ width: 375, height: 812, insets: { ...ZERO, top: 50, bottom: 34 } }).halo.w).toBe(343);
    expect(L({ width: 393, height: 852, insets: { ...ZERO, top: 59, bottom: 34 } }).halo.w).toBe(361);
    const max = L({ width: 430, height: 932, insets: { ...ZERO, top: 59, bottom: 34 } });
    expect(max.halo.w).toBe(398);
    expect(max.row.h).toBe(144);
    expect(max.numeralPt2).toBe(168);
  });

  test('a narrow window (280 wide): the side slots are a third of the row; the navigation circle still fits', () => {
    const l = L({ width: 280, height: 600 });
    expect(l.end.w).toBe(248);
    expect(l.nav.w).toBeCloseTo(248 / 3, 6);
    expect(l.sign.w).toBeLessThanOrEqual(248 / 3);
  });

  test('320 × 568: halo 240, a 112 pt top row and the R2-1 at 90 × 112', () => {
    const l = L({ width: 320, height: 568, insets: { ...ZERO, top: 20 } });
    expect(l.halo.w).toBe(240);
    expect(l.row.h).toBe(112);
    expect([l.sign.w, l.sign.h]).toEqual([90, 112]);
  });

  test('km: the round sign at most 116 pt, fitted to its row', () => {
    const l = L({ width: 375, height: 667, units: 'km' });
    expect([l.sign.w, l.sign.h]).toEqual([112, 112]);
    const big = L({ width: 430, height: 932, units: 'km' });
    expect([big.sign.w, big.sign.h]).toEqual([116, 116]);
    const small = L({ width: 320, height: 568, units: 'km' });
    expect([small.sign.w, small.sign.h]).toEqual([96, 96]);
  });

  test('iPhone SE landscape 667 × 375: the sign left of a full-height halo (347) with the points inside it, the navigation button right with End under it', () => {
    const l = L({ width: 667, height: 375 });
    expect(l).toMatchObject({ orientation: 'landscape', compact: false });
    expect(l.halo).toMatchObject({ x: 128, y: 12, w: 347, h: 347, ring: true });
    const mid = l.halo.y + l.halo.h / 2;
    // the sign in the left column, level with the halo's centre
    expect(l.sign).toEqual({ x: 16, y: mid - 60, w: 96, h: 120 });
    // the right column, top to bottom: the band, the navigation button, End (160 wide)
    expect(l.band).toEqual({ x: 491, y: 12, w: 160, h: 56 });
    expect(l.nav).toEqual({ x: 523, y: 167, w: 96, h: 104 });
    expect(l.end).toEqual({ x: 491, y: 375 - 16 - 76, w: 160, h: 76 });
    expect(l.end.y).toBe(l.nav.y + l.nav.h + 12);
    // the points inside the halo, under the speed: the stack raised 33 pt, the numerals sized for it
    expect(l.points).toBe('halo');
    expect(l.haloPoints).toEqual({ lift: 33, pt: 28, w: 135 });
    expect([l.numeralPt2, l.numeralPt3]).toEqual([126, 97]);
    // the navigation list covers the sign and the halo, never the button or End
    expect(l.panel).toEqual({ x: 16, y: 12, w: 459, h: 347 });
  });

  test('iPhone 15 landscape 852 × 393 (side insets 59, bottom 21): the halo the full height, 344 pt, centred on the screen', () => {
    const l = L({ width: 852, height: 393, insets: { top: 0, bottom: 21, left: 59, right: 59 } });
    expect(l).toMatchObject({ orientation: 'landscape', compact: false, halo: { y: 12, w: 344, ring: true }, points: 'halo' });
    expect(l.halo.x + l.halo.w / 2).toBe(852 / 2);
    expect(l.end).toMatchObject({ x: 852 - 75 - 163, w: 163 });
    expect(l.sign.x).toBeGreaterThanOrEqual(75);
    expect(l.nav.x + l.nav.w).toBeLessThanOrEqual(852 - 75);
  });

  test('a wide landscape window (an iPad, 1194 × 834): the 420 pt halo centred on the screen, End at most 420 wide', () => {
    const l = L({ width: 1194, height: 834 });
    expect(l.halo).toMatchObject({ w: 420, ring: true });
    expect(l.halo.x + l.halo.w / 2).toBe(1194 / 2);
    expect(l.end.w).toBe(355);
  });

  test('a 360 × 640 Android turned, with the 3-button bar on the right (640 × 360, right 48): the ring, 272 pt; too small for the points inside, they go in the band line', () => {
    const l = L({ width: 640, height: 360, insets: { ...ZERO, right: 48 } });
    expect(l).toMatchObject({ orientation: 'landscape', compact: false, halo: { w: 272, ring: true }, points: 'line', haloPoints: null });
    expect(l.nav.w).toBe(96);
    expect(l.numeralPt2).toBeGreaterThanOrEqual(96);
    const statusBar = L({ width: 640, height: 360, insets: { ...ZERO, top: 24, right: 48 } });
    expect(statusBar).toMatchObject({ compact: false, halo: { w: 272, ring: true } });
    expect(L({ width: 600, height: 400 })).toMatchObject({ compact: false, halo: { w: 280, ring: true } });
  });

  test('landscape falls to compact only when the middle cannot hold a 220 pt ring, or the right column its stack', () => {
    // frameW - 32 - 96 - 160 >= 220 from width 540; the band, navigation and End stack (260 pt) from height 288
    expect(L({ width: 540, height: 400 })).toMatchObject({ compact: false, halo: { w: 220 } });
    expect(L({ width: 538, height: 400 })).toMatchObject({ compact: true });
    expect(L({ width: 700, height: 288 })).toMatchObject({ compact: false, halo: { w: 260 } });
    expect(L({ width: 700, height: 286 })).toMatchObject({ compact: true });
  });

  test('a DashPal paired: an 88 pt chip slot at the band right; the line beside it, never under it', () => {
    const l = L({ width: 393, height: 852, chip: true });
    expect(l.chip).toEqual({ x: l.band.x + l.band.w - 88, y: l.band.y, w: 88, h: 56 });
    expect(overlap(l.chip!, l.line)).toBe(false);
    expect(L({ width: 393, height: 852 }).chip).toBeNull();
  });
});

describe('invariants across windows', () => {
  const windows: [number, number][] = [];
  for (let w = 280; w <= 430; w += 10) for (let h = 320; h <= 932; h += 24) windows.push([w, h]);
  const insetSets = [ZERO, { top: 47, bottom: 34, left: 0, right: 0 }, { top: 24, bottom: 48, left: 0, right: 0 }];
  const cases: { w: number; h: number; ins: typeof ZERO; chip: boolean; units: 'mi' | 'km' }[] = [];
  for (const [w, h] of windows)
    for (const ins of insetSets) {
      cases.push({ w, h, ins, chip: true, units: 'mi' });
      // landscape: the same window turned (the insets move to the sides)
      // (side insets only on a window as wide as a phone turned on its side)
      const side = h >= 568 ? ins.top : 0;
      cases.push({ w: h, h: w, ins: { top: 0, bottom: ins.bottom > 0 && h >= 568 ? 21 : 0, left: side, right: side }, chip: false, units: 'km' });
      // an Android phone turned, its 3-button bar on one side, the status bar on top
      if (h >= 568) cases.push({ w: h, h: w, ins: { top: 24, bottom: 0, left: 0, right: 48 }, chip: true, units: 'mi' });
    }

  test('End is always fully inside the window (every window from 280 × 320, both orientations, any insets), 76 pt tall (64 to 76 when compact), its knob a 64 pt target', () => {
    for (const c of cases) {
      const l = L({ width: c.w, height: c.h, insets: c.ins, chip: c.chip, units: c.units });
      if (!inside(l.end, c.w, c.h)) throw new Error(`End outside ${c.w}x${c.h} ${JSON.stringify(c.ins)}: ${JSON.stringify(l.end)}`);
      if (l.compact) {
        expect(l.end.h).toBeGreaterThanOrEqual(64);
        expect(l.end.h).toBeLessThanOrEqual(76);
      } else expect(l.end.h).toBe(76);
      // a landscape End shares its column with the navigation button: at least 160 wide
      expect(l.end.w).toBeGreaterThanOrEqual(l.orientation === 'landscape' && !l.compact ? 160 : 200);
      expect(l.end.w).toBeLessThanOrEqual(420);
    }
  });

  test('nothing overlaps: band items, points, sign, End and navigation never meet each other or the halo ring', () => {
    for (const c of cases) {
      const l = L({ width: c.w, height: c.h, insets: c.ins, chip: c.chip, units: c.units });
      const items: [string, Rect][] = [
        ['band', l.band],
        ['sign', l.sign],
        ['end', l.end],
        ['nav', l.nav],
      ];
      if (l.points !== 'line' && l.points !== 'halo') items.push(['points', l.points]);
      for (let a = 0; a < items.length; a += 1)
        for (let b = a + 1; b < items.length; b += 1)
          if (overlap(items[a]![1], items[b]![1])) throw new Error(`${items[a]![0]} meets ${items[b]![0]} at ${c.w}x${c.h}`);
      if (l.halo.ring) for (const [name, r] of items) if (hitsCircle(r, l.halo)) throw new Error(`${name} meets the halo at ${c.w}x${c.h}`);
      if (l.chip) expect(overlap(l.chip, l.line)).toBe(false);
      // the navigation list never covers the navigation button or End
      expect(overlap(l.panel, l.nav)).toBe(false);
      expect(overlap(l.panel, l.end)).toBe(false);
      expect(inside(l.panel, c.w, c.h)).toBe(true);
      if (l.orientation === 'landscape' && !l.compact) {
        expect(l.sign.x + l.sign.w).toBeLessThanOrEqual(l.halo.x + 1e-9);
        expect(l.nav.x).toBeGreaterThanOrEqual(l.halo.x + l.halo.w - 1e-9);
      }
      // the sign and the nav rect sit in the top row, above the band and (in portrait) the halo; End is the lowest thing
      expect(l.sign.y).toBeGreaterThanOrEqual(l.row.y - 1e-9);
      expect(l.sign.y + l.sign.h).toBeLessThanOrEqual(l.row.y + l.row.h + 1e-9);
      if (l.orientation === 'portrait') {
        expect(l.halo.y).toBeGreaterThanOrEqual(l.row.y + l.row.h - 1e-9);
        expect(l.end.y).toBeGreaterThanOrEqual(l.halo.y + l.halo.h - 1e-9);
      }
      // the nav rect holds the 64 pt circle and its caption, within the row
      expect(l.nav.w).toBeGreaterThanOrEqual(64);
      expect(l.nav.w).toBeLessThanOrEqual(HUD_NAV_W_PT);
      // the 80 pt circle's slot, or the 64 pt one's in a compact window
      expect(l.nav.h).toBe(l.compact ? HUD_COMPACT_NAV_H_PT : HUD_NAV_H_PT);
      expect(l.nav.y).toBeGreaterThanOrEqual(l.row.y - 1e-9);
      expect(l.nav.y + l.nav.h).toBeLessThanOrEqual(l.row.y + l.row.h + 1e-9);
    }
  });

  test('outside compact windows: a ring of at least 220 pt, two-digit numerals at least 96 pt (120 from 360 wide), "188" inside the chord', () => {
    for (const c of cases) {
      const l = L({ width: c.w, height: c.h, insets: c.ins, chip: c.chip, units: c.units });
      if (l.compact) continue;
      expect(l.halo.w).toBeGreaterThanOrEqual(220);
      expect(l.halo.w).toBe(l.halo.h);
      expect(l.numeralPt2).toBeGreaterThanOrEqual(96);
      if (l.orientation === 'portrait' && c.w >= 360 && l.halo.w >= 328) expect(l.numeralPt2).toBeGreaterThanOrEqual(120);
      const rc = haloGeometry(l.halo.w).rc;
      const lift = l.haloPoints?.lift ?? 0;
      expect(((3 * 0.535 * l.numeralPt3) / 2) ** 2 + (0.357 * l.numeralPt3 + lift) ** 2).toBeLessThanOrEqual((0.94 * rc) ** 2);
      if (l.haloPoints !== null) {
        // the points line, under the unit label, keeps its corners inside the ring for either size
        for (const pt of [l.numeralPt2, l.numeralPt3]) {
          const bottom = -lift + 0.357 * pt + SPEED_UNIT_GAP_PT + unitLineHeight(l.unitPt) + 4 + Math.round(1.15 * l.haloPoints.pt);
          expect((l.haloPoints.w / 2) ** 2 + bottom ** 2).toBeLessThanOrEqual((0.94 * rc) ** 2 + 1e-6);
        }
      }
    }
  });

  test('landscape: the points inside the halo on every phone turned that keeps 96 pt numerals with them', () => {
    let inside = 0;
    for (const c of cases) {
      const l = L({ width: c.w, height: c.h, insets: c.ins, chip: c.chip, units: c.units });
      if (l.orientation !== 'landscape' || l.compact) continue;
      if (l.points === 'halo') {
        inside += 1;
        expect(l.numeralPt2).toBeGreaterThanOrEqual(96);
        expect(l.haloPoints!.w).toBeGreaterThanOrEqual(3.5 * l.haloPoints!.pt);
      } else expect([l.points, l.haloPoints]).toEqual(['line', null]);
    }
    expect(inside).toBeGreaterThan(20);
  });
});

/**
 * Where the readout really draws (SpeedReadout: its box centred in the halo box, the digits optically
 * centred in the box, the unit label hanging under them): the digits' top, the label's bottom.
 */
function readout(l: HudLayout, pt: number): { digitsTop: number; labelBottom: number } {
  const cy = l.halo.y + l.halo.h / 2;
  const boxTop = cy - numeralLineHeight(pt) / 2;
  return { digitsTop: cy - (DIGIT_HEIGHT_EM / 2) * pt, labelBottom: boxTop + unitTop(pt) + unitLineHeight(l.unitPt) };
}

describe('compact windows (§3.3)', () => {
  const compactWindows: [number, number, Partial<HudLayoutInput['insets']>][] = [
    [600, 300, {}],
    [412, 300, {}],
    [568, 320, {}],
    [500, 330, {}],
    [640, 300, { top: 24, right: 48 }],
    [300, 400, {}],
    [280, 320, {}],
    [320, 280, {}],
  ];
  for (let w = 280; w <= 700; w += 20) for (let h = 240; h <= 420; h += 10) compactWindows.push([w, h, {}]);
  test.each([1, 1.3, 1.6, 2])('font scale %p: the digits stay under the top row and the unit label above End; the numerals fit their box', (fontScale) => {
    let compact = 0;
    for (const [width, height, ins] of compactWindows) {
      const l = L({ width, height, insets: { ...ZERO, ...ins }, fontScale });
      if (!l.compact) continue;
      // Too short for the top row, a 64 pt End and the label alone (280 x 240 at 2x): nothing readable fits.
      if (l.end.y - 8 - (l.row.y + l.row.h + 8) < SPEED_UNIT_GAP_PT + unitLineHeight(l.unitPt)) continue;
      compact += 1;
      for (const [pt, digits] of [
        [l.numeralPt2, 2],
        [l.numeralPt3, 3],
      ] as const) {
        const r = readout(l, pt);
        const at = `${width}x${height} ${JSON.stringify(ins)} @${fontScale} ${digits} digits`;
        if (r.labelBottom > l.end.y + 1e-9) throw new Error(`label ${r.labelBottom} over End ${l.end.y} at ${at}`);
        if (r.digitsTop < l.row.y + l.row.h - 1e-9) throw new Error(`digits over the top row at ${at}`);
        if (digits * DIGIT_ADVANCE_EM * pt > l.halo.w + 1e-9) throw new Error(`${digits} digits wider than their box at ${at}`);
      }
    }
    expect(compact).toBeGreaterThan(20);
  });

  test('412 × 300 (a third of a split screen): the box is the full width, the band between the sign and navigation, the label 8 pt clear of End', () => {
    const l = L({ width: 412, height: 300 });
    expect(l.compact).toBe(true);
    expect(l.halo).toMatchObject({ x: 16, w: 380, ring: false });
    expect(l.end).toMatchObject({ w: 380, h: 76 });
    expect(l.band.x).toBeGreaterThanOrEqual(l.sign.x + l.sign.w);
    expect(l.band.x + l.band.w).toBeLessThanOrEqual(l.nav.x);
    expect(l.numeralPt2).toBe(86);
    const clear = l.end.y - readout(l, l.numeralPt2).labelBottom;
    expect(clear).toBeGreaterThanOrEqual(8);
    expect(clear).toBeLessThan(9);
  });

  test('300 × 400: compact, no ring, the points in the band line, End pinned at the bottom', () => {
    const l = L({ width: 300, height: 400 });
    expect(l.compact).toBe(true);
    expect(l.halo.ring).toBe(false);
    expect(l.points).toBe('line');
    expect(l.row.h).toBe(88);
    expect(l.end.y).toBe(400 - 16 - 76);
    expect(l.numeralPt2).toBeGreaterThan(0);
    expect(l.numeralPt3).toBeLessThan(l.numeralPt2);
  });

  test('a compact window too short for a 76 pt End and readable numerals gives End back, never under 64', () => {
    const tiny = L({ width: 280, height: 240, fontScale: 2 });
    expect(tiny.compact).toBe(true);
    expect(tiny.end.h).toBe(64);
    expect(tiny.end.y + tiny.end.h).toBe(240 - 16);
    const between = L({ width: 412, height: 262 });
    expect(between.compact).toBe(true);
    expect(between.end.h).toBeGreaterThan(64);
    expect(between.end.h).toBeLessThan(76);
    expect(L({ width: 412, height: 300 }).end.h).toBe(76);
  });

  test('a short wide window (600 × 240) is compact too, End inside; at 600 × 300 a 272 pt ring fits', () => {
    const l = L({ width: 600, height: 240 });
    expect(l.compact).toBe(true);
    expect(inside(l.end, 600, 240)).toBe(true);
    expect(L({ width: 600, height: 300 })).toMatchObject({ compact: false, halo: { w: 272, ring: true } });
  });

  test('a larger font scale grows the unit label and shrinks the numerals, never the halo', () => {
    const one = L({ width: 360, height: 780 });
    const two = L({ width: 360, height: 780, fontScale: 2 });
    expect(two.halo.w).toBe(one.halo.w);
    expect(two.unitPt).toBe(40);
    expect(two.numeralPt2).toBeLessThan(one.numeralPt2);
    expect(L({ width: 360, height: 780, fontScale: 3 }).unitPt).toBe(40);
  });

  test('a nonsense window (0 × 0, NaN) never throws', () => {
    expect(() => L({ width: 0, height: 0 })).not.toThrow();
    expect(() => L({ width: Number.NaN, height: 500 })).not.toThrow();
  });
});
