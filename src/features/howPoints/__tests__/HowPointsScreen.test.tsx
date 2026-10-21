import { screen } from '@testing-library/react-native';

import { draw, press } from '@/features/drives/__fixtures__/drives';

import { HowPointsView } from '../HowPointsScreen';

test('the explainer, the penalty list and every rule section are on the page', async () => {
  const onBack = jest.fn();
  await draw(<HowPointsView onBack={onBack} />);
  expect(screen.getByText('Safe miles earn points')).toBeOnTheScreen();
  expect(screen.getByText('Events cost points')).toBeOnTheScreen();
  expect(screen.getByText('Streaks multiply')).toBeOnTheScreen();
  for (const id of ['points', 'penalties', 'phone', 'speeding', 'multipliers', 'cap', 'streaks', 'levels', 'rating', 'boards', 'mistakes']) {
    expect(screen.getByTestId(`rules-${id}`)).toBeOnTheScreen();
  }
  expect(screen.queryByTestId('rules-leagues')).toBeNull();
  expect(screen.queryByText(/league|tier|Bronze|Diamond/i)).toBeNull();
  expect(screen.getByText('safe mi × 20 × multiplier')).toBeOnTheScreen();
  expect(screen.getByLabelText('Drive points equal safe miles times 20 times your multiplier, minus penalties')).toBeOnTheScreen();
  expect(screen.getByText('20 points for every safe mile you drive.')).toBeOnTheScreen();
  expect(screen.getByText('Weekly challenges (3 a week) are worth +200 points each.')).toBeOnTheScreen();
  expect(screen.getByText('Each drive in your streak adds 0.02 to your multiplier, up to ×1.30 at a 15-drive streak.')).toBeOnTheScreen();
  expect(screen.queryByText(/DMS|driver monitoring/i)).toBeNull();
  expect(screen.getByText(/From 40 to 100 mi they earn half/)).toBeOnTheScreen();
  expect(screen.getByText('−32 (−16 when stopped in traffic), ×1.5 over 25 mph and ×2 over 45 mph')).toBeOnTheScreen();
  expect(screen.getByText(/Speed and phone use count double/)).toBeOnTheScreen();
  expect(screen.queryByText(/× 10 ×|\+100 points|\+25 clean/)).toBeNull();
  await press(screen.getByLabelText('Back'));
  expect(onBack).toHaveBeenCalled();
});
