import { PHONE_PICKUP_MIN_MPH, PHONE_PUTDOWN_QUIET_S } from '@scoring';

import { distanceIn, type Units } from '@/lib/units';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "10 mph" or "16 km/h": a speed in the driver's units, whole. */
const speed = (mph: number, units: Units) => (units === 'km' ? `${Math.round(distanceIn(mph, 'km'))} km/h` : `${mph} mph`);

/** "45 min" under an hour, "3.2 h" from there: driving time in a sentence. */
function hours(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = seconds / 3600;
  return `${h < 10 ? (Math.round(h * 10) / 10).toFixed(1) : Math.round(h).toLocaleString('en-US')} h`;
}

/**
 * Phone use's rate line: pickups per hour at driving speed, "0.4 pickups an hour at driving
 * speed", or "No pickups in 3.2 h at driving speed". Null when the phone was not watched.
 */
function pickupsRate(pickups: number, phoneS: number): string | null {
  if (phoneS <= 0) return null;
  if (pickups <= 0) return `No pickups in ${hours(phoneS)} at driving speed`;
  const perHour = (pickups * 3600) / phoneS;
  if (perHour < 0.1) return 'Under 0.1 pickups an hour at driving speed';
  const n = perHour < 10 ? (Math.round(perHour * 10) / 10).toFixed(1) : Math.round(perHour).toLocaleString('en-US');
  return `${n} pickups an hour at driving speed`;
}

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
    /** The chart footer's left text: what the number in the middle is, and over what. */
    ratingWindow: 'Safety Rating · Last 90 days',
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
      body: "Your Safety Rating is the average of your category scores, with Speed and Phone use counting double. Each one covers your last 90 days, with recent weeks counting a bit more, and compares your slips to your chances to slip: hard brakes per slowdown, hard starts per speed-up, sharp turns per turn, how much of your driving is over the limit, and how often you pick up your phone at driving speed and how long you hold it while you're moving. You start at a typical driver's score and move from there with every drive.",
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
      body: 'Pair a DashPal to get a score for how focused you stay on the road.',
      action: 'Set up DashPal',
    },
    /** Attention with a DashPal but no watched drives in the range. */
    noDashpal: 'No DashPal drives yet',
    noDashpalBody: (range: string) => `DashPal didn't watch any drives in the ${range.toLowerCase()}. Your Attention numbers show up here once it does.`,
    /** Phone use: how a pickup is judged, under its numbers. */
    phoneHow: (units: Units) => [
      `A pickup counts once the car is going ${speed(PHONE_PICKUP_MIN_MPH, units)} or more. After that, every second your phone is in your hand while you're moving counts too.`,
      `Put it down and pick it up again within ${PHONE_PUTDOWN_QUIET_S} s and it's still one pickup.`,
    ],
    /** Phone use before any drive was watched for it. */
    noPhone: 'No phone data yet',
    noPhoneBody: 'Your Phone use numbers show up here after your next drive.',
    /** In place of the numbers when the range has no drives. */
    empty: 'No data yet',
    emptyBody: (range: string) => `No drives in the ${range.toLowerCase()}. Your numbers show up here after a drive.`,
    /** The line under a category's numbers. */
    rate: {
      braking: (n: number, slowdowns: number) => eventsRate(n, slowdowns, ['hard brake', 'hard brakes'], ['slowdown', 'slowdowns'], 'A hard brake on your only slowdown'),
      acceleration: (n: number, speedups: number) => eventsRate(n, speedups, ['hard start', 'hard starts'], ['speed-up', 'speed-ups'], 'A hard start on your only speed-up'),
      turning: (n: number, turns: number) => eventsRate(n, turns, ['sharp turn', 'sharp turns'], ['turn', 'turns'], 'A sharp turn on your only turn'),
      phone: pickupsRate,
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
  allTime: {
    title: 'All time',
    longestClean: 'Longest clean',
    cleanDrives: 'Clean drives',
    hint: 'Opens the drive',
  },
  /** The range toggle's name for a screen reader (a category sheet's own toggle). */
  range: 'Time range',
  /** The page's range toggle: it says what it changes. */
  rangeGroup: 'Time range, for Driving and Trends',
  metrics: {
    driving: 'Driving',
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
    cleanRate: 'Clean rate',
    pickups: 'Phone pickups',
    inHand: 'Time in hand',
  },
  trend: {
    title: 'Trends',
    /** Names the series picker for a screen reader. */
    picker: 'Trend series',
    score: 'Score',
    events: 'Events',
    notEnough: 'Not enough drives yet',
    /** The range's clean share under the title: "82%" then this. */
    clean: 'clean drives',
    /** The same for a screen reader ("Clean drives, 82 percent"). */
    cleanSpoken: 'Clean drives',
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
    /** None listed, but older drives (past 183 days, archived) still count in the totals. */
    spokenArchived: 'Drives, none in the last 6 months',
    emptyArchived: 'No drives in the last 6 months',
    showMore: 'Show more',
    clean: 'Clean',
    noEvents: 'No events',
    hint: 'Opens the drive summary',
  },
} as const;
