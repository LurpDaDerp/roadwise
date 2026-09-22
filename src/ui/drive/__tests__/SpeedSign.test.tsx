import { CONSTANTS } from '@scoring';
import { render, screen } from '@testing-library/react-native';
import type { TextStyle, ViewStyle } from 'react-native';

import type { LimitSample } from '@/core/engine/types';
import { SpeedSign, speedSignPropsEqual } from '@/ui/drive/SpeedSign';
import { HUD, SIGN_NUMERAL_PT } from '@/ui/drive/hudTokens';

const mockFontScale = jest.fn(() => 1);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({
    width: 390,
    height: 844,
    scale: 3,
    fontScale: mockFontScale(),
  }),
}));

const MPH = CONSTANTS.MPH;
const lim = (mph: number, extra: Partial<LimitSample> = {}): LimitSample => ({
  limitMps: mph * MPH,
  source: 'posted',
  matchConfidence: 0.92,
  parallelRoads: false,
  ...extra,
});
const flat = <T,>(style: unknown): T => Object.assign({}, ...[style].flat(Infinity));
const value = () => screen.getByTestId('hud-limit-value');
const sign = () => screen.getByTestId('hud-limit');

test('a confident limit shows on a sign drivers already know', async () => {
  await render(<SpeedSign limit={lim(35)} speedKnown night={false} />);
  expect(value()).toHaveTextContent('35');
  expect(screen.getByText('SPEED')).toBeOnTheScreen();
  expect(screen.getByText('LIMIT')).toBeOnTheScreen();
  expect(sign()).toHaveProp('accessibilityLabel', 'Speed limit 35 miles per hour');
});

test('a motorway-exit ramp match at 0.65 shows "—", not the ramp\'s 35', async () => {
  await render(<SpeedSign limit={lim(35, { matchConfidence: 0.65 })} speedKnown night={false} />);
  expect(value()).toHaveTextContent('—');
  expect(screen.queryByText('35')).toBeNull();
  expect(sign()).toHaveProp('accessibilityLabel', 'Speed limit unknown');
});

test('an unknown limit shows "—" and announces it as unknown', async () => {
  await render(
    <SpeedSign
      limit={{
        limitMps: null,
        source: 'unknown',
        matchConfidence: 0,
        parallelRoads: false,
      }}
      speedKnown
      night={false}
    />
  );
  expect(value()).toHaveTextContent('—');
  expect(sign()).toHaveProp('accessibilityLabel', 'Speed limit unknown');
});

test('a null limit shows "—"', async () => {
  await render(<SpeedSign limit={null} speedKnown night={false} />);
  expect(value()).toHaveTextContent('—');
});

test('through a GPS dropout the last road\'s limit is stale and shows "—"', async () => {
  await render(<SpeedSign limit={lim(60)} speedKnown={false} night={false} />);
  expect(value()).toHaveTextContent('—');
  expect(screen.queryByText('60')).toBeNull();
});

test('the sign keeps its shape when the limit is unknown: same face, same size', async () => {
  const { rerender } = await render(<SpeedSign limit={lim(35)} speedKnown night={false} />);
  const known = flat<ViewStyle>(sign().props.style);
  await rerender(<SpeedSign limit={null} speedKnown night={false} />);
  const unknown = flat<ViewStyle>(sign().props.style);
  expect(unknown.width).toBe(known.width);
  expect(unknown.height).toBe(known.height);
  expect(unknown.backgroundColor).toBe(HUD.day.signFace);
});

test('night mode dims the sign face below pure white and keeps the ink legible', async () => {
  await render(<SpeedSign limit={lim(35)} speedKnown night />);
  expect(flat<ViewStyle>(sign().props.style).backgroundColor).toBe(HUD.night.signFace);
  expect(flat<TextStyle>(value().props.style).color).toBe(HUD.night.signInk);
});

test.each([0.8, 1, 2, 3.1])('the limit numeral holds its size at font scale %s', async (s) => {
  mockFontScale.mockReturnValue(s);
  await render(<SpeedSign limit={lim(35)} speedKnown night={false} />);
  expect(flat<TextStyle>(value().props.style).fontSize).toBe(SIGN_NUMERAL_PT);
  expect(value()).toHaveProp('allowFontScaling', false);
});

test('memoised on what the sign displays, not on the limit object', () => {
  const base = { limit: lim(35), speedKnown: true, night: false };
  expect(speedSignPropsEqual(base, { ...base, limit: lim(35) })).toBe(true);
  expect(
    speedSignPropsEqual(
      { ...base, limit: lim(35, { matchConfidence: 0.6 }) },
      { ...base, limit: null }
    )
  ).toBe(true);
  expect(speedSignPropsEqual(base, { ...base, limit: lim(45) })).toBe(false);
  expect(speedSignPropsEqual(base, { ...base, speedKnown: false })).toBe(false);
  expect(speedSignPropsEqual(base, { ...base, night: true })).toBe(false);
});
