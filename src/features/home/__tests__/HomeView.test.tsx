import { screen, within } from '@testing-library/react-native';
import { Text } from 'react-native';

import { draw, drive, NOW, press, summary, sums } from '@/features/drives/__fixtures__/drives';
import { publishUnits, resetUnitsForTests } from '@/data/queries/units';
import { contrastRatio, Screen } from '@/ui';
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
  onAnalytics: jest.fn(),
  ...over,
});

describe('the full Home', () => {
  test('header: two pills (streak and points), the level on the drive card and the Safety Rating badge in its corner', async () => {
    const p = props();
    await draw(<HomeView {...p} />);
    expect(screen.getByText('Hey, lurp')).toBeOnTheScreen();
    const strip = screen.getByTestId('home-progress');
    expect(within(strip).getByLabelText('Streak 11 drives, multiplier 1.22')).toBeOnTheScreen();
    expect(within(strip).getByLabelText('1,240 points')).toBeOnTheScreen();
    // No freezes pill and no level pill: the level lives on the drive card.
    expect(screen.queryByLabelText('2 of 3 freezes held')).toBeNull();
    expect(within(strip).queryByText(/Lvl/)).toBeNull();
    const card = screen.getByTestId('home-header');
    expect(within(card).getByLabelText('Level 4, 1,000 points to level 5')).toBeOnTheScreen();
    expect(within(card).getByTestId('level-value')).toHaveTextContent('4');
    expect(within(card).getByText('1,000 pts to level 5')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Level 4 progress')).toBeOnTheScreen();
    // The badge where the league was: the whole rating, and it opens Analytics.
    const badge = within(card).getByLabelText('Safety Rating 92 out of 100');
    expect(within(card).getByTestId('rating-value')).toHaveTextContent('92');
    expect(screen.queryByTestId('league-badge')).toBeNull();
    expect(screen.queryByText(/league/i)).toBeNull();
    await press(badge);
    expect(p.onAnalytics).toHaveBeenCalledTimes(1);
  });

  test('at the top level the card says so', async () => {
    await draw(<HomeView {...props({ summary: summary({ progress: { level: 50, level_floor: 306_250, level_next: null, lifetime: 310_000 } }) })} />);
    expect(screen.getByLabelText('Level 50, top level')).toBeOnTheScreen();
    expect(screen.getByText('Top level')).toBeOnTheScreen();
  });

  test('an unranked driver sees a dash in the badge, with Unranked and how far to go', async () => {
    const p = props({ summary: summary({ progress: { ranked: false, safety_rating: null, miles_30d: 12.7 } }) });
    await draw(<HomeView {...p} />);
    expect(screen.getByTestId('rating-value')).toHaveTextContent('—');
    expect(screen.getByText('Unranked')).toBeOnTheScreen();
    expect(screen.getByText('12/25 mi')).toBeOnTheScreen();
    await press(screen.getByLabelText('Safety Rating: unranked. 12 of 25 miles in the last 30 days to get ranked'));
    expect(p.onAnalytics).toHaveBeenCalled();
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
    expect(within(screen.getByTestId('first-run')).queryByTestId('how-it-works')).toBeNull();
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
  test('starts from the Start drive capsule at the foot of the drive card, with no DMS chip beside it', async () => {
    const p = props();
    await draw(<HomeView {...p} />);
    expect(within(screen.getByTestId('home-header')).getByTestId('start-drive')).toBeOnTheScreen();
    await press(screen.getByRole('button', { name: 'Start drive' }));
    expect(p.onStart).toHaveBeenCalled();
    expect(screen.queryByTestId('dms-chip')).toBeNull();
  });

  test('busy while a start is under way, and gone while a drive records', async () => {
    await draw(<HomeView {...props({ starting: true })} />);
    expect(screen.getByTestId('start-drive')).toBeDisabled();
    await draw(<HomeView {...props({ recording: true, inProgress: <Text testID="in-progress">Drive in progress</Text> })} />);
    expect(screen.queryByTestId('start-drive')).toBeNull();
    expect(screen.getByTestId('home-header')).toBeOnTheScreen();
  });

  test('Start stays on the card while progress loads or fails', async () => {
    await draw(<HomeView {...props({ summary: undefined, summaryLoading: true })} />);
    expect(screen.getByTestId('start-drive')).toBeOnTheScreen();
    expect(screen.queryByTestId('home-progress')).toBeNull();
  });

  test('the avatar beside the greeting opens Profile', async () => {
    const onProfile = jest.fn();
    await draw(<HomeView {...props({ onProfile })} />);
    await press(screen.getByRole('button', { name: 'Profile' }));
    expect(onProfile).toHaveBeenCalled();
  });

  test.each([
    ['stopped', 'no_movement', 'Drive ended: the car didn’t move for 15 min, so it wasn’t saved.'],
    ['stopped', 'no_gps', 'Drive ended: there was no GPS signal, so it wasn’t saved.'],
    ['stopped', 'not_driven', 'Drive ended: the car never reached driving speed, so it wasn’t saved.'],
    ['limit', 'not_driven', 'Drive ended: the car never reached driving speed, so it wasn’t saved.'],
    ['walking', 'not_driven', 'You walked away before driving, so the drive wasn’t saved.'],
    ['manual', 'not_driven', 'The car never reached driving speed, so the drive wasn’t saved.'],
    ['orphan', 'not_driven', 'RoadWise closed during a drive that never reached driving speed, so it wasn’t saved.'],
    ['limit', 'no_movement', 'Drive ended: the car didn’t move for 15 min, so it wasn’t saved.'],
    ['limit', 'no_gps', 'Drive ended: there was no GPS signal, so it wasn’t saved.'],
    ['walking', 'no_movement', 'You walked away before driving, so the drive wasn’t saved.'],
    ['walking', 'no_gps', 'You walked away before driving, so the drive wasn’t saved.'],
    ['manual', 'no_movement', 'The car never moved, so the drive wasn’t saved.'],
    ['manual', 'no_gps', 'There was no GPS signal, so the drive wasn’t saved.'],
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

describe('the action items', () => {
  const card = <Text testID="perm-card">{"Location is off. Drives can't record."}</Text>;
  const weather = <Text testID="weather-slot">Dense fog</Text>;
  const dashpal = <Text testID="dashpal-slot">A new phone was paired</Text>;
  const fair = { level: 'fair' as const, axis: 'speeding' as const, title: 'Watch your speed', tip: 'Ease off a little over the limit.' };

  test('directly under the drive card, in order: weather, streak, permission, DashPal, tip; then stats, and How it works last', async () => {
    await draw(
      <HomeView
        {...props({ weather, permissions: card, dashpal, coaching: fair, streakNews: { clientTripId: 'a', outcome: 'reset' }, onDismissStreak: jest.fn() })}
      />
    );
    const tree = JSON.stringify(screen.toJSON());
    const at = (s: string) => {
      const i = tree.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('Hey, lurp'),
      at('1,240'),
      at('Start drive'),
      at('Dense fog'),
      at('Streak lost'),
      at("Location is off. Drives can't record."),
      at('A new phone was paired'),
      at('Watch your speed'),
      at('Last 7 days'),
      at('Recent drives'),
      at('Weekly challenges'),
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
    expect(tree.indexOf('Drive in progress')).toBeLessThan(tree.indexOf('1,240'));
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

describe('the streak card', () => {
  test.each([
    ['reset', 2, 'Streak lost', '2 freezes left'],
    ['reset', 0, 'Streak lost', 'No freezes left'],
    ['freeze_used', 1, 'A freeze saved your streak', '1 freeze left'],
    ['freeze_used', 3, 'A freeze saved your streak', '3 freezes left'],
  ] as const)('%s with %i freezes: "%s" / "%s", with the flakes', async (outcome, freezes, title, left) => {
    const onDismissStreak = jest.fn();
    await draw(<HomeView {...props({ summary: summary({ progress: { freezes } }), streakNews: { clientTripId: 'a', outcome }, onDismissStreak })} />);
    const c = screen.getByTestId('home-streak-card');
    expect(within(c).getByText(title)).toBeOnTheScreen();
    expect(within(c).getByText(left)).toBeOnTheScreen();
    // the flakes are drawn, and a screen reader hears the freezes once, as the words
    expect(within(c).getByTestId('home-streak-card-freezes', { includeHiddenElements: true })).toBeTruthy();
    expect(within(c).getByLabelText(left)).toBeOnTheScreen();
    expect(within(c).queryByLabelText(`${freezes} of 3 freezes held`)).toBeNull();
    expect(within(c).getByRole('button', { name: 'Hide streak news' })).toHaveProp('accessibilityHint', 'Hides the news from this drive.');
    await press(within(c).getByLabelText('Hide streak news'));
    expect(onDismissStreak).toHaveBeenCalledTimes(1);
  });

  test('no news: no card', async () => {
    await draw(<HomeView {...props({ streakNews: null })} />);
    expect(screen.queryByTestId('home-streak-card')).toBeNull();
  });
});

describe('the coaching tip card', () => {
  test.each(['fair', 'poor'] as const)('%s: the level icon at the left, the title and the tip; it opens Analytics', async (level) => {
    const p = props({ coaching: { level, axis: 'phone', title: 'Phone down while driving', tip: 'Put the phone away before you pull out.' } });
    await draw(<HomeView {...p} />);
    const label = `${level === 'fair' ? 'Fair' : 'Poor'}. Phone down while driving. Put the phone away before you pull out.`;
    expect(screen.getByTestId(`home-tip-${level}`)).toBeOnTheScreen();
    await press(screen.getByLabelText(label));
    expect(p.onAnalytics).toHaveBeenCalledTimes(1);
  });

  test('not when driving is good, or with too little driving to judge', async () => {
    await draw(<HomeView {...props({ coaching: { level: 'good', axis: null, title: 'Driving well', tip: 'Smooth driving lately. Keep it up.' } })} />);
    expect(screen.queryByTestId('home-tip')).toBeNull();
    await draw(<HomeView {...props({ coaching: { level: null, axis: null, title: 'Tips are on the way', tip: 'Drive a few more times to get tips here.' } })} />);
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

  test('the at-risk line sits on a paper ground in the page warning ink, so it reads wherever the fade falls', async () => {
    const s = summary();
    await draw(
      <Screen sky padded={false}>
        <HomeView {...props({ summary: { ...s, progress: { ...s.progress, at_risk: true } } })} />
      </Screen>
    );
    const c = tokens.color.light;
    expect(screen.getByTestId('home-at-risk-line')).toHaveStyle({ backgroundColor: c.surface });
    expect(screen.getByTestId('home-at-risk')).toHaveStyle({ color: c.warning });
    expect(contrastRatio(c.warning, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.color.dark.warning, tokens.color.dark.surface)).toBeGreaterThanOrEqual(4.5);
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
    expect(screen.getByText('19/40 km')).toBeOnTheScreen();
    expect(screen.getByLabelText('Safety Rating: unranked. 19 of 40 kilometers in the last 30 days to get ranked')).toBeOnTheScreen();
  });

  test('the rating is a whole number', async () => {
    const s = summary();
    await draw(<HomeView {...props({ summary: { ...s, progress: { ...s.progress, safety_rating: 91.7, ranked: true } } })} />);
    expect(screen.getByTestId('rating-value')).toHaveTextContent('92');
  });
});
