import type { Ionicons } from '@expo/vector-icons';
import { IDLE_END_S } from '@scoring';

import { hudCopy } from '@/features/drive/hudCopy';

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
    finishFailed: "Couldn't finish setting up. Check your connection and try again.",
  },
  /** The name each step goes by in its title until the step itself is built. */
  stepTitles: {
    username: 'Pick a username',
    how: 'How it works',
    location: 'Location',
    motion: 'Motion',
    notifications: 'Notifications',
    dashcam: 'DashPal',
  } satisfies Record<StepId, string>,
  username: {
    title: 'Pick a username',
    body: 'This is what friends see. No real names, ever.',
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
    body: {
      ios: 'Drive the way you normally do. RoadWise takes care of the rest.',
      android: 'Start a drive, then just drive. RoadWise takes care of the rest.',
    },
    rows: {
      ios: [
        { icon: 'car-sport-outline', title: 'It notices your drives', body: 'Once you’re on the road, RoadWise starts recording by itself. No buttons to remember.' },
        { icon: 'person-outline', title: 'Just riding along?', body: `Open RoadWise and tap “${hudCopy.notDriving}” so that trip won’t count.` },
        { icon: 'speedometer-outline', title: 'Every drive gets a score', body: 'Gentle stops, smooth starts, easy turns and staying near the limit all help.' },
        { icon: 'people-outline', title: 'Better with friends', body: 'Build your Safety Rating and see how it compares with your friends.' },
      ],
      android: [
        { icon: 'car-sport-outline', title: 'Start, then drive', body: 'Swipe Start drive on Home before you pull out. RoadWise records until you park.' },
        { icon: 'person-outline', title: 'Not you driving?', body: `Tap “${hudCopy.notDriving}” on the drive screen so that trip won’t count.` },
        { icon: 'speedometer-outline', title: 'Every drive gets a score', body: 'Gentle stops, smooth starts, easy turns and staying near the limit all help.' },
        { icon: 'people-outline', title: 'Better with friends', body: 'Build your Safety Rating and see how it compares with your friends.' },
      ],
    } satisfies Record<'ios' | 'android', { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[]>,
    continue: 'Sounds good',
  },
  /** What the permission steps share. */
  permissions: {
    loadFailed: "Couldn't check this phone's permissions.",
    retry: 'Try again',
  },
  location: {
    ios: {
      title: 'Let RoadWise notice your drives',
      body: 'RoadWise uses your location to notice when you start driving and to record the drive, even when the app is closed. It also checks the local weather.',
      steps: 'Your iPhone asks twice. Choose “Allow While Using App”, then “Change to Always Allow”.',
      promise: 'Your drives stay in your RoadWise account · Never sold',
      allow: 'Allow location',
      notNow: 'Not now',
      continue: 'Continue',
      openSettings: 'Open Settings',
      always: 'You’re all set. RoadWise will notice your drives.',
      whileUsing: 'Location is on only while RoadWise is open, so drives won’t start on their own. Start them from Home, or set Location to Always in Settings.',
      denied: 'Location is off, so RoadWise can’t record drives. You can turn it on later in Settings.',
      approximate: 'Location is set to approximate, so drives can’t record. Turn on Precise Location in Settings.',
      failed: 'Your phone didn’t answer. Try again.',
    },
    android: {
      title: 'Measure your drives',
      body: 'RoadWise uses precise location on drives you start, and to check local weather.',
      promise: 'Drives you start and local weather · Never sold',
      allow: 'Allow location',
      notNow: 'Not now',
      continue: 'Continue',
      openSettings: 'Open Settings',
      allowed: 'Location is allowed.',
      denied: 'Location is off, so RoadWise can’t record drives. You can finish setting up and turn it on later in Settings.',
      approximate: 'Location is set to approximate, so drives can’t record. Turn on Precise Location in Settings.',
      failed: 'Your phone didn’t answer. Try again.',
    },
  },
  motion: {
    title: { ios: 'Motion & Fitness', android: 'Physical activity' },
    body: {
      ios: 'Motion & Fitness tells driving from walking, so your drives start and end at the right moment. Speed and braking are measured either way.',
      android: 'Lets RoadWise end a drive once you park and walk away. Speed and braking are measured either way.',
    },
    allow: 'Allow motion access',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Motion access is allowed.',
    denied: {
      ios: 'Motion & Fitness is off, so drives won’t start on their own. Start them from Home, or turn it on in Settings.',
      android: `Physical activity is off. Drives still record, and one you forget to end stops after ${IDLE_MIN} min parked. You can turn it on in Settings.`,
    },
    unavailable: 'Your phone didn’t let us ask here. You can turn it on in Settings.',
    cantCheck: 'We couldn’t check motion access on this phone.',
    failed: 'Your phone didn’t answer. Try again.',
  },
  /** The examples are the app's own recap and the server's push copy (`supabase/functions/_shared/push_copy.ts`). */
  notifications: {
    title: 'Notifications',
    body: 'Get a recap after each drive, your Sunday summary, and a heads-up when a friend adds you.',
    examples: 'Examples',
    previews: [
      { id: 'drive_recap', title: 'Your drive recap is ready', body: '24 min · 12.0 mi. See how it went.' },
      { id: 'weekly_recap', title: 'Your week on the road', body: '4 drives this week. Safety Rating 92, up 1. 2 of 3 weekly goals done.' },
      { id: 'friend_request', title: 'New friend request', body: 'Someone wants to add you as a friend.' },
    ],
    allow: 'Allow notifications',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Notifications are allowed.',
    quiet: 'Notifications are delivered quietly.',
    denied: 'Notifications are off. You can turn them on later in Settings.',
    failed: 'Your phone didn’t answer. Try again.',
  },
} as const;
