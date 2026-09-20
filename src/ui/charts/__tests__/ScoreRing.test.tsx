import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { ScoreRing } from '@/ui/charts/ScoreRing';

const mockReduceMotion = jest.fn(() => false);
jest.mock('../../theme', () => {
  const actual = jest.requireActual<typeof import('../../theme')>('../../theme');
  const { tokens: tk } = jest.requireActual<typeof import('../../tokens')>('../../tokens');
  return {
    ...actual,
    useTheme: () => ({
      scheme: 'light',
      colors: tk.color.light,
      hud: tk.color.hud,
      type: tk.type,
      space: tk.space,
      radius: tk.radius,
      motion: tk.motion,
      reduceMotion: mockReduceMotion(),
    }),
  };
});

const mockFontScale = jest.fn(() => 1);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: mockFontScale() }),
}));

beforeEach(() => {
  mockReduceMotion.mockReturnValue(false);
  mockFontScale.mockReturnValue(1);
});

const fontSizeOf = (text: string): number =>
  (StyleSheet.flatten(screen.getByText(text).props.style as TextStyle).fontSize ?? 0);

/** A 160 dp ring carries a 10 dp stroke, so the arc runs on a 75 dp radius. */
const CIRCUMFERENCE = 2 * Math.PI * 75;

test('speaks the score and its band, and prints the numeral as the largest text', async () => {
  await render(<ScoreRing score={74} band="getting_there" testID="ring" />);
  expect(screen.getByRole('image', { name: 'Score 74, Getting there' })).toBeOnTheScreen();
  expect(fontSizeOf('74')).toBeGreaterThanOrEqual(44);
  expect(fontSizeOf('74')).toBeGreaterThan(fontSizeOf('Getting there'));
});

test('a provisional score says so and carries the stamp', async () => {
  await render(<ScoreRing score={74} band="getting_there" provisional testID="ring" />);
  expect(
    screen.getByRole('image', { name: 'Score 74, Getting there, provisional' })
  ).toBeOnTheScreen();
  expect(screen.getByText('PROVISIONAL')).toBeOnTheScreen();
});

test('with motion allowed the arc mounts empty and draws in', async () => {
  await render(<ScoreRing score={74} band="getting_there" testID="ring" />);
  expect(screen.getByTestId('ring-arc').props.strokeDashoffset).toBeCloseTo(CIRCUMFERENCE, 3);
});

test('with reduce motion on the arc is drawn to the score immediately', async () => {
  mockReduceMotion.mockReturnValue(true);
  await render(<ScoreRing score={74} band="getting_there" testID="ring" />);
  expect(screen.getByTestId('ring-arc').props.strokeDashoffset).toBeCloseTo(
    CIRCUMFERENCE * 0.26,
    3
  );
});

test('a score of zero prints the number over the bare track', async () => {
  await render(<ScoreRing score={0} band="needs_focus" testID="ring" />);
  expect(screen.queryByTestId('ring-arc')).toBeNull();
  expect(screen.getByText('0')).toBeOnTheScreen();
});

test('the ring grows with Dynamic Type but stops at 1.5x; the band label keeps the full 2x', async () => {
  mockFontScale.mockReturnValue(2);
  await render(<ScoreRing score={74} band="getting_there" testID="ring" />);
  expect(screen.getByTestId('ring')).toHaveStyle({ width: 240, height: 240 });
  expect(fontSizeOf('74')).toBe(72);
  expect(fontSizeOf('Getting there')).toBe(30);
});
