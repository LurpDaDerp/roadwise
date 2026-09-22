import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { DataProvider } from '@/data/queries/context';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { DriveContext } from '@/drive/DriveProvider';
import { ThemeProvider } from '@/ui/theme';

import type { FlowContext } from '../flow';
import { StepPositionProvider } from '../StepFrame';
import { NotEligibleStep } from '../steps/NotEligibleStep';

const USER = 'child-1';
const mockSignOut = jest.fn(async (_opts?: { force?: boolean }) => ({ signedOut: true }) as
  | { signedOut: true }
  | { signedOut: false; unsentDeletes: number | null });
const mockSession = {
  session: { user: { id: USER } },
  profile: { id: USER },
  signOut: (opts?: { force?: boolean }) => mockSignOut(opts),
};
const mockPurgeObjects = jest.fn(async (_id: string) => 'done' as 'done' | 'partial');
const mockPurgeLocal = jest.fn(async (_db: unknown) => {});

jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  purgeOwnObjects: (id: string) => mockPurgeObjects(id),
  purgeLocalDriveData: (db: unknown) => mockPurgeLocal(db),
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

async function renderStep(host?: { untilIdle(): Promise<void> }) {
  const db = await createTestDb();
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
});

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

  it('a partial removal never prints the kept line; it says so and offers to try again', async () => {
    mockPurgeObjects.mockResolvedValueOnce('partial');
    await renderStep();
    expect(await screen.findByText("We couldn't finish removing your drive data.")).toBeOnTheScreen();
    expect(screen.queryByText(KEPT)).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(KEPT)).toBeOnTheScreen();
    expect(mockPurgeObjects).toHaveBeenCalledTimes(2);
  });

  it('a failed clean-up on the phone never prints the kept line, and Storage is not claimed', async () => {
    mockPurgeLocal.mockRejectedValueOnce(new Error('disk'));
    await renderStep();
    expect(await screen.findByText("We couldn't finish removing your drive data.")).toBeOnTheScreen();
    expect(screen.queryByText(KEPT)).toBeNull();
    expect(mockPurgeObjects).not.toHaveBeenCalled();
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
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    expect(mockSignOut).toHaveBeenCalledWith(undefined);
  });

  it('a delete still owed does not keep the child signed in: the sign-out goes through', async () => {
    mockSignOut.mockResolvedValueOnce({ signedOut: false, unsentDeletes: 1 });
    await renderStep();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(2));
    expect(mockSignOut).toHaveBeenLastCalledWith({ force: true });
  });

  it('a sign-out that fails says so', async () => {
    mockSignOut.mockRejectedValueOnce(new Error('keychain'));
    await renderStep();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText("Couldn't sign out. Try again.")).toBeOnTheScreen();
  });
});
