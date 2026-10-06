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
  license: {
    title: 'Your license',
    body: 'So we know where you are on the road. You can change it later in Settings.',
    options: {
      permit: { title: "Learner's permit", body: 'You drive with a supervising adult.' },
      intermediate: { title: 'Intermediate', body: 'A provisional or junior license.' },
      full: { title: 'Full license', body: 'No restrictions.' },
    },
    continue: 'Continue',
    saveFailed: "Couldn't save that. Try again.",
  },
  how: {
    title: 'How it works',
    body: 'Drive safely, earn points, keep your streak going.',
    rows: [
      { big: '+10', title: 'Safe miles earn points', body: '10 points for every mile without an event.' },
      { big: '−', title: 'Events cost points', body: 'Speeding, phone pickups and hard braking take points off.' },
      { big: '×1.3', title: 'Streaks multiply', body: 'Each good drive grows your streak and boosts what you earn.' },
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
  /** The examples are the server's own push copy (`supabase/functions/_shared/push_copy.ts`). */
  notifications: {
    title: 'Notifications',
    body: 'Get your Sunday recap, your league results, and a heads-up when a friend adds you.',
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
