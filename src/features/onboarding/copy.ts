import { IDLE_END_S } from '@scoring';

import type { StepId } from './flow';

/** The automatic end's minutes (product spec v3 "Ending on its own"), so the words follow the rule. */
const IDLE_MIN = Math.round(IDLE_END_S / 60);

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
    how: 'How it works',
    motion: 'Motion',
    location: 'Location',
    notifications: 'Notifications',
    reminder: 'Forgot to start?',
    dashcam: 'DashPal',
    clan: 'Join a clan',
  } satisfies Record<StepId, string>,
  username: {
    title: 'Pick a username',
    body: 'This is what friends and leagues see. No real names, ever.',
    label: 'Username',
    placeholder: 'swift_fox',
    rules: '3 to 20 letters, numbers or underscores.',
    checking: 'Checking…',
    available: (name: string) => `@${name} is free. It's yours if you want it.`,
    reasons: {
      length: 'Use 3 to 20 characters.',
      characters: 'Only letters, numbers and underscores.',
      reserved: "That one's reserved. Try another.",
      not_allowed: "That username isn't allowed. Try another.",
      taken: 'Someone already has that one. Try another.',
    },
    checkFailed: "Couldn't check that name. Try again.",
    claim: 'Claim username',
  },
  how: {
    title: 'How it works',
    body: 'Drive safely, earn points, keep your streak going.',
    rows: [
      { big: '+10', title: 'Safe miles earn points', body: '10 points for every mile without an event.' },
      { big: '−', title: 'Events cost points', body: 'Speeding, phone use (leaving RoadWise mid-drive too) and hard braking take points off.' },
      { big: '×1.30', title: 'Streaks multiply', body: 'Each good drive grows your streak and boosts what you earn.' },
    ],
    continue: 'Got it',
  },
  clan: {
    title: 'Got a clan code?',
    body: "Join your friends' clan with their 8-character invite code. You can also do this later from the Clan tab.",
    label: 'Clan code',
    placeholder: 'ABCD2345',
    find: 'Find clan',
    join: (name: string) => `Join ${name}`,
    skip: 'Skip for now',
    members: (n: number) => `${n} of 30 drivers`,
    full: "This clan is full, so you can't join right now.",
    finishFailed: "Couldn't finish setting up. Check your connection and try again.",
  },
  /** What the permission steps share. */
  permissions: {
    loadFailed: "Couldn't check this phone's permissions.",
    retry: 'Try again',
  },
  location: {
    title: 'Measure your drives',
    body: 'RoadWise uses precise location to measure speed and miles during a drive you start.',
    promise: 'During drives you start, and for the optional forgot-to-start reminder only if you turn it on · Never sold',
    allow: 'Allow location',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Location is allowed.',
    denied:
      "Location is off, so RoadWise can't record drives. You can finish setting up and turn it on later in Settings.",
    approximate: "Location is set to approximate, so drives can't record. Turn on Precise Location in Settings.",
    failed: "Your phone didn't answer. Try again.",
  },
  motion: {
    title: { ios: 'Motion & Fitness', android: 'Physical activity' },
    body: 'Lets RoadWise tell when you walk away from your car, so a drive you forgot to end stops where you parked, and lets the optional forgot-to-start reminder notice a trip. Speed and braking are measured either way.',
    allow: 'Allow motion access',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Motion access is allowed.',
    denied: `Motion access is off. Drives still record; one you forget to end stops after the car hasn’t moved for ${IDLE_MIN} min. You can turn it on in Settings.`,
    unavailable: "Your phone didn't let us ask here. You can turn it on in Settings.",
    cantCheck: "We couldn't check motion access on this phone.",
    failed: "Your phone didn't answer. Try again.",
  },
  /** The examples are the server's own push copy (`supabase/functions/_shared/push_copy.ts`). */
  notifications: {
    title: 'Notifications',
    body: 'Get your forgot-to-start reminder, your Sunday recap, your league results, and a heads-up when a friend adds you.',
    examples: 'Examples',
    previews: [
      { id: 'weekly_recap', title: 'Your week in review', body: '4 drives, +312 points. Safety Rating 92.4 (up 1.2). Streak 6.' },
      { id: 'league_result', title: 'League results are in', body: 'You finished #3 in Silver and moved up to Gold.' },
      { id: 'friend_request', title: 'New friend request', body: 'Someone wants to add you as a friend.' },
    ],
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
