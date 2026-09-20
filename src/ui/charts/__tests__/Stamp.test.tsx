import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';

import { Stamp } from '@/ui/charts/Stamp';
import { tokens } from '@/ui/tokens';

// Reduce motion has to be known at the first render for "renders the final state immediately" to
// mean anything, so the theme is stubbed rather than waiting on the provider's async read.
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

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

beforeEach(() => mockReduceMotion.mockReturnValue(false));

const styleOf = (testID: string): ViewStyle =>
  StyleSheet.flatten(screen.getByTestId(testID).props.style as ViewStyle);

test.each([
  ['provisional', 'PROVISIONAL', 'Provisional'],
  ['safeDay', 'SAFE DAY', 'Safe day'],
  ['passenger', 'PASSENGER', 'Passenger'],
  ['disputed', 'DISPUTED', 'Disputed'],
] as const)('%s prints its word and speaks it in sentence case', async (kind, printed, spoken) => {
  await render(<Stamp kind={kind} testID="stamp" />);
  expect(screen.getByText(printed)).toBeOnTheScreen();
  expect(screen.getByTestId('stamp').props.accessibilityLabel).toBe(spoken);
  expect(screen.getByTestId('stamp').props.accessibilityRole).toBe('text');
});

test('a grade stamp prints the letter over its caption', async () => {
  await render(<Stamp kind="B" testID="stamp" />);
  expect(screen.getByText('B')).toBeOnTheScreen();
  expect(screen.getByText('DATA QUALITY')).toBeOnTheScreen();
  expect(screen.getByTestId('stamp').props.accessibilityLabel).toBe('Data quality B');
});

test('label overrides the word on a state stamp and the caption on a grade stamp', async () => {
  await render(
    <>
      <Stamp kind="provisional" label="Pending sync" testID="state" />
      <Stamp kind="C" label="GPS gaps" testID="grade" />
    </>
  );
  expect(screen.getByText('Pending sync')).toBeOnTheScreen();
  expect(screen.getByTestId('state').props.accessibilityLabel).toBe('Pending sync');
  expect(screen.getByText('GPS gaps')).toBeOnTheScreen();
  expect(screen.getByTestId('grade').props.accessibilityLabel).toBe('Data quality C, GPS gaps');
});

test('a state stamp is inked in stamp magenta, a grade stamp in ID blue', async () => {
  await render(
    <>
      <Stamp kind="safeDay" testID="state" />
      <Stamp kind="A" testID="grade" />
    </>
  );
  expect(styleOf('state').borderColor).toBe(tokens.color.light.stamp);
  expect(styleOf('grade').borderColor).toBe(tokens.color.light.accent);
});

test('with motion allowed the stamp mounts mid-slam: 1.15× and six degrees off its resting angle', async () => {
  await render(<Stamp kind="safeDay" testID="stamp" />);
  const s = styleOf('stamp');
  expect(s.opacity).toBe(0);
  expect(s.transform).toEqual([{ rotate: '-14deg' }, { scale: 1.15 }]);
});

test('with reduce motion on the stamp is at rest immediately: -8 degrees, full size, opaque', async () => {
  mockReduceMotion.mockReturnValue(true);
  await render(<Stamp kind="safeDay" testID="stamp" />);
  const s = styleOf('stamp');
  expect(s.transform).toEqual([{ rotate: '-8deg' }]);
  expect(s.opacity ?? 1).toBe(1);
});
