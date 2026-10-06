import { RANKED_MIN_MILES } from '@scoring';

import { distanceIn, formatDistance, type Units } from '@/lib/units';

/** Drivers need this many miles in 30 days for the global board (`get_global_board`). */
const GLOBAL_MIN_MILES = 100;

/** Every string on the Leagues tab. Plain, short, second person, no guilt. */
export const leaguesCopy = {
  title: 'Leagues',
  segments: { friends: 'Friends & clan', league: 'League', global: 'Global' },
  segmentsLabel: 'Choose a board',
  loadFailed: {
    title: "Couldn't load this board",
    body: 'Check your connection and try again.',
    retry: 'Try again',
  },
  refreshFailed: "Couldn't refresh. Showing the last board we loaded.",
  you: 'You',
  pts: 'pts',
  friends: {
    week: 'Weekly points',
    rating: 'Safety Rating',
    metricLabel: 'Rank by',
    emptyTitle: 'Bring your crew',
    emptyBody: 'Add friends or join a clan to see how you stack up against them.',
    emptyAction: 'Add friends',
    unrankedNote: (u: Units) => `Unranked drivers need ${formatDistance(RANKED_MIN_MILES, u, { digits: 0 })} in 30 days to get a Safety Rating.`,
  },
  league: {
    leagueName: (tier: string) => `${tier} league`,
    ofSize: (size: number) => `of ${size}`,
    minDrives: (n: number) => `${n} drives to move up`,
    drivesLeft: (n: number, min: number) => `Moving up needs ${min} drives this week (${n} to go).`,
    weekPoints: 'Points this week',
    movesUp: 'Moves up',
    movesDown: 'Moves down',
    unplacedTitle: (tier: string) => `Drive this week to join a ${tier} league`,
    unplacedBody: 'Your first scored drive this week puts you in a group of up to 30 drivers. Top 7 move up on Monday.',
    ineligibleTitle: 'Leagues are one account per phone',
    ineligibleBody:
      'Another account already plays leagues on this phone, so this one can’t join. Your drives still earn points, and you still show up on your friends and global boards.',
    resets: 'Leagues reset every Monday.',
  },
  global: {
    allStates: 'All states',
    filterLabel: 'Filter by state',
    sheetTitle: 'Pick a state',
    notEligibleTitle: (u: Units) => `Drive ${formatDistance(GLOBAL_MIN_MILES, u, { digits: 0 })} in 30 days to join`,
    notEligibleBody: (u: Units) =>
      `The global board ranks Safety Rating among drivers with ${formatDistance(GLOBAL_MIN_MILES, u, { digits: 0, spoken: true })} or more in the last 30 days.`,
    notInState: 'You’re not on this state’s board.',
    rank: 'Your rank',
    rating: 'Your Safety Rating',
    cleanMiles: (n: number, u: Units) => `${Math.round(distanceIn(n, u)).toLocaleString('en-US')} clean ${u}`,
    emptyTitle: 'No one here yet',
    emptyBody: (u: Units) => `Nobody in this state has driven ${formatDistance(GLOBAL_MIN_MILES, u, { digits: 0 })} in the last 30 days. Try all states.`,
  },
} as const;
