/**
 * Every string the trip screens print, in one table.
 *
 * `src/i18n/en.ts` is shared by every feature and is not this task's file to grow; the keys here
 * are shaped so a localisation pass can lift them into it without touching a component. Voice
 * (§7.0, §9.10): second person, supportive, plain words, never a code in primary text.
 */
export const tripCopy = {
  summaryTitle: 'Drive summary',
  back: 'Back',
  done: 'Done',
  loading: 'Loading this drive',
  route: { label: 'Route', start: 'Start', end: 'End' },
  splits: { time: 'Time', distance: 'Distance', conditions: 'Conditions' },
  conditions: { day: 'Day', night: 'Night', rain: 'Rain', nightRain: 'Night, rain' },
  score: {
    label: 'Score',
    notScored: 'Not scored',
    notScoredYet: 'Not scored yet',
    calculating: 'Calculating…',
  },
  unscored: {
    unknownRole: 'Tell us who was driving and this drive gets scored.',
    passenger: "You weren't driving, so this drive isn't scored.",
    tooShort: "Too short to score fairly. Drives under half a mile or two minutes aren't scored.",
    /** §7.D D1, verbatim. */
    gradeC: 'GPS signal was too weak to score this trip fairly.',
    implausible: "This didn't look like a drive, so it isn't scored.",
    calculating: 'Your score arrives when this drive syncs.',
    unknown: "This drive couldn't be scored.",
  },
  quality: { A: 'Clean signal', B: 'Some GPS gaps', C: 'Weak GPS' },
  chips: { willSync: 'Will sync', recovered: 'Recovered' },
  recovered:
    'Your phone stopped recording before the end, so this drive was saved from its last checkpoint.',
  syncError: {
    message: "This drive didn't upload. It still counts here.",
    details: 'Details',
    hide: 'Hide details',
    code: (code: string) => `Server code: ${code}`,
  },
  highlights: {
    label: 'Highlights',
    positive: {
      phone: 'No phone use',
      speeding: 'Kept to the limit',
      braking: 'Smooth braking',
      accel: 'Smooth acceleration',
      cornering: 'Steady cornering',
      focus: 'Eyes on the road',
    },
    episodes: (n: number) => `${n} ${n === 1 ? 'episode' : 'episodes'}`,
    /** Spoken form of a cost row: "Speeding, 2 episodes, minus 9 points". */
    lost: (points: string) => `minus ${points} points`,
  },
  tip: { label: 'Tip', hint: 'Opens the full tip' },
  earned: {
    label: 'Earned',
    safeDay: 'Safe day',
    goodDay: 'Good day',
    safeOnTrack: 'Safe day on track',
    goodOnTrack: 'Good day on track',
    counts: 'On your record',
    provisional: 'Confirmed when the day closes.',
  },
  footer: {
    fullTrip: 'See full trip',
    wrong: 'Something wrong?',
    share: 'Share',
    shareSoon: 'Share cards are coming soon.',
  },
  /** §7.C C10, verbatim. */
  roles: {
    question: 'Were you driving?',
    driver: 'Yes, I drove',
    passenger: 'Passenger',
    other: 'Bus, train, other',
    error: "Couldn't save that. Try again.",
  },
  perfect: { stamp: 'Clean drive' },
  notFound: { title: "This drive isn't on your record", body: 'It may have been removed.' },
  error: { message: "Couldn't open this drive.", retry: 'Try again' },
  tipScreen: {
    why: 'Why it matters',
    fromThisDrive: 'From this drive',
    practice: 'Practice this week',
    focusSet: 'Focus set for this week',
    focusConfirm: 'This is your focus this week.',
    error: "Couldn't save that. Try again.",
  },
} as const;
