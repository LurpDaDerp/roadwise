import { SAFETY_DISCLAIMER } from '@/features/auth/legal';

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
  /**
   * The Terms step (rev1: I7). The disclaimer is `SAFETY_DISCLAIMER` from `legal.ts`, quoted
   * unchanged; the full stop is added where it is shown. Published, the one tick acknowledges the
   * disclaimer and accepts both documents, so its label names both (T15 review I1).
   */
  terms: {
    title: 'Before you start',
    acknowledge: `I understand ${SAFETY_DISCLAIMER}.`,
    agree: 'I agree to the Terms and Privacy Policy.',
    continue: 'Continue',
    saveFailed: "Couldn't save that. Try again.",
  },
  /**
   * A4. No age threshold anywhere in these words (product spec A4: "no hint about thresholds");
   * the copy test holds every string here to that.
   */
  profile: {
    title: 'About you',
    nameLabel: 'First name',
    nameMissing: 'Enter your first name.',
    birthDateLabel: 'Birth date',
    month: 'Month',
    day: 'Day',
    year: 'Year',
    monthPlaceholder: 'MM',
    dayPlaceholder: 'DD',
    yearPlaceholder: 'YYYY',
    dateMissing: 'Enter your birth date as MM / DD / YYYY.',
    dateInvalid: 'Check the month and day.',
    dateFuture: "That date hasn't happened yet.",
    dateTooOld: 'Check the year.',
    birthDateFixed: "Your birth date is saved and can't be changed.",
    stageLabel: 'Driving experience',
    stageMissing: 'Choose the one that fits.',
    stages: {
      permit: "Learner's permit",
      new: 'Licensed under 1 year',
      developing: 'Licensed 1–3 years',
      experienced: 'Licensed 3+ years',
      non_driver: "I don't drive",
    },
    /** What a screen reader says for a chip whose printed label leans on a symbol. */
    stagesSpoken: {
      permit: "Learner's permit",
      new: 'Licensed under 1 year',
      developing: 'Licensed 1 to 3 years',
      experienced: 'Licensed 3 or more years',
      non_driver: "I don't drive",
    },
    continue: 'Continue',
    loadFailed: "Couldn't load your details.",
    saveFailed: "Couldn't save that. Try again.",
    retry: 'Try again',
  },
  /** The confirmation before the write-once birth date is sent. Date only: no age, no band. */
  confirmBirthDate: {
    title: 'Is this right?',
    fixed: "Your birth date can't be changed later.",
    confirm: "Yes, that's right",
    edit: 'Edit',
    saveFailed: "Couldn't save your birth date. Try again.",
  },
  /**
   * The under-13 block. "We've kept only what we need" is printed only after the removal it
   * describes has succeeded (rev1: I5).
   */
  notEligible: {
    title: 'RoadWise is for people 13 and older',
    removing: 'Removing your drive data…',
    kept: "We've kept only what we need to remember this.",
    removeFailed: "We couldn't finish removing your drive data.",
    retry: 'Try again',
    signOut: 'Sign out',
    signOutFailed: "Couldn't sign out. Try again.",
  },
} as const;

/** `YYYY-MM-DD` as "March 4, 2008", in words, whatever the phone's locale does with numbers. */
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function formatBirthDate(iso: string): string {
  const [y = NaN, m = NaN, d = NaN] = iso.split('-').map((part) => Number.parseInt(part, 10));
  return `${MONTH_NAMES[m - 1] ?? ''} ${d}, ${y}`;
}
