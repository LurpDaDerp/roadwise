import { screen, within } from '@testing-library/react-native';
import { driveMerit } from '@scoring';

import { contrastRatio } from '@/ui';
import { tokens } from '@/ui/tokens';

import { DAY, draw, drive, NOW, press } from '../__fixtures__/drives';
import { HistoryView, type HistoryViewProps } from '../HistoryView';
import { meritInk } from '../merit';

const NO_POINTS = /\bpoints?\b|\bpts\b|streak|negative/i;

const props = (over: Partial<HistoryViewProps> = {}): HistoryViewProps => ({
  drives: [
    drive({ clientTripId: 'a', startedAt: NOW - 1000, miles: 26, clean: true, counts: { ...drive().counts, hardBrake: 0 } }),
    drive({ clientTripId: 'b', startedAt: NOW - 2 * DAY, status: 'failed', miles: 3, counts: { ...drive().counts, hardBrake: 2, speeding: 1 } }),
    drive({ clientTripId: 'c', startedAt: NOW - 10 * DAY, status: 'not_driving' }),
    drive({ clientTripId: 'd', startedAt: NOW - 10 * DAY - 1000, status: 'unscored', reason: 'too_short', miles: 0.3 }),
  ],
  loading: false,
  error: false,
  filter: 'all',
  onFilter: jest.fn(),
  onOpen: jest.fn(),
  onBack: jest.fn(),
  onHome: jest.fn(),
  now: NOW,
  scores: new Map([
    ['a', 98],
    ['b', 71],
  ]),
  ...over,
});

test('drives are grouped by week, newest first, each week with its drives and distance', async () => {
  await draw(<HistoryView {...props()} />);
  expect(screen.getByText('This week')).toBeOnTheScreen();
  expect(screen.getByText('Last week')).toBeOnTheScreen();
  expect(screen.getByText('Sep 21 – 27')).toBeOnTheScreen();
  expect(screen.getByLabelText('This week, 1 drive, 26 mi')).toBeOnTheScreen();
  expect(screen.queryByText(NO_POINTS)).toBeNull();
});

test('a drive still uploading reads "score" until its upload has failed, then "not synced", as its recap says', async () => {
  await draw(
    <HistoryView
      {...props({
        drives: [
          drive({ clientTripId: 'e', startedAt: NOW - 1000, status: 'pending', result: null }),
          drive({ clientTripId: 'f', startedAt: NOW - 2000, status: 'pending', result: null, uploadFailed: true }),
        ],
        scores: new Map([
          ['e', 90],
          ['f', 88],
        ]),
      })}
    />
  );
  expect(within(screen.getByTestId('drive-e')).getByText('score')).toBeOnTheScreen();
  expect(within(screen.getByTestId('drive-e')).queryByText('not synced')).toBeNull();
  expect(within(screen.getByTestId('drive-f')).getByText('not synced')).toBeOnTheScreen();
  expect(screen.getByTestId('drive-f').props.accessibilityLabel).toContain('drive score 88, not synced');
});

test('a row shows its score in its merit colour (no icon), "not synced" for a drive still to upload, else the word', async () => {
  await draw(<HistoryView {...props()} />);
  const surfaces = [tokens.color.light.surface, tokens.color.light.surfaceRaised];
  const a = screen.getByTestId('drive-a-score');
  expect(a).toHaveTextContent('98');
  expect(driveMerit(98, 26)).toBe(5);
  expect(a).toHaveStyle({ color: meritInk(5, surfaces) });
  expect(contrastRatio(meritInk(5, surfaces), tokens.color.light.surface)).toBeGreaterThanOrEqual(4.5);
  expect(within(screen.getByTestId('drive-a')).getByText('score')).toBeOnTheScreen();
  expect(screen.getByTestId('drive-b-score')).toHaveStyle({ color: meritInk(1, surfaces) });
  expect(within(screen.getByTestId('drive-b')).getByText('not synced')).toBeOnTheScreen();
  expect(screen.getByTestId('drive-c-word')).toHaveTextContent('Not driving');
  expect(screen.getByTestId('drive-d-word')).toHaveTextContent('Too short');
  expect(screen.queryByTestId('merit-icon')).toBeNull();
  expect(screen.getByTestId('drive-b').props.accessibilityLabel).toContain('drive score 71, not synced, 1 speeding, 2 hard brake');
  expect(screen.getByTestId('drive-a').props.accessibilityLabel).toContain('Home to School');
  expect(screen.getByTestId('drive-a').props.accessibilityLabel).toContain('drive score 98, clean drive');
});

test('a score still loading leaves the column empty', async () => {
  await draw(<HistoryView {...props({ scores: new Map() })} />);
  expect(screen.queryByTestId('drive-a-score')).toBeNull();
  expect(screen.queryByTestId('drive-a-word')).toBeNull();
});

test('tapping a row opens its summary', async () => {
  const p = props();
  await draw(<HistoryView {...p} />);
  await press(screen.getByTestId('drive-b'));
  expect(p.onOpen).toHaveBeenCalledWith('b');
});

test('two filters, Clean and Passenger, toggle on and back off to all', async () => {
  const p = props({ filter: 'clean' });
  await draw(<HistoryView {...p} />);
  expect(screen.getByTestId('filter-clean')).toBeSelected();
  expect(screen.queryByTestId('filter-negative')).toBeNull();
  await press(screen.getByTestId('filter-clean'));
  expect(p.onFilter).toHaveBeenLastCalledWith('all');
  await press(screen.getByTestId('filter-passenger'));
  expect(p.onFilter).toHaveBeenLastCalledWith('passenger');
});

test('an empty filter says why and offers to show everything', async () => {
  const p = props({ drives: [], filter: 'passenger' });
  await draw(<HistoryView {...p} />);
  const empty = screen.getByTestId('history-empty-passenger');
  expect(within(empty).getByText('No passenger drives')).toBeOnTheScreen();
  await press(within(empty).getByText('Show all drives'));
  expect(p.onFilter).toHaveBeenCalledWith('all');
});

test('no drives at all points back to Home, in the words of how drives start here', async () => {
  const p = props({ drives: [] });
  await draw(<HistoryView {...p} />);
  expect(screen.getByText('Swipe Start drive on Home before you pull out. Every drive shows up here.')).toBeOnTheScreen();
  await press(screen.getByText('Go to Home'));
  expect(p.onHome).toHaveBeenCalled();
  await draw(<HistoryView {...props({ drives: [], autoDrives: true })} />);
  expect(screen.getByText("Your drives show up here after you've driven. RoadWise notices them on its own.")).toBeOnTheScreen();
});

test('with the drives of a kind all past 183 days (archived), its empty list says “in the last 6 months”, not “yet”; the body and button stay', async () => {
  const archived = { all: true, clean: true, passenger: false };
  await draw(<HistoryView {...props({ drives: [], archived })} />);
  expect(within(screen.getByTestId('history-empty-all')).getByText('No drives in the last 6 months')).toBeOnTheScreen();
  expect(screen.queryByText('No drives yet')).toBeNull();
  expect(screen.getByText('Swipe Start drive on Home before you pull out. Every drive shows up here.')).toBeOnTheScreen();
  expect(screen.getByText('Go to Home')).toBeOnTheScreen();
  await draw(<HistoryView {...props({ drives: [], archived, filter: 'clean' })} />);
  expect(within(screen.getByTestId('history-empty-clean')).getByText('No clean drives in the last 6 months')).toBeOnTheScreen();
  expect(screen.getByText('Drives with no events count as clean and show up here.')).toBeOnTheScreen();
  // No archived "Wasn't driving" drive: that filter's title is unchanged.
  await draw(<HistoryView {...props({ drives: [], archived, filter: 'passenger' })} />);
  expect(within(screen.getByTestId('history-empty-passenger')).getByText('No passenger drives')).toBeOnTheScreen();
  await draw(<HistoryView {...props({ drives: [], archived: { all: true, clean: false, passenger: true }, filter: 'passenger' })} />);
  expect(screen.getByText('No passenger drives in the last 6 months')).toBeOnTheScreen();
});

test('while loading it shows placeholders, not an empty state', async () => {
  await draw(<HistoryView {...props({ drives: undefined, loading: true })} />);
  expect(screen.getByTestId('history-loading')).toBeOnTheScreen();
  expect(screen.queryByTestId('history-empty-all')).toBeNull();
});
