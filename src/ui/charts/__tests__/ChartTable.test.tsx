import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { ChartTable } from '@/ui/charts/ChartTable';
import { ThemeProvider } from '@/ui/theme';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

const columns = [{ title: 'Week' }, { title: 'Score', numeric: true }, { title: 'Band' }];

test('a table names itself and reads each row as one sentence', async () => {
  await wrap(
    <ChartTable
      caption="Score by week"
      columns={columns}
      rows={[
        { key: '0', cells: ['Aug 4', '71', 'Getting there'], label: 'Aug 4, 71, Getting there' },
        { key: '1', cells: ['Aug 11', '84', 'Good'], label: 'Aug 11, 84, Good' },
      ]}
      testID="tbl"
    />
  );
  expect(screen.getByTestId('tbl').props.role).toBe('table');
  expect(screen.getByTestId('tbl').props.accessibilityLabel).toBe('Score by week');
  expect(screen.getByRole('row', { name: 'Week, Score, Band' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Aug 4, 71, Getting there' })).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Aug 11, 84, Good' })).toBeOnTheScreen();
  expect(screen.getByText('84')).toBeOnTheScreen();
});

test('an empty table says what is missing instead of showing nothing', async () => {
  await wrap(
    <ChartTable caption="Score by week" columns={columns} rows={[]} emptyText="No scores yet" />
  );
  expect(screen.getByText('No scores yet')).toBeOnTheScreen();
  expect(screen.getByRole('row', { name: 'Week, Score, Band' })).toBeOnTheScreen();
});
