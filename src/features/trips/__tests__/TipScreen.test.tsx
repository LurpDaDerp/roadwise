import { fireEvent, screen } from '@testing-library/react-native';

import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { RewardsRpcError } from '@/features/rewards/api';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';
import { pendingDay, serveRewards } from '@/features/trips/__fixtures__/rewards';
import { goalCategoryOf, TipScreen } from '@/features/trips/TipScreen';
import { BANNED_COPY } from '@/notifications/catalog';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time; the
// shapes are local rather than an `import` from 'node:fs' (the tips suite's pattern: no @types/node).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const { readdirSync, readFileSync, statSync } = require('node:fs') as {
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
  statSync: (path: string) => { isDirectory: () => boolean };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
// The rewards server is the fixture's double, resolved at call time (the fixture reads this module).
jest.mock('@/features/rewards/api', () => ({
  ...jest.requireActual<object>('@/features/rewards/api'),
  defaultRewardsApi: new Proxy(
    {},
    {
      get: (_target, name: string) => (...args: unknown[]) =>
        (
          jest.requireActual<{ rewardsApiDelegate: Record<string, (...a: unknown[]) => unknown> }>(
            '@/features/trips/__fixtures__/rewards'
          ).rewardsApiDelegate[name] as (...a: unknown[]) => unknown
        )(...args),
    }
  ),
}));

const ID = 'trip-1';

let rewards: ReturnType<typeof serveRewards>;

beforeEach(() => {
  mockRouter.back.mockClear();
  mockRouter.dismissTo.mockClear();
  rewards = serveRewards(pendingDay());
});

afterEach(clearQueryClients);

test('a coaching tip is read in full, with the moments from this drive it is about', async () => {
  const w = await world({
    trips: [
      tripRow({
        client_trip_id: ID,
        score: 91,
        category_deductions_json: JSON.stringify(deductions({ braking: 9 })),
      }),
    ],
    events: [
      eventRow({ id: 'b1', client_trip_id: ID, category: 'braking', started_at: T0 + 5 * 60_000, deduction: 4, measured_json: JSON.stringify({ peakG: -0.42 }) }),
      eventRow({ id: 'b2', client_trip_id: ID, category: 'braking', started_at: T0 + 9 * 60_000, deduction: 5, measured_json: JSON.stringify({ peakG: -0.5 }) }),
      eventRow({ id: 'b3', client_trip_id: ID, category: 'braking', started_at: T0 + 12 * 60_000, deduction: 3 }),
      eventRow({ id: 'p', client_trip_id: ID, category: 'braking', status: 'possible', deduction: 0 }),
    ],
  });
  await w.renderScreen(<TipScreen clientTripId={ID} />);

  expect(await screen.findByRole('header', { name: 'Leave a three-second gap' })).toBeOnTheScreen();
  expect(screen.getByText(/Why it matters/i)).toBeOnTheScreen();
  // Two examples at most, the ones that cost points, at the trip's own times.
  expect(screen.getByLabelText('12:05 PM, 0.42 g brake')).toBeOnTheScreen();
  expect(screen.getByLabelText('12:09 PM, 0.50 g brake')).toBeOnTheScreen();
  expect(screen.queryByText(/12:12 PM/)).toBeNull();
});

const brakingDrive = () =>
  tripRow({ client_trip_id: ID, score: 91, category_deductions_json: JSON.stringify(deductions({ braking: 9 })) });

describe('Practice this week (D6 → the weekly focus, §10.4)', () => {
  test("sets the tip's category as this week's focus on the server and says where it applied", async () => {
    const w = await world({ trips: [brakingDrive()] });
    await w.renderScreen(<TipScreen clientTripId={ID} />);
    await screen.findByRole('header', { name: 'Leave a three-second gap' });

    await fireEvent.press(screen.getByRole('button', { name: 'Practice this week' }));

    expect(await screen.findByText('This is your focus this week.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Focus set for this week' })).toBeDisabled();
    expect(rewards.api.setWeeklyFocus).toHaveBeenCalledTimes(1);
    expect(rewards.api.setWeeklyFocus).toHaveBeenCalledWith('braking');
  });

  test('a week that already has days counted takes it as next week\'s focus, and says so', async () => {
    rewards.server.focusApplied = 'next_week';
    const w = await world({ trips: [brakingDrive()] });
    await w.renderScreen(<TipScreen clientTripId={ID} />);
    await screen.findByRole('header', { name: 'Leave a three-second gap' });
    await fireEvent.press(screen.getByRole('button', { name: 'Practice this week' }));
    expect(
      await screen.findByText('This will be your focus next week — this week already has days counted.')
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Focus set for next week' })).toBeDisabled();
    expect(screen.queryByText('This is your focus this week.')).toBeNull();
  });

  test('offline: it says so, and the button stays to try again', async () => {
    rewards.server.fail.focus = new RewardsRpcError('offline');
    const w = await world({ trips: [brakingDrive()] });
    await w.renderScreen(<TipScreen clientTripId={ID} />);
    await screen.findByRole('header', { name: 'Leave a three-second gap' });
    await fireEvent.press(screen.getByRole('button', { name: 'Practice this week' }));
    expect(
      await screen.findByText("Couldn't set your focus. Try again when you're online.")
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Practice this week' })).toBeEnabled();
  });

  test('a busy server and any other refusal say what to do', async () => {
    rewards.server.fail.focus = new RewardsRpcError('busy');
    const w = await world({ trips: [brakingDrive()] });
    await w.renderScreen(<TipScreen clientTripId={ID} />);
    await screen.findByRole('header', { name: 'Leave a three-second gap' });
    await fireEvent.press(screen.getByRole('button', { name: 'Practice this week' }));
    expect(await screen.findByText('Busy right now. Try again.')).toBeOnTheScreen();

    rewards.server.fail.focus = new RewardsRpcError('limit');
    await fireEvent.press(screen.getByRole('button', { name: 'Practice this week' }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeOnTheScreen();
  });

  test('a camera (focus) tip has no goal category, so there is no button', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: 88, category_deductions_json: JSON.stringify(deductions({ focus: 12 })) })],
    });
    await w.renderScreen(<TipScreen clientTripId={ID} />);
    await screen.findByTestId('tip-screen');
    expect(screen.queryByRole('button', { name: 'Practice this week' })).toBeNull();
    expect(rewards.api.setWeeklyFocus).not.toHaveBeenCalled();
  });

  test('only the five goal categories map to a focus', () => {
    expect(['phone', 'speeding', 'braking', 'accel', 'cornering'].map(goalCategoryOf)).toEqual([
      'phone',
      'speeding',
      'braking',
      'accel',
      'cornering',
    ]);
    expect(goalCategoryOf('focus')).toBeNull();
    expect(goalCategoryOf('general')).toBeNull();
  });

  test('the phone-local weekly focus is gone: nothing reads or writes WEEKLY_FOCUS_KEY', () => {
    const root = join(__dirname, '..', '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !path.endsWith('TipScreen.test.tsx')) {
          if (readFileSync(path, 'utf8').includes('WEEKLY_FOCUS_KEY')) hits.push(path);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });

  test('the new focus lines pass BANNED_COPY', () => {
    for (const line of [
      'Focus set for next week',
      "Couldn't set your focus. Try again when you're online.",
    ]) {
      for (const banned of BANNED_COPY) expect(line).not.toMatch(banned);
    }
  });
});

test('the clean-drive card has nothing to practise: it reads, and Done goes back', async () => {
  const w = await world({ trips: [tripRow({ client_trip_id: ID, score: 100, status: 'final', sync_state: 'synced' })] });
  await w.renderScreen(<TipScreen clientTripId={ID} />);
  expect(await screen.findByRole('header', { name: 'Keep the run going' })).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Practice this week' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(mockRouter.back).toHaveBeenCalled();
});

test('a drive that is on the record but has nothing to coach says exactly that', async () => {
  const w = await world({ trips: [tripRow({ client_trip_id: ID, score: null, status: 'unscored' })] });
  await w.renderScreen(<TipScreen clientTripId={ID} />);
  expect(await screen.findByText('No tip for this drive')).toBeOnTheScreen();
  expect(screen.getByText("This drive didn't cost points in any one area.")).toBeOnTheScreen();
  expect(screen.queryByText("This drive isn't on your record")).toBeNull();
});

test('a drive that is not on the record at all is still the not-found state', async () => {
  const w = await world();
  await w.renderScreen(<TipScreen clientTripId="missing" />);
  expect(await screen.findByText("This drive isn't on your record")).toBeOnTheScreen();
});
