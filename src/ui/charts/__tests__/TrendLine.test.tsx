import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { TrendLine } from '@/ui/charts/TrendLine';
import { ThemeProvider } from '@/ui/theme';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

// The drawing is hidden from assistive tech by design (the image label carries the data), so
// anything inside it is queried as a drawn element, not an accessible one.
const drawn = { includeHiddenElements: true };

const points = [
  { label: 'Aug 4', value: 71 },
  { label: 'Aug 11', value: 76 },
  { label: 'Aug 18', value: null },
  { label: 'Aug 25', value: 84 },
];

test('describes the trend as one image and labels only its two ends', async () => {
  await wrap(<TrendLine points={points} width={320} testID="trend" />);
  expect(
    screen.getByRole('image', { name: 'Score trend, from 71 to 84 over 4 weeks' })
  ).toBeOnTheScreen();
  expect(screen.getByText('71', drawn)).toBeOnTheScreen();
  expect(screen.getByText('84', drawn)).toBeOnTheScreen();
  expect(screen.queryByText('76', drawn)).toBeNull();
  // The last point names its band; the washes behind the line are otherwise unlabelled.
  expect(screen.getByText('Good', drawn)).toBeOnTheScreen();
  expect(screen.getByText('Aug 4', drawn)).toBeOnTheScreen();
  expect(screen.getByText('Aug 25', drawn)).toBeOnTheScreen();
});

test('the drawing is hidden from assistive tech; the image label carries the numbers', async () => {
  await wrap(<TrendLine points={points} width={320} testID="trend" />);
  expect(screen.queryByText('71')).toBeNull();
  expect(screen.queryByText('Aug 4')).toBeNull();
  expect(screen.getByRole('image')).toBeOnTheScreen();
});

test('a period without a score breaks the line and has no marker', async () => {
  await wrap(<TrendLine points={points} width={320} testID="trend" />);
  expect(screen.queryByTestId('trend-marker-2', drawn)).toBeNull();
  expect(screen.getByTestId('trend-marker-3', drawn)).toBeOnTheScreen();
  const d = screen.getByTestId('trend-line', drawn).props.d as string;
  expect(d.match(/M/g)).toHaveLength(2);
});

test('band shading washes the three upper bands and leaves the lowest as bare card', async () => {
  await wrap(<TrendLine points={points} width={320} testID="trend" />);
  for (const band of ['excellent', 'good', 'getting_there']) {
    expect(screen.getByTestId(`trend-band-${band}`, drawn).props.fillOpacity).toBeGreaterThan(0);
  }
  expect(screen.getByTestId('trend-band-needs_focus', drawn).props.fillOpacity).toBe(0);
});

test('band shading can be switched off', async () => {
  await wrap(<TrendLine points={points} width={320} bandShading={false} testID="trend" />);
  expect(screen.queryByTestId('trend-band-good', drawn)).toBeNull();
  expect(screen.getByTestId('trend-line', drawn)).toBeOnTheScreen();
});

test('the table shows the same numbers, one row per period, and the button swaps back', async () => {
  await wrap(
    <TrendLine
      points={points}
      width={320}
      summaryText="Up 13 points in a month"
      testID="trend"
    />
  );
  expect(screen.getByText('Up 13 points in a month')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Show as table' }));
  expect(screen.queryByRole('image')).toBeNull();
  expect(screen.getByRole('row', { name: 'Week, Score, Band' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Aug 4, 71, Getting there' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Aug 18, not scored' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Aug 25, 84, Good' })).toBeOnTheScreen();
  expect(screen.getByText('Up 13 points in a month')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Show as chart' }));
  expect(screen.getByRole('image')).toBeOnTheScreen();
});

test('with no scores the chart says so and the table is empty', async () => {
  await wrap(<TrendLine points={[]} width={320} testID="trend" />);
  expect(screen.getByRole('image', { name: 'Score trend, no scores yet' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Show as table' }));
  expect(screen.getByText('No scores yet')).toBeOnTheScreen();
});

test('long period names go to the table and the screen reader; the axis keeps the short ones', async () => {
  await wrap(
    <TrendLine
      points={[
        { label: 'W1', longLabel: 'Week of Aug 4', value: 71 },
        { label: 'W2', longLabel: 'Week of Aug 11', value: 84 },
      ]}
      width={320}
      testID="trend"
    />
  );
  expect(screen.getByText('W1', drawn)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Show as table' }));
  expect(screen.getByRole('row', { name: 'Week of Aug 4, 71, Getting there' })).toBeOnTheScreen();
});
