// The compass at the halo sizes the driving screen's layouts produce (drive-screen design §3): one card
// concentric with the ring at the same gap, inside the halo's box, clear of the band and everything
// else on the screen, and its letters and mark readable on every sky in day and night.
import { hudLayout, type HudLayoutInput, type Rect } from '@/features/drive/hudLayout';
import { contrastRatio } from '@/ui/contrast';
import { opaque, over, withAlpha } from '@/ui/sky/color';
import { plainBundle, skyBundle } from '@/ui/sky/palette';

import { COMPASS_LETTER_REACH_EM, COMPASS_RING_GAP_PT, compassGeometry, glowStops, haloGeometry, ringRamp } from '../halo';
import { HUD } from '../hudTokens';

const ZERO = { top: 0, bottom: 0, left: 0, right: 0 };
type Phone = Partial<HudLayoutInput> & { width: number; height: number };
const PHONES: [string, Phone][] = [
  ['320 × 568', { width: 320, height: 568, insets: { ...ZERO, top: 20 } }],
  ['Android 360 × 640', { width: 360, height: 640, insets: { ...ZERO, top: 24, bottom: 48 } }],
  ['iPhone SE', { width: 375, height: 667, insets: { ...ZERO, top: 20 } }],
  ['iPhone 13 mini', { width: 375, height: 812, insets: { ...ZERO, top: 50, bottom: 34 } }],
  ['iPhone 15', { width: 393, height: 852, insets: { ...ZERO, top: 59, bottom: 34 } }],
  ['iPhone 16 Pro', { width: 402, height: 874, insets: { ...ZERO, top: 62, bottom: 34 } }],
  ['iPhone 15 Pro Max', { width: 430, height: 932, insets: { ...ZERO, top: 59, bottom: 34 } }],
  ['iPhone 16 Pro Max', { width: 440, height: 956, insets: { ...ZERO, top: 62, bottom: 34 } }],
  ['iPhone SE landscape', { width: 667, height: 375 }],
  ['iPhone 15 landscape', { width: 852, height: 393, insets: { top: 0, bottom: 21, left: 59, right: 59 } }],
  ['iPad split view', { width: 694, height: 1024, insets: { ...ZERO, top: 24, bottom: 20 } }],
];
const layoutOf = (o: Phone) => hudLayout({ insets: ZERO, fontScale: 1, chip: true, units: 'mi', ...o });

/** The nearest a rect comes to a point. */
const nearest = (r: Rect, cx: number, cy: number) => Math.hypot(Math.max(r.x - cx, 0, cx - (r.x + r.w)), Math.max(r.y - cy, 0, cy - (r.y + r.h)));

describe.each(PHONES)('%s', (_name, phone) => {
  const l = layoutOf(phone);
  const B = l.halo.w;
  const c = compassGeometry(B);
  const cx = l.halo.x + B / 2;
  const cy = l.halo.y + B / 2;

  test('a ring layout: the compass concentric with the ring, inside the halo’s box, the card at the gap', () => {
    expect(l.halo.ring).toBe(true);
    expect(l.halo.h).toBe(B);
    // the farthest anything is drawn: a letter's ink at its worst angle (a tick ends nearer)
    expect(c.letterR + COMPASS_LETTER_REACH_EM * c.letterPt).toBeLessThanOrEqual(c.outer);
    expect(c.outer).toBeLessThan(B / 2);
    if (B >= 253) {
      expect(c.inner - c.ring).toBeCloseTo(COMPASS_RING_GAP_PT, 9);
      // a severe event shakes in full
      expect(c.shakeMax).toBeGreaterThanOrEqual(7);
    } else {
      // the smallest ring boxes (320 pt wide) narrow the gap for 12 pt letters; a severe shake is capped
      expect(c.inner - c.ring).toBeGreaterThan(7);
      expect(c.shakeMax).toBeGreaterThanOrEqual(6);
    }
  });

  test('nothing else on the screen meets the compass (the portrait band clears it by 12 pt)', () => {
    const items: Rect[] = [l.band, l.row, l.sign, l.nav, l.end];
    if (l.chip !== null) items.push(l.chip);
    if (l.notDriving !== 'line') items.push(l.notDriving);
    if (l.orientation === 'landscape') items.splice(items.indexOf(l.row), 1); // the row is the whole frame there
    for (const r of items) expect(nearest(r, cx, cy)).toBeGreaterThanOrEqual(c.outer);
    if (l.orientation === 'portrait') expect(cy - c.outer - (l.band.y + l.band.h)).toBeGreaterThanOrEqual(12);
  });
});

test('the letters at the layouts’ halos: 12 pt in the smallest, 15 on an iPhone SE, 19 to 20 on every newer iPhone', () => {
  const size = (name: string) => compassGeometry(layoutOf(PHONES.find(([n]) => n === name)![1]).halo.w).letterPt;
  expect(size('320 × 568')).toBe(12);
  expect(size('Android 360 × 640')).toBe(12);
  expect(size('iPhone SE')).toBe(15);
  for (const name of ['iPhone 13 mini', 'iPhone 15', 'iPhone 16 Pro', 'iPhone 15 Pro Max', 'iPhone 16 Pro Max', 'iPhone SE landscape', 'iPhone 15 landscape']) {
    expect(size(name)).toBeGreaterThanOrEqual(19);
  }
});

// The letters and the mark sit over the halo's glow (at its calm strength, in any of its colours) on
// the driving screen's sky (every stop of every sky, and true black outside a theme).
describe('readable on every sky, in day and night, over the glow', () => {
  const phases = ['night', 'dawn', 'day', 'dusk'] as const;
  const kinds = ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm'] as const;
  const bundles = [
    ...phases.flatMap((phase) => kinds.flatMap((kind) => ([0, 1] as const).map((glow) => skyBundle({ phase, glow, weather: { kind, intensity: 'moderate' } })))),
    ...phases.map((phase) => skyBundle({ phase, glow: 1, weather: { kind: 'cloudy', intensity: 'light' } })),
    plainBundle('light'),
    plainBundle('dark'),
  ];
  /** The glow's opacity `x` pt from the centre of a `B` box (its radial gradient, linear between stops). */
  function glowAt(B: number, x: number): number {
    const g = haloGeometry(B);
    const st = glowStops(g);
    const o = x / g.Ro;
    for (let i = 1; i < st.length; i += 1) {
      const a = st[i - 1]!;
      const b = st[i]!;
      if (o <= b.offset) return a.opacity + ((b.opacity - a.opacity) * (o - a.offset)) / Math.max(1e-9, b.offset - a.offset);
    }
    return 0;
  }
  const grounds = {
    day: [...new Set([HUD.day.ground, ...bundles.flatMap((b) => b.sky.hud.day.stops.map(opaque))])],
    night: [...new Set([HUD.night.ground, ...bundles.flatMap((b) => b.sky.hud.night.stops.map(opaque))])],
  };
  /** The lowest contrast of `ink` over the ground at `x` pt from the centre, in both palettes. */
  function worst(B: number, x: number, ink: 'haloInk' | 'compassInk' | 'haloInkMuted'): number {
    const alpha = glowAt(B, x);
    let min = Infinity;
    for (const set of ['day', 'night'] as const) {
      const p = HUD[set];
      for (const ground of grounds[set]) for (const glow of ringRamp(p)) min = Math.min(min, contrastRatio(p[ink], opaque(over(ground, withAlpha(glow, alpha)))));
    }
    return min;
  }
  const sizes = [...new Set(PHONES.map(([, phone]) => layoutOf(phone).halo.w))];

  test.each(sizes)('a %i pt halo: the letters on their circle (N at 10:1, E/S/W 6:1), the ticks 4.5:1 and the mark 6.5:1', (B) => {
    const c = compassGeometry(B);
    expect(worst(B, c.letterR, 'haloInk')).toBeGreaterThanOrEqual(10);
    expect(worst(B, c.letterR, 'compassInk')).toBeGreaterThanOrEqual(6);
    // a tick's inner end (the nearer the ring, the brighter the glow)
    expect(worst(B, c.letterR - c.tick / 2, 'haloInkMuted')).toBeGreaterThanOrEqual(4.5);
    expect(worst(B, c.markTip - c.markH / 2, 'haloInk')).toBeGreaterThanOrEqual(6.5);
  });

  test('every letter’s inmost ink, in every ring box, holds 4.5:1 (E/S/W in the compass ink, where the muted ink would not)', () => {
    let n = Infinity;
    let esw = Infinity;
    let muted = Infinity;
    for (let B = 220; B <= 420; B += 1) {
      const c = compassGeometry(B);
      n = Math.min(n, worst(B, c.inner, 'haloInk'));
      esw = Math.min(esw, worst(B, c.inner, 'compassInk'));
      muted = Math.min(muted, worst(B, c.inner, 'haloInkMuted'));
    }
    expect(esw).toBeGreaterThanOrEqual(4.5);
    expect(n).toBeGreaterThan(esw);
    expect(muted).toBeLessThan(4.5);
  });
});
