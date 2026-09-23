import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { BANNED_COPY } from '@/notifications/catalog';

import { RewardsRpcError, type RewardsRpcCode } from '../api';
import { ChallengeDetailScreen } from '../challenges/ChallengeDetailScreen';
import { ChallengesScreen, challengeHref } from '../challenges/ChallengesScreen';
import { OFFLINE_LINE } from '../copy/common';
import { challengesCopy as copy } from '../copy/challenges';
import { resetEnsureWeekForTests } from '../useEnsureWeek';
import { fakeScreensApi, renderedStrings, screensWorld } from '../__fixtures__/goalChallengesWorld';
import { enrolmentRow, goalRow, iso, snapshot } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockFontScale = jest.fn(() => 1);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: mockFontScale() }),
}));

beforeEach(() => {
  resetEnsureWeekForTests();
  mockFontScale.mockReturnValue(1);
});
afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
  await settleInbox();
};

const THIS_WEEK = '2026-09-21';
const forbidden = /left to|hurry|expires|last chance|countdown|time left|hours? left/i;

function assertCopyRules() {
  const strings = renderedStrings(screen.toJSON());
  expect(strings.length).toBeGreaterThan(0);
  for (const s of strings) {
    for (const re of BANNED_COPY) expect(s).not.toMatch(re);
    expect(s).not.toMatch(forbidden);
  }
}

async function world(snap = snapshot(), opts: { online?: boolean } = {}) {
  const w = await screensWorld(opts.online === false ? { cached: snap } : {});
  if (opts.online === false) setOnline(false);
  const server = fakeScreensApi(snap);
  return { ...w, ...server };
}

async function renderList(snap = snapshot(), opts: { online?: boolean } = {}) {
  const w = await world(snap, opts);
  await w.render(<ChallengesScreen deps={{ api: w.api }} tz="UTC" />);
  await screen.findByTestId('challenges-screen');
  await settleInbox();
  return w;
}

async function renderDetail(challengeId: string, snap = snapshot(), opts: { online?: boolean } = {}) {
  const w = await world(snap, opts);
  await w.render(<ChallengeDetailScreen challengeId={challengeId} deps={{ api: w.api }} tz="UTC" />);
  await screen.findByTestId('challenge-screen');
  await settleInbox();
  return w;
}

const discoverOrder = () =>
  screen.getAllByTestId(/^challenge-row-/).map((el) => String(el.props.testID).replace('challenge-row-', ''));

describe('ChallengesScreen', () => {
  test('the segmented control is a tablist of three tabs; Active is selected when one is running', async () => {
    await renderList();
    const tabs = screen.getByTestId('challenge-tabs');
    expect(tabs.props.accessibilityRole).toBe('tablist');
    for (const key of ['active', 'discover', 'done'] as const) {
      const tab = screen.getByTestId(`challenge-tab-${key}`);
      expect(tab.props.accessibilityRole).toBe('tab');
      expect(tab.props.accessibilityLabel).toBe(copy.tabs[key]);
      expect(tab.props.accessibilityState).toMatchObject({ selected: key === 'active' });
    }
  });

  test('with nothing running, Discover opens first', async () => {
    await renderList(snapshot({ challenges: [] }));
    expect(screen.getByTestId('challenge-tab-discover').props.accessibilityState).toMatchObject({ selected: true });
  });

  test('Discover lists the four, the one matching this week\'s goal first as "Suggested for you"', async () => {
    await renderList(snapshot({ challenges: [], currentGoal: goalRow(THIS_WEEK, { category: 'speeding' }) }));
    expect(discoverOrder()).toEqual(['within_limit', 'phone_down', 'smooth_ride', 'safe_run']);
    const first = screen.getByTestId('challenge-row-within_limit');
    expect(within(first).getByText(copy.suggested)).toBeTruthy();
    expect(first.props.accessibilityLabel).toMatch(/^Suggested for you/);
    expect(screen.getAllByText(copy.suggested)).toHaveLength(1);
  });

  test('rows show the target in driving days and the points', async () => {
    await renderList(snapshot({ challenges: [] }));
    const row = screen.getByTestId('challenge-row-safe_run');
    expect(within(row).getByText('Have a safe day on 7 of 10 driving days')).toBeTruthy();
    expect(within(row).getByText('300 points')).toBeTruthy();
  });

  test('no suggestion when the newest goal is not this week\'s (before the week opens)', async () => {
    await renderList(snapshot({ challenges: [], currentGoal: goalRow('2026-09-14', { category: 'speeding' }) }), {
      online: false,
    });
    expect(discoverOrder()).toEqual(['phone_down', 'within_limit', 'smooth_ride', 'safe_run']);
    expect(screen.queryByText(copy.suggested)).toBeNull();
  });

  test('Discover marks a challenge already running', async () => {
    await renderList();
    await press(screen.getByTestId('challenge-tab-discover'));
    expect(within(screen.getByTestId('challenge-row-phone_down')).getByText(copy.running)).toBeTruthy();
  });

  test('Active shows progress in driving days; a row opens its detail', async () => {
    const running = enrolmentRow('phone_down', { pass_days: 6, fail_days: 4 });
    await renderList(snapshot({ challenges: [running] }));
    expect(screen.getByText('6 of 10 · 4 driving days left')).toBeTruthy();
    await press(screen.getByTestId('challenge-row-phone_down'));
    expect(mockRouter.push).toHaveBeenCalledWith(challengeHref('phone_down'));
  });

  test('Done lists completed and ended challenges, never left ones', async () => {
    const done = enrolmentRow('safe_run', { state: 'completed', pass_days: 7, fail_days: 1, completed_at: iso(Date.parse('2026-09-20T15:00:00Z')) });
    const ended = enrolmentRow('smooth_ride', { state: 'ended', pass_days: 8, fail_days: 6, ended_at: iso(Date.parse('2026-09-18T15:00:00Z')) });
    const left = enrolmentRow('within_limit', { state: 'left' });
    await renderList(snapshot({ challenges: [done, ended, left] }));
    await press(screen.getByTestId('challenge-tab-done'));
    expect(discoverOrder()).toEqual(['safe_run', 'smooth_ride']);
    await press(screen.getByTestId('challenge-row-safe_run'));
    expect(mockRouter.push).toHaveBeenCalledWith(challengeHref(done.id));
  });

  test('empty lists say so, each with one action to Discover', async () => {
    await renderList(snapshot({ challenges: [] }));
    await press(screen.getByTestId('challenge-tab-active'));
    expect(screen.getByText(copy.empty.active.title)).toBeTruthy();
    await press(screen.getByText(copy.empty.active.action));
    expect(screen.getByTestId('challenge-tab-discover').props.accessibilityState).toMatchObject({ selected: true });
    await press(screen.getByTestId('challenge-tab-done'));
    expect(screen.getByText(copy.empty.done.title)).toBeTruthy();
  });

  test('rendered copy on every tab passes BANNED_COPY and has no countdown words', async () => {
    const done = enrolmentRow('safe_run', { state: 'completed', completed_at: iso(Date.parse('2026-09-20T15:00:00Z')) });
    await renderList(snapshot({ challenges: [enrolmentRow('phone_down'), done] }));
    assertCopyRules();
    await press(screen.getByTestId('challenge-tab-discover'));
    assertCopyRules();
    await press(screen.getByTestId('challenge-tab-done'));
    assertCopyRules();
  });

  test('Dynamic Type 200 %: the tabs wrap instead of crushing', async () => {
    mockFontScale.mockReturnValue(2);
    await renderList();
    const style = [screen.getByTestId('challenge-tabs').props.style].flat(3).reduce((a, s) => ({ ...a, ...(s ?? {}) }), {}) as {
      flexWrap?: string;
    };
    expect(style.flexWrap).toBe('wrap');
  });
});

describe('ChallengeDetailScreen', () => {
  test('before joining: the sentence, the rules verbatim, the fairness note, the points, and Join', async () => {
    const { api } = await renderDetail('phone_down', snapshot({ challenges: [] }));
    expect(screen.getByText('Keep your phone down on 10 of 14 driving days')).toBeTruthy();
    expect(
      screen.getByText(
        "Counts the days you drive, starting tomorrow. Days you don't drive don't count and never run the clock down. A day counts once it's confirmed, and then it's final."
      )
    ).toBeTruthy();
    expect(screen.getByText('No extra driving needed: every driver gets the same number of days.')).toBeTruthy();
    expect(screen.getByText("200 points when it's complete")).toBeTruthy();
    await press(screen.getByTestId('challenge-join'));
    expect(api.joinChallenge).toHaveBeenCalledWith('phone_down');
    expect(await screen.findByText(copy.joined)).toBeTruthy();
    // now running: the one action is Leave
    expect(await screen.findByTestId('challenge-leave')).toBeTruthy();
    expect(screen.queryByTestId('challenge-join')).toBeNull();
    assertCopyRules();
  });

  test('two running: Join is disabled and says why', async () => {
    const snap = snapshot({ challenges: [enrolmentRow('phone_down'), enrolmentRow('within_limit')] });
    const { api } = await renderDetail('safe_run', snap);
    const join = screen.getByTestId('challenge-join');
    expect(join.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText(copy.twoActive)).toBeTruthy();
    await press(join);
    expect(api.joinChallenge).not.toHaveBeenCalled();
  });

  test.each(['busy', 'limit', 'invalid', 'not_available', 'two_active', 'already_active', 'unknown'] as const)(
    'a join refusal (%s) is worded honestly',
    async (code: RewardsRpcCode) => {
      const { server } = await renderDetail('smooth_ride', snapshot({ challenges: [] }));
      server.fail.join = new RewardsRpcError(code);
      await press(screen.getByTestId('challenge-join'));
      expect(await screen.findByText(copy.joinErrors[code])).toBeTruthy();
    }
  );

  test('running: progress in driving days, spoken; Leave asks first, then leaves', async () => {
    const running = enrolmentRow('phone_down', { pass_days: 6, fail_days: 4, start_day: '2026-09-10' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { api } = await renderDetail('phone_down', snapshot({ challenges: [running] }));
    expect(screen.getByText('6 of 10 · 4 driving days left')).toBeTruthy();
    const bar = screen.getByTestId('challenge-progress');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 10, now: 6, text: '6 of 10 days counted, 4 driving days left' });
    expect(screen.getByText(/^Counts the days you drive, from September 10\./)).toBeTruthy();
    await press(screen.getByTestId('challenge-leave'));
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body, buttons] = alert.mock.calls[0]!;
    expect(title).toBe('Leave this challenge?');
    expect(body).toBe("Days counted so far won't carry over.");
    expect(api.leaveChallenge).not.toHaveBeenCalled();
    const leave = (buttons ?? []).find((b) => b.style === 'destructive');
    expect(leave?.text).toBe(copy.leaveConfirm.leave);
    await act(async () => leave?.onPress?.());
    await settleInbox();
    expect(api.leaveChallenge).toHaveBeenCalledWith(running.id);
    expect(await screen.findByText(copy.leftNote)).toBeTruthy();
    expect(await screen.findByTestId('challenge-join')).toBeTruthy();
  });

  test('joined today: counting starts tomorrow', async () => {
    const running = enrolmentRow('safe_run', { pass_days: 0, fail_days: 0, start_day: '2026-09-24' });
    await renderDetail('safe_run', snapshot({ challenges: [running] }));
    expect(screen.getByText(copy.startsTomorrow)).toBeTruthy();
    expect(screen.getByText('0 of 7 · 10 driving days left')).toBeTruthy();
  });

  test.each(['busy', 'not_available', 'unknown'] as const)('a leave refusal (%s) is worded', async (code) => {
    const running = enrolmentRow('phone_down');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
      void buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    const { server } = await renderDetail('phone_down', snapshot({ challenges: [running] }));
    server.fail.leave = new RewardsRpcError(code);
    await press(screen.getByTestId('challenge-leave'));
    expect(await screen.findByText(copy.leaveErrors[code])).toBeTruthy();
  });

  test('completed: the date and the points added', async () => {
    const done = enrolmentRow('safe_run', {
      state: 'completed',
      pass_days: 7,
      fail_days: 1,
      completed_at: iso(Date.parse('2026-09-20T15:00:00Z')),
    });
    await renderDetail(done.id, snapshot({ challenges: [done] }));
    expect(screen.getByText('Completed on September 20.')).toBeTruthy();
    expect(screen.getByText('300 points added')).toBeTruthy();
    expect(screen.getByTestId('challenge-join')).toBeTruthy();
    expect(screen.getByText(copy.joinAgain)).toBeTruthy();
    assertCopyRules();
  });

  test('ended: said plainly', async () => {
    const ended = enrolmentRow('within_limit', { state: 'ended', pass_days: 8, fail_days: 6, ended_at: iso(Date.parse('2026-09-20T15:00:00Z')) });
    await renderDetail(ended.id, snapshot({ challenges: [ended] }));
    expect(screen.getByText('Ended after 14 driving days with 8 counted.')).toBeTruthy();
    expect(screen.queryByText(/points added/)).toBeNull();
    assertCopyRules();
  });

  test('offline: Join is disabled with the offline line, and nothing is sent', async () => {
    const { api } = await renderDetail('phone_down', snapshot({ challenges: [] }), { online: false });
    expect(screen.getByText(OFFLINE_LINE)).toBeTruthy();
    const join = screen.getByTestId('challenge-join');
    expect(join.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText(copy.joinOffline)).toBeTruthy();
    await press(join);
    expect(api.joinChallenge).not.toHaveBeenCalled();
  });

  test('an unknown challenge says so', async () => {
    await renderDetail('nope', snapshot());
    expect(screen.getByText(copy.notFound)).toBeTruthy();
  });
});
