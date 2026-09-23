/**
 * F9's words: the share composer and the card itself.
 *
 * - **Privacy first (D10, product F9, §10.7).** No card says where, when in the day, how fast, or
 *   who: no name, map, route, city, place, time of day or speed, for anyone. Distance and the
 *   invite code appear only when the driver turns them on (R-E: the code is off for everyone).
 * - **Not an ID (rev1: R-I m9, C18).** Nothing is titled or styled as a government document: no
 *   "licence"/"license", "ID", "DOB" or MRZ strip. The card says "RoadWise" and what was earned.
 * - **Points are never money.** No card shows points at all; a class, a streak, a badge, a goal
 *   or a drive score is the thing shared.
 */
export const shareCopy = {
  title: 'Share',
  close: 'Close',
  wordmark: 'RoadWise',
  privacyLine: 'No map, place or time is ever shown.',
  share: 'Share',
  shareHint: 'Opens the share sheet with this card',
  androidNote: 'Shares as text on this phone.',
  preview: 'Card preview',
  loading: 'Getting your card ready',
  loadError: "Your card couldn't be made.",
  retry: 'Try again',
  failed: "Couldn't share. Try again.",
  offline: "You're offline. This card is made from what was saved on this phone.",
  nothing: {
    title: 'Nothing to share yet.',
    action: 'Go to Rewards',
  },
  /** When the thing asked for isn't there to share yet (the brief's line, per kind where it fits). */
  empty: {
    trip: "You can share a drive once it's confirmed.",
    streak: "Share your first safe day once it's confirmed.",
    badge: "You can share a badge once you've earned it.",
    level: "Share your first safe day once it's confirmed.",
    goal: "You can share a weekly goal once it's reached.",
  },
  toggles: {
    distance: 'Show distance',
    distanceHint: 'Adds how far this drive was',
    code: 'Add my invite code',
    codeHint: 'Adds your code so friends can join you',
    codeLoading: 'Getting your code…',
    codeError: "Your code couldn't be loaded, so it isn't on the card.",
  },
  card: {
    trip: 'Drive score',
    streak: 'Safe-day streak',
    badge: 'Badge',
    level: 'Class',
    goal: 'Weekly goal reached',
    days: (n: number) => (n === 1 ? 'day' : 'days'),
    best: (n: number) => `Best ${n} ${n === 1 ? 'day' : 'days'}`,
    earned: (date: string) => `Earned ${date}`,
    safeDays: (n: number) => `${new Intl.NumberFormat('en-US').format(n)} ${n === 1 ? 'safe day' : 'safe days'}`,
    week: (date: string) => `Week of ${date}`,
    codeLabel: 'Invite code',
    codeLine: (code: string) => `Join me on RoadWise with my code ${code}.`,
  },
} as const;
