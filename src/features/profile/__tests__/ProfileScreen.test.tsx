/**
 * The Profile tab and achievements: the public card from `get_my_summary`, the five achievements
 * locked or unlocked, the entries, and the progress hints.
 */
import { screen } from '@testing-library/react-native';

import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { achievementViews } from '../achievements';
import { AchievementsScreen } from '../AchievementsScreen';
import { profileCopy } from '../copy';
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

const summary = (over: { ranked?: boolean; achievements?: string[] } = {}) => ({
  profile: { user_id: 'me', username: 'swift_fox', units: 'mi', heatmap_visibility: 'only_me' },
  progress: {
    points: 820, lifetime: 900, level: 3, level_floor: 750, level_next: 1500, streak: 7, at_risk: false,
    next_mult: 1.16, freezes: 2, clean_run: 1, freeze_progress: 0, phone_free_run: 12,
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
  expect(screen.getByLabelText('Safety Rating 92')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-first_drive-unlocked')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-streak_10-unlocked')).toBeOnTheScreen();
  expect(screen.getByTestId('achievement-clean_100-locked')).toBeOnTheScreen();
  expect(await screen.findByText(profileCopy.rows.requests(1))).toBeOnTheScreen();

  await tap('profile-friends');
  await tap('profile-heatmap');
  await tap('profile-blocked');
  expect(mockRouter.push.mock.calls.map((c) => c[0])).toEqual([PROFILE_HREFS.friends, PROFILE_HREFS.heatmap, '/settings/blocked']);
});

it('unranked says how far there is to go', async () => {
  answerRpc(mockRpc, { get_my_summary: summary({ ranked: false }), list_friends: { friends: [], incoming: [], outgoing: [] } });
  const w = await appWorld();
  await w.render(<ProfileScreen />);
  expect(await screen.findByLabelText(`Safety Rating: ${profileCopy.unranked}`)).toBeOnTheScreen();
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
