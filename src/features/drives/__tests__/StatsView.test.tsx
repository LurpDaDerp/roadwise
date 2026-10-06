import { screen } from '@testing-library/react-native';

import { tokens } from '@/ui/tokens';

import { draw, press, sums } from '../__fixtures__/drives';
import { StatsView } from '../StatsView';

const month = sums({ miles: 100, drives: 10, cleanDrives: 9, speeding: 5, hardBrake: 2 });
const all = sums({ miles: 1000, drives: 80, cleanDrives: 70, speeding: 6, hardBrake: 30 });

test('per 100 mi over 30 days by default, coloured with the band word', async () => {
  await draw(<StatsView month={month} all={all} loading={false} error={false} onBack={jest.fn()} />);
  expect(screen.getByTestId('stat-speeding-value')).toHaveTextContent('5.0');
  expect(screen.getByTestId('stat-speeding-value')).toHaveStyle({ color: tokens.color.light.signal.severe.text });
  expect(screen.getByLabelText('Speeding, 5.0 per 100 mi, Needs work')).toBeOnTheScreen();
  expect(screen.getByLabelText('Clean drives, 90 %, Good')).toBeOnTheScreen();
  expect(screen.getByLabelText('Miles, 100 mi')).toBeOnTheScreen();
});

test('totals and all time switch the table', async () => {
  await draw(<StatsView month={month} all={all} loading={false} error={false} onBack={jest.fn()} />);
  await press(screen.getByText('Totals'));
  expect(screen.getByLabelText('Speeding, 5 times')).toBeOnTheScreen();
  expect(screen.getByLabelText('Clean drives, 9 of 10 drives')).toBeOnTheScreen();
  await press(screen.getByText('All time'));
  expect(screen.getByLabelText('Hard braking, 30 times')).toBeOnTheScreen();
  await press(screen.getByText('Per 100 mi'));
  expect(screen.getByLabelText('Hard braking, 3.0 per 100 mi, Okay')).toBeOnTheScreen();
});

test('no drives in the window says so', async () => {
  await draw(<StatsView month={sums({ drives: 0, miles: 0 })} all={all} loading={false} error={false} onBack={jest.fn()} />);
  expect(screen.getByText('No drives in the last 30 days')).toBeOnTheScreen();
});
