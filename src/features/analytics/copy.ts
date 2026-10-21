const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A category's rate line under its numbers (scores §7.2): how often it slipped per chance, "1 hard
 * brake per 137 slowdowns", "No sharp turns in 85 turns", "Over the limit 2% of the time". Null when
 * there is nothing to say (no chances in the range, or Attention).
 */
function eventsRate(n: number, opps: number, event: [string, string], chance: [string, string], only: string): string | null {
  const o = Math.max(opps, n);
  if (o === 0) return null;
  if (n === 0) return `No ${event[1]} in ${plural(o, chance[0], chance[1])}`;
  if (n === 1 && o < 2) return only;
  const k = Math.round(o / n);
  return `1 ${event[0]} per ${plural(k, chance[0], chance[1])}`;
}

/** Every string the Analytics tab shows. Captions stay at one to three words. */
export const analyticsCopy = {
  title: 'Analytics',
  error: "Couldn't load your drives.",
  radar: {
    rating: 'Safety Rating',
    outOf: '/100',
    window: 'Last 90 days',
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
      body: "Your Safety Rating is the average of your category scores, with Speed counting double. Each one looks at your last 90 days, recent weeks a bit more, and judges you per chance to slip: hard brakes per slowdown, hard starts per speed-up, sharp turns per turn, and how much of your driving is over the limit. You start from a typical driver's score and move from there with every drive.",
    },
  },
  category: {
    /** Under the sheet's title (the axis name and its score). */
    subtitle: 'Score out of 100, last 90 days',
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
    /** The line under a category's numbers. */
    rate: {
      braking: (n: number, slowdowns: number) => eventsRate(n, slowdowns, ['hard brake', 'hard brakes'], ['slowdown', 'slowdowns'], 'A hard brake on your only slowdown'),
      acceleration: (n: number, speedups: number) => eventsRate(n, speedups, ['hard start', 'hard starts'], ['speed-up', 'speed-ups'], 'A hard start on your only speed-up'),
      turning: (n: number, turns: number) => eventsRate(n, turns, ['sharp turn', 'sharp turns'], ['turn', 'turns'], 'A sharp turn on your only turn'),
      speed: (speedingS: number, limitS: number): string | null => {
        if (limitS <= 0) return null;
        if (speedingS <= 0) return 'Never over the limit';
        const p = Math.round((100 * speedingS) / limitS);
        return p < 1 ? 'Over the limit under 1% of the time' : `Over the limit ${Math.min(p, 100)}% of the time`;
      },
      /** While the range holds drives recorded before the chances were counted. */
      estimated: (line: string) => `${line} (estimated)`,
    },
  },
  bests: {
    title: 'Personal best',
    longestClean: 'Longest clean',
    hint: 'Opens the drive',
  },
  range: 'Time range',
  metrics: {
    driving: 'Driving',
    clean: 'Clean driving',
    drives: 'Drives',
    driveTime: 'Drive time',
    distance: 'Distance',
    avgDrive: 'Avg drive',
    avgSpeed: 'Avg speed',
    speeding: 'Speeding events',
    hardBrakes: 'Hard brakes',
    hardStarts: 'Hard starts',
    sharpTurns: 'Sharp turns',
    slowdowns: 'Slowdowns',
    speedups: 'Speed-ups',
    turns: 'Turns',
    overLimit: 'Over the limit',
    withLimit: 'With a limit',
    cleanDrives: 'Clean drives',
    cleanRate: 'Clean rate',
  },
  trend: {
    title: 'Trends',
    /** Names the series picker for a screen reader. */
    picker: 'Trend series',
    score: 'Score',
    events: 'Events',
    notEnough: 'Not enough drives yet',
    /** What a screen reader calls each series and its step ("Safety Rating by day"). */
    spoken: {
      score: 'Safety Rating',
      events: 'Events per mile',
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
