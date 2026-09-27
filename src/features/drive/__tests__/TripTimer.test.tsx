import { render, screen } from '@testing-library/react-native';

import { formatMinutes, tripMinutes, TripTimer } from '../TripTimer';

const T = Date.UTC(2026, 8, 22, 19, 0, 0);

describe('formatMinutes — H:MM', () => {
  test.each([
    [0, '0:00'],
    [42, '0:42'],
    [67, '1:07'],
    [12 * 60, '12:00'],
    [-5, '0:00'],
    [Number.NaN, '0:00'],
  ])('%s → %s', (minutes, text) => {
    expect(formatMinutes(minutes)).toBe(text);
  });
});

describe('tripMinutes — whole minutes on the row clock', () => {
  test('counts from the start to the last row, whole minutes only', () => {
    expect(tripMinutes({ startedAt: T, lastRowTs: T + 41 * 60_000 + 59_000 })).toBe(41);
    expect(tripMinutes({ startedAt: T, lastRowTs: T + 42 * 60_000 })).toBe(42);
    expect(tripMinutes({ startedAt: T, lastRowTs: T })).toBe(0);
  });

  test('null with no trip or no row yet; never negative', () => {
    expect(tripMinutes({ startedAt: null, lastRowTs: T })).toBeNull();
    expect(tripMinutes({ startedAt: T, lastRowTs: null })).toBeNull();
    expect(tripMinutes({ startedAt: T + 60_000, lastRowTs: T })).toBe(0);
  });
});

describe('TripTimer', () => {
  test('shows the minutes as H:MM and says them', async () => {
    await render(<TripTimer minutes={67} night={false} />);
    expect(screen.getByText('1:07')).toBeTruthy();
    expect(screen.getByTestId('hud-timer')).toHaveProp(
      'accessibilityLabel',
      'Driving for 1 hour and 7 minutes'
    );
  });

  test('keeps its slot but shows nothing without a trip', async () => {
    await render(<TripTimer minutes={null} night={false} />);
    expect(screen.queryByTestId('hud-timer')).toBeNull();
  });
});
