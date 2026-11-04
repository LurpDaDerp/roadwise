import { screen, waitFor, within } from '@testing-library/react-native';

import type { CommutePlace } from '@/core/places/commute';
import type { ProblemSpot } from '@/data/queries/spots';
import { draw, drive, NOW, press, ROUTE } from '@/features/drives/__fixtures__/drives';
import { formatWhen } from '@/features/drives/format';
import type { LocalDrive } from '@/features/drives/model';
import { ThemeProvider } from '@/ui/theme';

import { CommuteCard } from '../CommuteCard';
import * as commuteModel from '../commuteModel';
import type { CommuteRow } from '../commuteModel';
import { CommuteSheet } from '../CommuteSheet';

const DAY = 86_400_000;
const HOME: CommutePlace = { id: 'home', kind: 'home', name: 'Home', lat: 40.7, lng: -74 };
const WORK: CommutePlace = { id: 'work', kind: 'work', name: 'Work', lat: 40.758, lng: -74 };
const SCHOOL: CommutePlace = { id: 'school', kind: 'school', name: 'School', lat: 40.8, lng: -74.1 };

const legDrives = (n: number, over: Partial<LocalDrive> = {}): LocalDrive[] =>
  Array.from({ length: n }, (_, i) => drive({ clientTripId: `c${i}`, startedAt: NOW - (i + 1) * DAY, fromPlace: 'home', toPlace: 'work', ...over }));

const row = (over: Partial<CommuteRow> = {}): CommuteRow => ({
  id: 'home-work',
  from: HOME,
  to: WORK,
  drives: legDrives(6),
  usualS: 24 * 60,
  departure: { minuteOfDay: 7 * 60 + 40, drives: 6 },
  score: 84,
  change: 3,
  scored: 9,
  ...over,
});

/** A spot on the fixture route (it runs north), heading its way. */
const spot = (id: string, over: Partial<ProblemSpot> = {}): ProblemSpot =>
  ({
    id,
    kind: 'hard_brake',
    state: 'active',
    pin: ROUTE[10]!,
    headingDeg: 0,
    segment: [],
    limitMph: null,
    recentHits: 3,
    recentPasses: 6,
    cleanStreak: 0,
    cleanNeeded: 3,
    label: 'Main St',
    ...over,
  }) as ProblemSpot;

describe('CommuteCard', () => {
  test('hidden with no leg to show', async () => {
    await draw(<CommuteCard rows={[]} onOpen={jest.fn()} />);
    expect(screen.queryByTestId('analytics-commute')).toBeNull();
  });

  test('"Your commute", last 4 months: a row per leg with its usual time, departure and score', async () => {
    const onOpen = jest.fn();
    await draw(
      <CommuteCard rows={[row(), row({ id: 'school-home', from: SCHOOL, to: HOME, usualS: 15 * 60, departure: null, score: 77, change: null, scored: 4 })]} onOpen={onOpen} />
    );
    const card = screen.getByTestId('analytics-commute');
    expect(within(card).getByRole('header', { name: 'Your commute' })).toBeOnTheScreen();
    expect(within(card).getByText('Last 4 months')).toBeOnTheScreen();
    const first = within(card).getByTestId('analytics-commute-home-work');
    expect(within(first).getByText('Home → Work')).toBeOnTheScreen();
    expect(within(first).getByText('Usually 24 min · Leave around 7:40 AM')).toBeOnTheScreen();
    expect(within(first).getByTestId('analytics-commute-score-home-work')).toHaveTextContent('Score 84 · Up 3');
    expect(first).toHaveAccessibleName('Home to Work, Usually 24 minutes, Leave around 7:40 AM, Score 84, Up 3');
    const second = within(card).getByTestId('analytics-commute-school-home');
    expect(within(second).getByText('School → Home')).toBeOnTheScreen();
    expect(within(second).getByText('Usually 15 min')).toBeOnTheScreen();
    expect(within(second).getByTestId('analytics-commute-score-school-home')).toHaveTextContent('Score 77');
    await press(second);
    expect(onOpen).toHaveBeenCalledWith('school-home');
  });

  test('no score line while the scores load', async () => {
    await draw(<CommuteCard rows={[row({ score: null, change: null, scored: 0 })]} onOpen={jest.fn()} />);
    expect(screen.queryByTestId('analytics-commute-score-home-work')).toBeNull();
    expect(screen.queryByText(/Score/)).toBeNull();
  });
});

describe('CommuteSheet', () => {
  const props = {
    onClose: jest.fn(),
    onOpenSpot: jest.fn(),
    onOpenDrive: jest.fn(),
  };
  beforeEach(() => jest.clearAllMocks());

  test('the leg up close: usual time, departure, score, the spots on the way and the 3 newest drives', async () => {
    const r = row();
    await draw(<CommuteSheet row={r} visible spots={[spot('s1'), spot('s2', { headingDeg: 180 })]} {...props} />);
    const sheet = screen.getByTestId('commute-sheet');
    expect(within(sheet).getByRole('header', { name: 'Home → Work' })).toBeOnTheScreen();
    expect(within(sheet).getByTestId('commute-usual')).toHaveAccessibleName('Usually 24 min, From 6 drives in the last 4 months');
    expect(within(sheet).getByTestId('commute-leave')).toHaveAccessibleName('Leave around 7:40 AM, On weekdays');
    expect(within(sheet).getByTestId('commute-score')).toHaveAccessibleName('Score 84, Your last 5 drives, up 3 from the 4 before');
    // s2 is on the road but heads the other way.
    const spots = within(sheet).getByTestId('commute-spots');
    expect(within(spots).getByRole('header', { name: 'Spots on the way' })).toBeOnTheScreen();
    expect(within(spots).getByTestId('commute-spot-s1')).toHaveAccessibleName('Main St, Hard braking, 3 of your last 6 drives here');
    expect(within(spots).queryByTestId('commute-spot-s2')).toBeNull();
    const drives = within(sheet).getByTestId('commute-drives');
    expect(within(drives).getByRole('header', { name: 'Recent drives' })).toBeOnTheScreen();
    expect(within(drives).getAllByTestId(/^commute-drive-/).map((el) => el.props.testID)).toEqual(['commute-drive-c0', 'commute-drive-c1', 'commute-drive-c2']);
    expect(within(drives).getByText(formatWhen(r.drives[0]!.startedAt))).toBeOnTheScreen();

    await press(within(spots).getByTestId('commute-spot-s1'));
    expect(props.onOpenSpot).toHaveBeenCalledWith('s1');
    await press(within(drives).getByTestId('commute-drive-c1'));
    expect(props.onOpenDrive).toHaveBeenCalledWith('c1');
  });

  test('no departure, no change yet, no spots on the way: those parts are left out', async () => {
    await draw(<CommuteSheet row={row({ departure: null, change: null, scored: 3, drives: legDrives(3) })} visible spots={[spot('s1', { pin: { lat: 41, lng: -75 } })]} {...props} />);
    const sheet = screen.getByTestId('commute-sheet');
    expect(within(sheet).queryByTestId('commute-leave')).toBeNull();
    expect(within(sheet).getByTestId('commute-score')).toHaveAccessibleName('Score 84, Your last 3 drives');
    expect(within(sheet).queryByTestId('commute-spots')).toBeNull();
    expect(within(sheet).getAllByTestId(/^commute-drive-/)).toHaveLength(3);
  });

  test('a steady score says so; no score at all shows no score block', async () => {
    const view = await draw(<CommuteSheet row={row({ change: 1, scored: 10 })} visible {...props} />);
    expect(screen.getByTestId('commute-score')).toHaveAccessibleName('Score 84, Your last 5 drives, about the same as the 5 before');
    expect(screen.getByTestId('commute-score')).toBeOnTheScreen();
    await view.rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <CommuteSheet row={row({ score: null, change: null, scored: 0 })} visible {...props} />
      </ThemeProvider>
    );
    expect(screen.queryByTestId('commute-score')).toBeNull();
    expect(screen.queryByTestId('commute-spots')).toBeNull();
  });

  test('a falling score', async () => {
    await draw(<CommuteSheet row={row({ change: -6, scored: 12 })} visible {...props} />);
    expect(screen.getByTestId('commute-score')).toHaveAccessibleName('Score 84, Your last 5 drives, down 6 from the 5 before');
  });

  test('the spots on the way are read only while the sheet is up, and kept for the slide out', async () => {
    const read = jest.spyOn(commuteModel, 'spotsOnTheWay');
    try {
      const sheet = (r: CommuteRow | null, visible: boolean, spots: ProblemSpot[]) => (
        <ThemeProvider scheme="light" reduceMotion>
          <CommuteSheet row={r} visible={visible} spots={spots} {...props} />
        </ThemeProvider>
      );
      const view = await draw(<CommuteSheet row={row()} visible spots={[spot('s1')]} {...props} />);
      expect(read).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('commute-spot-s1')).toBeOnTheScreen();
      // Closed: new drives, new spots and the leg let go cost nothing, and the old answer stays on the way out.
      await view.rerender(sheet(row(), false, [spot('s1')]));
      await view.rerender(sheet(row({ drives: legDrives(6) }), false, [spot('s1'), spot('s2')]));
      await view.rerender(sheet(null, false, [spot('s2')]));
      expect(read).toHaveBeenCalledTimes(1);
      // Open again: read afresh.
      await view.rerender(sheet(row(), true, [spot('s2')]));
      expect(read).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('commute-spot-s2')).toBeOnTheScreen();
      expect(screen.queryByTestId('commute-spot-s1')).toBeNull();
    } finally {
      read.mockRestore();
    }
  });

  test('closed, it shows nothing; it keeps the last leg while it slides away', async () => {
    const view = await draw(<CommuteSheet row={null} visible={false} {...props} />);
    expect(screen.queryByText('Home → Work')).toBeNull();
    await view.rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <CommuteSheet row={row()} visible {...props} />
      </ThemeProvider>
    );
    expect(screen.getByRole('header', { name: 'Home → Work' })).toBeOnTheScreen();
    await view.rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <CommuteSheet row={null} visible={false} {...props} />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.queryByTestId('commute-sheet')).toBeNull());
  });
});
