import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { BANNED_COPY } from '@/notifications/catalog';
import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';

import { GOAL_CATEGORY_VALUES, RewardsRpcError, type RewardsRpcCode } from '../api';
import { CATEGORY_LABEL, FOCUS_APPLIED, GOAL_PROGRESS, goalSentence, OFFLINE_LINE } from '../copy/common';
import { goalCopy } from '../copy/goal';
import { WeeklyGoalScreen } from '../goal/WeeklyGoalScreen';
import { resetEnsureWeekForTests } from '../useEnsureWeek';
import { fakeScreensApi, renderedStrings, screensWorld } from '../__fixtures__/goalChallengesWorld';
import { goalRow, snapshot } from '../__fixtures__/rows';

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
  jest.clearAllMocks();
});

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
  await settleInbox();
};

/** The fixture clock is Wednesday 2026-09-23 12:00 UTC: this week starts 2026-09-21. */
const THIS_WEEK = '2026-09-21';
const LAST_WEEK = '2026-09-14';

async function renderGoal(snap = snapshot(), opts: { online?: boolean } = {}) {
  const w = await screensWorld(opts.online === false ? { cached: snap } : {});
  if (opts.online === false) setOnline(false);
  const server = fakeScreensApi(snap);
  await w.render(<WeeklyGoalScreen deps={{ api: server.api }} tz="UTC" />);
  await screen.findByTestId('goal-screen');
  await settleInbox();
  return { ...w, ...server };
}

const forbidden = /left to|hurry|expires|last chance|days in a row/i;

function assertCopyRules() {
  const strings = renderedStrings(screen.toJSON());
  expect(strings.length).toBeGreaterThan(0);
  for (const s of strings) {
    for (const re of BANNED_COPY) expect(s).not.toMatch(re);
    expect(s).not.toMatch(forbidden);
  }
}

describe('WeeklyGoalScreen', () => {
  test.each(GOAL_CATEGORY_VALUES)('this week\'s focus is printed as the goal sentence (%s)', async (category) => {
    await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK, { category }) }));
    expect(screen.getByText(goalSentence(category, 4))).toBeTruthy();
  });

  test('progress is text and a bar, and the bar speaks its value', async () => {
    await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 2, fail_days: 1 }) }));
    expect(screen.getByText('2 of 4 driving days')).toBeTruthy();
    const bar = screen.getByTestId('goal-progress');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 4, now: 2, text: '2 of 4 driving days counted' });
  });

  test('an active goal says today counts when the day closes, and states the proration rule', async () => {
    await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK) }));
    expect(screen.getByText('Today counts when the day closes.')).toBeTruthy();
    expect(
      screen.getByText('Drive fewer than 4 days? Keep it up on every day you drive and it still counts.')
    ).toBeTruthy();
    // what reaching it adds, never shown as added
    expect(screen.getByText('150 points when the goal is reached')).toBeTruthy();
    expect(screen.queryByText(/added/)).toBeNull();
    assertCopyRules();
  });

  test('a reached goal says so (the shared words), with the points added', async () => {
    await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK, { state: 'achieved', pass_days: 4 }) }));
    expect(screen.getByText(GOAL_PROGRESS.achieved)).toBeTruthy();
    expect(screen.getByText('150 points added')).toBeTruthy();
    expect(screen.queryByText('Today counts when the day closes.')).toBeNull();
  });

  test('a prorated goal reached on every driving day', async () => {
    await renderGoal(
      snapshot({ currentGoal: goalRow(THIS_WEEK, { state: 'achieved', pass_days: 2, prorated: true }) })
    );
    expect(screen.getByText(GOAL_PROGRESS.achievedProrated)).toBeTruthy();
  });

  test.each([
    ['achieved', { state: 'achieved', pass_days: 4 }, 'Reached: Keep your phone down on 4 driving days.'],
    [
      'achieved (prorated)',
      { state: 'achieved', pass_days: 2, prorated: true },
      'Reached on every day you drove: Keep your phone down on 4 driving days.',
    ],
    ['ended', { state: 'ended', pass_days: 1, fail_days: 3 }, 'Not reached: Keep your phone down on 4 driving days.'],
    ['no drives', { state: 'no_drives', pass_days: 0 }, "No drives last week — that's fine"],
    ['still being confirmed', { state: 'active' }, "Last week's result appears once its last days are confirmed."],
  ] as const)("last week's result: %s", async (_name, over, text) => {
    await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK), lastGoal: goalRow(LAST_WEEK, over) }));
    expect(within(screen.getByTestId('goal-last-week')).getByText(text)).toBeTruthy();
    assertCopyRules();
  });

  test('no last week section when last week had no goal', async () => {
    await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK), lastGoal: null }));
    expect(screen.queryByTestId('goal-last-week')).toBeNull();
  });

  test('offline before the week is opened: the newest goal is last week\'s, so no current goal is claimed', async () => {
    const stale = snapshot({ currentGoal: goalRow(LAST_WEEK, { state: 'active', category: 'speeding' }), lastGoal: null });
    const { api } = await renderGoal(stale, { online: false });
    expect(screen.getByText(OFFLINE_LINE)).toBeTruthy();
    expect(screen.getByText(goalCopy.noGoal.title)).toBeTruthy();
    expect(screen.queryByText(goalSentence('speeding', 4))).toBeNull();
    // ...but it is last week's, so it is shown as last week
    expect(within(screen.getByTestId('goal-last-week')).getByText(goalCopy.lastWeek.confirming)).toBeTruthy();
    expect(api.openMyWeek).not.toHaveBeenCalled();
    expect(api.fetchSnapshot).not.toHaveBeenCalled();
  });

  test('online with no goal for this week opens the week once', async () => {
    const { api } = await renderGoal(snapshot({ currentGoal: goalRow(LAST_WEEK), lastGoal: null }));
    await waitFor(() => expect(api.openMyWeek).toHaveBeenCalledTimes(1));
  });

  test('a read error has a retry', async () => {
    const w = await screensWorld();
    const { api, server } = fakeScreensApi();
    server.fail.fetch = new Error('refused');
    await w.render(<WeeklyGoalScreen deps={{ api }} tz="UTC" />);
    expect(await screen.findByText(goalCopy.error.message)).toBeTruthy();
    server.fail.fetch = undefined;
    await press(screen.getByText(goalCopy.error.retry));
    expect(await screen.findByText(goalSentence('phone', 4))).toBeTruthy();
  });

  describe('FocusPicker', () => {
    test('five radios, the current focus checked', async () => {
      await renderGoal(snapshot({ currentGoal: goalRow(THIS_WEEK, { category: 'braking' }) }));
      await press(screen.getByText(goalCopy.changeFocus));
      const group = screen.getByTestId('focus-options');
      expect(group.props.accessibilityRole).toBe('radiogroup');
      for (const c of GOAL_CATEGORY_VALUES) {
        const radio = screen.getByTestId(`focus-${c}`);
        expect(radio.props.accessibilityRole).toBe('radio');
        expect(radio.props.accessibilityLabel).toBe(CATEGORY_LABEL[c]);
        expect(radio.props.accessibilityState).toMatchObject({ checked: c === 'braking' });
      }
    });

    test.each(['this_week', 'next_week'] as const)('save shows where it applied (%s)', async (applied) => {
      const { api, server } = await renderGoal();
      server.focusApplied = applied;
      await press(screen.getByText(goalCopy.changeFocus));
      await press(screen.getByTestId('focus-speeding'));
      expect(screen.getByTestId('focus-speeding').props.accessibilityState).toMatchObject({ checked: true });
      await press(screen.getByText(goalCopy.picker.save));
      expect(api.setWeeklyFocus).toHaveBeenCalledWith('speeding');
      expect(await screen.findByText(FOCUS_APPLIED[applied])).toBeTruthy();
      // the sheet's one action is now Done, which closes it
      await press(screen.getByText(goalCopy.picker.done));
      expect(screen.queryByTestId('focus-options')).toBeNull();
    });

    test.each(['busy', 'limit', 'invalid', 'not_available', 'unknown'] as const)(
      'a refusal (%s) is worded, and the sheet stays open to try again',
      async (code: RewardsRpcCode) => {
        const { server } = await renderGoal();
        server.fail.focus = new RewardsRpcError(code);
        await press(screen.getByText(goalCopy.changeFocus));
        await press(screen.getByTestId('focus-accel'));
        await press(screen.getByText(goalCopy.picker.save));
        expect(await screen.findByText(goalCopy.picker.errors[code])).toBeTruthy();
        expect(screen.getByText(goalCopy.picker.save)).toBeTruthy();
      }
    );

    test('busy is the shared line', () => {
      expect(goalCopy.picker.errors.busy).toBe('Busy right now. Try again.');
    });

    test('offline: nothing is sent, and the sheet says why', async () => {
      const { api } = await renderGoal(snapshot(), { online: false });
      await press(screen.getByText(goalCopy.changeFocus));
      await press(screen.getByTestId('focus-cornering'));
      await press(screen.getByText(goalCopy.picker.save));
      expect(await screen.findByText(goalCopy.picker.errors.offline)).toBeTruthy();
      expect(api.setWeeklyFocus).not.toHaveBeenCalled();
    });

    test('save is off until a different focus is chosen; cancel closes without a call', async () => {
      const { api } = await renderGoal();
      await press(screen.getByText(goalCopy.changeFocus));
      expect(screen.getByTestId('focus-save').props.accessibilityState).toMatchObject({ disabled: true });
      await press(screen.getByText(goalCopy.picker.cancel));
      expect(screen.queryByTestId('focus-options')).toBeNull();
      expect(api.setWeeklyFocus).not.toHaveBeenCalled();
    });
  });

  test('the rendered copy passes BANNED_COPY and has no countdown words (picker open too)', async () => {
    await renderGoal();
    assertCopyRules();
    await press(screen.getByText(goalCopy.changeFocus));
    assertCopyRules();
  });

  test('Dynamic Type 200 %: the goal sentence and the action scale to twice their size', async () => {
    mockFontScale.mockReturnValue(2);
    await renderGoal();
    const sentence = screen.getByText(goalSentence('phone', 4));
    const flat = [sentence.props.style].flat(3).reduce((a, s) => ({ ...a, ...(s ?? {}) }), {}) as { fontSize?: number };
    expect(flat.fontSize).toBeGreaterThanOrEqual(2 * 17);
    expect(screen.getByText(goalCopy.changeFocus)).toBeTruthy();
  });
});
