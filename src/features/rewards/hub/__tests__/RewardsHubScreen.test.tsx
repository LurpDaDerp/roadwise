import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { routerDouble } from '@/features/trips/__fixtures__/render';
import { BANNED_COPY } from '@/notifications/catalog';

import { RewardsDataError } from '../../api';
import { CONFIRM_RULE, goalActiveLine, NOT_MONEY, OFFLINE_LINE, SETTLE_RULE, STREAK_RULE } from '../../copy/common';
import { hubCopy } from '../../copy/hub';
import { resetEnsureWeekForTests } from '../../useEnsureWeek';
import {
  badgeRow,
  enrolmentRow,
  goalRow,
  progressRow,
  snapshot,
} from '../../__fixtures__/rows';
import { dayPayload, fakeRewardsApi, renderedStrings, rewardsWorld, type WorldSeed } from '../__fixtures__/harness';
import { RewardsHubScreen } from '../RewardsHubScreen';
import { BADGES_HREF, badgeHref, challengeHref, CHALLENGES_HREF, GOAL_HREF, INVITE_HREF } from '../routes';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));

/** 2026-09-23 in UTC, the fixtures' NOW. */
const TODAY = '2026-09-23';

afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  resetEnsureWeekForTests();
  jest.clearAllMocks();
});

async function renderHub(snap = snapshot(), seed: WorldSeed = {}) {
  const w = await rewardsWorld(seed);
  const server = fakeRewardsApi(snap);
  await w.render(<RewardsHubScreen deps={{ api: server.api }} tz="UTC" />);
  await screen.findByTestId('hub-card');
  await settleInbox();
  await flush();
  return { ...w, ...server };
}

/** Lets the local settings reads (the referral flag, today's day row) land inside `act`. */
const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

/** A press, and whatever it started, inside one `act`. */
const press = async (testID: string) => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
};

const allText = () => renderedStrings(screen.getByTestId('hub-screen')).join('\n');

const expandHow = () => press('hub-how-toggle');

describe('RewardsHubScreen — states', () => {
  it('loading: a skeleton until the snapshot lands', async () => {
    const w = await rewardsWorld();
    const server = fakeRewardsApi();
    let release: () => void = () => undefined;
    server.server.hold = new Promise<void>((r) => {
      release = r;
    });
    await w.render(<RewardsHubScreen deps={{ api: server.api }} tz="UTC" />);
    expect(screen.getByTestId('hub-loading')).toBeTruthy();
    expect(screen.queryByTestId('hub-find-challenge')).toBeNull();
    await act(async () => release());
    expect(await screen.findByTestId('hub-card')).toBeTruthy();
  });

  it('error: an inline error with a retry that fetches again', async () => {
    const w = await rewardsWorld();
    const server = fakeRewardsApi();
    server.server.fail = new RewardsDataError('bad row');
    await w.render(<RewardsHubScreen deps={{ api: server.api }} tz="UTC" />);
    expect(await screen.findByText(hubCopy.error)).toBeTruthy();
    server.server.fail = null;
    await act(async () => {
      fireEvent.press(screen.getByLabelText(hubCopy.retry));
    });
    expect(await screen.findByTestId('hub-card')).toBeTruthy();
    expect(server.api.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('offline: the cached snapshot with the offline banner', async () => {
    setOnline(false);
    const cached = snapshot({ progress: progressRow({ points: 480, xp: 480 }) });
    const w = await rewardsWorld({ cached });
    const server = fakeRewardsApi();
    await w.render(<RewardsHubScreen deps={{ api: server.api }} tz="UTC" />);
    expect(await screen.findByText(OFFLINE_LINE)).toBeTruthy();
    expect(screen.getByTestId('hub-points-value')).toHaveTextContent('480');
    expect(server.api.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('offline with nothing cached: says so, with a retry', async () => {
    setOnline(false);
    const w = await rewardsWorld();
    const server = fakeRewardsApi();
    await w.render(<RewardsHubScreen deps={{ api: server.api }} tz="UTC" />);
    expect(await screen.findByText(hubCopy.offlineEmpty)).toBeTruthy();
    expect(screen.getByLabelText(hubCopy.retry)).toBeTruthy();
  });

  it('new user (no progress): the first-points line, Learner at 0, and no streak claim', async () => {
    await renderHub(snapshot({ progress: null, currentGoal: null, lastGoal: null, days: [], badges: [], challenges: [] }));
    expect(screen.getByText(hubCopy.newUser)).toBeTruthy();
    expect(screen.getByTestId('hub-points-value')).toHaveTextContent('0');
    expect(screen.getByTestId('hub-class-name')).toHaveTextContent('Learner');
    expect(screen.getByTestId('hub-streak-days')).toHaveTextContent('0');
    expect(screen.queryByTestId('hub-streak-best')).toBeNull();
    expect(screen.queryByTestId('hub-streak-shields')).toBeNull();
  });

  it('a driver with points does not get the new-user line', async () => {
    await renderHub();
    expect(screen.queryByText(hubCopy.newUser)).toBeNull();
  });
});

describe('RewardsHubScreen — the card', () => {
  it('POINTS prints the settled total and speaks it as points', async () => {
    await renderHub(snapshot({ progress: progressRow({ points: 1250, xp: 1250 }) }));
    expect(screen.getByTestId('hub-points-value')).toHaveTextContent('1,250');
    expect(screen.getByTestId('hub-points').props.accessibilityLabel).toBe('1,250 points');
  });

  it('CLASS: name, a rule, "1,100 to Smooth", spoken "Class Steady, 1,100 points to Smooth"', async () => {
    await renderHub(snapshot({ progress: progressRow({ points: 2900, xp: 2900, level: 2 }) }));
    expect(screen.getByTestId('hub-class-name')).toHaveTextContent('Steady');
    expect(screen.getByTestId('hub-class-next')).toHaveTextContent('1,100 to Smooth');
    expect(screen.getByTestId('hub-class').props.accessibilityLabel).toBe('Class Steady, 1,100 points to Smooth');
    expect(screen.getByTestId('hub-class-bar-fill', { includeHiddenElements: true }).props.style.width).toBe('56%');
  });

  it('CLASS at the top says so', async () => {
    await renderHub(snapshot({ progress: progressRow({ points: 30000, xp: 30000, level: 6 }) }));
    expect(screen.getByTestId('hub-class-next')).toHaveTextContent('Top class');
    expect(screen.getByTestId('hub-class').props.accessibilityLabel).toBe('Class Mentor, the top class');
  });

  it('STREAK with 0 shields: the number and "days", no shield line', async () => {
    await renderHub(snapshot({ progress: progressRow({ streak_days: 12, best_streak: 12, shields: 0 }) }));
    expect(screen.getByTestId('hub-streak-days')).toHaveTextContent('12');
    expect(screen.getByText('days')).toBeTruthy();
    expect(screen.queryByTestId('hub-streak-shields')).toBeNull();
    expect(screen.getByTestId('hub-streak').props.accessibilityLabel).toBe('Streak 12 days');
  });

  it('STREAK with 2 shields: "2 shields" as words beside the glyph', async () => {
    await renderHub(snapshot({ progress: progressRow({ streak_days: 12, best_streak: 20, shields: 2 }) }));
    expect(screen.getByTestId('hub-streak-shields')).toHaveTextContent(/2 shields$/);
    expect(screen.getByTestId('hub-streak').props.accessibilityLabel).toBe('Streak 12 days, 2 shields');
    expect(screen.queryByTestId('hub-streak-best')).toBeNull();
  });

  it('STREAK restarted: 0 and "Best 30"', async () => {
    await renderHub(snapshot({ progress: progressRow({ streak_days: 0, best_streak: 30, shields: 0 }) }));
    expect(screen.getByTestId('hub-streak-days')).toHaveTextContent('0');
    expect(screen.getByTestId('hub-streak-best')).toHaveTextContent('Best 30');
    expect(screen.getByTestId('hub-streak').props.accessibilityLabel).toBe('Streak 0 days, best 30');
  });

  it('STREAK is the server counter, never recomputed from day rows', async () => {
    const snap = snapshot({ progress: progressRow({ streak_days: 3, best_streak: 9 }) });
    await renderHub(snap, { days: [[TODAY, dayPayload({ safeDay: true })], ['2026-09-22', dayPayload({ safeDay: true })]] });
    expect(screen.getByTestId('hub-streak-days')).toHaveTextContent('3');
  });
});

describe('RewardsHubScreen — today', () => {
  const imperative = /\b(drive|go|start|open)\b/i;

  it('nothing when there is no day row today — never a nudge to drive', async () => {
    await renderHub();
    expect(screen.queryByTestId('hub-today')).toBeNull();
  });

  it('nothing for a day row with no counted drive', async () => {
    await renderHub(snapshot(), { days: [[TODAY, dayPayload({ tripsScored: 0, tripsAll: 0 })]] });
    expect(screen.queryByTestId('hub-today')).toBeNull();
  });

  it('a safe day so far: "Today looks like a safe day so far. Confirmed when the day closes."', async () => {
    await renderHub(snapshot(), { days: [[TODAY, dayPayload({ safeDay: true })]] });
    const line = screen.getByTestId('hub-today');
    expect(line).toHaveTextContent('Today looks like a safe day so far. Confirmed when the day closes.');
    expect(String(line.props.children)).not.toMatch(imperative);
  });

  it.each([
    ['good', dayPayload({ goodDay: true }), hubCopy.today.good],
    ['not safe', dayPayload({}), hubCopy.today.notSafe],
    ['deleted only (D2): not safe, and says why — never "no drive"', dayPayload({ tripsScored: 0, tripsAll: 2 }), hubCopy.today.deleted],
  ])('%s', async (_name, payload, text) => {
    await renderHub(snapshot(), { days: [[TODAY, payload]] });
    const line = screen.getByTestId('hub-today');
    expect(line).toHaveTextContent(text);
    expect(text.endsWith(SETTLE_RULE)).toBe(true);
    expect(text).not.toMatch(imperative);
    expect(text).not.toMatch(/no drive/i);
  });

  it('a day row from yesterday is not today', async () => {
    await renderHub(snapshot(), { days: [['2026-09-22', dayPayload({ safeDay: true })]] });
    expect(screen.queryByTestId('hub-today')).toBeNull();
  });

  it('a day before the account’s rewards began (not counted) is never told it will be confirmed', async () => {
    await renderHub(snapshot({ progress: progressRow({ rewards_start: '2026-09-24' }) }), {
      days: [[TODAY, dayPayload({ safeDay: true })]],
    });
    expect(screen.queryByTestId('hub-today')).toBeNull();
  });

  it('every today line is free of imperatives', () => {
    for (const line of Object.values(hubCopy.today)) expect(line).not.toMatch(imperative);
  });
});

describe('RewardsHubScreen — goal, challenges, badges, links', () => {
  it('this week’s goal row opens /rewards/goal and speaks its progress', async () => {
    await renderHub(snapshot({ currentGoal: goalRow('2026-09-21', { category: 'phone', pass_days: 2 }) }));
    const line = goalActiveLine({ pass: 2, target: 4, failDays: 0 });
    expect(line).toMatch(/^2 of 4 days so far\./);
    expect(screen.getByTestId('hub-goal').props.accessibilityLabel).toBe(
      `This week's goal, Keep your phone down on 4 driving days, ${line}`
    );
    expect(screen.getByTestId('hub-goal-progress')).toHaveTextContent(line);
    await press('hub-goal');
    expect(mockRouter.push).toHaveBeenCalledWith(GOAL_HREF);
  });

  it('last week’s goal is never shown as this week’s (offline before the week opens)', async () => {
    setOnline(false);
    const cached = snapshot({ currentGoal: goalRow('2026-09-14', { pass_days: 3 }) });
    const w = await rewardsWorld({ cached });
    const server = fakeRewardsApi();
    await w.render(<RewardsHubScreen deps={{ api: server.api }} tz="UTC" />);
    await screen.findByTestId('hub-card');
    expect(screen.getByTestId('hub-goal')).toHaveTextContent(new RegExp(hubCopy.goal.offline.replace(/[.']/g, '.')));
    expect(screen.queryByTestId('hub-goal-progress')).toBeNull();
  });

  it('up to two active challenges, each to its detail; others are not listed', async () => {
    const snap = snapshot({
      challenges: [
        enrolmentRow('phone_down', { pass_days: 6 }),
        enrolmentRow('safe_run', { pass_days: 1 }),
        enrolmentRow('smooth_ride', { state: 'completed' }),
      ],
    });
    await renderHub(snap);
    expect(screen.getByTestId('hub-challenge-phone_down')).toHaveTextContent(/No phone use.*6 of 10 driving days/s);
    expect(screen.getByTestId('hub-challenge-safe_run')).toBeTruthy();
    expect(screen.queryByTestId('hub-challenge-smooth_ride')).toBeNull();
    await press('hub-challenge-phone_down');
    expect(mockRouter.push).toHaveBeenCalledWith(challengeHref('phone_down'));
  });

  it('one primary action, "Find a challenge", only when none is active', async () => {
    await renderHub(snapshot({ challenges: [enrolmentRow('phone_down', { state: 'ended' })] }));
    await press('hub-find-challenge');
    expect(mockRouter.push).toHaveBeenCalledWith(CHALLENGES_HREF);
    expect(screen.queryByTestId('hub-challenges')).toBeNull();
  });

  it('no primary action while a challenge is active', async () => {
    await renderHub();
    expect(screen.queryByTestId('hub-find-challenge')).toBeNull();
    expect(screen.queryByText(hubCopy.findChallenge)).toBeNull();
  });

  it('the next-badge teaser: "Next badge: 12 of 30 safe days" → the badge', async () => {
    const snap = snapshot({
      progress: progressRow({ safe_days: 12, phone_free_days: 1, smooth_days: 1, goals_achieved: 0, challenges_completed: 0 }),
      badges: [badgeRow('safe_days_7')],
    });
    await renderHub(snap);
    expect(screen.getByText('Next badge: 12 of 30 safe days')).toBeTruthy();
    await press('hub-next-badge-row');
    expect(mockRouter.push).toHaveBeenCalledWith(badgeHref('safe_days_30'));
  });

  it('links: Badges and Challenges; Invite friends hidden while the referral flag is off', async () => {
    await renderHub(snapshot(), { referral: false });
    await press('hub-link-badges');
    expect(mockRouter.push).toHaveBeenCalledWith(BADGES_HREF);
    await press('hub-link-challenges');
    expect(mockRouter.push).toHaveBeenCalledWith(CHALLENGES_HREF);
    expect(screen.queryByTestId('hub-link-invite')).toBeNull();
    expect(screen.queryByText(hubCopy.links.invite)).toBeNull();
  });

  it('Invite friends hidden when the flag was never fetched (local default off)', async () => {
    await renderHub();
    expect(screen.queryByTestId('hub-link-invite')).toBeNull();
  });

  it('Invite friends shown when the referral flag is on', async () => {
    await renderHub(snapshot(), { referral: true });
    await waitFor(() => expect(screen.getByTestId('hub-link-invite')).toBeTruthy());
    await press('hub-link-invite');
    expect(mockRouter.push).toHaveBeenCalledWith(INVITE_HREF);
  });
});

describe('RewardsHubScreen — how rewards work, and honest copy', () => {
  it('expands with its state announced, and says the rules', async () => {
    await renderHub();
    const toggle = screen.getByTestId('hub-how-toggle');
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText(CONFIRM_RULE)).toBeNull();
    await expandHow();
    expect(screen.getByTestId('hub-how-toggle').props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText(CONFIRM_RULE)).toBeTruthy();
    expect(screen.getByText(NOT_MONEY)).toBeTruthy();
    expect(screen.getByText(new RegExp(STREAK_RULE.replace(/[.']/g, '.')))).toBeTruthy();
    expect(
      screen.getByText('Nothing is earned while you drive; everything shows up after the day is confirmed.')
    ).toBeTruthy();
  });

  it('no sentence promises that a later correction changes a confirmed day (rev1: R-A)', async () => {
    await renderHub();
    await expandHow();
    const text = allText();
    expect(text).not.toMatch(/recalculat|will (change|go up|rise|be updated)|can (still )?change|(correction|dispute|answer)s? (later )?(can|will|may) /i);
    expect(text).toContain("After that it doesn't change.");
  });

  it('rendered text passes BANNED_COPY (NOT_MONEY included), with no store, leaderboard, crew or coming soon', async () => {
    const snap = snapshot({ progress: progressRow({ streak_days: 0, best_streak: 30, shields: 2 }), challenges: [] });
    await renderHub(snap, { referral: true, days: [[TODAY, dayPayload({ safeDay: true })]] });
    await waitFor(() => expect(screen.getByTestId('hub-link-invite')).toBeTruthy());
    await expandHow();
    const text = allText();
    expect(text).toContain(NOT_MONEY);
    for (const re of BANNED_COPY) expect(text).not.toMatch(re);
    expect(text).not.toMatch(/store|leaderboard|crew|coming soon/i);
    expect(text).not.toMatch(/in a row/i);
  });
});
