import { PHONE_PICKUP_MIN_MPH, PHONE_PUTDOWN_QUIET_S } from '@scoring';

import { distanceIn, type Units } from '@/lib/units';

import type { PickupMoment, PickupSpeed, RoadKind, WeatherView } from './insights';

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

/** "2×", "1.6×": a ratio to 1 decimal, a whole one without it. */
const times = (r: number) => `${Number.isInteger(r) ? r : r.toFixed(1)}×`;

/** The road kinds by their limits (buckets of 27 and 48 mph): the km rows at the matching posted km/h limits. */
const ROAD_LABEL: Record<Units, Record<RoadKind, string>> = {
  mi: { low: 'Streets, 25 mph and under', mid: 'Main roads, 30–45 mph', high: 'Highways, 50 mph and up' },
  km: { low: 'Streets, 40 km/h and under', mid: 'Main roads, 50–70 km/h', high: 'Highways, 80 km/h and up' },
};
const ROAD_WORDS: Record<RoadKind, string> = { low: 'streets', mid: 'main roads', high: 'highways' };

const PICKUP_SPEED_LABEL: Record<Units, Record<PickupSpeed, string>> = {
  mi: { low: '10–25 mph', mid: '25–45 mph', high: '45+ mph' },
  km: { low: '16–40 km/h', mid: '40–70 km/h', high: '70+ km/h' },
};
const PICKUP_MOMENT_LABEL: Record<PickupMoment, string> = { first: 'First 5 min', middle: 'In between', last: 'Last 5 min' };
/** The 3-hour bands in a sentence ("Your pickups happen most between 6 and 9pm"). */
const BAND_PHRASES = [
  'between midnight and 3am',
  'between 3 and 6am',
  'between 6 and 9am',
  'between 9am and noon',
  'between noon and 3pm',
  'between 3 and 6pm',
  'between 6 and 9pm',
  'between 9pm and midnight',
] as const;

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
    /** Speed's "Where you speed": its speeding time by kind of road, against its driving there. */
    roads: {
      title: 'Where you speed',
      /** A row's road kind, with its limits in the driver's units. */
      label: (kind: RoadKind, units: Units): string => ROAD_LABEL[units][kind],
      speeding: (pct: number) => `${pct}% of your speeding`,
      driving: (pct: number) => `${pct}% of your driving`,
      /** When one kind holds half the speeding or more; `onlyPct` when its driving share is 15 points or more under that. */
      headline: (kind: RoadKind, onlyPct: number | null) =>
        onlyPct === null
          ? `Most of your speeding is on ${ROAD_WORDS[kind]}.`
          : `Most of your speeding is on ${ROAD_WORDS[kind]}, even though only ${onlyPct}% of your driving is there.`,
    },
    /** Phone use's "When pickups happen": the range's pickups by speed, moment in the drive and time of day. */
    pickupTiming: {
      title: 'When pickups happen',
      first: 'Most of your pickups happen in the first 5 minutes. Set your music and route before you go.',
      last: 'Most of your pickups happen near the end of a drive. The message can wait until you park.',
      highway: 'Most of your pickups happen at highway speeds.',
      /** The busiest 3-hour band (0 = midnight to 3am). */
      band: (band: number) => `Your pickups happen most ${BAND_PHRASES[band] ?? BAND_PHRASES[0]}.`,
      speedRow: 'Speed',
      momentRow: 'In the drive',
      timeRow: 'Time of day',
      speed: (key: PickupSpeed, units: Units): string => PICKUP_SPEED_LABEL[units][key],
      moment: (key: PickupMoment): string => PICKUP_MOMENT_LABEL[key],
      share: (pct: number) => `${pct}% of pickups`,
    },
  },
  /** The weather card under Time of day: the drives in rain or snow against the dry, all time. */
  weather: {
    title: 'Weather',
    text: (v: WeatherView, units: Units): string => {
      const per = units === 'km' ? 'kilometer' : 'mile';
      switch (v.kind) {
        case 'worse':
          return v.ratio === null
            ? `In rain or snow you have more events per ${per}. Slow down and leave more room.`
            : `In rain or snow you have ${times(v.ratio)} the events per ${per}. Slow down and leave more room.`;
        case 'smooth':
          return 'You drive as smoothly in rain or snow as in the dry. Nice.';
        case 'bumpier':
          return 'Rain and snow make your drives a little bumpier. Give yourself extra time.';
      }
    },
    /** Under the comment: "4 drives in rain or snow · 38 mi". */
    detail: (drives: number, distance: string) => `${plural(drives, 'drive', 'drives')} in rain or snow · ${distance}`,
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
    recenter: 'Recenter map',
    recenterHint: 'Shows all your trips again',
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
  commute: {
    title: 'Your commute',
    caption: 'Last 4 months',
    /** A leg's title, "Home → Work", and the same for a screen reader (which reads "→" as "right arrow"). */
    leg: (from: string, to: string) => `${from} → ${to}`,
    spokenLeg: (from: string, to: string) => `${from} to ${to}`,
    /** The usual drive time: "Usually 24 min". */
    usually: (time: string) => `Usually ${time}`,
    /** The usual departure: "Leave around 7:40 AM". */
    leave: (clock: string) => `Leave around ${clock}`,
    score: (n: number) => `Score ${n}`,
    change: {
      up: (n: number) => `Up ${n}`,
      down: (n: number) => `Down ${n}`,
      steady: 'Steady',
    },
    rowHint: 'Opens this commute',
    sheet: {
      /** Under the usual drive time: how many drives it comes from. */
      usualLine: (n: number) => `From ${n} ${n === 1 ? 'drive' : 'drives'} in the last 4 months`,
      leaveLine: 'On weekdays',
      /** Under the score: what it is the mean of, and how it moved against the drives before. */
      scoreLine: (recent: number, before: number, change: 'up' | 'down' | 'steady' | null, by: number) => {
        const last = `Your last ${recent} ${recent === 1 ? 'drive' : 'drives'}`;
        if (change === null) return last;
        if (change === 'steady') return `${last}, about the same as the ${before} before`;
        return `${last}, ${change} ${Math.abs(by)} from the ${before} before`;
      },
      spots: 'Spots on the way',
      spotHint: 'Opens the spot',
      recent: 'Recent drives',
      driveHint: 'Opens the drive summary',
    },
  },
} as const;
