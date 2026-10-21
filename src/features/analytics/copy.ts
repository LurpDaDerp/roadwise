/** Every string the Analytics tab shows. Captions stay at one to three words. */
export const analyticsCopy = {
  title: 'Analytics',
  error: "Couldn't load your drives.",
  radar: {
    rating: 'Safety Rating',
    outOf: '/100',
    window: 'Last 30 days',
    noScore: 'no score yet',
    /** An axis's button for a screen reader ("Speeding, score 82"). */
    axis: (label: string, score: number | null) => (score === null ? `${label}, no score yet` : `${label}, score ${score}`),
    /** The Attention chip without a DashPal. */
    locked: (label: string) => `${label}, needs DashPal`,
    axisHint: 'Opens details',
    /** The button under the chart and the sheet it opens: what makes the total. */
    how: {
      label: 'How it works',
      hint: 'Explains the Safety Rating',
      title: 'How it works',
      body: 'Your Safety Rating is the average of your category scores, each from its events per mile over the last 30 days, with Speed and Phone use counting double.',
    },
  },
  category: {
    /** Under the sheet's title (the axis name and its score). */
    subtitle: 'Score out of 100, last 30 days',
    /** The range card's title. */
    range: { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', year: 'Last 365 days' },
    eyesOff: 'Eyes off road',
    drowsy: 'Drowsy',
    watched: 'DashPal miles',
    /** Attention without a paired DashPal. */
    locked: {
      title: 'Attention comes from DashPal',
      body: 'Pair a DashPal and it will score how well you stay focused on the road.',
      action: 'Set up DashPal',
    },
    /** Attention with a DashPal but no watched drives in the range. */
    noDashpal: 'No DashPal drives yet',
    noDashpalBody: (range: string) => `DashPal didn't watch any drives in the ${range.toLowerCase()}. Your Attention numbers show up here after one.`,
    /** In place of the numbers when the range has no drives. */
    empty: 'No data yet',
    emptyBody: (range: string) => `No drives in the ${range.toLowerCase()}. Your numbers show up here after a drive.`,
  },
  bests: {
    title: 'Personal best',
    mostPoints: 'Most points',
    longestClean: 'Longest clean',
    phoneFree: 'Phone-free',
    hint: 'Opens the drive',
  },
  range: 'Time range',
  metrics: {
    driving: 'Driving',
    points: 'Points',
    drives: 'Drives',
    driveTime: 'Drive time',
    distance: 'Distance',
    avgDrive: 'Avg drive',
    avgSpeed: 'Avg speed',
    speeding: 'Speeding events',
    hardBrakes: 'Hard brakes',
    hardStarts: 'Hard starts',
    sharpTurns: 'Sharp turns',
    pickups: 'Pickups',
    phoneTime: 'Phone time',
    cleanDrives: 'Clean drives',
    cleanRate: 'Clean rate',
    totalPoints: 'Total points',
    avgPoints: 'Avg points/drive',
    /** Avg points/drive for a screen reader. */
    avgPointsSpoken: 'Average points per drive',
  },
  trend: {
    title: 'Trends',
    /** Names the series picker for a screen reader. */
    picker: 'Trend series',
    score: 'Score',
    events: 'Events',
    points: 'Points',
    notEnough: 'Not enough drives yet',
    /** What a screen reader calls each series and its step ("Safety Rating by day"). */
    spoken: {
      score: 'Safety Rating',
      events: 'Events per mile',
      points: 'Total points',
    },
    /** Events in kilometres. */
    spokenEventsKm: 'Events per kilometer',
    by: { drive: 'by drive', day: 'by day', week: 'by week', month: 'by month' },
    lowest: 'Lowest',
    latest: 'latest',
    direction: { up: 'trending up', down: 'trending down', steady: 'holding steady' },
  },
  timeOfDay: {
    title: 'Time of day',
  },
  grid: {
    title: 'When you drive',
    empty: 'No drives yet',
    busiest: 'Busiest',
    /** The colour key's ends. */
    fewer: 'Fewer',
    more: 'More',
  },
  map: {
    title: 'All trips',
    caption: 'All time',
    empty: 'No trips yet',
    noMap: "Maps aren't available in this build.",
  },
  drives: {
    title: 'Drives',
    /** The header for a screen reader, without the middle dot. */
    spoken: (n: number) => (n === 0 ? 'Drives, none yet' : `Drives, ${n}`),
    empty: 'No drives yet',
    showMore: 'Show more',
    clean: 'Clean',
    noEvents: 'No events',
    hint: 'Opens the drive summary',
  },
} as const;
