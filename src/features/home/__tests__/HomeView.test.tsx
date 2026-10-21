import { screen, within } from '@testing-library/react-native';
import { Text } from 'react-native';

import { draw, drive, NOW, press, summary, sums, swipe } from '@/features/drives/__fixtures__/drives';
import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { Screen } from '@/ui';
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
  week: sums({ miles: 50, drives: 4, cleanDrives: 2, speeding: 3, hardBrake: 1, hardAccel: 0 }),
  month: sums({ miles: 200, drives: 20, cleanDrives: 18, speeding: 2, hardBrake: 4, hardAccel: 2 }),
  thisWeek: sums({ miles: 38.4, drives: 4 }),
  autoDrives: false,
  starting: false,
  refusal: null,
  onStart: jest.fn(),
  onRefusalAction: jest.fn(),
  onOpenDrive: jest.fn(),
  onSeeAll: jest.fn(),
  onAllStats: jest.fn(),
  onHowScores: jest.fn(),
  onAnalytics: jest.fn(),
  ...over,
});

const NO_POINTS = /\bpoints?\b|\bpts\b|streak|freeze|\blevel\b|leaderboard/i;

describe('the full Home', () => {
  test('this week in two pills, the Safety Rating in its ring with the week and the window, and no points anywhere', async () => {
    const p = props({ recent: [] });
    await draw(<HomeView {...p} />);
    expect(screen.getByText('Hey, lurp')).toBeOnTheScreen();
    const pills = screen.getByTestId('home-week');
    expect(within(pills).getByText('4 drives · 38 mi')).toBeOnTheScreen();
    expect(within(pills).getByLabelText('4 drives this week, 38 miles')).toBeOnTheScreen();
    expect(within(pills).getByText('1 of 3 goals')).toBeOnTheScreen();
    expect(within(pills).getByLabelText('1 of 3 weekly goals done')).toBeOnTheScreen();
    const card = screen.getByTestId('home-header');
    expect(within(card).getByTestId('rating-value')).toHaveTextContent('92');
    expect(within(card).getByText('Safety Rating')).toBeOnTheScreen();
    expect(within(card).getByText('Up 2 this week')).toBeOnTheScreen();
    expect(within(card).getByText('Last 90 days')).toBeOnTheScreen();
    const block = within(card).getByRole('button', { name: 'Safety Rating 92 out of 100. Up 2 this week.' });
    expect(block).toHaveProp('accessibilityHint', 'Opens Analytics');
    await press(block);
    expect(p.onAnalytics).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(NO_POINTS)).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(NO_POINTS);
  });

  test('a first drive of the week, no goals yet and no trend: the pill says so, the goals pill and trend line hide', async () => {
    await draw(<HomeView {...props({ thisWeek: sums({ drives: 0, miles: 0 }), summary: summary({ challenges: [], progress: { rating_trend: null } }) })} />);
    expect(screen.getByText('No drives yet this week')).toBeOnTheScreen();
    expect(screen.queryByTestId('home-week-goals')).toBeNull();
    expect(screen.queryByTestId('rating-trend')).toBeNull();
    expect(screen.getByRole('button', { name: 'Safety Rating 92 out of 100.' })).toBeOnTheScreen();
  });

  test.each([
    [-2.6, 'Down 3 this week'],
    [0.3, 'Steady this week'],
  ])('a week of %s reads "%s"', async (trend, line) => {
    await draw(<HomeView {...props({ summary: summary({ progress: { rating_trend: trend } }) })} />);
    expect(within(screen.getByTestId('rating-trend')).getByText(line)).toBeOnTheScreen();
  });

  test('no rating yet: the ring fills toward 10 mi in 90 days, holds a dash, and says how far to go', async () => {
    const p = props({ summary: summary({ progress: { ranked: false, safety_rating: null, miles_90d: 4.6 } }) });
    await draw(<HomeView {...p} />);
    expect(screen.getByTestId('rating-value')).toHaveTextContent('—');
    expect(screen.getByText('No rating yet')).toBeOnTheScreen();
    expect(screen.getByText('4 of 10 mi to your rating')).toBeOnTheScreen();
    expect(screen.getByLabelText('Distance toward a Safety Rating')).toHaveProp('accessibilityValue', { min: 0, max: 100, now: 40 });
    await press(screen.getByRole('button', { name: 'No rating yet. 4 of 10 miles to your rating' }));
    expect(p.onAnalytics).toHaveBeenCalled();
  });

  test('before any drive the rating says it comes after the first one', async () => {
    await draw(<HomeView {...props({ driveCount: 0, recent: [], summary: summary({ progress: { ranked: false, safety_rating: null, miles_90d: 0 } }) })} />);
    expect(screen.getByText('Your rating shows up after your first drive.')).toBeOnTheScreen();
  });

  test('stats card: speeding, harsh driving, clean drives and distance; distance has no colour and no arrow', async () => {
    await draw(<HomeView {...props()} />);
    const card = screen.getByTestId('stats-card');
    expect(within(card).getByText('Last 7 days')).toBeOnTheScreen();
    expect(screen.getByLabelText('Speeding events, 3, Needs work, Up, worse vs your 30-day average')).toBeOnTheScreen();
    expect(screen.getByLabelText('Clean drives, 50 %, Okay, Down, worse vs your 30-day average')).toBeOnTheScreen();
    expect(within(card).getByTestId('home-stat-miles')).toBeOnTheScreen();
    expect(within(card).getByText('Distance')).toBeOnTheScreen();
    expect(within(card).queryByText('Phone pickups')).toBeNull();
    expect(screen.getByLabelText('Distance, 50.0 mi')).toBeOnTheScreen();
    expect(within(card).getByText('3')).toHaveStyle({ color: tokens.color.light.signal.severe.text });
    expect(within(card).getByText('Compared with your average week in the last 30 days.')).toBeOnTheScreen();
  });

  test("recent drives with their scores, this week's goals with a check or the fraction, and links out", async () => {
    const p = props({ scores: new Map([['a', 97]]) });
    await draw(<HomeView {...p} />);
    expect(screen.getByTestId('recent-a-score')).toHaveTextContent('97');
    expect(screen.queryByTestId('recent-b-score')).toBeNull();
    await press(screen.getByTestId('recent-b'));
    expect(p.onOpenDrive).toHaveBeenCalledWith('b');
    await press(screen.getByText('See all'));
    expect(p.onSeeAll).toHaveBeenCalled();
    await press(screen.getByText('All stats'));
    expect(p.onAllStats).toHaveBeenCalled();
    const goals = screen.getByTestId('goals');
    expect(within(goals).getByText("This week's goals")).toBeOnTheScreen();
    expect(within(goals).getByLabelText('Easy does it, done. 4 drives with no speeding')).toBeOnTheScreen();
    expect(within(goals).getByTestId('goal-c1-done', { includeHiddenElements: true })).toBeTruthy();
    expect(within(goals).getByLabelText('Smooth operator, 2 of 4. 4 drives with no hard stops, starts or turns')).toBeOnTheScreen();
    expect(within(goals).getByText('2/4', { includeHiddenElements: true })).toBeTruthy();
    expect(within(goals).getByText('New goals every Monday.')).toBeOnTheScreen();
    expect(screen.queryByTestId('first-run')).toBeNull();
  });

  test('a goal past its target still reads as the target', async () => {
    await draw(
      <HomeView
        {...props({ summary: summary({ challenges: [{ id: 'x', slot: 1, title: 'Clean sweep', description: '3 drives with no events', target: 3, progress: 5, completed: false }] }) })}
      />
    );
    expect(screen.getByLabelText('Clean sweep, 3 of 3. 3 drives with no events')).toBeOnTheScreen();
  });
});

describe('first run', () => {
  test('before any drive: header, Start, "Take your first drive" and how it works only', async () => {
    const p = props({ driveCount: 0, recent: [] });
    await draw(<HomeView {...p} />);
    expect(screen.getByTestId('home-header')).toBeOnTheScreen();
    expect(screen.getByTestId('start-drive')).toBeOnTheScreen();
    expect(screen.getByText('Take your first drive')).toBeOnTheScreen();
    expect(screen.getByText('Swipe Start drive before you pull out. Then put your phone down and go.')).toBeOnTheScreen();
    expect(screen.getByTestId('how-it-works')).toBeOnTheScreen();
    expect(screen.getByText('Start, then drive')).toBeOnTheScreen();
    expect(screen.queryByTestId('stats-card')).toBeNull();
    expect(screen.queryByTestId('recent-drives')).toBeNull();
    expect(screen.queryByTestId('goals')).toBeNull();
    await press(screen.getByText('How scores work'));
    expect(p.onHowScores).toHaveBeenCalled();
  });

  test('with automatic drives on, the words say drives start on their own, and Start gets its quiet line', async () => {
    await draw(<HomeView {...props({ driveCount: 0, recent: [], autoDrives: true })} />);
    expect(screen.getByText("Just drive. RoadWise notices once you're moving and keeps a record.")).toBeOnTheScreen();
    expect(screen.getByText('Drives record themselves')).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-header')).getByTestId('start-caption')).toHaveTextContent('Or just drive. RoadWise notices on its own.');
  });

  test('without automatic drives there is no caption under Start', async () => {
    await draw(<HomeView {...props({ autoDrives: false })} />);
    expect(screen.queryByTestId('start-caption')).toBeNull();
  });

  test('after one or two drives it counts down to the stats and keeps those drives reachable', async () => {
    await draw(<HomeView {...props({ driveCount: 2, recent: [drive()] })} />);
    expect(screen.getByText('1 more drive to unlock your stats')).toBeOnTheScreen();
    expect(screen.getByText('Nice start. Your stats show up here after 3 drives.')).toBeOnTheScreen();
    expect(screen.queryByTestId('stats-card')).toBeNull();
    expect(screen.getByTestId('recent-drives')).toBeOnTheScreen();
  });
});

describe('Start drive', () => {
  test('starts from a swipe of the Start drive capsule at the foot of the drive card, never a tap', async () => {
    const p = props();
    await draw(<HomeView {...p} />);
    const start = within(screen.getByTestId('home-header')).getByRole('button', { name: 'Start drive' });
    expect(start).toHaveProp('accessibilityHint', "Swipe right to start. Recording begins once you're moving.");
    await press(start).catch(() => {});
    expect(p.onStart).not.toHaveBeenCalled();
    await swipe(start);
    expect(p.onStart).toHaveBeenCalled();
  });

  test('busy while a start is under way, and gone while a drive records or waits', async () => {
    await draw(<HomeView {...props({ starting: true })} />);
    expect(screen.getByTestId('start-drive')).toBeDisabled();
    await draw(<HomeView {...props({ recording: true, autoDrives: true, inProgress: <Text testID="in-progress">Drive in progress</Text> })} />);
    expect(screen.queryByTestId('start-drive')).toBeNull();
    expect(screen.queryByTestId('start-caption')).toBeNull();
    expect(screen.getByTestId('home-header')).toBeOnTheScreen();
  });

  test('Start stays on the card while the rating loads or fails', async () => {
    await draw(<HomeView {...props({ summary: undefined, summaryLoading: true })} />);
    expect(screen.getByTestId('start-drive')).toBeOnTheScreen();
    expect(screen.getByTestId('home-header-loading')).toBeOnTheScreen();
  });

  test('the avatar beside the greeting opens Profile', async () => {
    const onProfile = jest.fn();
    await draw(<HomeView {...props({ onProfile })} />);
    await press(screen.getByRole('button', { name: 'Profile' }));
    expect(onProfile).toHaveBeenCalled();
  });

  test.each([
    ['stopped', 'no_movement', 'Drive ended: the car didn’t move for 5 min, so it wasn’t saved.'],
    ['stopped', 'no_gps', 'Drive ended: there was no GPS signal, so it wasn’t saved.'],
    ['stopped', 'not_driven', 'Drive ended: the car never reached driving speed, so it wasn’t saved.'],
    ['limit', 'no_movement', 'Drive ended: the car didn’t move for 5 min, so it wasn’t saved.'],
    ['walking', 'not_driven', 'You walked away before driving, so the drive wasn’t saved.'],
    ['manual', 'not_driven', 'The car never reached driving speed, so the drive wasn’t saved.'],
    ['manual', 'no_movement', 'The car never moved, so the drive wasn’t saved.'],
    ['manual', 'no_gps', 'There was no GPS signal, so the drive wasn’t saved.'],
    ['orphan', 'not_driven', 'RoadWise closed during a drive that never reached driving speed, so it wasn’t saved.'],
    ['orphan', 'no_movement', 'RoadWise closed during a drive that never moved, so it wasn’t saved.'],
    ['orphan', 'no_gps', 'RoadWise closed during a drive with no GPS signal, so it wasn’t saved.'],
  ] as const)('a drive not kept (%s, %s) says why above Start, in at most 90 characters', async (cause, reason, line) => {
    expect(dropCopy(cause, reason)).toBe(line);
    expect(line.length).toBeLessThanOrEqual(90);
    const onDismiss = jest.fn();
    await draw(<HomeView {...props({ dropNotice: { message: dropCopy(cause, reason), onDismiss } })} />);
    expect(screen.getByTestId('drive-dropped')).toHaveTextContent(line, { exact: false });
    await press(screen.getByText('OK'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('a refusal outranks the information line; no line without one', async () => {
    await draw(<HomeView {...props({ refusal: 'busy', dropNotice: { message: dropCopy('stopped', 'no_movement'), onDismiss: jest.fn() } })} />);
    expect(screen.getByTestId('start-refusal')).toBeOnTheScreen();
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    await draw(<HomeView {...props()} />);
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
  });

  test('refused without location: one line with its fix', async () => {
    await draw(<HomeView {...props({ refusal: 'permission' })} />);
    expect(screen.getByTestId('start-refusal')).toHaveTextContent(/RoadWise needs location to record a drive\./);
    expect(screen.getByText('Fix it')).toBeOnTheScreen();
  });
});

describe('the action items', () => {
  const card = <Text testID="perm-card">{"Location is off. Drives can't record."}</Text>;
  const weather = <Text testID="weather-slot">Dense fog</Text>;
  const dashpal = <Text testID="dashpal-slot">A new phone was paired</Text>;
  const fair = { level: 'fair' as const, axis: 'speed' as const, title: 'Watch your speed', tip: 'Ease off a little over the limit.', also: [] };

  test('directly under the drive card, in order: weather, permission, DashPal, tip; then stats, drives, goals, and How it works last', async () => {
    await draw(<HomeView {...props({ weather, permissions: card, dashpal, coaching: fair })} />);
    const tree = JSON.stringify(screen.toJSON());
    const at = (s: string) => {
      const i = tree.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('Hey, lurp'),
      at('4 drives · 38 mi'),
      at('Safety Rating'),
      at('Start drive'),
      at('Dense fog'),
      at("Location is off. Drives can't record."),
      at('A new phone was paired'),
      at('Watch your speed'),
      at('Last 7 days'),
      at('Recent drives'),
      at("This week's goals"),
      at('How it works'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the permission card is not shown while a drive records (the in-progress strip shows under the greeting)', async () => {
    await draw(<HomeView {...props({ permissions: card, recording: true, inProgress: <Text testID="in-progress">Drive in progress</Text> })} />);
    expect(screen.queryByTestId('perm-card')).toBeNull();
    expect(screen.getByTestId('in-progress')).toBeOnTheScreen();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('Drive in progress')).toBeGreaterThan(tree.indexOf('Hey, lurp'));
    expect(tree.indexOf('Drive in progress')).toBeLessThan(tree.indexOf('4 drives · 38 mi'));
  });

  test('the DashPal slot stays while a drive records (it hides its own cards; a setup sheet it opened stays)', async () => {
    await draw(<HomeView {...props({ permissions: card, dashpal, recording: true, inProgress: <Text>Drive in progress</Text> })} />);
    expect(screen.getByTestId('dashpal-slot')).toBeOnTheScreen();
  });

  test('How it works is last for a first-run driver too', async () => {
    await draw(<HomeView {...props({ driveCount: 1, recent: [drive()], weather })} />);
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('How it works')).toBeGreaterThan(tree.indexOf('Recent drives'));
    expect(tree.indexOf('How it works')).toBeGreaterThan(tree.indexOf('1 more drive'));
  });
});

describe('the coaching tip card', () => {
  test.each(['fair', 'poor'] as const)('%s: the level icon at the left, the title and the tip; it opens Analytics', async (level) => {
    const p = props({ coaching: { level, axis: 'braking', title: 'Brake earlier', tip: 'Look further ahead and ease off sooner.', also: [] } });
    await draw(<HomeView {...p} />);
    const label = `${level === 'fair' ? 'Fair' : 'Poor'}. Brake earlier. Look further ahead and ease off sooner.`;
    expect(screen.getByTestId(`home-tip-${level}`)).toBeOnTheScreen();
    await press(screen.getByLabelText(label));
    expect(p.onAnalytics).toHaveBeenCalledTimes(1);
  });

  test('not when driving is good, or with too little driving to judge', async () => {
    await draw(<HomeView {...props({ coaching: { level: 'good', axis: null, title: 'Driving well', tip: 'Smooth driving lately. Keep it up.', also: [] } })} />);
    expect(screen.queryByTestId('home-tip')).toBeNull();
    await draw(<HomeView {...props({ coaching: { level: null, axis: null, title: 'Tips are on the way', tip: 'Drive a few more times to get tips here.', also: [] } })} />);
    expect(screen.queryByTestId('home-tip')).toBeNull();
  });
});

describe('on the sky', () => {
  test('the greeting is a header in the white sky ink, and pull to refresh spins in it', async () => {
    await draw(
      <Screen sky padded={false}>
        <HomeView {...props({ onRefresh: jest.fn() })} />
      </Screen>
    );
    expect(screen.getByRole('header', { name: 'Hey, lurp' })).toHaveStyle({ color: '#FFFFFF' });
    const { refreshControl } = screen.getByTestId('home').props as { refreshControl: { props: { tintColor: string } } };
    expect(refreshControl.props.tintColor).toBe('#FFFFFF');
  });

  test('the week pills sit on paper, so they read wherever the fade falls', async () => {
    await draw(
      <Screen sky padded={false}>
        <HomeView {...props()} />
      </Screen>
    );
    expect(screen.getByTestId('home-week-drives')).toHaveStyle({ backgroundColor: tokens.color.light.surface });
  });
});

test('the header says so when the rating cannot load', async () => {
  const p = props({ summary: undefined, summaryError: true });
  await draw(<HomeView {...p} />);
  expect(screen.getByText("Couldn't load your rating")).toBeOnTheScreen();
  await press(screen.getByText('Try again'));
  expect(p.onRetrySummary).toHaveBeenCalled();
});

describe('units and rounding', () => {
  afterEach(() => resetUnitsForTests());

  test('km: the stats card shows the same counts, the week pill and the distance to a rating convert', async () => {
    publishUnits('km');
    await draw(<HomeView {...props({ summary: summary({ profile: { units: 'km' }, progress: { ranked: false, safety_rating: null, miles_90d: 6 } }) })} />);
    expect(screen.getByLabelText('Speeding events, 3, Needs work, Up, worse vs your 30-day average')).toBeOnTheScreen();
    expect(screen.queryByText(/per 100/)).toBeNull();
    expect(screen.getByText('4 drives · 62 km')).toBeOnTheScreen();
    expect(screen.getByText('9 of 16 km to your rating')).toBeOnTheScreen();
  });

  test('the rating is a whole number', async () => {
    await draw(<HomeView {...props({ summary: summary({ progress: { safety_rating: 91.7, ranked: true } }) })} />);
    expect(screen.getByTestId('rating-value')).toHaveTextContent('92');
  });
});
