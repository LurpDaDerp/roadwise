import { AUTO_TRIGGER } from '@drive-sense/detect/policy';
import { screen } from '@testing-library/react-native';

import { NOT_DRIVING_BUDGET_MS } from '@/drive/notDriving';
import { WAIT_TOTAL_MS } from '@/drive/waiting';
import { draw, press } from '@/features/drives/__fixtures__/drives';

import { DRIVE_NUMBERS, HowScoresView } from '../HowScoresScreen';

test('the hero, the three ideas and every rule section are on the page, with no points', async () => {
  const onBack = jest.fn();
  await draw(<HowScoresView onBack={onBack} autoDrives />);
  expect(screen.getByText('Smooth and steady wins')).toBeOnTheScreen();
  expect(screen.getByText('Every drive gets a score out of 100. Your Safety Rating sums up your last 90 days.')).toBeOnTheScreen();
  expect(screen.getByText('Drives record themselves')).toBeOnTheScreen();
  for (const id of ['drive-score', 'speeding', 'rating', 'drives', 'dashpal', 'goals', 'friends', 'mistakes']) {
    expect(screen.getByTestId(`rules-${id}`)).toBeOnTheScreen();
  }
  expect(screen.getByText('How drives start and end')).toBeOnTheScreen();
  expect(screen.queryByTestId('rules-penalties')).toBeNull();
  expect(screen.queryByText(/\bpoints?\b|\bpts\b|streak|freeze|multiplier|league/i)).toBeNull();
  await press(screen.getByLabelText('Back'));
  expect(onBack).toHaveBeenCalled();
});

test('without automatic drives the page says to start each drive', async () => {
  await draw(<HowScoresView onBack={jest.fn()} autoDrives={false} />);
  expect(screen.getByText('Start, then drive')).toBeOnTheScreen();
  expect(screen.getByText('Starting a drive')).toBeOnTheScreen();
  expect(screen.queryByText('How drives start and end')).toBeNull();
});

test('the drive numbers come from the drive code', () => {
  expect(DRIVE_NUMBERS).toEqual({
    autoTriggerMph: AUTO_TRIGGER.mph,
    autoTriggerS: AUTO_TRIGGER.holdMs / 1000,
    waitMin: WAIT_TOTAL_MS / 60_000,
    notDrivingMin: NOT_DRIVING_BUDGET_MS / 60_000,
  });
  expect(DRIVE_NUMBERS).toEqual({ autoTriggerMph: 20, autoTriggerS: 10, waitMin: 5, notDrivingMin: 2 });
});
