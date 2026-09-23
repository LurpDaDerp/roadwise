/**
 * This week's focus on Home (§7.B B1 item 6, M5 Task 10): the RECORD section's weekly goal field.
 * The rewards server is a double behind `defaultRewardsApi`; the database, the query client and
 * the rewards hooks are the real ones.
 */
import { act, screen, waitFor, within } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { WeeklyFocusField } from '@/features/home/WeeklyFocusField';
import { setOnline } from '@/features/inbox/__fixtures__/harness';
import { RewardsDataError, type RewardsSnapshot, type WeeklyGoalSummary } from '@/features/rewards/api';
import { writeCachedRewards } from '@/features/rewards/cache';
import { NOT_MONEY } from '@/features/rewards/copy/common';
import { resetEnsureWeekForTests } from '@/features/rewards/useEnsureWeek';
import { goalRow, NOW, snapshot, UID } from '@/features/rewards/__fixtures__/rows';
import { clearQueryClients, press, routerDouble, world } from '@/features/trips/__fixtures__/render';
import { BANNED_COPY } from '@/notifications/catalog';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
// NOW is Wednesday 2026-09-23 12:00 UTC: this week starts Monday 2026-09-21.
jest.mock('@/lib/deviceZone', () => ({ deviceZone: () => 'UTC' }));

const mockServer: {
  answer: () => Promise<RewardsSnapshot>;
  open: () => Promise<WeeklyGoalSummary>;
  fetches: number;
  opens: number;
} = {
  answer: () => Promise.reject(new Error('set in beforeEach')),
  open: () => Promise.reject(new Error('set in beforeEach')),
  fetches: 0,
  opens: 0,
};
jest.mock('@/features/rewards/api', () => {
  const actual = jest.requireActual<typeof import('@/features/rewards/api')>('@/features/rewards/api');
  return {
    ...actual,
    defaultRewardsApi: {
      ...actual.defaultRewardsApi,
      fetchSnapshot: () => {
        mockServer.fetches += 1;
        return mockServer.answer();
      },
      openMyWeek: () => {
        mockServer.opens += 1;
        return mockServer.open();
      },
    },
  };
});

const THIS_WEEK = '2026-09-21';
const now = () => NOW;

const openedSummary: WeeklyGoalSummary = {
  week_start: THIS_WEEK,
  category: 'braking',
  source: 'weakest',
  target_days: 4,
  pass_days: 0,
  fail_days: 0,
  state: 'active',
  prorated: false,
};

beforeEach(() => {
  resetEnsureWeekForTests();
  mockServer.answer = async () => snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 2 }) });
  mockServer.open = async () => openedSummary;
  mockServer.fetches = 0;
  mockServer.opens = 0;
  mockRouter.push.mockClear();
});

afterEach(() => {
  clearQueryClients();
  setOnline(null);
});

async function renderField(before?: (w: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  const w = await world({}, now);
  await before?.(w);
  await w.renderScreen(<WeeklyFocusField />);
  return w;
}

/** The shared active line (`goalActiveLine`) with no failed day: the proration promise holds. */
const ACTIVE_LINE = 'Drive fewer days this week? Keeping it up on each day you drive still counts.';
const LABEL =
  'This week. Keep your phone down on 4 driving days. 2 of 4 driving days. Drive fewer days this week? Keeping it up on each day you drive still counts. Opens your weekly goal';

test("this week's goal: the sentence, the day count with a bar, and a tap to the goal", async () => {
  await renderField();
  const field = await screen.findByRole('button', { name: LABEL });
  expect(screen.getByText('This week')).toBeOnTheScreen();
  expect(within(field).getByText('Keep your phone down on 4 driving days')).toBeOnTheScreen();
  expect(within(field).getByText('2 of 4 driving days')).toBeOnTheScreen();
  expect(within(field).getByText(ACTIVE_LINE)).toBeOnTheScreen();
  // The count is printed once: the shared line comes without its own.
  expect(within(field).getAllByText(/2 of 4/)).toHaveLength(1);
  // Never a nudge to drive more.
  expect(within(field).queryByText(/more driving day/)).toBeNull();
  expect(within(field).getByTestId('weekly-focus-bar', { includeHiddenElements: true })).toBeOnTheScreen();
  await press(field);
  expect(mockRouter.push).toHaveBeenCalledWith('/rewards/goal');
  // A goal that already exists is never opened again.
  expect(mockServer.opens).toBe(0);
});

test('after a day that did not pass, the proration promise is dropped and no line is printed', async () => {
  mockServer.answer = async () => snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 2, fail_days: 1 }) });
  await renderField();
  expect(
    await screen.findByRole('button', {
      name: 'This week. Keep your phone down on 4 driving days. 2 of 4 driving days. Opens your weekly goal',
    })
  ).toBeOnTheScreen();
  // Nothing more to say after a failed day: no line at all, and the count printed once.
  expect(screen.queryByTestId('weekly-focus-line')).toBeNull();
  expect(screen.getAllByText(/2 of 4/)).toHaveLength(1);
  expect(screen.queryByText(/Drive fewer days/)).toBeNull();
});

test('a goal reached says so, and its bar is full', async () => {
  mockServer.answer = async () =>
    snapshot({ currentGoal: goalRow(THIS_WEEK, { category: 'speeding', pass_days: 4, state: 'achieved' }) });
  await renderField();
  expect(
    await screen.findByRole('button', {
      name: 'This week. Stay within the limit on 4 driving days. 4 of 4 driving days. Goal reached. Opens your weekly goal',
    })
  ).toBeOnTheScreen();
  expect(screen.getByText('Goal reached.')).toBeOnTheScreen();
  expect(screen.getByTestId('weekly-focus-fill', { includeHiddenElements: true }).props.style).toEqual(
    expect.arrayContaining([expect.objectContaining({ width: '100%' })])
  );
});

test('the bar never runs past full', async () => {
  mockServer.answer = async () =>
    snapshot({ currentGoal: goalRow(THIS_WEEK, { target_days: 2, pass_days: 3, state: 'achieved', prorated: true }) });
  await renderField();
  await screen.findByText('3 of 2 driving days');
  expect(screen.getByTestId('weekly-focus-fill', { includeHiddenElements: true }).props.style).toEqual(
    expect.arrayContaining([expect.objectContaining({ width: '100%' })])
  );
});

test("no goal for this week yet, online: this week's goal is opened, then printed", async () => {
  let serverGoal = goalRow('2026-09-14', { state: 'ended' });
  let opened: () => void = () => {};
  mockServer.answer = async () => snapshot({ currentGoal: serverGoal });
  mockServer.open = () =>
    new Promise((resolve) => {
      opened = () => {
        serverGoal = goalRow(THIS_WEEK, { category: 'braking', pass_days: 0 });
        resolve(openedSummary);
      };
    });
  await renderField();

  // Last week's goal is never printed as this week's.
  expect(await screen.findByText('No goal for this week yet.')).toBeOnTheScreen();
  expect(screen.queryByText('Keep your phone down on 4 driving days')).toBeNull();
  await waitFor(() => expect(mockServer.opens).toBe(1));
  await act(async () => opened());
  expect(await screen.findByText('Brake smoothly on 4 driving days')).toBeOnTheScreen();
  expect(screen.getByText('0 of 4 driving days')).toBeOnTheScreen();
  expect(screen.getByText('Counts from the days you drive this week.')).toBeOnTheScreen();
  expect(mockServer.opens).toBe(1);
});

test('offline with no goal saved: it says when the goal appears, and nothing is asked of the server', async () => {
  setOnline(false);
  await renderField();
  expect(await screen.findByText("Your weekly goal appears when you're online.")).toBeOnTheScreen();
  expect(screen.queryByRole('button')).toBeNull();
  expect(mockServer.fetches + mockServer.opens).toBe(0);
});

test("offline with only last week's goal saved: the same line, never last week's goal as this week's", async () => {
  await renderField(async (w) => {
    await writeCachedRewards(createSettingsRepo(w.db), UID, snapshot({ currentGoal: goalRow('2026-09-14') }));
    setOnline(false);
  });
  expect(await screen.findByText("Your weekly goal appears when you're online.")).toBeOnTheScreen();
  expect(screen.queryByText(/driving days/)).toBeNull();
  expect(mockServer.opens).toBe(0);
});

test("offline with this week's goal saved: the saved goal is printed", async () => {
  await renderField(async (w) => {
    await writeCachedRewards(createSettingsRepo(w.db), UID, snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 2 }) }));
    setOnline(false);
  });
  expect(await screen.findByRole('button', { name: LABEL })).toBeOnTheScreen();
  expect(mockServer.fetches).toBe(0);
});

test('while the rewards load, the field is a skeleton', async () => {
  let finish: (s: RewardsSnapshot) => void = () => {};
  mockServer.answer = () => new Promise((resolve) => (finish = resolve));
  await renderField();
  expect(await screen.findByTestId('weekly-focus-loading')).toBeOnTheScreen();
  expect(screen.getByText('This week')).toBeOnTheScreen();
  await act(async () => finish(snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 2 }) })));
  expect(await screen.findByRole('button', { name: LABEL })).toBeOnTheScreen();
});

test('an unreadable answer: the field says so with its own retry', async () => {
  mockServer.answer = async () => {
    throw new RewardsDataError('weekly_goals');
  };
  await renderField();
  expect(await screen.findByText("Couldn't read your weekly goal.")).toBeOnTheScreen();
  mockServer.answer = async () => snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 2 }) });
  await press(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: LABEL })).toBeOnTheScreen();
});

test('every printed and spoken line passes BANNED_COPY', async () => {
  const lines: string[] = [];
  for (const state of ['active', 'achieved', 'no_drives', 'ended'] as const) {
    clearQueryClients();
    resetEnsureWeekForTests();
    mockServer.answer = async () => snapshot({ currentGoal: goalRow(THIS_WEEK, { pass_days: 1, state }) });
    const w = await world({}, now);
    const view = await w.renderScreen(<WeeklyFocusField />);
    const field = await screen.findByTestId('weekly-focus');
    lines.push(String(field.props.accessibilityLabel));
    for (const n of within(field).queryAllByText(/.+/)) lines.push(String(n.props.children));
    view.unmount();
  }
  const checked = lines.filter((l) => l !== NOT_MONEY);
  expect(checked.length).toBeGreaterThan(8);
  for (const l of checked) for (const re of BANNED_COPY) expect([l, re.test(l)]).toEqual([l, false]);
});
