import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { HUD } from '@/ui/drive/hudTokens';
import {
  DASH_CENTRE_EM,
  DIGIT_CENTRE_EM,
  numeralBoxWidth,
  numeralLineHeight,
  numeralShift,
  numeralWidthEm,
  SpeedReadout,
  TEXT_SLACK_PT,
  unitTop,
} from '@/ui/drive/SpeedReadout';

const p = HUD.day;

type Flat = { fontSize?: number; lineHeight?: number; width?: number; height?: number; transform?: { translateY: number }[] };
const flat = (el: { props: { style?: unknown } }): Flat => StyleSheet.flatten(el.props.style as never) as Flat;

describe('SpeedReadout', () => {
  test('prints whole mph in the given colour', async () => {
    await render(<SpeedReadout speed={34} color={p.minor} unitColor={p.inkMuted} size={120} speeding />);
    const n = screen.getByTestId('hud-speed-numeral');
    expect(n).toHaveTextContent('34');
    expect(n).toHaveStyle({ color: p.minor, fontSize: 120 });
    expect(screen.getByLabelText('Speed 34 miles per hour, over the limit')).toBeTruthy();
  });

  test('km/h prints and speaks its unit', async () => {
    await render(<SpeedReadout speed={56} unit="km/h" color={p.ink} unitColor={p.inkMuted} size={120} />);
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('56');
    expect(screen.getByText('km/h')).toBeTruthy();
    expect(screen.getByLabelText('Speed 56 kilometers per hour')).toBeTruthy();
  });

  test('the halo colour style drives the numerals; the spoken label is the same with or without it', async () => {
    await render(<SpeedReadout speed={61} color={p.haloInk} unitColor={p.haloInkMuted} size={150} numeralStyle={{ color: '#FF0000' }} speeding />);
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ color: '#FF0000' });
    expect(screen.getByLabelText('Speed 61 miles per hour, over the limit')).toBeTruthy();
    expect(screen.getByTestId('hud-speed-unit')).toHaveStyle({ color: p.haloInkMuted });
  });

  test('the box is the numerals alone, digits optically centred; the unit hangs under the digits', async () => {
    await render(<SpeedReadout speed={88} color={p.haloInk} unitColor={p.haloInkMuted} size={150} />);
    expect(numeralLineHeight(150)).toBe(180);
    expect(numeralShift(150)).toBeCloseTo(-6.45, 6);
    expect(screen.getByTestId('hud-speed')).toHaveStyle({ width: 174, height: 180 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ fontSize: 150, lineHeight: 180, width: 174, height: 182, transform: [{ translateY: numeralShift(150) }] });
    // box centre 90, digits' half-height 53.55, 6 pt clear
    expect(unitTop(150)).toBeCloseTo(149.55, 6);
    expect(numeralLineHeight(97)).toBe(116);
  });

  test('unknown speed is "-", never 0, its dash centred where the digits are', async () => {
    await render(<SpeedReadout speed={null} color={p.ink} unitColor={p.inkMuted} size={120} />);
    const n = screen.getByTestId('hud-speed-numeral');
    expect(n).toHaveTextContent('-');
    expect(screen.getByLabelText('Speed unknown')).toBeTruthy();
    // the hyphen's ink centre is 0.29 em over the baseline, the digits' 0.357: it moves up the difference
    expect(numeralShift(120, '-')).toBeCloseTo(-0.11 * 120, 6);
    expect(numeralShift(120, '-') - numeralShift(120, '88')).toBeCloseTo(-(DIGIT_CENTRE_EM - DASH_CENTRE_EM) * 120, 6);
    expect(n).toHaveStyle({ width: 50, height: 146, transform: [{ translateY: numeralShift(120, '-') }] });
  });

  test('no self-scaling text (adjustsFontSizeToFit, minimumFontScale): the size is the layout’s, for one, two or three digits or "-"', async () => {
    for (const speed of [5, 42, 112, null]) {
      const r = await render(<SpeedReadout speed={speed} color={p.ink} unitColor={p.inkMuted} size={133} />);
      for (const id of ['hud-speed-numeral', 'hud-speed-unit']) {
        const el = screen.getByTestId(id);
        expect(el.props.adjustsFontSizeToFit).toBeUndefined();
        expect(el.props.minimumFontScale).toBeUndefined();
        expect(el.props.allowFontScaling).toBe(false);
        expect(el.props.numberOfLines).toBe(1);
      }
      expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ fontSize: 133 });
      await r.unmount();
    }
  });

  test('the numerals’ box widths for 1, 2 and 3 digits and "-": the widest drawing of the string, rounded up, plus 2 pt a side', () => {
    expect(numeralWidthEm('5')).toBeCloseTo(0.566, 9);
    expect(numeralWidthEm('88')).toBeCloseTo(1.132, 9);
    expect(numeralWidthEm('120')).toBeCloseTo(1.698, 9);
    expect(numeralWidthEm('-')).toBeCloseTo(0.376, 9);
    expect([numeralBoxWidth('5', 150), numeralBoxWidth('88', 150), numeralBoxWidth('120', 117), numeralBoxWidth('-', 120)]).toEqual([89, 174, 203, 50]);
    // never narrower than the tabular digits (0.535 em) the face really draws
    for (const size of [48, 96, 117, 135, 160, 168]) {
      for (const s of ['7', '42', '105']) expect(numeralBoxWidth(s, size)).toBeGreaterThan(s.length * 0.535 * size);
      expect(numeralBoxWidth('-', size)).toBeGreaterThan(0.376 * size);
    }
  });

  test('every frame it sets is a whole number of points, a whole number taller than its line (any size, any Dynamic Type)', async () => {
    for (const size of [48, 86, 97, 117, 135, 160, 168])
      for (const speed of [3, 64, 101, null]) {
        const r = await render(<SpeedReadout speed={speed} color={p.ink} unitColor={p.inkMuted} size={size} />);
        const box = flat(screen.getByTestId('hud-speed'));
        const n = flat(screen.getByTestId('hud-speed-numeral'));
        const u = flat(screen.getByTestId('hud-speed-unit'));
        for (const v of [box.width, box.height, n.width, n.height, n.lineHeight, u.height, u.lineHeight])
          if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${String(v)} at ${size} ${String(speed)}`);
        expect(n.height).toBe(n.lineHeight! + TEXT_SLACK_PT);
        expect(u.height).toBe(u.lineHeight! + TEXT_SLACK_PT);
        expect(n.width).toBe(box.width);
        await r.unmount();
      }
  });
});
