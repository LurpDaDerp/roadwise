/** The monthly Wrapped's words: the story, the share, Home's card and the archive (Profile's row is in `profileCopy`). */
export const wrappedCopy = {
  /** The story's header: "Your October", or a shared one's "maya_16's October". */
  ownHeader: (month: string) => `Your ${month}`,
  sharedHeader: (username: string | null, month: string) => (username ? `${username}'s ${month}` : `A RoadWise driver's ${month}`),
  close: 'Close',
  next: 'Next',
  previous: 'Back',
  /** Spoken on the slide count: "Slide 3 of 10". */
  slideOf: (n: number, total: number) => `Slide ${n} of ${total}`,

  intro: {
    own: (month: string) => `Your ${month} on the road`,
    shared: (month: string) => `${month} on the road`,
    ownBody: "Here's how your month went.",
    sharedBody: "Here's how their month went.",
  },
  totals: {
    title: 'The month in numbers',
    distance: 'Distance',
    time: 'Drive time',
    drives: 'Drives',
    avg: 'Average drive',
    longest: 'Longest drive',
  },
  safety: {
    title: 'Safety',
    avgScore: 'Average drive score',
    rating: 'Safety Rating',
    noRating: 'No rating yet',
    up: (d: number, month: string) => `Up ${d} since ${month} 1`,
    down: (d: number, month: string) => `Down ${d} since ${month} 1`,
    same: (month: string) => `Same as on ${month} 1`,
    clean: 'Clean drives',
    cleanOf: (n: number, total: number) => `${n} of ${total} drives`,
    longestClean: 'Longest clean drive',
  },
  smoothness: {
    title: 'Smoothness',
    hard: 'Hard brakes, starts and turns',
    best: 'Best category',
  },
  phoneSpeed: {
    title: 'Phone and speed',
    pickups: 'Phone pickups',
    speeding: 'Speeding events',
    note: 'Speeds are never shown.',
  },
  /** "per 100 mi". */
  per100: (unit: string) => `per 100 ${unit}`,
  habits: {
    title: 'Habits',
    day: 'Busiest day',
    time: 'Busiest time',
    split: 'Weekdays and weekends',
    splitValue: (weekday: number, weekend: number) => `${weekday} weekday · ${weekend} weekend`,
  },
  places: {
    title: 'Places',
    most: 'Your most-driven trip',
    drives: (n: number) => `${n} drives`,
    commute: (n: number) => (n === 1 ? '1 drive on your commute' : `${n} drives on your commute`),
  },
  progress: {
    title: 'Progress',
    badges: (n: number) => (n === 1 ? '1 badge earned' : `${n} badges earned`),
    goals: (n: number) => (n === 1 ? '1 weekly goal done' : `${n} weekly goals done`),
  },
  archetype: {
    ownKicker: 'Your driving style this month',
    sharedKicker: 'Their driving style this month',
  },
  summary: {
    share: 'Share',
    shareError: "Couldn't share. Try again.",
    stopSharing: 'Stop sharing',
    stopped: "Sharing stopped. The link doesn't work anymore.",
    stopError: "Couldn't stop sharing. Try again.",
    footer: 'Get your own Wrapped at the start of each month',
    /** The text that goes with the shared image. */
    shareMessage: (month: string, archetype: string, link: string) => `My ${month} on RoadWise: ${archetype}. ${link}`,
    /** The card's four numbers. */
    distance: 'Distance',
    avgScore: 'Avg drive score',
    clean: 'Clean drives',
    hard: 'Hard events',
  },
  better: (x: number) => `Better than ${x}% of drivers`,
  moreMiles: (x: number) => `More miles than ${x}% of drivers`,

  notAvailable: "This Wrapped isn't available",
  notAvailableBody: 'It may have been taken down.',
  noMonth: (month: string) => `No Wrapped for ${month}`,
  noMonthBody: 'A month needs 3 or more scored drives.',
  loadError: "Couldn't load this Wrapped.",
  retry: 'Try again',

  home: {
    title: (month: string) => `Your ${month} Wrapped`,
    body: 'See your month on the road.',
    dismiss: 'Close',
    hint: 'Opens your Wrapped',
  },
  archive: {
    title: 'Wrapped',
    empty: 'Your first Wrapped arrives on the 1st after a month with 3 or more scored drives.',
  },
} as const;
