import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import type { FlowContext, StepId } from '../flow';
import { readSavedPlan, readSavedStep, savePlan, saveStep } from '../state';
import { OnboardingStepper, resetSessionPlan } from '../Stepper';

// Task 12's real Terms, profile and block steps read the session, the config and the server; this
// suite is about the stepper's mechanics, so those three render the placeholder frame instead.
jest.mock('../steps/TermsStep', () => {
  const { PlaceholderStep } = jest.requireActual('../steps/PlaceholderStep');
  return { TermsStep: (p: object) => <PlaceholderStep {...p} step="terms" /> };
});
jest.mock('../steps/ProfileStep', () => {
  const { PlaceholderStep } = jest.requireActual('../steps/PlaceholderStep');
  return { ProfileStep: (p: object) => <PlaceholderStep {...p} step="profile" /> };
});
jest.mock('../steps/NotEligibleStep', () => {
  const { PlaceholderStep } = jest.requireActual('../steps/PlaceholderStep');
  return { NotEligibleStep: (p: object) => <PlaceholderStep {...p} step="not-eligible" /> };
});

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
  return {
    platform: 'android',
    ageBand: '18_plus',
    drivingStage: 'new',
    termsCurrent: true,
    termsPublished: true,
    minorConsentMode: 'guardian_link_optional',
    features: { autoDetect: true, guardianInvites: false },
    ...over,
  };
}

let settings: SettingsRepo;

beforeEach(async () => {
  settings = createSettingsRepo(await createTestDb());
  mockRouter.replace.mockClear();
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
  it.each(['bogus', 'Terms', '', undefined])(
    'sends an unknown step (%p) to start',
    async (step) => {
      await renderStepper(step, ctx());
      expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/start');
    }
  );

  it('sends a known step that is not in this flow to the step it resumes at', async () => {
    await renderStepper('camera', ctx());
    expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/ready');
    await renderStepper('location', ctx({ ageBand: 'u13' }));
    expect(screen.getAllByTestId('redirect').at(-1)).toHaveTextContent(
      '/(onboarding)/not-eligible'
    );
    // Terms just accepted: the context no longer lists the step, so it moves on to what comes next.
    await renderStepper('terms', ctx());
    expect(screen.getAllByTestId('redirect').at(-1)).toHaveTextContent('/(onboarding)/location');
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

  it('resumes from start with nothing saved at the first step', async () => {
    await renderStepper('start', ctx({ termsCurrent: false }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/terms'));
  });

  it('clamps a saved step the flow no longer has', async () => {
    await saveStep(settings, 'auto-detect');
    await renderStepper('start', ctx({ features: { autoDetect: false, guardianInvites: false } }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/ready'));
  });

  it('waits for the context before resuming from start', async () => {
    const view = await renderStepper('start', null);
    await act(async () => {});
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="start" ctx={ctx({ ageBand: 'u13' })} settings={settings} />
      </ThemeProvider>
    );
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/not-eligible')
    );
  });

  it('renders the registered step with its position and saves it for a later resume', async () => {
    await renderStepper('motion', ctx());
    expect(screen.getByText('Step 2 of 5')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Motion' })).toBeOnTheScreen();
    await waitFor(async () => expect(await readSavedStep(settings)).toBe('motion'));
  });

  it('moves forward with Continue and back with Back', async () => {
    await renderStepper('motion', ctx());
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/notifications');
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/location');
    await act(async () => {});
  });

  it('offers no Back on the first step', async () => {
    await renderStepper('location', ctx());
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
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/location');

    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="location" ctx={ctx()} settings={settings} />
      </ThemeProvider>
    );
    mockRouter.replace.mockClear();
    expect(listeners.at(-1)?.()).toBe(false);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    spy.mockRestore();
    await act(async () => {});
  });

  it('keeps the count steady as Terms and the profile drop out of the flow', async () => {
    const view = await renderStepper(
      'terms',
      ctx({ termsCurrent: false, drivingStage: 'unknown' })
    );
    expect(screen.getByText('Step 1 of 7')).toBeOnTheScreen();
    const at = (step: StepId, c: FlowContext) =>
      view.rerender(
        <ThemeProvider>
          <OnboardingStepper step={step} ctx={c} settings={settings} />
        </ThemeProvider>
      );
    await at('profile', ctx({ drivingStage: 'unknown' }));
    expect(screen.getByText('Step 2 of 7')).toBeOnTheScreen();
    await at('location', ctx());
    expect(screen.getByText('Step 3 of 7')).toBeOnTheScreen();
    await act(async () => {});
  });

  it('carries the saved count across a restart, through start', async () => {
    // Killed at "Step 3 of 7": Terms and the profile were passed, and have since left the flow.
    await saveStep(settings, 'location');
    await savePlan(settings, [
      'terms',
      'profile',
      'location',
      'motion',
      'notifications',
      'auto-detect',
      'ready',
    ]);
    const view = await renderStepper('start', ctx());
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/location'));
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="location" ctx={ctx()} settings={settings} />
      </ThemeProvider>
    );
    expect(screen.getByText('Step 3 of 7')).toBeOnTheScreen();
    await waitFor(async () =>
      expect(await readSavedPlan(settings)).toEqual([
        'terms',
        'profile',
        'location',
        'motion',
        'notifications',
        'auto-detect',
        'ready',
      ])
    );
  });

  it('starts the count afresh through start when nothing is saved', async () => {
    const view = await renderStepper('terms', ctx({ termsCurrent: false }));
    const fresh = createSettingsRepo(await createTestDb());
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="start" ctx={ctx()} settings={fresh} />
      </ThemeProvider>
    );
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper step="location" ctx={ctx()} settings={fresh} />
      </ThemeProvider>
    );
    expect(screen.getByText('Step 1 of 5')).toBeOnTheScreen();
    await act(async () => {});
  });

  it('reads the forward target from the newest context, not the one the step rendered with', async () => {
    // The profile step refreshes the profile before it calls onNext: the band it learns decides.
    const view = await renderStepper(
      'profile',
      ctx({ ageBand: 'unknown', drivingStage: 'unknown' })
    );
    await view.rerender(
      <ThemeProvider>
        <OnboardingStepper
          step="profile"
          ctx={ctx({
            ageBand: '13_17',
            drivingStage: 'unknown',
            features: { autoDetect: true, guardianInvites: true },
          })}
          settings={settings}
        />
      </ThemeProvider>
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(onboarding)/guardian');
    await act(async () => {});
  });

  it('leaves the flow for Home after the last step (until Task 14 finishes onboarding properly)', async () => {
    await renderStepper('ready', ctx());
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(tabs)/home');
    await act(async () => {});
  });
});
