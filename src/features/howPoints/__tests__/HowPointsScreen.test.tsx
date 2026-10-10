import { screen } from '@testing-library/react-native';

import { draw, press } from '@/features/drives/__fixtures__/drives';

import { HowPointsView } from '../HowPointsScreen';

test('the explainer, the penalty list and every rule section are on the page', async () => {
  const onBack = jest.fn();
  await draw(<HowPointsView onBack={onBack} />);
  expect(screen.getByText('Safe miles earn points')).toBeOnTheScreen();
  expect(screen.getByText('Events cost points')).toBeOnTheScreen();
  expect(screen.getByText('Streaks multiply')).toBeOnTheScreen();
  for (const id of ['points', 'penalties', 'multipliers', 'cap', 'streaks', 'levels', 'rating', 'leagues', 'mistakes']) {
    expect(screen.getByTestId(`rules-${id}`)).toBeOnTheScreen();
  }
  expect(screen.getByText('Each drive in your streak adds 0.02 to your multiplier, up to ×1.30 at a 15-drive streak.')).toBeOnTheScreen();
  expect(screen.queryByText(/DMS|driver monitoring/i)).toBeNull();
  expect(screen.getByText(/From 40 to 100 mi they earn half/)).toBeOnTheScreen();
  expect(screen.getByText('−40 (−20 when stopped in traffic)')).toBeOnTheScreen();
  await press(screen.getByLabelText('Back'));
  expect(onBack).toHaveBeenCalled();
});
