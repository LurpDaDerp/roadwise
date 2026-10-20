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
    axisHint: 'Opens details',
  },
  category: {
    /** Under the sheet's title (the axis name and its score). */
    subtitle: 'Score out of 100, last 30 days',
    /** The range card's title. */
    range: { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', year: 'Last 365 days' },
    rate: 'Rate',
    afterDark: 'After dark',
    darkShare: 'Share after dark',
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
    cleanShare: 'Clean share',
    totalPoints: 'Total points',
    avgPoints: 'Avg points',
  },
  trend: {
    title: 'Trend',
    /** Names the series picker for a screen reader. */
    picker: 'Trend series',
    score: 'Score',
    events: 'Events',
    points: 'Points',
    notEnough: 'Not enough drives yet',
    /** What a screen reader calls each series and its step ("Score by day"). */
    spoken: {
      score: 'Score',
      events: (distance: string) => `Events per 100 ${distance}`,
      points: 'Points per drive',
    },
    by: { drive: 'by drive', day: 'by day', week: 'by week', month: 'by month' },
    lowest: 'Lowest',
    latest: 'latest',
    direction: { up: 'trending up', down: 'trending down', steady: 'holding steady' },
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
