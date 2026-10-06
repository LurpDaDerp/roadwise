import { render, screen } from '@testing-library/react-native';

import { HUD } from '@/ui/drive/hudTokens';
import { SpeedReadout } from '@/ui/drive/SpeedReadout';
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
