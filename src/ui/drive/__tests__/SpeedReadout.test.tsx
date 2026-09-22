import { CONSTANTS } from '@scoring';
import { render, screen } from '@testing-library/react-native';
import type { TextStyle, ViewStyle } from 'react-native';

import type { LimitSample } from '@/core/engine/types';
import { SpeedReadout, speedReadoutPropsEqual } from '@/ui/drive/SpeedReadout';
import { HUD, SPEED_NUMERAL_PT } from '@/ui/drive/hudTokens';
import { fontFamilies } from '@/ui/fonts';

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
const L35: LimitSample = {
  limitMps: 35 * MPH,
  source: 'posted',
  matchConfidence: 0.95,
  parallelRoads: false,
};
const RAMP35: LimitSample = { ...L35, matchConfidence: 0.65 };

const flat = <T,>(style: unknown): T => Object.assign({}, ...[style].flat(Infinity));
const numeral = () => screen.getByTestId('hud-speed-numeral');
const frame = () => flat<ViewStyle>(screen.getByTestId('hud-speed').props.style);

beforeEach(() => mockFontScale.mockReturnValue(1));

test('a known speed shows its rounded mph and says so', async () => {
  await render(<SpeedReadout speedMps={38.4 * MPH} speedKnown limit={L35} night={false} />);
  expect(numeral()).toHaveTextContent('38');
  expect(screen.getByTestId('hud-speed')).toHaveProp(
    'accessibilityLabel',
    'Speed 38 miles per hour'
  );
});

test('an unknown speed shows "—" and announces it as unknown, never 0', async () => {
  await render(<SpeedReadout speedMps={0} speedKnown={false} limit={L35} night={false} />);
  expect(numeral()).toHaveTextContent('—');
  expect(screen.queryByText('0')).toBeNull();
  expect(screen.getByTestId('hud-speed')).toHaveProp('accessibilityLabel', 'Speed unknown');
});

test('an unknown speed never shows the stale number the snapshot still carries', async () => {
  await render(<SpeedReadout speedMps={27} speedKnown={false} limit={L35} night={false} />);
  expect(numeral()).toHaveTextContent('—');
  expect(screen.queryByText('60')).toBeNull();
});

test('speeding past tolerance changes the border weight and adds an icon, not only the colour', async () => {
  const { rerender } = await render(
    <SpeedReadout speedMps={36 * MPH} speedKnown limit={L35} night={false} />
  );
  const calm = frame();
  expect(screen.queryByTestId('hud-speeding-icon')).toBeNull();

  await rerender(<SpeedReadout speedMps={45 * MPH} speedKnown limit={L35} night={false} />);
  const fast = frame();
  expect(fast.borderWidth).toBeGreaterThan(calm.borderWidth ?? 0);
  expect(fast.borderColor).toBe(HUD.day.speeding);
  expect(screen.getByTestId('hud-speeding-icon')).toBeOnTheScreen();
  expect(flat<TextStyle>(numeral().props.style).color).toBe(HUD.day.speeding);
  expect(screen.getByTestId('hud-speed')).toHaveProp(
    'accessibilityLabel',
    'Speed 45 miles per hour, over the limit'
  );
});

test('the frame keeps its outer size when the border thickens, so nothing jumps at 1 Hz', async () => {
  const { rerender } = await render(
    <SpeedReadout speedMps={30 * MPH} speedKnown limit={L35} night={false} />
  );
  const calm = frame();
  await rerender(<SpeedReadout speedMps={50 * MPH} speedKnown limit={L35} night={false} />);
  const fast = frame();
  expect((calm.borderWidth ?? 0) + Number(calm.padding)).toBe(
    (fast.borderWidth ?? 0) + Number(fast.padding)
  );
});

test('no speeding treatment against a limit the sign would not show', async () => {
  await render(<SpeedReadout speedMps={60 * MPH} speedKnown limit={RAMP35} night={false} />);
  expect(screen.queryByTestId('hud-speeding-icon')).toBeNull();
});

test('no speeding treatment on an unknown speed', async () => {
  await render(<SpeedReadout speedMps={60 * MPH} speedKnown={false} limit={L35} night={false} />);
  expect(screen.queryByTestId('hud-speeding-icon')).toBeNull();
});

test.each([0.8, 1, 1.35, 2, 3.1])(
  'the numerals stay at least 96 pt, tabular, in the HUD face at font scale %s',
  async (scale) => {
    mockFontScale.mockReturnValue(scale);
    await render(<SpeedReadout speedMps={62 * MPH} speedKnown limit={L35} night={false} />);
    const s = flat<TextStyle>(numeral().props.style);
    expect(SPEED_NUMERAL_PT).toBeGreaterThanOrEqual(96);
    expect(s.fontSize).toBe(SPEED_NUMERAL_PT);
    expect(s.fontFamily).toBe(fontFamilies.numeralsBold);
    expect(s.fontVariant).toContain('tabular-nums');
    expect(numeral()).toHaveProp('allowFontScaling', false);
  }
);

test('the unit label follows Dynamic Type up to 2x and never shrinks below its size', async () => {
  mockFontScale.mockReturnValue(0.8);
  const { rerender } = await render(
    <SpeedReadout speedMps={62 * MPH} speedKnown limit={L35} night={false} />
  );
  const small = flat<TextStyle>(screen.getByText('mph').props.style).fontSize!;
  mockFontScale.mockReturnValue(3);
  await rerender(<SpeedReadout speedMps={63 * MPH} speedKnown limit={L35} night={false} />);
  const big = flat<TextStyle>(screen.getByText('mph').props.style).fontSize!;
  expect(big).toBe(small * 2);
});

test('night mode uses the night ink, never pure white', async () => {
  await render(<SpeedReadout speedMps={40 * MPH} speedKnown limit={L35} night />);
  expect(flat<TextStyle>(numeral().props.style).color).toBe(HUD.night.ink);
});

test('the readout is silent to a screen reader: no live region speaking every second', async () => {
  await render(<SpeedReadout speedMps={40 * MPH} speedKnown limit={L35} night={false} />);
  expect(screen.getByTestId('hud-speed').props.accessibilityLiveRegion).toBeUndefined();
});

test('a new snapshot with the same displayed values does not re-render the readout', () => {
  const base = {
    speedMps: 30 * MPH,
    speedKnown: true,
    limit: L35,
    night: false,
  };
  expect((SpeedReadout as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  // same whole mph and a fresh but equal limit object: skipped
  expect(
    speedReadoutPropsEqual(base, {
      ...base,
      speedMps: 30.1 * MPH,
      limit: { ...L35 },
    })
  ).toBe(true);
  // an unknown speed is "—" whatever number the snapshot carries
  expect(
    speedReadoutPropsEqual(
      { ...base, speedKnown: false, speedMps: 0 },
      { ...base, speedKnown: false, speedMps: 20 }
    )
  ).toBe(true);
  expect(speedReadoutPropsEqual(base, { ...base, speedMps: 31 * MPH })).toBe(false);
  expect(speedReadoutPropsEqual(base, { ...base, speedMps: 45 * MPH })).toBe(false);
  expect(speedReadoutPropsEqual(base, { ...base, speedKnown: false })).toBe(false);
  expect(speedReadoutPropsEqual(base, { ...base, night: true })).toBe(false);
});
