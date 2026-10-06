import { screen, within } from '@testing-library/react-native';

import { tokens } from '@/ui/tokens';

import { DAY, draw, drive, NOW, press } from '../__fixtures__/drives';
import { HistoryView, type HistoryViewProps } from '../HistoryView';

const props = (over: Partial<HistoryViewProps> = {}): HistoryViewProps => ({
  drives: [
    drive({ clientTripId: 'a', startedAt: NOW - 1000, pointsNet: 120, clean: true, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 'b', startedAt: NOW - 2 * DAY, pointsNet: -44, counts: { ...drive().counts, pickups: 2 } }),
    drive({ clientTripId: 'c', startedAt: NOW - 10 * DAY, status: 'not_driving', pointsNet: 0 }),
  ],
  loading: false,
  error: false,
  filter: 'all',
  onFilter: jest.fn(),
  onOpen: jest.fn(),
  onBack: jest.fn(),
  onHome: jest.fn(),
  now: NOW,
  ...over,
});

test('drives are grouped by week, newest first', async () => {
  await draw(<HistoryView {...props()} />);
  expect(screen.getByText('This week')).toBeOnTheScreen();
  expect(screen.getByText('Last week')).toBeOnTheScreen();
  expect(screen.getByText('Sep 21 – 27')).toBeOnTheScreen();
  expect(screen.getByLabelText('This week, 1 drive, 12.0 mi, +120 pts')).toBeOnTheScreen();
});

test('a row shows net points in green or red with a sign, and its events', async () => {
  await draw(<HistoryView {...props()} />);
  expect(screen.getByTestId('drive-a-points')).toHaveStyle({ color: tokens.color.light.signal.clean.text });
  expect(screen.getByTestId('drive-a-points')).toHaveTextContent('+120');
  expect(screen.getByTestId('drive-b-points')).toHaveStyle({ color: tokens.color.light.signal.severe.text });
  expect(screen.getByTestId('drive-b-points')).toHaveTextContent('−44');
  expect(screen.getByTestId('drive-b-event-phone_pickup')).toBeOnTheScreen();
  expect(screen.getByTestId('drive-c-word')).toHaveTextContent('Not driving');
  expect(screen.getByTestId('drive-b').props.accessibilityLabel).toContain('44 points lost, 2 phone pickup');
  expect(screen.getByTestId('drive-a').props.accessibilityLabel).toContain('Home to School');
});

test('tapping a row opens its summary', async () => {
  const p = props();
  await draw(<HistoryView {...p} />);
  await press(screen.getByTestId('drive-b'));
  expect(p.onOpen).toHaveBeenCalledWith('b');
});

test('filters toggle on and back off to all', async () => {
  const p = props({ filter: 'clean' });
  await draw(<HistoryView {...p} />);
  expect(screen.getByTestId('filter-clean')).toBeSelected();
  await press(screen.getByTestId('filter-clean'));
  expect(p.onFilter).toHaveBeenLastCalledWith('all');
  await press(screen.getByTestId('filter-negative'));
  expect(p.onFilter).toHaveBeenLastCalledWith('negative');
});

test('an empty filter says why and offers to show everything', async () => {
  const p = props({ drives: [], filter: 'passenger' });
  await draw(<HistoryView {...p} />);
  const empty = screen.getByTestId('history-empty-passenger');
  expect(within(empty).getByText('No passenger drives')).toBeOnTheScreen();
  await press(within(empty).getByText('Show all drives'));
  expect(p.onFilter).toHaveBeenCalledWith('all');
});

test('no drives at all points back to Home', async () => {
  const p = props({ drives: [] });
  await draw(<HistoryView {...p} />);
  await press(screen.getByText('Go to Home'));
  expect(p.onHome).toHaveBeenCalled();
});

test('while loading it shows placeholders, not an empty state', async () => {
  await draw(<HistoryView {...props({ drives: undefined, loading: true })} />);
  expect(screen.getByTestId('history-loading')).toBeOnTheScreen();
  expect(screen.queryByTestId('history-empty-all')).toBeNull();
});
