import { RANKED_MIN_MILES } from '@scoring';

import { distanceIn, formatDistance, type Units } from '@/lib/units';

/** Drivers need this many miles in 30 days for the global board (`get_global_board`). */
const GLOBAL_MIN_MILES = 100;

/** Every string on the Leaderboards tab. Plain, short, second person, no guilt. */
export const leaguesCopy = {
  title: 'Leaderboards',
  segments: { friends: 'Friends', global: 'Global' },
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
    emptyBody: 'Add friends to see how you stack up against them.',
    emptyAction: 'Add friends',
    unrankedNote: (u: Units) => `Unranked drivers need ${formatDistance(RANKED_MIN_MILES, u, { digits: 0 })} in 30 days to get a Safety Rating.`,
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
