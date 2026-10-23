import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';

import { HUD } from '@/ui/drive/hudTokens';
import {
  DASH_CENTRE_EM,
  DIGIT_CENTRE_EM,
  NUMERAL_DIGIT_ADVANCE_EM,
  numeralAdvanceEm,
  numeralBoxWidth,
  numeralLineHeight,
  numeralShift,
  numeralWidthEm,
  sameShape,
  SPEED_FADE_MS,
  SpeedReadout,
  TEXT_SLACK_PT,
  unitTop,
} from '@/ui/drive/SpeedReadout';

const p = HUD.day;

type Flat = {
  fontSize?: number;
  lineHeight?: number;
  width?: number;
  height?: number;
  left?: number;
  opacity?: number;
  color?: string;
  transform?: { translateY: number }[];
};
const flat = (el: { props: { style?: unknown } }): Flat => StyleSheet.flatten(el.props.style as never) as Flat;
const digits = () => screen.getAllByTestId('hud-speed-digit');
const fading = () => screen.queryAllByTestId('hud-speed-digit-out');

describe('SpeedReadout', () => {
  test('prints whole mph in the given colour', async () => {
    await render(<SpeedReadout speed={34} color={p.minor} unitColor={p.inkMuted} size={120} speeding />);
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('34');
    for (const d of digits()) expect(d).toHaveStyle({ color: p.minor, fontSize: 120 });
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
    for (const d of digits()) expect(d).toHaveStyle({ color: '#FF0000' });
    expect(screen.getByLabelText('Speed 61 miles per hour, over the limit')).toBeTruthy();
    expect(screen.getByTestId('hud-speed-unit')).toHaveStyle({ color: p.haloInkMuted });
  });

  test('the box is the numerals alone, digits optically centred; the unit hangs under the digits', async () => {
    await render(<SpeedReadout speed={88} color={p.haloInk} unitColor={p.haloInkMuted} size={150} />);
    expect(numeralLineHeight(150)).toBe(180);
    expect(numeralShift(150)).toBeCloseTo(-6.45, 6);
    expect(screen.getByTestId('hud-speed')).toHaveStyle({ width: 174, height: 180 });
    // the row is the box wide, the line plus its slack tall, moved so the ink centres
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ width: 174, height: 182, transform: [{ translateY: numeralShift(150) }] });
    for (const d of digits()) expect(d).toHaveStyle({ fontSize: 150, lineHeight: 180, height: 182 });
    // box centre 90, digits' half-height 53.55, 6 pt clear
    expect(unitTop(150)).toBeCloseTo(149.55, 6);
    expect(numeralLineHeight(97)).toBe(116);
  });

  test('tabular: each digit in a cell of the face’s tabular advance, its Text the widest digit plus slack, centred on the cell', async () => {
    expect(NUMERAL_DIGIT_ADVANCE_EM).toBe(0.535);
    expect([numeralAdvanceEm('1'), numeralAdvanceEm('4'), numeralAdvanceEm('-')]).toEqual([0.535, 0.535, 0.376]);
    await render(<SpeedReadout speed={14} color={p.ink} unitColor={p.inkMuted} size={150} />);
    const cell = 0.535 * 150;
    for (const d of digits()) {
      // 85 + 4 wide: wider than any digit's drawing, centred over its 80.25 pt cell
      expect(flat(d).width).toBe(numeralBoxWidth('4', 150));
      expect(flat(d).left).toBeCloseTo((cell - numeralBoxWidth('4', 150)) / 2, 9);
    }
    // the cells together are narrower than the box, so the row centres them as one centred string would
    expect(2 * cell).toBeLessThan(numeralBoxWidth('14', 150));
  });

  test('unknown speed is "-", never 0, its dash centred where the digits are', async () => {
    await render(<SpeedReadout speed={null} color={p.ink} unitColor={p.inkMuted} size={120} />);
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('-');
    expect(screen.getByLabelText('Speed unknown')).toBeTruthy();
    // the hyphen's ink centre is 0.29 em over the baseline, the digits' 0.357: it moves up the difference
    expect(numeralShift(120, '-')).toBeCloseTo(-0.11 * 120, 6);
    expect(numeralShift(120, '-') - numeralShift(120, '88')).toBeCloseTo(-(DIGIT_CENTRE_EM - DASH_CENTRE_EM) * 120, 6);
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ width: 50, height: 146, transform: [{ translateY: numeralShift(120, '-') }] });
    expect(digits()[0]).toHaveStyle({ width: 50, height: 146 });
  });

  test('no self-scaling text (adjustsFontSizeToFit, minimumFontScale): the size is the layout’s, for one, two or three digits or "-"', async () => {
    for (const speed of [5, 42, 112, null]) {
      const r = await render(<SpeedReadout speed={speed} color={p.ink} unitColor={p.inkMuted} size={133} />);
      for (const el of [...digits(), screen.getByTestId('hud-speed-unit')]) {
        expect(el.props.adjustsFontSizeToFit).toBeUndefined();
        expect(el.props.minimumFontScale).toBeUndefined();
        expect(el.props.allowFontScaling).toBe(false);
        expect(el.props.numberOfLines).toBe(1);
      }
      expect(digits()).toHaveLength(speed === null ? 1 : String(speed).length);
      for (const d of digits()) expect(d).toHaveStyle({ fontSize: 133 });
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

  test('every Text frame it sets is a whole number of points, a whole number taller than its line (any size, any Dynamic Type)', async () => {
    for (const size of [48, 86, 97, 117, 135, 160, 168])
      for (const speed of [3, 64, 101, null]) {
        const r = await render(<SpeedReadout speed={speed} color={p.ink} unitColor={p.inkMuted} size={size} />);
        const box = flat(screen.getByTestId('hud-speed'));
        const row = flat(screen.getByTestId('hud-speed-numeral'));
        const u = flat(screen.getByTestId('hud-speed-unit'));
        const ds = digits().map(flat);
        for (const v of [box.width, box.height, row.width, row.height, u.height, u.lineHeight, ...ds.flatMap((d) => [d.width, d.height, d.lineHeight])])
          if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${String(v)} at ${size} ${String(speed)}`);
        for (const d of ds) expect(d.height).toBe(d.lineHeight! + TEXT_SLACK_PT);
        expect(u.height).toBe(u.lineHeight! + TEXT_SLACK_PT);
        expect(row.width).toBe(box.width);
        await r.unmount();
      }
  });
});

describe('SpeedReadout: a change crossfades, digit by digit', () => {
  const view = (speed: number | null, fade = true, size = 150) => <SpeedReadout speed={speed} color={p.ink} unitColor={p.inkMuted} size={size} fade={fade} />;

  test('only the digits that change fade: the old one out, the new one in, together over 200 ms; the rest never dim', async () => {
    expect(SPEED_FADE_MS).toBe(200);
    jest.useFakeTimers();
    try {
      const r = await render(view(34));
      // nothing fades at first
      expect(screen.queryByTestId('hud-speed-fading')).toBeNull();
      expect(digits().map((d) => flat(d).opacity)).toEqual([undefined, undefined]);
      await r.rerender(view(35));
      expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('35');
      // the tens stay as they were (no fade style); the units: "4" fading out under the "5" fading in
      expect(flat(digits()[0]!).opacity).toBeUndefined();
      expect(fading().map((d) => d.props.children)).toEqual(['4']);
      expect(flat(digits()[1]!).opacity).toBe(0);
      expect(flat(fading()[0]!).opacity).toBe(1);
      // the fading layer holds a still digit's place with an empty cell, so the "4" stands where it stood
      expect(screen.getByTestId('hud-speed-fading')).toHaveStyle(flat(screen.getByTestId('hud-speed-numeral')) as object);
      const opacity = (el: Parameters<typeof getAnimatedStyle>[0]) => (getAnimatedStyle(el) as { opacity?: number }).opacity ?? NaN;
      // halfway, both are partly there
      await act(() => jest.advanceTimersByTime(SPEED_FADE_MS / 2));
      expect(opacity(digits()[1]!)).toBeGreaterThan(0.2);
      expect(opacity(digits()[1]!)).toBeLessThan(0.8);
      expect(opacity(fading()[0]!)).toBeGreaterThan(0.2);
      expect(opacity(fading()[0]!)).toBeLessThan(0.8);
      await act(() => jest.advanceTimersByTime(SPEED_FADE_MS / 2 + 50));
      expect(opacity(digits()[1]!)).toBeCloseTo(1, 3);
      expect(opacity(fading()[0]!)).toBeCloseTo(0, 3);
      // two digits change at once: both fade
      await r.rerender(view(42));
      expect(fading().map((d) => d.props.children)).toEqual(['3', '5']);
      expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('42');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a change in the number of digits or to or from "-" swaps at once, and so does every change without fade (Reduce Motion)', async () => {
    const r = await render(view(99));
    await r.rerender(view(100, true, 120));
    expect(screen.queryByTestId('hud-speed-fading')).toBeNull();
    expect(digits().map((d) => flat(d).opacity)).toEqual([undefined, undefined, undefined]);
    await r.rerender(view(null, true, 120));
    expect(screen.queryByTestId('hud-speed-fading')).toBeNull();
    await r.rerender(view(7, true, 120));
    expect(screen.queryByTestId('hud-speed-fading')).toBeNull();
    const still = await render(view(34, false));
    await still.rerender(view(35, false));
    expect(screen.queryAllByTestId('hud-speed-fading')).toHaveLength(0);
    expect(screen.getAllByTestId('hud-speed-numeral').at(-1)).toHaveTextContent('35');
    expect(sameShape('34', '35')).toBe(true);
    expect(sameShape('99', '100')).toBe(false);
    expect(sameShape('-', '5')).toBe(false);
  });

  test('the readout renders once per new number: an unchanged speed re-renders nothing that fades', async () => {
    const r = await render(view(50));
    await r.rerender(view(51));
    const first = fading()[0];
    await r.rerender(view(51));
    expect(fading()[0]).toBe(first);
  });
});
