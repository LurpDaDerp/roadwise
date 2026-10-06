import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { friendRow, globalBoard, league, leagueMember } from '../__fixtures__/data';
import { callsTo, renderScreen, resetHarness, respond, router, rpcError } from '../__fixtures__/harness';
import { LeaguesScreen } from '../LeaguesScreen';
import { FRIENDS_ADD_HREF, profileHref } from '../routes';

jest.mock('@/data/server/rpc', () => jest.requireActual('@/features/leagues/__fixtures__/harness').rpcModule);
jest.mock('@/data/supabase/session', () => jest.requireActual('@/features/leagues/__fixtures__/harness').sessionModule);
jest.mock('expo-router', () => jest.requireActual('@/features/leagues/__fixtures__/harness').routerModule);

afterEach(resetHarness);

const HOUR = 3_600_000;
/** ends_at so the countdown reads "Ends in 2d 4h" whatever the wall clock says. */
const endsIn2d4h = () => new Date(Date.now() + 52 * HOUR + 30 * 60_000).toISOString();

const friends = [
  friendRow('amy', { rank: 1, value: 420 }),
  friendRow('maya', { rank: 2, value: 300, is_me: true, user_id: 'id-me' }),
  friendRow('zed', { rank: 3, value: 10 }),
];
const friendsRating = [
  friendRow('amy', { rank: 1, value: 96.4 }),
  friendRow('maya', { rank: 2, value: 91.2, is_me: true, user_id: 'id-me' }),
  friendRow('rookie', { rank: 3, value: null, ranked: false }),
];

function wire(over: Record<string, unknown> = {}) {
  respond({
    get_friends_board: (a: Record<string, unknown>) => (a.p_metric === 'rating' ? friendsRating : friends),
    get_my_league: league({ ends_at: endsIn2d4h() }),
    get_global_board: globalBoard(),
    ...over,
  });
}

describe('Friends & clan (default)', () => {
  test('weekly points board, your row marked, rows open profiles', async () => {
    wire();
    await renderScreen(<LeaguesScreen />);
    expect(await screen.findByTestId('friend-row-amy')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Friends & clan' })).toBeSelected();
    expect(callsTo('get_friends_board')).toEqual([{ p_metric: 'week' }]);
    expect(screen.getByLabelText(/^Number 2, maya, You, Level 2, 300 points$/)).toBeOnTheScreen();
    expect(within(screen.getByTestId('friend-row-amy')).getByText('420')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: /^Number 1, amy/ }));
    expect(router.push).toHaveBeenCalledWith(profileHref('amy'));
  });

  test('Safety Rating toggle: unranked drivers show "Unranked", never a number', async () => {
    wire();
    await renderScreen(<LeaguesScreen />);
    await screen.findByTestId('friend-row-amy');
    await fireEvent.press(screen.getByTestId('metric-rating'));
    expect(await screen.findByTestId('friend-row-rookie')).toBeOnTheScreen();
    expect(callsTo('get_friends_board')).toContainEqual({ p_metric: 'rating' });
    const rookie = within(screen.getByTestId('friend-row-rookie'));
    expect(rookie.getByText('Unranked')).toBeOnTheScreen();
    expect(rookie.getByText('–')).toBeOnTheScreen();
    expect(within(screen.getByTestId('friend-row-amy')).getByText('96.4')).toBeOnTheScreen();
  });

  test('switching metric keeps the old board, read with its own metric, until the new one lands', async () => {
    let release: (rows: unknown) => void = () => {};
    wire({
      get_friends_board: (a: Record<string, unknown>) =>
        a.p_metric === 'rating' ? new Promise((r) => (release = r)) : friends,
    });
    await renderScreen(<LeaguesScreen />);
    await screen.findByTestId('friend-row-amy');
    await fireEvent.press(screen.getByTestId('metric-rating'));
    await waitFor(() => expect(callsTo('get_friends_board')).toContainEqual({ p_metric: 'rating' }));
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
    expect(within(screen.getByTestId('friend-row-amy')).getByText('420')).toBeOnTheScreen();
    release(friendsRating);
    expect(await screen.findByText('96.4')).toBeOnTheScreen();
  });

  test('just you: an invite to add friends', async () => {
    wire({ get_friends_board: [friendRow('maya', { is_me: true })] });
    await renderScreen(<LeaguesScreen />);
    expect(await screen.findByTestId('friends-empty')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add friends' }));
    expect(router.push).toHaveBeenCalledWith(FRIENDS_ADD_HREF);
  });

  test('a failed first load offers a retry', async () => {
    wire({ get_friends_board: rpcError('boom') });
    await renderScreen(<LeaguesScreen />);
    expect(await screen.findByText("Couldn't load this board")).toBeOnTheScreen();
    wire();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('friend-row-amy')).toBeOnTheScreen();
  });
});

describe('League', () => {
  const open = async () => {
    await renderScreen(<LeaguesScreen />);
    await fireEvent.press(screen.getByRole('tab', { name: 'League' }));
  };

  test('placed: tier, countdown, zones with labelled lines, your rank', async () => {
    const members = league().members.map((m) => (m.rank === 4 ? leagueMember(4, { is_me: true, drives: 2, username: 'maya' }) : m));
    wire({ get_my_league: league({ ends_at: endsIn2d4h(), members }) });
    await open();
    expect(await screen.findByText('Gold league')).toBeOnTheScreen();
    expect(screen.getByText('Ends in 2d 4h', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByLabelText('League week ends in 2 days 4 hours')).toBeOnTheScreen();
    expect(screen.getByTestId('league-rules')).toHaveTextContent('Top 7 move up · Bottom 5 move down · 3 drives to move up');
    expect(screen.getByTestId('league-drives-left')).toHaveTextContent('Drive 1 more time this week to move up.');
    expect(screen.getByText('#4')).toBeOnTheScreen();
    expect(screen.getByTestId('zone-up')).toHaveTextContent(/Moves up/);
    expect(screen.getByLabelText(/^Number 7, driver7, .*moves up$/)).toBeOnTheScreen();
    // a top spot short of the drive minimum is not marked as moving up
    expect(screen.getByLabelText(/^Number 4, maya, You, Level 3 · 2 drives · needs 1 more drive, 960 points$/)).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Number 8, driver8, Level 3 · 4 drives, 920 points$/)).toBeOnTheScreen();
  });

  test('the demotion zone is labelled at the bottom of a full group', async () => {
    wire();
    await open();
    await screen.findByText('Gold league');
    expect(await screen.findByTestId('zone-down')).toHaveTextContent(/Moves down/);
    expect(screen.getByLabelText(/^Number 26, driver26, .*moves down$/)).toBeOnTheScreen();
  });

  test('unplaced: drive this week to join', async () => {
    wire({ get_my_league: league({ ends_at: endsIn2d4h(), placed: false, group_id: null, members: [], size: 0 }) });
    await open();
    expect(await screen.findByText('Drive this week to join a Gold league')).toBeOnTheScreen();
    expect(screen.queryByTestId('zone-up')).toBeNull();
  });

  test('a phone whose league slot belongs to another account', async () => {
    wire({ get_my_league: league({ eligible: false, placed: false, members: [], size: 0 }) });
    await open();
    expect(await screen.findByText('Leagues are one account per phone')).toBeOnTheScreen();
  });

  test("last week's result", async () => {
    wire({
      get_my_league: league({
        ends_at: endsIn2d4h(),
        last_result: { week: '2026-W40', result: 'promoted', final_rank: 2, tier: 'silver' },
      }),
    });
    await open();
    expect(await screen.findByTestId('last-result')).toHaveTextContent(/You finished #2 last week and moved up to Gold!/);
  });
});

describe('Global', () => {
  const open = async () => {
    await renderScreen(<LeaguesScreen />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Global' }));
  };

  test('eligible: your percentile and your row', async () => {
    wire();
    await open();
    expect(await screen.findByText("You're in the top 8%")).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Number 2, maya, You, 220 clean mi, 97.1$/)).toBeOnTheScreen();
    expect(within(screen.getByTestId('global-row-1')).getByText('99.4')).toBeOnTheScreen();
    expect(screen.getByText('410 clean mi')).toBeOnTheScreen();
  });

  test('not eligible: what it takes to join', async () => {
    wire({ get_global_board: globalBoard({ me: { rank: null, percentile: null, eligible: false, safety_rating: 80 } }) });
    await open();
    expect(await screen.findByText('Drive 100 mi in 30 days to join')).toBeOnTheScreen();
    expect(screen.queryByText(/top \d+%/)).toBeNull();
  });

  test('a new state filter keeps the last board on screen until its own lands', async () => {
    let release: (b: unknown) => void = () => {};
    wire({
      get_global_board: (a: Record<string, unknown>) =>
        a.p_state === 'TX' ? new Promise((r) => (release = r)) : globalBoard(),
    });
    await open();
    await screen.findByText("You're in the top 8%");
    await fireEvent.press(screen.getByTestId('state-filter'));
    await fireEvent.press(await screen.findByTestId('state-TX'));
    await waitFor(() => expect(callsTo('get_global_board')).toContainEqual({ p_state: 'TX' }));
    expect(screen.getByTestId('global-row-1')).toBeOnTheScreen();
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
    release(globalBoard({ top: [], me: { rank: null, percentile: null, eligible: true, safety_rating: 97 } }));
    expect(await screen.findByTestId('global-empty')).toBeOnTheScreen();
  });

  test('the state filter asks for that state only', async () => {
    wire();
    await open();
    await screen.findByText("You're in the top 8%");
    await fireEvent.press(screen.getByTestId('state-filter'));
    await fireEvent.press(await screen.findByTestId('state-TX'));
    await waitFor(() => expect(callsTo('get_global_board')).toContainEqual({ p_state: 'TX' }));
    expect(callsTo('get_global_board')[0]).toEqual({ p_state: null });
    expect(await screen.findByTestId('global-board')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Texas' })).toBeOnTheScreen();
  });
});
