import { CONSTANTS } from '@scoring';
import { render, screen } from '@testing-library/react-native';
import type { TextStyle } from 'react-native';

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

const flat = <T,>(style: unknown): T => Object.assign({}, ...[style].flat(Infinity));
const numeral = () => screen.getByTestId('hud-speed-numeral');
const ink = () => flat<TextStyle>(numeral().props.style).color;

beforeEach(() => mockFontScale.mockReturnValue(1));

test('a known speed shows its rounded mph and says so', async () => {
  await render(
    <SpeedReadout speedMps={38.4 * MPH} speedKnown limit={L35} level="calm" night={false} />
  );
  expect(numeral()).toHaveTextContent('38');
  expect(screen.getByTestId('hud-speed')).toHaveProp(
    'accessibilityLabel',
    'Speed 38 miles per hour'
  );
});

test('an unknown speed shows "—" and announces it as unknown, never 0', async () => {
  await render(
    <SpeedReadout speedMps={0} speedKnown={false} limit={L35} level="calm" night={false} />
  );
  expect(numeral()).toHaveTextContent('—');
  expect(screen.queryByText('0')).toBeNull();
  expect(screen.getByTestId('hud-speed')).toHaveProp('accessibilityLabel', 'Speed unknown');
});

test('an unknown speed never shows the stale number the snapshot still carries', async () => {
  await render(
    <SpeedReadout speedMps={27} speedKnown={false} limit={L35} level="calm" night={false} />
  );
  expect(numeral()).toHaveTextContent('—');
  expect(screen.queryByText('60')).toBeNull();
});

test('the numerals take the halo level as colour: ink, then amber, then soft red', async () => {
  const { rerender } = await render(
    <SpeedReadout speedMps={36 * MPH} speedKnown limit={L35} level="calm" night={false} />
  );
  expect(ink()).toBe(HUD.day.ink);
  await rerender(
    <SpeedReadout speedMps={45 * MPH} speedKnown limit={L35} level="attention" night={false} />
  );
  expect(ink()).toBe(HUD.day.attention);
  expect(screen.getByTestId('hud-speed')).toHaveProp(
    'accessibilityLabel',
    'Speed 45 miles per hour, over the limit'
  );
  await rerender(
    <SpeedReadout speedMps={55 * MPH} speedKnown limit={L35} level="critical" night={false} />
  );
  expect(ink()).toBe(HUD.day.critical);
});

test('nothing flashes and nothing is added: the same one text node in every state', async () => {
  const { rerender } = await render(
    <SpeedReadout speedMps={36 * MPH} speedKnown limit={L35} level="calm" night={false} />
  );
  const calm = screen.getByTestId('hud-speed').children.length;
  await rerender(
    <SpeedReadout speedMps={55 * MPH} speedKnown limit={L35} level="critical" night={false} />
  );
  expect(screen.getByTestId('hud-speed').children.length).toBe(calm);
});

test('the spoken "over the limit" follows the limit gate, not the colour', async () => {
  await render(
    <SpeedReadout
      speedMps={60 * MPH}
      speedKnown
      limit={{ ...L35, matchConfidence: 0.65 }}
      level="attention"
      night={false}
    />
  );
  expect(screen.getByTestId('hud-speed')).toHaveProp(
    'accessibilityLabel',
    'Speed 60 miles per hour'
  );
});

test.each([0.8, 1, 1.35, 2, 3.1])(
  'the numerals stay at least 96 pt, tabular, in the HUD face at font scale %s',
  async (scale) => {
    mockFontScale.mockReturnValue(scale);
    await render(
      <SpeedReadout speedMps={62 * MPH} speedKnown limit={L35} level="calm" night={false} />
    );
    const s = flat<TextStyle>(numeral().props.style);
    expect(SPEED_NUMERAL_PT).toBeGreaterThanOrEqual(96);
    expect(s.fontSize).toBe(SPEED_NUMERAL_PT);
    expect(s.fontFamily).toBe(fontFamilies.numeralsBold);
    expect(s.fontVariant).toContain('tabular-nums');
    expect(numeral()).toHaveProp('allowFontScaling', false);
  }
);

test('the halo may size the numerals to its diameter', async () => {
  await render(
    <SpeedReadout
      speedMps={62 * MPH}
      speedKnown
      limit={L35}
      level="calm"
      night={false}
      size={120}
    />
  );
  const s = flat<TextStyle>(numeral().props.style);
  expect(s.fontSize).toBe(120);
  expect(s.lineHeight).toBe(132);
});

test('the unit label follows Dynamic Type up to 2x and never shrinks below its size', async () => {
  mockFontScale.mockReturnValue(0.8);
  const { rerender } = await render(
    <SpeedReadout speedMps={62 * MPH} speedKnown limit={L35} level="calm" night={false} />
  );
  const small = flat<TextStyle>(screen.getByText('mph').props.style).fontSize!;
  mockFontScale.mockReturnValue(3);
  await rerender(
    <SpeedReadout speedMps={63 * MPH} speedKnown limit={L35} level="calm" night={false} />
  );
  const big = flat<TextStyle>(screen.getByText('mph').props.style).fontSize!;
  expect(big).toBe(small * 2);
});

test('night mode uses the night ink, never pure white', async () => {
  await render(<SpeedReadout speedMps={40 * MPH} speedKnown limit={L35} level="calm" night />);
  expect(ink()).toBe(HUD.night.ink);
});

test('the readout is silent to a screen reader: no live region speaking every second', async () => {
  await render(
    <SpeedReadout speedMps={40 * MPH} speedKnown limit={L35} level="calm" night={false} />
  );
  expect(screen.getByTestId('hud-speed').props.accessibilityLiveRegion).toBeUndefined();
});

test('a new snapshot with the same displayed values does not re-render the readout', () => {
  const base = {
    speedMps: 30 * MPH,
    speedKnown: true,
    limit: L35,
    level: 'calm' as const,
    night: false,
    size: 104,
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
  expect(speedReadoutPropsEqual(base, { ...base, level: 'attention' })).toBe(false);
  expect(speedReadoutPropsEqual(base, { ...base, size: 96 })).toBe(false);
});
