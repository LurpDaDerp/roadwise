/** The Profile tab, public profile, achievements and heat map privacy words. Usernames only, ever. */
export const profileCopy = {
  tab: 'Profile',
  rating: 'Safety Rating',
  noRating: 'No rating yet',
  /** "4 of 10 mi to your rating". */
  toRating: (progress: string) => `${progress} to your rating`,
  trend: {
    label: 'This week',
    spoken: (word: string) => `${word} this week`,
  },
  totals: { drives: 'Drives', distance: 'Distance', time: 'On the road' },
  categories: {
    title: 'Categories',
    noScore: '—',
    spoken: (label: string, score: number | null) => (score === null ? `${label}, no score yet` : `${label} ${score}`),
  },
  loadError: "Couldn't load your profile.",
  retry: 'Try again',

  achievements: {
    title: 'Achievements',
    seeAll: 'See all',
    count: (got: number, total: number) => `${got} of ${total}`,
    unlocked: 'Unlocked',
    locked: 'Locked',
  },

  rows: {
    friends: { title: 'Friends', subtitle: 'Add by username or QR code' },
    requests: (n: number) => (n === 1 ? '1 request' : `${n} requests`),
    heatmap: { title: 'Heat map', subtitle: 'Who can see your routes' },
    how: { title: 'How scores work', subtitle: 'Drive scores and your Safety Rating' },
    settings: { title: 'Settings', subtitle: 'Privacy, alerts, notifications' },
    account: { title: 'Account', subtitle: 'Sign out, export or delete' },
    blocked: { title: 'Blocked users', subtitle: 'See and unblock' },
  },

  heatmap: {
    title: 'Heat map',
    intro: 'To see the roads you drive most, open All trips in Analytics.',
    visibility: 'Who can see it',
    visibilityHint: 'It starts as Only me. Choose Friends and they’ll see it on your profile.',
    zones: 'Privacy zones',
    zonesSubtitle: 'Hide routes near home or school',
    privacy: 'It never shows routes in your privacy zones or the first and last quarter mile of a drive.',
    noMap: "Maps aren't available in this build.",
  },

  achievementHints: {
    first_drive: 'Finish a drive of half a mile or more.',
    clean_100: 'Drive 100 miles with no events.',
    perfect_week: 'Take 3 or more drives in one week, all with no events.',
  },

  public: {
    notFound: 'Driver not found',
    notFoundBody: 'Check the username and try again.',
    addFriend: 'Add friend',
    requested: 'Requested',
    accept: 'Accept',
    decline: 'Decline',
    friends: 'Friends',
    cancelTitle: (u: string) => `Cancel your request to ${u}?`,
    cancelRequest: 'Cancel request',
    removeTitle: (u: string) => `Remove ${u} as a friend?`,
    removeBody: "You won't see each other on the Friends tab.",
    remove: 'Remove friend',
    keep: 'Keep',
    more: 'More options',
    report: 'Report',
    block: 'Block',
    blockTitle: (u: string) => `Block ${u}?`,
    blockBody: "They can't find or add you, and you won't see each other on the Friends tab. You can unblock them in Settings.",
    cancel: 'Cancel',
    stats: 'Last 30 days',
    statsEmpty: 'No drives in the last 30 days.',
    reportTitle: (u: string) => `Report ${u}`,
    reportIntro: 'What’s wrong? Reports are private, so they’ll never know it was you.',
    reportReasons: {
      inappropriate_name: 'Inappropriate username',
      harassment: 'Harassment or bullying',
      cheating: 'Cheating',
      impersonation: 'Pretending to be someone else',
      other: 'Something else',
    },
    reported: "Thanks. We'll take a look.",
  },
} as const;
