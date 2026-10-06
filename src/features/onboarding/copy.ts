import type { StepId } from './flow';

/**
 * Every string the onboarding stepper prints, in one table. Voice: second person, plain words.
 * Honesty: nothing here claims more than the screen it is on can back.
 */
export const onboardingCopy = {
  frame: {
    stepOf: (index: number, total: number) => `Step ${index} of ${total}`,
    back: 'Back',
    loading: 'Loading',
  },
  /** The name each step goes by in its title until the step itself is built. */
  stepTitles: {
    username: 'Pick a username',
    license: 'Your license',
    how: 'How it works',
    motion: 'Motion',
    location: 'Location',
    notifications: 'Notifications',
    clan: 'Join a clan',
  } satisfies Record<StepId, string>,
  placeholder: {
    body: 'Nothing to set up here yet.',
    continue: 'Continue',
  },
  /** What the permission steps share. */
  permissions: {
    loadFailed: "Couldn't check this phone's permissions.",
    retry: 'Try again',
  },
  location: {
    title: 'Measure your drives',
    body: 'RoadWise uses location to measure speed and miles during a drive you start.',
    promise: 'Only while a drive you started is running · Never sold',
    allow: 'Allow location',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Location is allowed.',
    denied:
      "Location is off, so RoadWise can't record drives. You can finish setting up and turn it on later in Settings.",
    approximate:
      "Location is set to approximate, so speed and distance can't be measured accurately. Turn on Precise Location in Settings.",
    failed: "Your phone didn't answer. Try again.",
  },
  motion: {
    title: { ios: 'Motion & Fitness', android: 'Physical activity' },
    body: "RoadWise uses motion to detect hard braking and to notice when you've stopped driving.",
    allow: 'Allow motion access',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Motion access is allowed.',
    denied:
      'Motion access is off, so drives may not end on their own. You can turn it on in Settings.',
    unavailable: "Your phone didn't let us ask here. You can turn it on in Settings.",
    cantCheck: "We couldn't check motion access on this phone.",
    failed: "Your phone didn't answer. Try again.",
  },
  /**
   * The previews are the catalog's own copy, never text written here, so an example can't promise
   * a notification the app doesn't send.
   */
  notifications: {
    title: 'Notifications',
    body: 'RoadWise lets you know when your weekly recap and league results are in, and when a friend adds you.',
    examples: 'Examples',
    promise: "We hold them while you're driving.",
    allow: 'Allow notifications',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Notifications are allowed.',
    quiet: 'Notifications are delivered quietly.',
    denied: 'Notifications are off. You can turn them on later in Settings.',
    failed: "Your phone didn't answer. Try again.",
  },
} as const;
