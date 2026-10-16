import { render, screen } from '@testing-library/react-native';

import { HUD } from '@/ui/drive/hudTokens';
import { numeralLineHeight, numeralShift, SpeedReadout, unitTop } from '@/ui/drive/SpeedReadout';
import { SpeedSign } from '@/ui/drive/SpeedSign';

const p = HUD.day;

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
    expect(screen.getByTestId('hud-speed')).toHaveStyle({ height: 180 });
    expect(screen.getByTestId('hud-speed-numeral')).toHaveStyle({ fontSize: 150, lineHeight: 180, transform: [{ translateY: numeralShift(150) }] });
    // box centre 90, digits' half-height 53.55, 6 pt clear
    expect(unitTop(150)).toBeCloseTo(149.55, 6);
    expect(numeralLineHeight(97)).toBe(116);
  });

  test('unknown speed is "—", never 0', async () => {
    await render(<SpeedReadout speed={null} color={p.ink} unitColor={p.inkMuted} size={120} />);
    expect(screen.getByTestId('hud-speed-numeral')).toHaveTextContent('—');
    expect(screen.getByLabelText('Speed unknown')).toBeTruthy();
  });
});

describe('SpeedSign', () => {
  test('prints the limit on a round sign', async () => {
    await render(<SpeedSign limit={35} palette={p} />);
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    expect(screen.getByLabelText('Speed limit 35')).toBeTruthy();
    expect(screen.getByTestId('hud-limit')).toHaveStyle({ backgroundColor: p.signFace, borderColor: p.signRing });
  });

  test('an unknown limit keeps the sign and prints "—"', async () => {
    await render(<SpeedSign limit={null} palette={p} />);
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('—');
    expect(screen.getByLabelText('Speed limit unknown')).toBeTruthy();
  });
});
