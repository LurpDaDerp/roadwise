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
   * A5, the guardian invite (rev1: I6 — shown only while `guardian_invites` is on). Limited to what
   * this build can back: nothing here says what a guardian can see, because nothing is shared with
   * one until M6 builds it (G7's "see exactly what they see" clause is left out until G7 exists).
   * Dates are "September 29" from `formatInviteExpiry`.
   */
  guardian: {
    title: 'Invite a parent or guardian',
    explainer:
      'A guardian sees only what you choose to share. Nothing is shared until you set it up.',
    codeLabel: 'Invite code',
    send: 'Send invite',
    /** Pending, declined or expired with no code on screen: a new invite replaces the old code. */
    sendNew: 'Send a new invite',
    /**
     * Shown under a live code the screen no longer holds (T13 review m1): the parent may already
     * have it, and a new invite revokes it on the server.
     */
    replaceNote: 'Sending a new invite cancels the code you sent before.',
    /** The tap on "Send a new invite" over a live code confirms first (T13 review m1). */
    confirmReplace: {
      title: 'Cancel your old code?',
      body: 'The code you sent before will stop working. Only the new code will work.',
      confirm: 'Send a new invite',
      cancel: 'Keep the old code',
    },
    later: "I'll do this later",
    continue: 'Continue',
    /** Required mode only: the screen waits for the link, so the teen can ask the server again. */
    checkAgain: 'Check again',
    status: {
      /** `when` is `formatInviteExpiry`: day, date and time, "Tue Sep 29, 3:40 pm" (m3). */
      pending: (when: string) => `Your invite code works until ${when}.`,
      pendingUndated: 'Your invite code is still active.',
      linked: 'A guardian is linked to your account.',
      declined: 'Your last invite was declined. You can send a new one.',
      expired: 'Your last invite code expired. You can send a new one.',
      loadFailed: "Couldn't check your invite. You can still send one.",
    },
    errors: {
      rateLimited: "You've made as many invites as you can in a day. Try again later.",
      notAvailable: "Guardian invites aren't available right now.",
      /** Only when the request never reached the server (m4). */
      offline: "Couldn't reach RoadWise. Check your connection and try again.",
      /** Anything else the server refused: not the connection's fault (m4). */
      failed: "Couldn't create an invite. Try again later.",
      shareFailed: "Couldn't open sharing. Your code is above, so you can send it another way.",
    },
  },
  /**
   * A6. The primer and its first line are the brief's words (rev1: m). iOS asks While Using only
   * (design §5.3), so the Always question is announced for after the first drive and nothing more.
   */
  location: {
    title: 'Measure your drives',
    body: 'We use location to measure speed and distance during drives.',
    promise: "Only records while you're on a drive · Never sold",
    iosLater: "After your first drive, we'll ask whether drives can start on their own.",
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
  /** A7. `unavailable` is the brief's line: no claim about when the phone will ask. */
  motion: {
    title: { ios: 'Motion & Fitness', android: 'Physical activity' },
    body: "RoadWise uses your phone's motion activity to notice when a drive starts and ends, and to tell driving apart from walking.",
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
   * A8. The previews are the catalog's own copy (`renderLocal`, `renderPush`), never text written
   * here, so an example can't promise a notification the app doesn't send. The promise line is
   * printed only while this phone reports when it is driving (rev1: C1).
   */
  notifications: {
    title: 'Notifications',
    body: "RoadWise lets you know when a drive summary is ready, and when something stops your drives from being recorded.",
    examples: 'Examples',
    promise: "We hold them while you're driving.",
    allow: 'Allow notifications',
    notNow: 'Not now',
    continue: 'Continue',
    openSettings: 'Open Settings',
    allowed: 'Notifications are allowed.',
    quiet: 'Notifications are delivered quietly.',
    denied: 'Notifications are off. Updates wait in your Inbox instead.',
    failed: "Your phone didn't answer. Try again.",
  },
  /**
   * A9 and the auto-record screen (Task 19). The toggle's own line says plainly that it turns on
   * automatic recording, before any tap (Ruling T9 (2)).
   */
  autoRecord: {
    title: 'Record drives automatically',
    body: 'RoadWise can start recording when it detects a drive, so you never have to remember to tap.',
    toggle: 'Record drives automatically',
    toggleOn: 'RoadWise starts recording your drives automatically.',
    toggleOff: 'Off. You start each drive yourself with Drive.',
    /** On, but this account hasn't affirmed the background-location disclosure (Task 19 r1). */
    needsOk: 'Turned on, but it can’t start drives until you review how RoadWise uses background location.',
    review: 'Review background location',
    reviewHint: 'Shows how RoadWise uses background location, then turns auto-record on',
    iosAfterFirstDrive: 'Turns on after your first drive, once you allow it.',
    needs: {
      location: "Auto-record needs location access, which is off on this phone.",
      always: {
        ios: 'Auto-record needs location set to Always.',
        android: 'Auto-record needs location set to Allow all the time.',
      },
      motion: 'Auto-record needs motion access, which is off on this phone.',
    },
    turnOn: 'Turn on',
    skip: 'Skip',
    continue: 'Continue',
    failed: "That didn't work. Try again.",
    loadFailed: "Couldn't check this phone's permissions.",
    retry: 'Try again',
    battery: {
      label: 'Battery',
      exempt: 'Your phone lets RoadWise run in the background.',
      optimized: 'Your phone may stop RoadWise in the background, so drives may be missed.',
      open: 'Open battery settings',
    },
  },
  /**
   * A12. Every row says what the phone reported just now; "On" for auto-record only when it is
   * armed. The "just drive" tip only when auto-record is armed (rev1: I8).
   */
  ready: {
    title: "You're set up",
    body: "Here's what's on for this phone.",
    rows: {
      autoRecord: 'Auto-record',
      location: 'Location',
      motion: 'Motion',
      notifications: 'Notifications',
      guardian: 'Guardian',
    },
    status: {
      armed: 'On',
      notAvailable: 'Not available',
      afterFirstDrive: 'After your first drive',
      notArmed: "On, but it can't start drives yet",
      cantCheck: "Can't check",
      off: 'Off',
      locationAlways: 'Allowed all the time',
      locationWhileUsing: 'Allowed while using the app',
      approximate: 'Approximate only',
      notAllowed: 'Not allowed',
      allowed: 'Allowed',
      notOnPhone: 'Not on this phone',
      quiet: 'Delivered quietly',
      guardianLinked: 'Linked',
      guardianPending: 'Invite sent',
      guardianNone: 'Not invited',
      guardianDeclined: 'Invite declined',
      guardianExpired: 'Invite expired',
    },
    tipArmed: "Next time you drive, just drive. We'll have a summary ready when you park.",
    tipManual: "Tap Drive before you set off — we'll have a summary ready when you park.",
    readFailed: "Couldn't check this phone's permissions.",
    retry: 'Try again',
    home: 'Go to Home',
    startDrive: 'Start a drive now',
    finishFailed: "Couldn't finish setting up. Check your connection and try again.",
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
    /** The phone is clean; what is left is in Storage, which the server removes (B6). */
    serverFinishes:
      'If you sign out now, RoadWise will finish removing your recorded drives from its servers.',
    /** The phone itself still holds some of it. */
    stillOnPhone: 'Some of your drive data is still on this phone. Try again before you sign out.',
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * The invite's expiry as the phone's local day, date and time — "Tue Sep 29, 3:40 pm". The code
 * stops at the minute it was issued a week later, so a bare date would read as the whole day
 * (T13 review m3). Built by hand, not `Intl`, so it reads the same on every engine.
 */
export function formatInviteExpiry(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const h = at.getHours();
  const mm = String(at.getMinutes()).padStart(2, '0');
  const clock = `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'am' : 'pm'}`;
  return `${WEEKDAYS[at.getDay()]} ${MONTH_NAMES[at.getMonth()]!.slice(0, 3)} ${at.getDate()}, ${clock}`;
}

/**
 * What the teen's share sheet sends: the code and when it stops working, and no link — there is
 * no page to open until M6 builds redemption, so a URL would lead nowhere.
 */
export function guardianShareMessage(code: string, expires: string): string {
  return `I'd like to add you as my guardian on RoadWise. My invite code is ${code}. It can be used once, until ${expires}.`;
}
