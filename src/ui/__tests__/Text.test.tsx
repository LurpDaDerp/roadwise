import { render, screen } from '@testing-library/react-native';
import type { TextStyle } from 'react-native';

import { PointsCounter } from '@/ui/primitives/PointsCounter';
import { Text } from '@/ui/primitives/Text';
import { ThemeProvider } from '@/ui/theme';

const mockFontScale = jest.fn(() => 1);

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: mockFontScale() }),
}));

function styleOf(text: string): TextStyle {
  return Object.assign({}, ...[screen.getByText(text).props.style].flat());
}

test('renders a variant with its font size', async () => {
  await render(
    <ThemeProvider>
      <Text variant="title1">Hello</Text>
    </ThemeProvider>
  );
  expect(styleOf('Hello').fontSize).toBe(30);
});

test('follows Dynamic Type but caps the scale at 2.0', async () => {
  mockFontScale.mockReturnValue(3);
  await render(
    <ThemeProvider>
      <Text variant="title1">Hello</Text>
    </ThemeProvider>
  );
  const flat = styleOf('Hello');
  expect(flat.fontSize).toBe(60);
  expect(flat.lineHeight).toBe(68);
});

test('leaves fontWeight off a variant whose face is already weighted', async () => {
  await render(
    <ThemeProvider>
      <Text variant="title1">Printed</Text>
      <Text variant="body">Plain</Text>
    </ThemeProvider>
  );
  expect('fontWeight' in styleOf('Printed')).toBe(false);
  expect(styleOf('Plain').fontWeight).toBe('400');
});

test('big numerals stop scaling early so they still fit a phone at the largest text sizes', async () => {
  mockFontScale.mockReturnValue(3);
  await render(
    <ThemeProvider reduceMotion>
      <PointsCounter value={-1234} size="hero" unit="" />
      <Text variant="display">88</Text>
      <Text variant="stat">42</Text>
      <Text variant="body">Body</Text>
    </ThemeProvider>
  );
  expect(styleOf('−1,234').fontSize).toBeCloseTo(64 * 1.3);
  expect(styleOf('88').fontSize).toBeCloseTo(44 * 1.3);
  expect(styleOf('42').fontSize).toBeCloseTo(28 * 1.5);
  expect(styleOf('Body').fontSize).toBe(17 * 2);
});
