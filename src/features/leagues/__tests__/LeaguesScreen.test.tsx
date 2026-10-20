import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { friendRow, globalBoard } from '../__fixtures__/data';
import { callsTo, renderScreen, resetHarness, respond, router, rpcError } from '../__fixtures__/harness';
import { LeaguesScreen } from '../LeaguesScreen';
import { FRIENDS_ADD_HREF, profileHref } from '../routes';

jest.mock('@/data/server/rpc', () => jest.requireActual('@/features/leagues/__fixtures__/harness').rpcModule);
jest.mock('@/data/supabase/session', () => jest.requireActual('@/features/leagues/__fixtures__/harness').sessionModule);
jest.mock('expo-router', () => jest.requireActual('@/features/leagues/__fixtures__/harness').routerModule);

afterEach(resetHarness);

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
    get_global_board: globalBoard(),
    ...over,
  });
}

test('the Leaderboards tab has two boards: Friends and Global, no league', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  expect(screen.getByRole('header', { name: 'Leaderboards' })).toBeOnTheScreen();
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  expect(screen.getByRole('tab', { name: 'Friends' })).toBeOnTheScreen();
  expect(screen.getByRole('tab', { name: 'Global' })).toBeOnTheScreen();
  expect(screen.queryByRole('tab', { name: 'League' })).toBeNull();
  await screen.findByTestId('friend-row-amy');
  expect(callsTo('get_my_league')).toEqual([]);
});

test('the title and the pull-to-refresh spinner of both boards are white on the sky', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  expect(screen.getByRole('header', { name: 'Leaderboards' })).toHaveStyle({ color: '#FFFFFF' });
  const tint = (el: { props: unknown }) => (el.props as { refreshControl: { props: { tintColor: string } } }).refreshControl.props.tintColor;
  expect(tint(await screen.findByTestId('friends-board'))).toBe('#FFFFFF');
  await fireEvent.press(screen.getByRole('tab', { name: 'Global' }));
  expect(tint(await screen.findByTestId('global-board'))).toBe('#FFFFFF');
});

/** The nearest fill behind an element: the boards sit on the sky, so text needs a paper ground. */
type Node = { props: { style?: unknown }; parent: Node | null };
function ground(el: Node): string | undefined {
  for (let n: Node | null = el; n; n = n.parent) {
    const bg = (StyleSheet.flatten(n.props.style as object) as { backgroundColor?: string } | undefined)?.backgroundColor;
    if (bg !== undefined && bg !== 'transparent') return bg;
  }
  return undefined;
}

test('notes and empty states on the boards sit on a paper card, never on the open sky', async () => {
  wire({ get_friends_board: (a: Record<string, unknown>) => (a.p_metric === 'rating' ? [friendRow('maya', { is_me: true, value: null, ranked: false })] : [friendRow('maya', { is_me: true })]) });
  await renderScreen(<LeaguesScreen />);
  expect(ground(await screen.findByTestId('friends-empty'))).toBe('#FFFFFF');
  await fireEvent.press(screen.getByTestId('metric-rating'));
  expect(ground(await screen.findByText(/^Unranked drivers need/))).toBe('#FFFFFF');
  wire({ get_global_board: globalBoard({ me: { rank: null, percentile: null, eligible: true, safety_rating: 80 }, top: [] }) });
  await fireEvent.press(screen.getByRole('tab', { name: 'Global' }));
  expect(ground(await screen.findByTestId('global-not-in-state'))).toBe('#FFFFFF');
  expect(ground(screen.getByTestId('global-empty'))).toBe('#FFFFFF');
});

test('a failed load and a not-eligible card sit on paper too', async () => {
  wire({ get_friends_board: rpcError('boom'), get_global_board: globalBoard({ me: { rank: null, percentile: null, eligible: false, safety_rating: 80 } }) });
  await renderScreen(<LeaguesScreen />);
  expect(ground(await screen.findByTestId('load-failed'))).toBe('#FFFFFF');
  await fireEvent.press(screen.getByRole('tab', { name: 'Global' }));
  expect(ground(await screen.findByTestId('global-not-eligible'))).toBe('#FFFFFF');
});

describe('Friends (default)', () => {
  test('weekly points board, your row marked, rows open profiles', async () => {
    wire();
    await renderScreen(<LeaguesScreen />);
    expect(await screen.findByTestId('friend-row-amy')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Friends' })).toBeSelected();
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
    expect(within(screen.getByTestId('friend-row-amy')).getByText('96')).toBeOnTheScreen();
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
    expect(await screen.findByText('96')).toBeOnTheScreen();
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

describe('Global', () => {
  const open = async () => {
    await renderScreen(<LeaguesScreen />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Global' }));
  };

  test('eligible: your percentile and your row', async () => {
    wire();
    await open();
    expect(await screen.findByText("You're in the top 8%")).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Number 2, maya, You, 220 clean mi, 97$/)).toBeOnTheScreen();
    expect(within(screen.getByTestId('global-row-1')).getByText('99')).toBeOnTheScreen();
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

  test('the state sheet opened while the board loads stays the same sheet when the board lands', async () => {
    let release: (b: unknown) => void = () => {};
    wire({ get_global_board: () => new Promise((r) => (release = r)) });
    await open();
    await fireEvent.press(await screen.findByTestId('state-filter'));
    const sheet = await screen.findByTestId('state-sheet-modal');
    release(globalBoard());
    expect(await screen.findByTestId('global-board')).toBeOnTheScreen();
    // Not remounted: the same modal is still up (iOS would have closed it and refused a new one).
    expect(screen.getByTestId('state-sheet-modal')).toBe(sheet);
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
