import type { StepId } from './flow';

/**
 * Every string the onboarding stepper prints, in one table (M2 pattern; `src/i18n/en.ts` is not
 * this feature's to grow). Voice (§7.0): second person, plain words. Honesty: nothing here claims
 * more than the screen it is on can back.
 */
export const onboardingCopy = {
  frame: {
    stepOf: (index: number, total: number) => `Step ${index} of ${total}`,
    back: 'Back',
    loading: 'Loading',
  },
  /** The name each step goes by in its title until the step itself is built. */
  stepTitles: {
    terms: 'Terms',
    profile: 'About you',
    'not-eligible': "RoadWise isn't available for this account",
    guardian: 'Guardian',
    location: 'Location',
    motion: 'Motion',
    notifications: 'Notifications',
    'auto-detect': 'Record drives automatically',
    camera: 'Camera',
    family: 'Family',
    ready: 'Ready',
  } satisfies Record<StepId, string>,
  placeholder: {
    body: 'Nothing to set up here yet.',
    continue: 'Continue',
  },
} as const;
