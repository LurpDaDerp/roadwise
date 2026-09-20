import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { categoryCaps } from '@/content/scoring-explainer';
import { CategoryBars } from '@/ui/charts/CategoryBars';
import { ThemeProvider } from '@/ui/theme';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

// The drawing is hidden from assistive tech by design (the image label carries the data), so
// anything inside it is queried as a drawn element, not an accessible one.
const drawn = { includeHiddenElements: true };

const caps = [
  { category: 'phone', label: 'Phone use', cap: 30 },
  { category: 'speeding', label: 'Speeding', cap: 25 },
  { category: 'braking', label: 'Hard braking', cap: 12 },
];

test('reads every category as "label, lost of cap points" and prints the value beside each bar', async () => {
  await wrap(<CategoryBars deductions={{ speeding: 12, braking: 6.25 }} caps={caps} testID="bars" />);
  expect(
    screen.getByRole('image', {
      name: 'Points lost by category. Phone use 0 of 30 points, Speeding 12 of 25 points, Hard braking 6.3 of 12 points',
    })
  ).toBeOnTheScreen();
  expect(screen.getByText('0 of 30', drawn)).toBeOnTheScreen();
  expect(screen.getByText('12 of 25', drawn)).toBeOnTheScreen();
  expect(screen.getByText('6.3 of 12', drawn)).toBeOnTheScreen();
  // and nothing inside the drawing is a separate stop for a screen reader
  expect(screen.queryByText('12 of 25')).toBeNull();
});

test('the box is as long as the cap and the fill is what the trip cost', async () => {
  await wrap(<CategoryBars deductions={{ speeding: 12 }} caps={caps} testID="bars" />);
  expect(screen.getByTestId('bars-track-phone', drawn)).toHaveStyle({ width: '100.00%' });
  expect(screen.getByTestId('bars-track-speeding', drawn)).toHaveStyle({ width: '83.33%' });
  expect(screen.getByTestId('bars-fill-speeding', drawn)).toHaveStyle({ width: '48.00%' });
  expect(screen.queryByTestId('bars-fill-phone', drawn)).toBeNull();
});

test('a deduction over the cap fills the box and no more', async () => {
  await wrap(<CategoryBars deductions={{ braking: 40 }} caps={caps} testID="bars" />);
  expect(screen.getByTestId('bars-fill-braking', drawn)).toHaveStyle({ width: '100.00%' });
  expect(screen.getByText('12 of 12', drawn)).toBeOnTheScreen();
});

test('the table shows the same numbers and keeps the summary line', async () => {
  await wrap(
    <CategoryBars
      deductions={{ speeding: 12 }}
      caps={caps}
      summaryText="Speeding cost the most"
      testID="bars"
    />
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Show as table' }));
  expect(screen.getByRole('row', { name: 'Category, Lost, Cap' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Speeding, 12 of 25 points' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Phone use, 0 of 30 points' })).toBeOnTheScreen();
  expect(screen.getByText('Speeding cost the most')).toBeOnTheScreen();
});

test('takes the scoring explainer caps as they are', async () => {
  await wrap(<CategoryBars deductions={{ phone: 6, speeding: 6 }} caps={categoryCaps} testID="bars" />);
  expect(screen.getByText('6 of 30', drawn)).toBeOnTheScreen();
  expect(screen.getByText('6 of 25', drawn)).toBeOnTheScreen();
  expect(screen.getAllByText(/ of /, drawn)).toHaveLength(categoryCaps.length);
});
