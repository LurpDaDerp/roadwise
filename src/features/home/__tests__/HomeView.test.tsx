import { screen, within } from '@testing-library/react-native';

import { draw, drive, NOW, press, summary, sums } from '@/features/drives/__fixtures__/drives';
import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { tokens } from '@/ui/tokens';

import { HomeView, type HomeViewProps } from '../HomeView';
import { dropCopy } from '../StartDrive';

const props = (over: Partial<HomeViewProps> = {}): HomeViewProps => ({
  summary: summary(),
  summaryLoading: false,
  summaryError: false,
  onRetrySummary: jest.fn(),
  driveCount: 12,
  recent: [drive({ clientTripId: 'a' }), drive({ clientTripId: 'b', startedAt: NOW - 86_400_000 })],
  week: sums({ miles: 50, drives: 4, cleanDrives: 2, speeding: 3, pickups: 0, hardBrake: 1, hardAccel: 0 }),
  month: sums({ miles: 200, drives: 20, cleanDrives: 18, speeding: 2, pickups: 1, hardBrake: 4, hardAccel: 2 }),
  starting: false,
  refusal: null,
  onStart: jest.fn(),
  onRefusalAction: jest.fn(),
  onOpenDrive: jest.fn(),
  onSeeAll: jest.fn(),
  onAllStats: jest.fn(),
  onHowPoints: jest.fn(),
  onLeagues: jest.fn(),
  ...over,
});

describe('the full Home', () => {
  test('header: rating with trend, points, level, streak, freezes and league rank', async () => {
    const p = props();
    await draw(<HomeView {...p} />);
    expect(screen.getByText('Hey, lurp')).toBeOnTheScreen();
    expect(screen.getByLabelText('Safety Rating 92 out of 100, up 1.5 this week')).toBeOnTheScreen();
    expect(screen.getByLabelText('1,240 points')).toBeOnTheScreen();
    expect(screen.getByLabelText('Level 4, 1000 points to level 5')).toBeOnTheScreen();
    expect(screen.getByLabelText('Streak 11 drives, multiplier 1.22')).toBeOnTheScreen();
    expect(screen.getByLabelText('2 of 3 freezes held')).toBeOnTheScreen();
    await press(screen.getByLabelText('Gold league, rank 4 of 30'));
    expect(p.onLeagues).toHaveBeenCalled();
  });

  test('an unranked driver sees how far from a rating they are', async () => {
    await draw(<HomeView {...props({ summary: summary({ progress: { ranked: false, safety_rating: null, miles_30d: 12.7 } }) })} />);
    expect(screen.getByText('Unranked')).toBeOnTheScreen();
    expect(screen.getByText('12/25 mi to get ranked')).toBeOnTheScreen();
  });

  test('stats card: 4 stats coloured by band, with arrows vs 30 days', async () => {
    await draw(<HomeView {...props()} />);
    const card = screen.getByTestId('stats-card');
    expect(within(card).getByText('Last 7 days')).toBeOnTheScreen();
    expect(screen.getByLabelText('Speeding, 6.0 per 100 mi, Needs work, Up, worse vs your 30-day average')).toBeOnTheScreen();
    expect(screen.getByLabelText('Phone pickups, 0.0 per 100 mi, Good, Down, better vs your 30-day average')).toBeOnTheScreen();
    expect(screen.getByLabelText('Clean drives, 50 %, Okay, Down, worse vs your 30-day average')).toBeOnTheScreen();
    expect(within(card).getByText(/^6.0/)).toHaveStyle({ color: tokens.color.light.signal.severe.text });
  });

  test('with no drive in 7 days the card shows 30 days without arrows', async () => {
    await draw(<HomeView {...props({ week: sums({ drives: 0, miles: 0 }) })} />);
    expect(screen.getByText('Last 30 days')).toBeOnTheScreen();
    expect(screen.getByLabelText('Speeding, 1.0 per 100 mi, Good')).toBeOnTheScreen();
  });

  test('recent drives, weekly challenges, and links out', async () => {
    const p = props();
    await draw(<HomeView {...p} />);
    expect(screen.getByTestId('recent-a')).toBeOnTheScreen();
    await press(screen.getByTestId('recent-b'));
    expect(p.onOpenDrive).toHaveBeenCalledWith('b');
    await press(screen.getByText('See all'));
    expect(p.onSeeAll).toHaveBeenCalled();
    await press(screen.getByText('All stats'));
    expect(p.onAllStats).toHaveBeenCalled();
    expect(screen.getByLabelText('Phone down: 3 of 5')).toBeOnTheScreen();
    expect(screen.getByLabelText('Under the limit: done')).toBeOnTheScreen();
    expect(screen.queryByTestId('first-run')).toBeNull();
  });
});

describe('first run', () => {
  test('before any drive: header, Start, "Take your first drive" and how it works only', async () => {
    const p = props({ driveCount: 0, recent: [] });
    await draw(<HomeView {...p} />);
    expect(screen.getByTestId('home-header')).toBeOnTheScreen();
    expect(screen.getByTestId('start-drive')).toBeOnTheScreen();
    expect(screen.getByText('Take your first drive')).toBeOnTheScreen();
    expect(screen.getByTestId('how-it-works')).toBeOnTheScreen();
    expect(screen.queryByTestId('stats-card')).toBeNull();
    expect(screen.queryByTestId('recent-drives')).toBeNull();
    expect(screen.queryByTestId('challenges')).toBeNull();
    await press(screen.getByText('All the rules'));
    expect(p.onHowPoints).toHaveBeenCalled();
  });

  test('after one or two drives it counts down to the stats and keeps those drives reachable', async () => {
    await draw(<HomeView {...props({ driveCount: 2, recent: [drive()] })} />);
    expect(screen.getByText('1 more drive to unlock your stats')).toBeOnTheScreen();
    expect(screen.queryByTestId('stats-card')).toBeNull();
    expect(screen.getByTestId('recent-drives')).toBeOnTheScreen();
  });
});

describe('Start drive', () => {
  test('starts from the gold button, with no DMS chip beside it', async () => {
    const p = props();
    await draw(<HomeView {...p} />);
    await press(screen.getByTestId('start-drive'));
    expect(p.onStart).toHaveBeenCalled();
    expect(screen.queryByTestId('dms-chip')).toBeNull();
  });

  test.each([
    ['stopped', 'no_movement', 'Drive ended: the car didn’t move for 15 min, so it wasn’t saved.'],
    ['stopped', 'no_gps', 'Drive ended: there was no GPS signal, so it wasn’t saved.'],
    ['stopped', 'not_driven', 'Drive ended: the car never reached driving speed, so it wasn’t saved.'],
    ['limit', 'not_driven', 'Drive ended: the car never reached driving speed, so it wasn’t saved.'],
    ['walking', 'not_driven', 'Drive ended: you walked away before driving, so it wasn’t saved.'],
    ['manual', 'not_driven', 'The car never reached driving speed, so the drive wasn’t saved.'],
    ['orphan', 'not_driven', 'A drive left open when RoadWise closed never reached driving speed, so it wasn’t saved.'],
    ['limit', 'no_movement', 'Drive ended: the car didn’t move for 15 min, so it wasn’t saved.'],
    ['limit', 'no_gps', 'Drive ended: there was no GPS signal, so it wasn’t saved.'],
    ['walking', 'no_movement', 'Drive ended: you walked away before driving, so it wasn’t saved.'],
    ['walking', 'no_gps', 'Drive ended: you walked away before driving, so it wasn’t saved.'],
    ['manual', 'no_movement', 'The car never moved, so the drive wasn’t saved.'],
    ['manual', 'no_gps', 'There was no GPS signal, so the drive wasn’t saved.'],
    ['orphan', 'no_movement', 'A drive left open when RoadWise closed never moved, so it wasn’t saved.'],
    ['orphan', 'no_gps', 'A drive left open when RoadWise closed had no GPS signal, so it wasn’t saved.'],
  ] as const)('a drive not kept (%s, %s) says why above Start, in at most 90 characters', async (cause, reason, line) => {
    expect(dropCopy(cause, reason)).toBe(line);
    expect(line.length).toBeLessThanOrEqual(90);
    const onDismiss = jest.fn();
    await draw(<HomeView {...props({ dropNotice: { message: dropCopy(cause, reason), onDismiss } })} />);
    expect(screen.getByTestId('drive-dropped')).toHaveTextContent(line, { exact: false });
    await press(screen.getByText('OK'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a refusal outranks the notice; no notice without one', async () => {
    await draw(<HomeView {...props({ refusal: 'busy', dropNotice: { message: dropCopy('stopped', 'no_movement'), onDismiss: jest.fn() } })} />);
    expect(screen.getByTestId('start-refusal')).toBeOnTheScreen();
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    await draw(<HomeView {...props()} />);
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
  });

  test('refused without location: one line, no speed wording', async () => {
    await draw(<HomeView {...props({ refusal: 'permission' })} />);
    expect(screen.getByTestId('start-refusal')).toHaveTextContent(/RoadWise needs location to record a drive\./);
    expect(screen.getByText('Fix it')).toBeOnTheScreen();
    expect(screen.queryByText(/Pull over|stopped/)).toBeNull();
  });
});

test('the header says so when progress cannot load', async () => {
  const p = props({ summary: undefined, summaryError: true });
  await draw(<HomeView {...p} />);
  expect(screen.getByText("Couldn't load your progress")).toBeOnTheScreen();
  await press(screen.getByText('Try again'));
  expect(p.onRetrySummary).toHaveBeenCalled();
});

describe('final-review fixes', () => {
  afterEach(() => resetUnitsForTests());

  test('the challenges strip shows progress toward a Freeze', async () => {
    const s = summary();
    await draw(<HomeView {...props({ summary: { ...s, progress: { ...s.progress, freeze_progress: 2 } } })} />);
    expect(screen.getByTestId('challenges-freeze')).toHaveTextContent(/2\/3 toward a Freeze/);
  });

  test('km: the stats card reads per 100 km and the unranked line converts', async () => {
    publishUnits('km');
    const s = summary();
    await draw(<HomeView {...props({ summary: { ...s, progress: { ...s.progress, ranked: false, safety_rating: null, miles_30d: 12 } } })} />);
    expect(screen.getAllByText('per 100 km').length).toBeGreaterThan(0);
    expect(screen.getByText('19/40 km to get ranked')).toBeOnTheScreen();
  });

  test('the rating is a whole number', async () => {
    const s = summary();
    await draw(<HomeView {...props({ summary: { ...s, progress: { ...s.progress, safety_rating: 91.7, ranked: true } } })} />);
    expect(screen.getByTestId('rating-value')).toHaveTextContent('92');
  });
});
