/**
 * The Profile tab and achievements: the card from `get_my_summary` (the Safety Rating, its change
 * this week) with your all-time totals from this phone, the three
 * achievements locked or unlocked, the entries, and the heat map row's privacy-only screen.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
import { analyticsCopy } from '@/features/analytics/copy';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { ACHIEVEMENT_ICON, achievementViews, badgeOrder, PROFILE_BADGES } from '../achievements';
import { AchievementsScreen } from '../AchievementsScreen';
import { profileCopy } from '../copy';
import { HeatmapScreen } from '../HeatmapScreen';
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

const summary = (over: { ranked?: boolean; achievements?: string[]; heatmap?: string; trend?: number | null } = {}) => ({
  profile: {
    user_id: 'me',
    username: 'swift_fox',
    units: 'mi',
    heatmap_visibility: over.heatmap ?? 'only_me',
    onboarded_at: '2026-10-02T12:00:00Z',
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

it('the card: the Safety Rating with its week, your totals; six of the 13 achievements, unlocked first; a badge for friend requests; no points', async () => {
  answerRpc(mockRpc, {
    get_my_summary: summary(),
    list_friends: { friends: [], incoming: [{ user_id: 'x', username: 'newbie' }], outgoing: [] },
  });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-username')).toHaveTextContent('swift_fox');
  expect(screen.queryByText(/since/i)).toBeNull();
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
  expect(within(screen.getByTestId('profile-achievements')).getAllByTestId(/^achievement-/)).toHaveLength(6);
  expect(screen.queryByTestId('achievement-spot_cleared-locked')).toBeNull();
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
])('a week of %s reads "%s"; an unknown week shows nothing', async (trend, word) => {
  answerRpc(mockRpc, { get_my_summary: summary({ trend }), list_friends: { friends: [], incoming: [], outgoing: [] } });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-trend')).toHaveTextContent(new RegExp(word));
});

it('achievement hints say how to get each one', () => {
  const views = achievementViews(['first_drive']);
  expect(views.map((v) => v.id)).toEqual([
    'first_drive',
    'clean_100',
    'clean_500',
    'clean_1000',
    'perfect_week',
    'rain_or_shine',
    'better_speed',
    'better_braking',
    'better_acceleration',
    'better_turning',
    'better_phone',
    'better_attention',
    'spot_cleared',
  ]);
  expect(views.find((v) => v.id === 'clean_100')).toMatchObject({ unlocked: false, hint: 'Drive 100 miles with no events.' });
  expect(views.find((v) => v.id === 'clean_500')).toMatchObject({ unlocked: false, hint: 'Drive 500 miles with no events.', title: 'Clean 500' });
  expect(views.find((v) => v.id === 'clean_1000')).toMatchObject({ unlocked: false, hint: 'Drive 1,000 miles with no events.', title: 'Clean 1,000' });
  expect(views.find((v) => v.id === 'rain_or_shine')).toMatchObject({
    unlocked: false,
    hint: 'Finish a drive with no events in rain or snow.',
    title: 'Rain or Shine',
  });
  expect(views.find((v) => v.id === 'perfect_week')).toMatchObject({ unlocked: false, hint: 'Take 3 or more drives in one week, all with no events.' });
  expect(views.find((v) => v.id === 'better_braking')).toMatchObject({ unlocked: false, hint: 'Get your Braking score 10 higher than it was 30 days ago.' });
  expect(views.find((v) => v.id === 'better_phone')).toMatchObject({ unlocked: false, hint: 'Get your Phone use score 10 higher than it was 30 days ago.' });
  expect(views.find((v) => v.id === 'spot_cleared')).toMatchObject({ unlocked: false, hint: 'Drive clean through a spot to watch until it clears.' });
  expect(views.find((v) => v.id === 'first_drive')).toMatchObject({ unlocked: true });
  // An unlocked badge says what it was for.
  expect(achievementViews(['spot_cleared']).find((v) => v.id === 'spot_cleared')).toMatchObject({ unlocked: true, hint: 'Clear a spot to watch.' });
  expect(achievementViews(['rain_or_shine']).find((v) => v.id === 'rain_or_shine')).toMatchObject({
    unlocked: true,
    hint: 'Finish a clean drive in rain or snow.',
  });
  // Every badge has its own icon and a hint (no copy is shared by two).
  expect(new Set(views.map((v) => v.hint)).size).toBe(views.length);
  expect(new Set(Object.values(ACHIEVEMENT_ICON)).size).toBe(views.length);
});

it('a badge row puts unlocked badges first and caps at the limit', () => {
  expect(badgeOrder(['spot_cleared', 'better_turning'], PROFILE_BADGES).map((a) => a.id)).toEqual([
    'better_turning',
    'spot_cleared',
    'first_drive',
    'clean_100',
    'clean_500',
    'clean_1000',
  ]);
  expect(badgeOrder([])).toHaveLength(13);
});

it('the achievements screen lists all 13 with their state', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ achievements: ['first_drive', 'spot_cleared'] }) });
  const w = await appWorld();
  await w.render(<AchievementsScreen />);
  expect(await screen.findByText(profileCopy.achievements.count(2, 13))).toBeOnTheScreen();
  expect(screen.getAllByTestId(/^achievement-row-/)).toHaveLength(13);
  expect(screen.getByTestId('achievement-hint-clean_100')).toHaveTextContent('Drive 100 miles with no events.');
  expect(screen.getByTestId('achievement-hint-clean_1000')).toHaveTextContent('Drive 1,000 miles with no events.');
  expect(screen.getByTestId('achievement-hint-rain_or_shine')).toHaveTextContent('Finish a drive with no events in rain or snow.');
  expect(screen.getByTestId('achievement-hint-better_attention')).toHaveTextContent('Get your Attention score 10 higher than it was 30 days ago.');
  expect(screen.getByTestId('achievement-hint-spot_cleared')).toHaveTextContent('Clear a spot to watch.');
});

const NO_FRIENDS = { friends: [], incoming: [], outgoing: [] };

it('the achievements screen shows nothing as locked while the summary loads', async () => {
  mockRpc.mockImplementation(() => new Promise(() => {}));
  const w = await appWorld();
  await w.render(<AchievementsScreen />);
  expect(await screen.findByTestId('achievement-loading-first_drive', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.queryByText(profileCopy.achievements.count(0, 13))).toBeNull();
  expect(screen.queryByTestId('achievement-row-first_drive')).toBeNull();
  expect(screen.queryByText(profileCopy.achievements.locked)).toBeNull();
});

it('the achievements screen that cannot load says so, and Try again loads it', async () => {
  answerRpc(mockRpc, { get_my_summary: new Error('offline') });
  const w = await appWorld();
  await w.render(<AchievementsScreen />);
  // The query tries once more (after about a second) before it fails.
  expect(await screen.findByTestId('achievements-load-error', {}, { timeout: 4000 })).toHaveTextContent(new RegExp(profileCopy.loadError));
  expect(screen.queryByText(profileCopy.achievements.count(0, 13))).toBeNull();
  answerRpc(mockRpc, { get_my_summary: summary({ achievements: ['first_drive'] }) });
  await act(async () => {
    fireEvent.press(screen.getByText(profileCopy.retry));
  });
  expect(await screen.findByText(profileCopy.achievements.count(1, 13))).toBeOnTheScreen();
});

it("the Profile card's badges wait for the summary instead of showing every one locked", async () => {
  mockRpc.mockImplementation(async (fn: string) => (fn === 'list_friends' ? NO_FRIENDS : new Promise(() => {})));
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-achievements-loading', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.queryByTestId('achievement-first_drive-locked')).toBeNull();
});


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
    expect(screen.getByTestId('heatmap-visibility-hint')).toHaveTextContent('It starts as Only me. Choose Friends and they’ll see it on your profile.');
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
