// The speed-limit sign (drive-screen design §3.4): the US R2-1 "SPEED LIMIT" rectangle in miles, the
// round red-ringed sign in kilometres, "-" when the limit is unknown, never Dynamic Type. The print is
// sized and placed by arithmetic (signMetrics), never by the text system: on React Native 0.86 iOS
// `adjustsFontSizeToFit` with a fixed line on a frame a hair short drew the number at 4 pt (the user's
// blank sign with a black dot near its foot; RN #52642).
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { HUD } from '@/ui/drive/hudTokens';
import { numeralInkEm, numeralWidthEm, TEXT_SLACK_PT } from '@/ui/drive/SpeedReadout';
import { SIGN_BORDER_INSET_PT, signMetrics, signSize, SpeedSign, type SignMetrics } from '@/ui/drive/SpeedSign';

const p = HUD.day;

type Flat = { fontSize?: number; lineHeight?: number; top?: number; left?: number; width?: number; height?: number };
const flat = (el: { props: { style?: unknown } }): Flat => StyleSheet.flatten(el.props.style as never) as Flat;

type Node = { type: unknown; props: Record<string, unknown>; children: (Node | string)[] };
/** Every host Text under `root` (a render's root). */
function allTexts(root: unknown): Node[] {
  const out: Node[] = [];
  const walk = (n: Node | string | null | undefined) => {
    if (n === null || n === undefined || typeof n === 'string') return;
    if (n.type === 'Text') out.push(n);
    n.children.forEach(walk);
  };
  walk(root as Node);
  if (out.length === 0) throw new Error('no Text rendered');
  return out;
}

/** Barlow Semi Condensed Bold (the legend's face): advances in em, read from its TTF. */
const LEGEND_EM: Record<string, number> = { S: 0.52, P: 0.531, E: 0.511, D: 0.547, L: 0.499, I: 0.246, M: 0.631, T: 0.526 };
const legendWidth = (word: string, pt: number) => [...word].reduce((w, ch) => w + LEGEND_EM[ch]! * pt, 0) + 0.5 * word.length;

/** Where a line set in `pt` on a `line`-tall line puts its baseline (React Native centres the face's 1.2 em in the line). */
const baseline = (top: number, pt: number, line: number) => top + line / 2 + 0.4 * pt;
/** The number's ink on the face: the digits 0 to 0.714 em above the baseline, the hyphen 0.219 to 0.361. */
function numberInk(m: SignMetrics, value: string): { top: number; bottom: number; centre: number } {
  const b = baseline(m.numeralTop, m.numeralPt, m.numeralLine);
  const em = numeralInkEm(value);
  return { top: b - em.top * m.numeralPt, bottom: b - em.bottom * m.numeralPt, centre: b - ((em.top + em.bottom) / 2) * m.numeralPt };
}

describe('miles: the R2-1 rectangle', () => {
  test('SPEED / LIMIT over the number, black on the white face with a black border, 0.8 wide', async () => {
    await render(<SpeedSign limit={35} palette={p} units="mi" height={128} />);
    expect(screen.getByTestId('hud-limit-words')).toHaveTextContent('SPEEDLIMIT');
    expect(screen.getByText('SPEED')).toHaveStyle({ fontSize: 21, lineHeight: 26, top: 4, left: 9, width: 84, height: 28, color: p.signInk });
    expect(screen.getByText('LIMIT')).toHaveStyle({ fontSize: 21, lineHeight: 26, top: 30, left: 9, width: 84, height: 28 });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 59, lineHeight: 71, top: 49, left: 9, width: 84, height: 73, color: p.signInk });
    expect(screen.getByTestId('hud-limit')).toHaveStyle({ width: 102, height: 128, backgroundColor: p.signFace });
    expect(screen.getByTestId('hud-limit-border')).toHaveStyle({ borderColor: p.signInk, borderWidth: 3, top: SIGN_BORDER_INSET_PT });
    expect(screen.getByLabelText('Speed limit 35')).toBeTruthy();
    expect(signSize('mi', 128)).toEqual({ width: 102, height: 128 });
  });

  test('at its smallest portrait size (96 tall) the legend is 16 pt and the number 44 pt', async () => {
    await render(<SpeedSign limit={65} palette={p} units="mi" height={96} />);
    expect(screen.getByText('LIMIT')).toHaveStyle({ fontSize: 16 });
    expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 44, lineHeight: 53, top: 38 });
  });

  test('unknown: SPEED LIMIT - at the full number size, its dash where the digits are centred', async () => {
    await render(<SpeedSign limit={null} palette={p} units="mi" height={112} />);
    expect(screen.getByTestId('hud-limit-words')).toBeTruthy();
    const v = screen.getByTestId('hud-limit-value');
    expect(v).toHaveTextContent('-');
    // the hyphen's ink sits lower in its line than the digits', so its line starts 3 pt higher
    expect(v).toHaveStyle({ fontSize: 52, top: 40 });
    expect(signMetrics('mi', 112, '35').numeralTop).toBe(43);
    expect(screen.getByLabelText('Speed limit unknown')).toBeTruthy();
  });

  test('the iPhone 15 sign (112 tall): "SPEED" 6 pt under the border, the digits 12 pt under "LIMIT" and 13 pt over the border', () => {
    const m = signMetrics('mi', 112, '35');
    expect(m).toMatchObject({ width: 90, height: 112, edge: 2, legendPt: 19, legendLine: 23, legendTops: [4, 27], numeralPt: 52, numeralFullPt: 52, numeralLine: 63, numeralTop: 43, textLeft: 8, textW: 74 });
    const inner = SIGN_BORDER_INSET_PT + m.edge;
    const capTop = baseline(m.legendTops[0]!, m.legendPt, m.legendLine) - 0.7 * m.legendPt;
    expect(capTop - inner).toBeCloseTo(5.8, 6);
    const ink = numberInk(m, '35');
    const limitFoot = baseline(m.legendTops[1]!, m.legendPt, m.legendLine);
    expect(ink.top - limitFoot).toBeCloseTo(12.1, 1);
    expect(112 - inner - ink.bottom).toBeCloseTo(12.7, 1);
  });
});

describe('kilometres: the round sign', () => {
  test('the number in a red ring on the white face, no words; "120" shrinks to fit inside the ring', async () => {
    await render(<SpeedSign limit={120} palette={p} units="km" height={114} />);
    expect(screen.queryByTestId('hud-limit-words')).toBeNull();
    const v = screen.getByTestId('hud-limit-value');
    expect(v).toHaveTextContent('120');
    expect(v.props.adjustsFontSizeToFit).toBeUndefined();
    expect(v.props.numberOfLines).toBe(1);
    // full size is 46; three digits come down to 43 so their corners clear the ring by 7 pt
    expect(v).toHaveStyle({ fontSize: 43, lineHeight: 52 });
    // placed from inside the 10 pt ring: the line's top 29 and the box's left 14 on the face
    expect(v).toHaveStyle({ top: 29 - 10, left: 14 - 10, width: 86, height: 54 });
    expect(screen.getByTestId('hud-limit')).toHaveStyle({ width: 114, height: 114, borderRadius: 57, backgroundColor: p.signFace, borderColor: p.signRing, borderWidth: 10 });
    expect(signSize('km', 114)).toEqual({ width: 114, height: 114 });
  });

  test('two digits at the full size, centred on the face', async () => {
    await render(<SpeedSign limit={50} palette={p} units="km" height={112} />);
    expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 45, lineHeight: 54, top: 27 - 10 });
    expect(Math.abs(numberInk(signMetrics('km', 112, '50'), '50').centre - 56)).toBeLessThanOrEqual(0.5);
  });

  test('unknown: "-"', async () => {
    await render(<SpeedSign limit={null} palette={p} units="km" height={100} />);
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('-');
    expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 40 });
    expect(screen.getByLabelText('Speed limit unknown')).toBeTruthy();
  });
});

test('a sign graphic: no Dynamic Type and no self-scaling print (adjustsFontSizeToFit, minimumFontScale) in either sign, known or not', async () => {
  for (const units of ['mi', 'km'] as const)
    for (const limit of [5, 35, 120, null]) {
      const r = await render(<SpeedSign limit={limit} palette={p} units={units} height={112} />);
      const texts = allTexts(r.root);
      expect(texts.length).toBe(units === 'mi' ? 3 : 1);
      for (const t of texts) {
        expect(t.props.allowFontScaling).toBe(false);
        expect(t.props.adjustsFontSizeToFit).toBeUndefined();
        expect(t.props.minimumFontScale).toBeUndefined();
        expect(t.props.numberOfLines).toBe(1);
      }
      await r.unmount();
    }
});

describe('the computed sizes (pt) for one, two and three digits and "-"', () => {
  test.each([
    // miles: H, then 5, 35, -, 100
    ['mi', 64, [29, 29, 29, 20]],
    ['mi', 88, [40, 40, 40, 31]],
    ['mi', 96, [44, 44, 44, 35]],
    ['mi', 112, [52, 52, 52, 43]],
    ['mi', 117, [54, 54, 54, 45]],
    ['mi', 128, [59, 59, 59, 49]],
    ['mi', 144, [66, 66, 66, 57]],
    // kilometres: D, then 5, 50, -, 120
    ['km', 64, [26, 26, 26, 23]],
    ['km', 88, [35, 35, 35, 33]],
    ['km', 96, [38, 38, 38, 35]],
    ['km', 112, [45, 45, 45, 42]],
    ['km', 114, [46, 46, 46, 43]],
    ['km', 116, [46, 46, 46, 44]],
  ] as const)('%s %p', (units, height, sizes) => {
    const values = units === 'mi' ? ['5', '35', '-', '100'] : ['5', '50', '-', '120'];
    expect(values.map((v) => signMetrics(units, height, v).numeralPt)).toEqual(sizes);
  });
});

describe('invariants for every sign the driving screen can lay out (64 to 144 tall)', () => {
  const values = ['1', '5', '35', '88', '-', '100', '120', '888'];
  const all: { units: 'mi' | 'km'; h: number; v: string; m: SignMetrics }[] = [];
  for (let h = 64; h <= 144; h += 1) for (const units of ['mi', 'km'] as const) for (const v of values) all.push({ units, h, v, m: signMetrics(units, h, v) });

  test('every size, line, top and box is a whole number of points, the boxes inside the face', () => {
    for (const { units, h, v, m } of all) {
      const at = `${units} ${h} "${v}"`;
      const whole = [m.width, m.height, m.edge, m.legendPt, m.legendLine, ...m.legendTops, m.numeralPt, m.numeralLine, m.numeralTop, m.textLeft, m.textW];
      for (const n of whole) if (!Number.isInteger(n)) throw new Error(`${n} is not whole at ${at}`);
      expect(m.textLeft).toBeGreaterThanOrEqual(0);
      expect(m.textLeft + m.textW).toBeLessThanOrEqual(m.width);
      // centred across the face
      expect(m.textLeft * 2 + m.textW).toBe(m.width);
      for (const top of [...m.legendTops, m.numeralTop]) expect(top).toBeGreaterThanOrEqual(0);
      if (m.numeralTop + m.numeralLine + TEXT_SLACK_PT > m.height) throw new Error(`the number's box leaves the face at ${at}`);
      // each line is at least the face's own 1.2 em, so the glyphs sit where the arithmetic says
      expect(m.numeralLine).toBeGreaterThanOrEqual(1.2 * m.numeralPt - 1e-9);
      expect(m.numeralLine).toBeLessThan(1.2 * m.numeralPt + 1);
      expect(m.legendLine).toBeGreaterThanOrEqual(1.2 * m.legendPt - 1e-9);
      expect(m.legendLine).toBeLessThan(1.2 * m.legendPt + 1);
    }
  });

  test('the string always fits its box at the size chosen; one and two digits and "-" always get the full size', () => {
    for (const { units, h, v, m } of all) {
      if (numeralWidthEm(v) * m.numeralPt > m.textW) throw new Error(`"${v}" overflows at ${units} ${h}`);
      if (v.length <= 2) expect(m.numeralPt).toBe(m.numeralFullPt);
      else expect(m.numeralPt).toBeLessThanOrEqual(m.numeralFullPt);
      expect(m.numeralPt).toBeGreaterThanOrEqual(units === 'mi' ? 20 : 23);
    }
  });

  test('the number’s ink is centred in its space (within half a point; the hyphen too)', () => {
    for (const { units, h, v, m } of all) {
      const mid = units === 'km' ? m.height / 2 : (m.region.top + m.region.bottom) / 2;
      const off = numberInk(m, v).centre - mid;
      if (Math.abs(off) > 0.5 + 1e-9) throw new Error(`"${v}" is ${off} pt off centre at ${units} ${h}`);
    }
  });

  test('miles: "SPEED" about 5% of the height (3 pt at least) under the border, the number’s ink 4% of the height (3 pt at least) clear of "LIMIT" and the border, the legend inside its box', () => {
    for (const { units, h, v, m } of all) {
      if (units !== 'mi') continue;
      const inner = SIGN_BORDER_INSET_PT + m.edge;
      const capTop = baseline(m.legendTops[0]!, m.legendPt, m.legendLine) - 0.7 * m.legendPt;
      expect(capTop - inner).toBeGreaterThanOrEqual(3 - 0.5);
      const minGap = Math.max(3, Math.round(0.04 * h));
      // the two legend lines stack without meeting
      expect(m.legendTops[1]).toBe(m.legendTops[0]! + m.legendLine);
      expect(m.region.top).toBeCloseTo(baseline(m.legendTops[1]!, m.legendPt, m.legendLine), 9);
      expect(m.region.bottom).toBe(h - inner);
      const ink = numberInk(m, v);
      if (ink.top - m.region.top < minGap || m.region.bottom - ink.bottom < minGap) throw new Error(`the digits crowd the legend or the border at ${h} "${v}"`);
      for (const word of ['SPEED', 'LIMIT']) expect(legendWidth(word, m.legendPt)).toBeLessThanOrEqual(m.textW);
    }
  });

  test('kilometres: the ink’s corners stay inside the ring, 6% of the diameter (4 pt at least) clear of it', () => {
    for (const { units, h, v, m } of all) {
      if (units !== 'km') continue;
      const ri = h / 2 - m.edge;
      const halfW = (numeralWidthEm(v) * m.numeralPt) / 2;
      const ink = numberInk(m, v);
      const far = Math.max(Math.abs(ink.top - h / 2), Math.abs(ink.bottom - h / 2));
      const corner = Math.hypot(halfW, far);
      if (ri - corner < Math.max(4, Math.round(0.06 * h)) - 1e-9) throw new Error(`"${v}" reaches the ring at ${h}: ${ri - corner} pt`);
    }
  });

  test('rendered: every Text in the sign has whole-point sizes and positions, its frame a whole number of points taller than its line', async () => {
    for (const units of ['mi', 'km'] as const)
      for (const h of [64, 88, 96, 101, 112, 117, 129, 144])
        for (const limit of [7, 45, 110, null]) {
          const r = await render(<SpeedSign limit={limit} palette={p} units={units} height={h} />);
          for (const t of allTexts(r.root)) {
            const s = flat(t);
            for (const k of ['fontSize', 'lineHeight', 'top', 'left', 'width', 'height'] as const) {
              const n = s[k];
              if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error(`${k} ${String(n)} at ${units} ${h} ${String(limit)}`);
            }
            expect(s.height).toBe(s.lineHeight! + TEXT_SLACK_PT);
          }
          await r.unmount();
        }
  });
});

test('a nonsense height never throws and still prints', () => {
  for (const h of [0, -5, Number.NaN, 0.4, 1e6]) for (const units of ['mi', 'km'] as const) expect(signMetrics(units, h, '35').numeralPt).toBeGreaterThanOrEqual(1);
  expect(signMetrics('mi', 112, '').numeralPt).toBe(52);
});
