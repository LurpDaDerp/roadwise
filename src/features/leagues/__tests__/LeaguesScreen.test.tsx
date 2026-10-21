import { fireEvent, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { publishUnits, resetUnitsForTests } from '@/data/queries/units';

import { friendRow } from '../__fixtures__/data';
import { callsTo, renderScreen, resetHarness, respond, router, rpcError } from '../__fixtures__/harness';
import { boardSubtitle } from '../FriendsBoard';
import { LeaguesScreen } from '../LeaguesScreen';
import { FRIENDS_ADD_HREF, profileHref } from '../routes';

jest.mock('@/data/server/rpc', () => jest.requireActual('@/features/leagues/__fixtures__/harness').rpcModule);
jest.mock('@/data/supabase/session', () => jest.requireActual('@/features/leagues/__fixtures__/harness').sessionModule);
jest.mock('expo-router', () => jest.requireActual('@/features/leagues/__fixtures__/harness').routerModule);

afterEach(async () => {
  resetUnitsForTests();
  await resetHarness();
});

const board = [
  friendRow('amy', { rank: 1, value: 96.4, miles_90d: 212 }),
  friendRow('maya', { rank: 2, value: 91.2, is_me: true, user_id: 'id-me', miles_90d: 128 }),
  // shares the rating but not the driving stats
  friendRow('quiet', { rank: 3, value: 85.1, miles_90d: null }),
  friendRow('rookie', { rank: 4, value: null, ranked: false, miles_90d: 4.6 }),
];

const wire = (over: Record<string, unknown> = {}) => respond({ get_friends_board: board, ...over });

const NO_POINTS = /\bpoints?\b|\bpts\b|level|weekly|global|leaderboard/i;

test('the Friends tab: one board by Safety Rating, no segments, no metric chips, no global board', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  expect(screen.getByRole('header', { name: 'Friends' })).toBeOnTheScreen();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(screen.queryByTestId('metric-week')).toBeNull();
  await screen.findByTestId('friend-row-amy');
  // one call, with no metric
  expect(callsTo('get_friends_board')).toEqual([undefined]);
  expect(callsTo('get_global_board')).toEqual([]);
  expect(screen.queryByText(NO_POINTS)).toBeNull();
});

test('rows: place, name, "You", the 90-day distance when shared, and the whole rating; they open profiles', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  const amy = await screen.findByTestId('friend-row-amy');
  expect(within(amy).getByText('96')).toBeOnTheScreen();
  expect(within(amy).getByText('212 mi in 90 days')).toBeOnTheScreen();
  expect(screen.getByLabelText(/^Number 2, maya, You, 128 mi in 90 days, 91$/)).toBeOnTheScreen();
  // a friend who keeps their driving stats to themselves: one line, no distance
  expect(screen.getByLabelText(/^Number 3, quiet, 85$/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: /^Number 1, amy/ }));
  expect(router.push).toHaveBeenCalledWith(profileHref('amy'));
});

test('a friend without a rating yet: a dash, no place, how far to go, spoken as "No rating yet"', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  const rookie = within(await screen.findByTestId('friend-row-rookie'));
  expect(rookie.getByText('—')).toBeOnTheScreen();
  expect(rookie.getByText('–')).toBeOnTheScreen();
  expect(rookie.getByText('4 of 10 mi to a rating')).toBeOnTheScreen();
  expect(screen.getByLabelText(/^Not placed, rookie, 4 of 10 mi to a rating, No rating yet$/)).toBeOnTheScreen();
  expect(screen.getByTestId('friends-caption')).toHaveTextContent('Ranked by Safety Rating, last 90 days. Drivers get a Safety Rating after 10 mi in 90 days.');
});

test('everyone rated: the caption alone', async () => {
  wire({ get_friends_board: board.slice(0, 2) });
  await renderScreen(<LeaguesScreen />);
  expect(await screen.findByTestId('friends-caption')).toHaveTextContent(/^Ranked by Safety Rating, last 90 days$/);
});

test('the subtitle in kilometres', () => {
  publishUnits('km');
  expect(boardSubtitle({ rank: 1, miles_90d: 128 }, 'km')).toBe('206 km in 90 days');
  expect(boardSubtitle({ rank: null, miles_90d: 4.6 }, 'km')).toBe('7 of 16 km to a rating');
  expect(boardSubtitle({ rank: 1, miles_90d: null }, 'km')).toBeUndefined();
});

test('the add-friends button beside the title opens Add friends', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  await fireEvent.press(screen.getByTestId('leagues-add'));
  expect(router.push).toHaveBeenCalledWith(FRIENDS_ADD_HREF);
  expect(screen.getByTestId('leagues-add')).toHaveProp('accessibilityLabel', 'Add friends');
});

test('the title and the pull-to-refresh spinner are white on the sky', async () => {
  wire();
  await renderScreen(<LeaguesScreen />);
  expect(screen.getByRole('header', { name: 'Friends' })).toHaveStyle({ color: '#FFFFFF' });
  const tint = (el: { props: unknown }) => (el.props as { refreshControl: { props: { tintColor: string } } }).refreshControl.props.tintColor;
  expect(tint(await screen.findByTestId('friends-board'))).toBe('#FFFFFF');
});

/** The nearest fill behind an element: the board sits on the sky, so text needs a paper ground. */
type Node = { props: { style?: unknown }; parent: Node | null };
function ground(el: Node): string | undefined {
  for (let n: Node | null = el; n; n = n.parent) {
    const bg = (StyleSheet.flatten(n.props.style as object) as { backgroundColor?: string } | undefined)?.backgroundColor;
    if (bg !== undefined && bg !== 'transparent') return bg;
  }
  return undefined;
}

test('notes and empty states sit on a paper card, never on the open sky', async () => {
  wire({ get_friends_board: [friendRow('maya', { is_me: true, value: null, ranked: false })] });
  await renderScreen(<LeaguesScreen />);
  expect(ground(await screen.findByTestId('friends-empty'))).toBe('#FFFFFF');
  expect(ground(screen.getByTestId('friends-caption'))).toBe('#FFFFFF');
});

test('just you: an invite to add friends', async () => {
  wire({ get_friends_board: [friendRow('maya', { is_me: true })] });
  await renderScreen(<LeaguesScreen />);
  expect(await screen.findByTestId('friends-empty')).toHaveTextContent(/Add friends to see how your Safety Ratings compare\./);
  await fireEvent.press(within(screen.getByTestId('friends-empty')).getByRole('button', { name: 'Add friends' }));
  expect(router.push).toHaveBeenCalledWith(FRIENDS_ADD_HREF);
});

test('a failed first load offers a retry, on paper', async () => {
  wire({ get_friends_board: rpcError('boom') });
  await renderScreen(<LeaguesScreen />);
  expect(await screen.findByText("Couldn't load your friends")).toBeOnTheScreen();
  expect(ground(screen.getByTestId('load-failed'))).toBe('#FFFFFF');
  wire();
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByTestId('friend-row-amy')).toBeOnTheScreen();
});
