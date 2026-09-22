import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { DataProvider } from '@/data/queries/context';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { readProfileCache } from '@/features/auth/profileCache';
import { DriveContext } from '@/drive/DriveProvider';
import { ThemeProvider } from '@/ui/theme';

import type { FlowContext } from '../flow';
import { StepPositionProvider } from '../StepFrame';
import { NotEligibleStep } from '../steps/NotEligibleStep';

const USER = 'child-1';
const mockSignOut = jest.fn(async (_opts?: { force?: boolean }) => ({ signedOut: true }) as
  | { signedOut: true }
  | { signedOut: false; unsentDeletes: number | null });
const mockSession: {
  session: { user: { id: string } } | null;
  profile: { id: string };
  signOut: (opts?: { force?: boolean }) => Promise<unknown>;
} = {
  session: { user: { id: USER } },
  profile: { id: USER },
  signOut: (opts?: { force?: boolean }) => mockSignOut(opts),
};
const mockPurgeObjects = jest.fn(async (_id: string) => 'done' as 'done' | 'partial');
const mockPurgeLocal = jest.fn(async (_db: unknown) => {});
const mockReadPurged = jest.fn(async (_db: unknown, _id: string) => false);
const mockMarkPurged = jest.fn(async (_db: unknown, _id: string) => {});

jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  purgeOwnObjects: (id: string) => mockPurgeObjects(id),
  purgeLocalDriveData: (db: unknown) => mockPurgeLocal(db),
  readBlockPurged: (db: unknown, id: string) => mockReadPurged(db, id),
  markBlockPurged: (db: unknown, id: string) => mockMarkPurged(db, id),
}));

const ctx: FlowContext = {
  platform: 'ios',
  ageBand: 'u13',
  drivingStage: 'unknown',
  termsCurrent: false,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
};

const KEPT = "We've kept only what we need to remember this.";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderStep(host?: { untilIdle(): Promise<void> }, given?: Db) {
  const db = given ?? (await createTestDb());
  const step = (
    // Inside the stepper, as it renders in the app: the provider carries "Step 1 of 1".
    <StepPositionProvider value={{ index: 1, total: 1 }}>
      <NotEligibleStep ctx={ctx} onNext={() => {}} />
    </StepPositionProvider>
  );
  await render(
    <ThemeProvider>
      <DataProvider db={db}>
        {host ? (
          <DriveContext.Provider value={{ host, store: {} } as never}>{step}</DriveContext.Provider>
        ) : (
          step
        )}
      </DataProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mockSignOut.mockReset().mockResolvedValue({ signedOut: true });
  mockPurgeObjects.mockReset().mockResolvedValue('done');
  mockPurgeLocal.mockReset().mockResolvedValue(undefined);
  mockReadPurged.mockReset().mockResolvedValue(false);
  mockMarkPurged.mockReset().mockResolvedValue(undefined);
  mockSession.session = { user: { id: USER } };
});

const signOutButton = () => screen.getByTestId('not-eligible-sign-out');
const FAILED = "We couldn't finish removing your drive data.";

describe('NotEligibleStep', () => {
  it('says who RoadWise is for, as a heading, with no step count', async () => {
    await renderStep();
    expect(
      screen.getByRole('header', { name: 'RoadWise is for people 13 and older' })
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Step \d+ of \d+/)).toBeNull();
    expect(screen.queryByTestId('onboarding-progress-rule')).toBeNull();
    await act(async () => {});
  });

  it('prints the kept line only once the removal has succeeded', async () => {
    const objects = deferred<'done' | 'partial'>();
    mockPurgeObjects.mockReturnValueOnce(objects.promise);
    await renderStep();
    expect(screen.getByText('Removing your drive data…')).toBeOnTheScreen();
    expect(screen.queryByText(KEPT)).toBeNull();

    await act(async () => objects.resolve('done'));
    expect(await screen.findByText(KEPT)).toBeOnTheScreen();
    expect(mockPurgeLocal).toHaveBeenCalledTimes(1);
    expect(mockPurgeObjects).toHaveBeenCalledWith(USER);
  });

  it('a partial removal never prints the kept line; Try again comes first, sign-out second', async () => {
    mockPurgeObjects.mockResolvedValueOnce('partial');
    await renderStep();
    expect(await screen.findByText(FAILED)).toBeOnTheScreen();
    expect(screen.queryByText(KEPT)).toBeNull();
    // The phone is clean; what is left is on the server, which says it will finish.
    expect(screen.getByTestId('not-eligible-after-failure')).toHaveTextContent(
      'If you sign out now, RoadWise will finish removing your recorded drives from its servers.'
    );
    const buttons = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
    expect(buttons.indexOf('Try again')).toBeLessThan(buttons.indexOf('Sign out'));
    expect(signOutButton().props.accessibilityState).toMatchObject({ disabled: false });
    expect(mockMarkPurged).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(KEPT)).toBeOnTheScreen();
    expect(mockPurgeObjects).toHaveBeenCalledTimes(2);
    expect(mockMarkPurged).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('sign-out is disabled while the removal runs', async () => {
    const objects = deferred<'done' | 'partial'>();
    mockPurgeObjects.mockReturnValueOnce(objects.promise);
    await renderStep();
    await waitFor(() => expect(mockPurgeObjects).toHaveBeenCalled());
    expect(signOutButton().props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(signOutButton());
    expect(mockSignOut).not.toHaveBeenCalled();
    await act(async () => objects.resolve('done'));
    expect(signOutButton().props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('a removal already finished on this phone is not run again (no Storage call)', async () => {
    mockReadPurged.mockResolvedValue(true);
    await renderStep();
    expect(await screen.findByText(KEPT)).toBeOnTheScreen();
    expect(mockPurgeLocal).not.toHaveBeenCalled();
    expect(mockPurgeObjects).not.toHaveBeenCalled();
  });

  it('with no session nothing is removed as the account, and nothing claims it was', async () => {
    mockSession.session = null;
    await renderStep();
    expect(await screen.findByText(FAILED)).toBeOnTheScreen();
    expect(mockPurgeObjects).not.toHaveBeenCalled();
    expect(mockReadPurged).not.toHaveBeenCalled();
    expect(screen.queryByText(KEPT)).toBeNull();
  });

  it('"done" means the band-only profile cache is already on disk (a relaunch never arms)', async () => {
    const db = await createTestDb();
    const settings = createSettingsRepo(db);
    await settings.set('device.lastUserId', USER);
    await settings.set('profile.cache', {
      userId: USER,
      profile: { id: USER, age_band: 'u13', display_name: 'Kid' },
    });
    const actual = jest.requireActual<typeof import('../api')>('../api');
    // The real purge (only the file system and the notifier stubbed): the kept line may show
    // only once its transaction, the cache rewrite included, has committed.
    mockPurgeLocal.mockImplementationOnce((d) =>
      actual.purgeLocalDriveData(d as Db, {
        traces: { clear: async () => {} },
        cancelSummaries: async () => {},
      })
    );
    await renderStep(undefined, db);
    expect(await screen.findByText(KEPT)).toBeOnTheScreen();
    expect(await readProfileCache(settings, USER)).toEqual({ id: USER, age_band: 'u13' });
  });

  it('waits for an open drive to close before removing anything on the phone', async () => {
    const idle = deferred<void>();
    await renderStep({ untilIdle: () => idle.promise });
    await act(async () => {});
    expect(mockPurgeLocal).not.toHaveBeenCalled();
    await act(async () => idle.resolve());
    await waitFor(() => expect(mockPurgeLocal).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(KEPT)).toBeOnTheScreen();
  });

  it('Sign out is the existing sign-out', async () => {
    await renderStep();
    await screen.findByText(KEPT);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    expect(mockSignOut).toHaveBeenCalledWith(undefined);
  });

  it('a delete still owed does not keep the child signed in: the sign-out goes through', async () => {
    mockSignOut.mockResolvedValueOnce({ signedOut: false, unsentDeletes: 1 });
    await renderStep();
    await screen.findByText(KEPT);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(2));
    expect(mockSignOut).toHaveBeenLastCalledWith({ force: true });
  });

  it('a sign-out that fails says so', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('keychain'));
    await renderStep();
    await screen.findByText(KEPT);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText("Couldn't sign out. Try again.")).toBeOnTheScreen();
  });
});
