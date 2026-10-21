import { RANKED_MIN_MILES } from '@scoring';

import { formatDistance, type Units } from '@/lib/units';

/** Every string on the Friends tab. Plain, short, second person, no guilt. */
export const leaguesCopy = {
  title: 'Friends',
  add: 'Add friends',
  loadFailed: {
    title: "Couldn't load your friends",
    body: 'Check your connection and try again.',
    retry: 'Try again',
  },
  refreshFailed: "Couldn't refresh. Showing the last board we loaded.",
  you: 'You',
  friends: {
    /** "128 mi in 90 days". */
    miles: (dist: string) => `${dist} in 90 days`,
    /** "4 of 10 mi to a rating". */
    toRating: (progress: string) => `${progress} to a rating`,
    noRatingSpoken: 'No rating yet',
    caption: 'Ranked by Safety Rating, last 90 days',
    unratedNote: (u: Units) => `Drivers get a Safety Rating after ${formatDistance(RANKED_MIN_MILES, u, { digits: 0 })} in 90 days.`,
    emptyTitle: 'Bring your crew',
    emptyBody: 'Add friends to see how your Safety Ratings compare.',
    emptyAction: 'Add friends',
  },
} as const;
