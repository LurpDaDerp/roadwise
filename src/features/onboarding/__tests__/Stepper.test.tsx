import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { memoryDb as createTestDb } from '@/features/permissions/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import type { FlowContext, StepId } from '../flow';
import { readSavedPlan, readSavedStep, savePlan, saveStep } from '../state';
import { OnboardingStepper, resetSessionPlan } from '../Stepper';

// Every step renders as a stub: this suite is about the stepper's mechanics, not the steps.
jest.mock('../steps/UsernameStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { UsernameStep: (p: object) => <StubStep {...p} step="username" /> };
});
jest.mock('../steps/HowStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { HowStep: (p: object) => <StubStep {...p} step="how" /> };
});
jest.mock('../steps/MotionStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { MotionStep: (p: object) => <StubStep {...p} step="motion" /> };
});
jest.mock('../steps/LocationStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { LocationStep: (p: object) => <StubStep {...p} step="location" /> };
});
jest.mock('../steps/NotificationsStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { NotificationsStep: (p: object) => <StubStep {...p} step="notifications" /> };
});
jest.mock('../steps/ReminderStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { ReminderStep: (p: object) => <StubStep {...p} step="reminder" /> };
});
jest.mock('../steps/DashcamStep', () => {
  const { StubStep } = jest.requireActual('../__fixtures__/StubStep');
  return { DashcamStep: (p: object) => <StubStep {...p} step="dashcam" /> };
});
const mockFinish = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());
jest.mock('../finish', () => ({ finishOnboarding: (deps: unknown) => mockFinish(deps) }));
const mockRefreshProfile = jest.fn(() => Promise.resolve());
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: 'user-1' } }, refreshProfile: mockRefreshProfile }),
}));

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    // Every screen in these suites is focused; `Stepper.router.test.tsx` covers a covered one.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useRouter: () => mockRouter,
    Redirect: ({ href }: { href: string }) => <MockText testID="redirect">{href}</MockText>,
  };
});

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { platform: 'android', hasUsername: true, ...over };
}

let settings: SettingsRepo;

beforeEach(async () => {
  settings = createSettingsRepo(await createTestDb());
  mockRouter.replace.mockClear();
  mockFinish.mockReset().mockResolvedValue(undefined);
  resetSessionPlan();
});

function renderStepper(step: string | undefined, c: FlowContext | null) {
  return render(
    <ThemeProvider>
      <OnboardingStepper step={step} ctx={c} settings={settings} />
    </ThemeProvider>
  );
}

describe('OnboardingStepper', () => {
  it.each(['bogus', 'Terms', 'ready', '', undefined])(
    'sends an unknown step (%p) to start',
    async (step) => {
      await renderStepper(step, ctx());
      expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/start');
    }
  );

  it('sends a known step that is not in this flow to the step it resumes at', async () => {
    // The username was just claimed: the context no longer lists the step, so it moves on.
    await renderStepper('username', ctx());
    expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/how');
  });

  it('holds a skeleton while the context is loading, without redirecting', async () => {
    await renderStepper('location', null);
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(screen.getByLabelText('Loading')).toBeOnTheScreen();
  });

  it('resumes from start at the saved step', async () => {
    await saveStep(settings, 'notifications');
    await renderStepper('start', ctx());
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/notifications')
    );
  });

  it('resumes from start at the username while it is owed, whatever was saved', async () => {
    await saveStep(settings, 'notifications');
    await renderStepper('start', ctx({ hasUsername: false }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/username'));
  });

  it('waits for the context before resuming from start', async () => {
    const view = await renderStepper('start', null);
    await act(async () => {});
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="start" ctx={ctx()} settings={settings} />
      </ThemeProvider>
    );
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/how'));
  });

  it('renders the registered step with its position and saves it for a later resume', async () => {
    await renderStepper('motion', ctx());
    expect(screen.getByText('Step 2 of 6')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Motion' })).toBeOnTheScreen();
    await waitFor(async () => expect(await readSavedStep(settings)).toBe('motion'));
  });

  it('moves forward with Continue and back with Back', async () => {
    await renderStepper('location', ctx());
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/notifications');
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/motion');
    await act(async () => {});
  });

  it('offers no Back on the first step', async () => {
    await renderStepper('how', ctx());
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await act(async () => {});
  });

  it('maps the Android back button onto Back, and leaves it to the system with nowhere to go', async () => {
    const listeners: (() => boolean)[] = [];
    const spy = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockImplementation((_event, handler) => {
        listeners.push(handler as () => boolean);
        return {
          remove: () => listeners.splice(listeners.indexOf(handler as () => boolean), 1),
        };
      });

    const view = await renderStepper('motion', ctx());
    expect(listeners.at(-1)?.()).toBe(true);
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/how');

    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="how" ctx={ctx()} settings={settings} />
      </ThemeProvider>
    );
    mockRouter.replace.mockClear();
    expect(listeners.at(-1)?.()).toBe(false);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    spy.mockRestore();
    await act(async () => {});
  });

  it('keeps the count steady as the username drops out of the flow', async () => {
    const view = await renderStepper('username', ctx({ hasUsername: false }));
    expect(screen.getByText('Step 1 of 7')).toBeOnTheScreen();
    const at = (step: StepId, c: FlowContext) =>
      view.rerender(
        <ThemeProvider>
          <OnboardingStepper step={step} ctx={c} settings={settings} />
        </ThemeProvider>
      );
    await at('how', ctx());
    expect(screen.getByText('Step 2 of 7')).toBeOnTheScreen();
    await act(async () => {});
  });

  it('carries the saved count across a restart, through start', async () => {
    // A plan saved by an older build, with retired steps (license, clan) and before the reminder and
    // DashPal steps existed: the retired ids drop out, the new steps join the count.
    const PLAN = ['username', 'license', 'how', 'motion', 'location', 'notifications', 'clan'] as StepId[];
    const NOW: StepId[] = ['username', 'how', 'motion', 'location', 'notifications', 'reminder', 'dashcam'];
    await saveStep(settings, 'location');
    await savePlan(settings, PLAN);
    const view = await renderStepper('start', ctx());
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/location'));
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="location" ctx={ctx()} settings={settings} />
      </ThemeProvider>
    );
    expect(screen.getByText('Step 4 of 7')).toBeOnTheScreen();
    await waitFor(async () => expect(await readSavedPlan(settings)).toEqual(NOW));
  });

  it('finishes onboarding after the last step', async () => {
    await renderStepper('dashcam', ctx());
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mockFinish).toHaveBeenCalledTimes(1));
    expect(mockFinish).toHaveBeenCalledWith(
      expect.objectContaining({ settings, userId: 'user-1', router: mockRouter, refreshProfile: mockRefreshProfile })
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('onboarding-finish-error')).toBeNull();
  });

  it('says so when finishing fails, and finishes on the next press', async () => {
    mockFinish.mockRejectedValueOnce(new Error('offline'));
    await renderStepper('dashcam', ctx());
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('onboarding-finish-error')).toHaveTextContent(
      "Couldn't finish setting up. Check your connection and try again."
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mockFinish).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('onboarding-finish-error')).toBeNull());
  });

  it('runs one finish at a time', async () => {
    let release: () => void = () => {};
    mockFinish.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    await renderStepper('dashcam', ctx());
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockFinish).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });
});
