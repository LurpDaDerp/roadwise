/**
 * The Profile tab and achievements: the card from `get_my_summary` (the Safety Rating, its change
 * this week, the month you started) with your all-time totals from this phone, the three
 * achievements locked or unlocked, the entries, and the heat map row's privacy-only screen.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
import { analyticsCopy } from '@/features/analytics/copy';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { achievementViews } from '../achievements';
import { AchievementsScreen } from '../AchievementsScreen';
import { profileCopy } from '../copy';
import { HeatmapScreen } from '../HeatmapScreen';
import { sinceMonth } from '../ProfileHeader';
import { PROFILE_HREFS, ProfileScreen } from '../ProfileScreen';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
const mockRouter = { push: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
// All-time totals from this phone's drives.
let mockTotals = { miles: 612.4, durationS: 21 * 3600, nightMiles: 0, drives: 48, cleanDrives: 30, speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0 };
jest.mock('@/data/queries', () => ({
  ...jest.requireActual('@/data/queries'),
  useStatSums: () => ({ data: mockTotals, refetch: jest.fn(async () => undefined) }),
}));

const summary = (over: { ranked?: boolean; achievements?: string[]; heatmap?: string; trend?: number | null; onboarded?: string | null } = {}) => ({
  profile: {
    user_id: 'me',
    username: 'swift_fox',
    units: 'mi',
    heatmap_visibility: over.heatmap ?? 'only_me',
    onboarded_at: over.onboarded === undefined ? '2026-10-02T12:00:00Z' : over.onboarded,
    share_rating: true,
    share_categories: false,
    share_achievements: false,
    share_stats: false,
  },
  progress: {
    safety_rating: over.ranked === false ? 88 : 92.4,
    ranked: over.ranked ?? true,
    miles_90d: over.ranked === false ? 6.6 : 140,
    rating_trend: over.trend === undefined ? 1.6 : over.trend,
  },
  not_driving_left: 2,
  challenges: [],
  achievements: over.achievements ?? ['first_drive'],
});

const NO_POINTS = /\bpoints?\b|\bpts\b|streak|freeze|\blevel\b|league/i;

beforeEach(() => {
  mockRpc.mockReset();
  mockRouter.push.mockClear();
  mockTotals = { miles: 612.4, durationS: 21 * 3600, nightMiles: 0, drives: 48, cleanDrives: 30, speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0 };
});
afterEach(() => clearQueryClients());

it('the card: when you started, the Safety Rating with its week, your totals; the three achievements; a badge for friend requests; no points', async () => {
  answerRpc(mockRpc, {
    get_my_summary: summary(),
    list_friends: { friends: [], incoming: [{ user_id: 'x', username: 'newbie' }], outgoing: [] },
  });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-username')).toHaveTextContent('swift_fox');
  expect(screen.getByTestId('profile-since')).toHaveTextContent('Driving with RoadWise since Oct 2026');
  expect(screen.getByLabelText('Safety Rating 92')).toBeOnTheScreen();
  expect(screen.getByLabelText('Up 2 this week')).toBeOnTheScreen();
  expect(within(screen.getByTestId('profile-trend')).getByText('This week')).toBeOnTheScreen();
  expect(screen.getByLabelText('Drives 48')).toBeOnTheScreen();
  expect(screen.getByTestId('profile-distance')).toHaveTextContent(/612 mi/);
  expect(screen.getByLabelText('Distance 612 miles')).toBeOnTheScreen();
  expect(screen.getByTestId('profile-time')).toHaveTextContent(/21 h/);
  expect(screen.getByLabelText('On the road 21 hours')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-first_drive-unlocked')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-clean_100-locked')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-perfect_week-locked')).toBeOnTheScreen();
  expect(screen.queryByTestId(/achievement-(streak_10|phone_free_25)/)).toBeNull();
  expect(await screen.findByText(profileCopy.rows.requests(1))).toBeOnTheScreen();
  expect(screen.queryByText(NO_POINTS)).toBeNull();

  await tap('profile-friends');
  await tap('profile-heatmap');
  await tap('profile-how');
  await tap('profile-blocked');
  expect(mockRouter.push.mock.calls.map((c) => c[0])).toEqual([PROFILE_HREFS.friends, PROFILE_HREFS.heatmap, SETTINGS_HREFS.howScoresWork, '/settings/blocked']);
  expect(screen.getByText('How scores work')).toBeOnTheScreen();
});

it('scrolls below the status bar: the list sits inside a top safe area, with no inset padding of its own', async () => {
  answerRpc(mockRpc, { get_my_summary: summary(), list_friends: { friends: [], incoming: [], outgoing: [] } });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  await screen.findByTestId('profile-username');
  const area = screen.getByTestId('profile-safe-area');
  expect(area.props.edges).toMatchObject({ top: 'additive' });
  expect(within(area).getByTestId('profile-screen')).toBeOnTheScreen();
});

it('no rating yet says how far there is to go, and no week', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ ranked: false }), list_friends: { friends: [], incoming: [], outgoing: [] } });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  // Screen readers hear the way to a rating too, not only "No rating yet".
  expect(await screen.findByLabelText('Safety Rating: No rating yet, 6 of 10 miles to your rating')).toBeOnTheScreen();
  expect(screen.getByText('6 of 10 mi to your rating')).toBeOnTheScreen();
  expect(screen.queryByTestId('profile-trend')).toBeNull();
});

it.each([
  [-0.6, 'Down 1'],
  [0.2, 'Steady'],
])('a week of %s reads "%s"; an unknown week and start month show nothing', async (trend, word) => {
  answerRpc(mockRpc, { get_my_summary: summary({ trend }), list_friends: { friends: [], incoming: [], outgoing: [] } });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-trend')).toHaveTextContent(new RegExp(word));
  expect(sinceMonth(null)).toBeNull();
  expect(sinceMonth('not a date')).toBeNull();
});

it('achievement hints say how to get each one', () => {
  const views = achievementViews(['first_drive']);
  expect(views.map((v) => v.id)).toEqual(['first_drive', 'clean_100', 'perfect_week']);
  expect(views.find((v) => v.id === 'clean_100')).toMatchObject({ unlocked: false, hint: 'Drive 100 miles with no events.' });
  expect(views.find((v) => v.id === 'perfect_week')).toMatchObject({ unlocked: false, hint: 'Take 3 or more drives in one week, all with no events.' });
  expect(views.find((v) => v.id === 'first_drive')).toMatchObject({ unlocked: true });
});

it('the achievements screen lists all three with their state', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ achievements: ['first_drive'] }) });
  const w = await appWorld();
  await w.render(<AchievementsScreen />);
  expect(await screen.findByText(profileCopy.achievements.count(1, 3))).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-hint-clean_100')).toHaveTextContent('Drive 100 miles with no events.');
});

const NO_FRIENDS = { friends: [], incoming: [], outgoing: [] };

it('the totals fit a narrow card: each number shrinks to one line', async () => {
  mockTotals = { ...mockTotals, drives: 12345, miles: 123456 };
  answerRpc(mockRpc, { get_my_summary: summary(), list_friends: NO_FRIENDS });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  const value = within(await screen.findByTestId('profile-distance')).getByText('123,456 mi');
  expect(value.props.numberOfLines).toBe(1);
  expect(value.props.adjustsFontSizeToFit).toBe(true);
});

it('the title is a header on the sky', async () => {
  answerRpc(mockRpc, { get_my_summary: summary(), list_friends: NO_FRIENDS });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-title')).toHaveTextContent(profileCopy.tab);
  expect(screen.getByRole('header', { name: profileCopy.tab })).toBeOnTheScreen();
});

describe('the heat map row opens who can see it', () => {
  it('has the visibility choice, the zones link and the privacy note, and no map', async () => {
    answerRpc(mockRpc, { get_my_summary: summary(), update_profile: {} });
    const w = await appWorld();
    await w.render(<HeatmapScreen />);
    expect(await screen.findByTestId('heatmap-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('heatmap-intro')).toHaveTextContent(profileCopy.heatmap.intro);
    // it names the Analytics card by its own title
    expect(profileCopy.heatmap.intro).toContain(analyticsCopy.map.title);
    expect(screen.getByTestId('heatmap-privacy')).toHaveTextContent(profileCopy.heatmap.privacy);
    expect(screen.getByTestId('heatmap-visibility-hint')).toHaveTextContent('Only me is the default. Friends see it on your profile.');
    expect(screen.queryByTestId('heatmap-map')).toBeNull();
    expect(screen.queryByTestId('heatmap-empty')).toBeNull();
    await tap('heatmap-zones');
    expect(mockRouter.push).toHaveBeenLastCalledWith('/settings/privacy-zones');
  });

  it('offers Only me and Friends, shows the saved choice, and saves a change', async () => {
    answerRpc(mockRpc, { get_my_summary: summary({ heatmap: 'friends' }), update_profile: {} });
    const w = await appWorld();
    await w.render(<HeatmapScreen />);
    const control = within(await screen.findByTestId('heatmap-visibility'));
    await waitFor(() => expect(control.getByRole('tab', { name: 'Friends' })).toBeSelected());
    expect(control.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual(['Only me', 'Friends']);
    await act(async () => {
      fireEvent.press(control.getByRole('tab', { name: 'Only me' }));
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('update_profile', { p_heatmap_visibility: 'only_me' }));
    expect(control.getByRole('tab', { name: 'Only me' })).toBeSelected();
  });
});
