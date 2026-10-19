/**
 * The Profile tab and achievements: the public card from `get_my_summary` (Safety Rating, streak,
 * points and freezes; no league), the five achievements locked or unlocked, the entries, the
 * progress hints, and the heat map row's privacy-only screen.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { achievementViews } from '../achievements';
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

const summary = (
  over: { ranked?: boolean; achievements?: string[]; freezes?: number; points?: number; heatmap?: string } = {}
) => ({
  profile: { user_id: 'me', username: 'swift_fox', units: 'mi', heatmap_visibility: over.heatmap ?? 'only_me' },
  progress: {
    points: over.points ?? 820, lifetime: 900, level: 3, level_floor: 750, level_next: 1500, streak: 7, at_risk: false,
    next_mult: 1.16, freezes: over.freezes ?? 2, clean_run: 1, freeze_progress: 0, phone_free_run: 12,
    safety_rating: over.ranked === false ? 88 : 92.4, ranked: over.ranked ?? true, miles_30d: 14.6,
    clean_miles_30d: 10, rating_trend: 1.2, league_tier: 'silver',
  },
  league: { week: '2026-W41', tier: 'silver', group_id: 'g', rank: 4, size: 30, ends_at: '2026-10-12T04:00:00Z' },
  not_driving_left: 2,
  challenges: [],
  achievements: over.achievements ?? ['first_drive', 'streak_10'],
});

beforeEach(() => {
  mockRpc.mockReset();
  mockRouter.push.mockClear();
});
afterEach(() => clearQueryClients());

it('shows the public card, the achievements and a badge for friend requests', async () => {
  answerRpc(mockRpc, {
    get_my_summary: summary(),
    list_friends: { friends: [], incoming: [{ user_id: 'x', username: 'newbie' }], outgoing: [] },
  });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-username')).toHaveTextContent('swift_fox');
  expect(screen.getByTestId('profile-level')).toHaveTextContent('Level 3');
  expect(screen.getByText('600 pts to level 4')).toBeOnTheScreen();
  expect(screen.getByLabelText('Safety Rating 92')).toBeOnTheScreen();
  expect(screen.getByLabelText('Streak 7')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-first_drive-unlocked')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-streak_10-unlocked')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-clean_100-locked')).toBeOnTheScreen();
  expect(await screen.findByText(profileCopy.rows.requests(1))).toBeOnTheScreen();

  await tap('profile-friends');
  await tap('profile-heatmap');
  await tap('profile-blocked');
  expect(mockRouter.push.mock.calls.map((c) => c[0])).toEqual([PROFILE_HREFS.friends, PROFILE_HREFS.heatmap, '/settings/blocked']);
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

it('unranked says how far there is to go', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ ranked: false }), list_friends: { friends: [], incoming: [], outgoing: [] } });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  // Screen readers hear the way to being ranked too, not only "Unranked".
  expect(await screen.findByLabelText(`Safety Rating: ${profileCopy.unranked}, ${profileCopy.unrankedMiles('14/25 mi')}`)).toBeOnTheScreen();
  expect(screen.getByText(profileCopy.unrankedMiles('14/25 mi'))).toBeOnTheScreen();
});

it('achievement hints say how close you are', () => {
  const views = achievementViews(['first_drive'], { streak: 7, phone_free_run: 30 });
  expect(views.map((v) => v.id)).toEqual(['first_drive', 'clean_100', 'perfect_week', 'phone_free_25', 'streak_10']);
  expect(views.find((v) => v.id === 'streak_10')).toMatchObject({ unlocked: false, progress: 0.7, hint: 'Your streak is 7. Reach 10.' });
  expect(views.find((v) => v.id === 'phone_free_25')?.progress).toBe(1);
  expect(views.find((v) => v.id === 'first_drive')).toMatchObject({ unlocked: true, progress: 1 });
});

it('the achievements screen lists all five with their state', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ achievements: ['first_drive'] }) });
  const w = await appWorld();
  await w.render(<AchievementsScreen />);
  expect(await screen.findByText(profileCopy.achievements.count(1, 5))).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-hint-streak_10')).toHaveTextContent('Your streak is 7. Reach 10.');
});

const NO_FRIENDS = { friends: [], incoming: [], outgoing: [] };

it('the card shows points and freezes (N of 3), and no league', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ points: 12345, freezes: 2 }), list_friends: NO_FRIENDS });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-points')).toHaveTextContent(/12,345/);
  expect(screen.getByLabelText('Points 12,345')).toBeOnTheScreen();
  expect(screen.getByTestId('profile-freezes')).toHaveTextContent(/2 of 3/);
  expect(screen.getByLabelText('Freezes 2 of 3')).toBeOnTheScreen();
  expect(screen.queryByText(/league/i)).toBeNull();
  expect(screen.queryByText(/silver/i)).toBeNull();
  expect(screen.queryByText(/clan/i)).toBeNull();
});

it('the points and freezes fit a narrow card (320 pt, large text)', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ points: 1234567, freezes: 2 }), list_friends: NO_FRIENDS });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  // A long total shrinks to one line instead of running past its column.
  const value = await screen.findByTestId('profile-points-value');
  expect(value.props.numberOfLines).toBe(1);
  expect(value.props.adjustsFontSizeToFit).toBe(true);
  // "N of 3" wraps under the snowflakes rather than past the card edge.
  const row = screen.getByTestId('profile-freezes-row');
  expect(row).toHaveStyle({ flexWrap: 'wrap' });
  expect(within(row).getByText('2 of 3').props.style).toEqual(expect.arrayContaining([expect.objectContaining({ flexShrink: 1 })]));
});

it.each([
  [0, '0 of 3'],
  [3, '3 of 3'],
])('freezes always show: %i held reads "%s"', async (freezes, text) => {
  answerRpc(mockRpc, { get_my_summary: summary({ freezes }), list_friends: NO_FRIENDS });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByTestId('profile-freezes')).toHaveTextContent(new RegExp(text));
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
    expect(screen.getByTestId('heatmap-privacy')).toHaveTextContent(profileCopy.heatmap.privacy);
    expect(screen.getByTestId('heatmap-visibility-hint')).toHaveTextContent('Only me is the default. Friends see it on your profile.');
    expect(screen.queryByTestId('heatmap-map')).toBeNull();
    expect(screen.queryByTestId('heatmap-empty')).toBeNull();
    expect(screen.queryByText(/clan/i)).toBeNull();
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

  it('a saved clan setting shows as Only me, as the server treats it', async () => {
    answerRpc(mockRpc, { get_my_summary: summary({ heatmap: 'clan' }) });
    const w = await appWorld();
    await w.render(<HeatmapScreen />);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_my_summary', undefined));
    const control = within(await screen.findByTestId('heatmap-visibility'));
    await waitFor(() => expect(control.getByRole('tab', { name: 'Only me' })).toBeSelected());
    expect(control.getByRole('tab', { name: 'Friends' })).not.toBeSelected();
  });
});
