// The speed-limit sign (drive-screen design §3.4): the US R2-1 "SPEED LIMIT" rectangle in miles, the
// round red-ringed sign in kilometres, "-" when the limit is unknown, never Dynamic Type.
import { render, screen } from '@testing-library/react-native';

import { HUD } from '@/ui/drive/hudTokens';
import { signMetrics, signSize, SpeedSign } from '@/ui/drive/SpeedSign';

const p = HUD.day;

describe('miles: the R2-1 rectangle', () => {
  test('SPEED / LIMIT over the number, black on the white face with a black border, 0.8 wide', async () => {
    await render(<SpeedSign limit={35} palette={p} units="mi" height={128} />);
    expect(screen.getByTestId('hud-limit-words')).toHaveTextContent('SPEEDLIMIT');
    expect(screen.getByText('SPEED')).toHaveStyle({ fontSize: 21, color: p.signInk });
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('35');
    expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 59, color: p.signInk });
    expect(screen.getByTestId('hud-limit')).toHaveStyle({ width: 102, height: 128, backgroundColor: p.signFace });
    expect(screen.getByTestId('hud-limit-border')).toHaveStyle({ borderColor: p.signInk });
    expect(screen.getByLabelText('Speed limit 35')).toBeTruthy();
    expect(signSize('mi', 128)).toEqual({ width: 102, height: 128 });
  });

  test('at its smallest (96 tall) the legend is at least 16 pt and the number at least 44 pt', async () => {
    await render(<SpeedSign limit={65} palette={p} units="mi" height={96} />);
    expect(screen.getByText('LIMIT')).toHaveStyle({ fontSize: 16 });
    expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 44 });
  });

  test('unknown: SPEED LIMIT -', async () => {
    await render(<SpeedSign limit={null} palette={p} units="mi" height={120} />);
    expect(screen.getByTestId('hud-limit-words')).toBeTruthy();
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('-');
    expect(screen.getByLabelText('Speed limit unknown')).toBeTruthy();
  });
});

describe('kilometres: the round sign', () => {
  test('the number in a red ring on the white face, no words; "120" shrinks to fit if it must', async () => {
    await render(<SpeedSign limit={120} palette={p} units="km" height={114} />);
    expect(screen.queryByTestId('hud-limit-words')).toBeNull();
    const v = screen.getByTestId('hud-limit-value');
    expect(v).toHaveTextContent('120');
    expect(v.props.adjustsFontSizeToFit).toBe(true);
    expect(v.props.numberOfLines).toBe(1);
    expect(v).toHaveStyle({ fontSize: 46 });
    expect(screen.getByTestId('hud-limit')).toHaveStyle({ width: 114, height: 114, borderRadius: 57, backgroundColor: p.signFace, borderColor: p.signRing, borderWidth: 10 });
    expect(signSize('km', 114)).toEqual({ width: 114, height: 114 });
  });

  test('unknown: "-"', async () => {
    await render(<SpeedSign limit={null} palette={p} units="km" height={100} />);
    expect(screen.getByTestId('hud-limit-value')).toHaveTextContent('-');
    expect(screen.getByLabelText('Speed limit unknown')).toBeTruthy();
  });
});

test('a sign graphic: no Dynamic Type on any of its print', async () => {
  await render(<SpeedSign limit={50} palette={p} units="mi" height={128} />);
  for (const t of [screen.getByText('SPEED'), screen.getByText('LIMIT'), screen.getByTestId('hud-limit-value')]) expect(t.props.allowFontScaling).toBe(false);
});

test('the print is drawn from signMetrics: at the 112 pt top row the R2-1 holds 105 pt of print, the number 52 pt in a 74 pt line', async () => {
  const m = signMetrics('mi', 112);
  expect(m).toMatchObject({ legendPt: 19, numeralPt: 52, numeralLine: 55, textW: 74, contentH: 105, room: 112 });
  await render(<SpeedSign limit={35} palette={p} units="mi" height={112} />);
  expect(screen.getByTestId('hud-limit-value')).toHaveStyle({ fontSize: 52, lineHeight: 55, width: 74 });
  const k = signMetrics('km', 112);
  expect(k).toMatchObject({ numeralPt: 45, numeralLine: 50, textW: 84, contentH: 50, room: 92 });
});
