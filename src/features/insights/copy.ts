/**
 * Every string the insight screens print, in one table.
 *
 * `src/i18n/en.ts` is shared by every feature and is not this task's file to grow; the keys here
 * are shaped so a localisation pass can lift them into it without touching a component. Voice
 * (§7.0, §9.10, §10.11): second person, supportive, plain words, never a comparison with anyone
 * but the driver's own earlier self, never a nudge to drive more.
 */
import type { EventCategory } from '@scoring';

import type { InsightsPeriod } from '@/data/queries';

export const insightsCopy = {
  title: 'Insights',
  back: 'Back',
  loading: 'Loading your insights',
  error: { message: "Couldn't read your drives.", retry: 'Try again' },
  chart: {
    showTable: 'Show as table',
    showChart: 'Show as chart',
    /** A long chart names itself and hands the rows to the table rather than reciting them. */
    manyRows: (caption: string, rows: number) =>
      `${caption}. ${rows} rows — open the table to read them.`,
  },

  period: {
    label: 'Period',
    options: {
      '4w': { short: '4 wk', spoken: '4 weeks', over: 'over 4 weeks' },
      '3mo': { short: '3 mo', spoken: '3 months', over: 'over 3 months' },
      '12mo': { short: '12 mo', spoken: '12 months', over: 'over 12 months' },
      all: { short: 'All', spoken: 'All time', over: 'since your first drive' },
    } satisfies Record<InsightsPeriod, { short: string; spoken: string; over: string }>,
  },

  score: {
    label: 'Long-term score',
    /** Printed where the numeral would go while the score is still being built. */
    notYet: '—',
    building: 'Building',
    provisional: 'Provisional',
    /**
     * §9.6 gates on *both* a trip count and driving time, and over the recent window rather than
     * all time, so the note names both and says which window it means.
     */
    provisionalNote: (trips: number, days: number) =>
      `Provisional until you have ${trips} scored drives and an hour of scored driving in the last ${days} days.`,
  },

  trend: {
    label: 'Score by week',
    up: (points: string, over: string) => `Up ${points} points ${over}.`,
    down: (points: string, over: string) => `Down ${points} points ${over}.`,
    steady: (score: string, over: string) => `Steady at ${score} ${over}.`,
    one: (score: string) => `One scored week so far, at ${score}.`,
    none: (over: string) => `No scored weeks ${over}.`,
    /**
     * §7.E E1's sparse-period note, and the one claim on this screen a driver will check.
     *
     * It does *not* say driving less never lowers the score, which §9.6 promises and the model
     * does not do: the long-term score is a recency-weighted mean pulled toward a prior of
     * `LONG_TERM_MU0`, so as the weights decay a quiet stretch slides the score toward that
     * prior — down for a driver above it, up for one below. What is true is the half a driver
     * needs: a week without a drive takes no points off, and the number they are looking at
     * follows recent driving. Naming the prior is what keeps the drift from reading as a penalty.
     */
    sparse: (start: string) =>
      `Weeks without a drive leave a gap. A quiet week costs no points; over a long break the score drifts back toward ${start}, where every score starts.`,
  },

  youVsYou: {
    label: 'You vs. you',
    /** The card is fixed at the last four weeks against the eight before (§7.E E1). */
    window: 'Your last 4 weeks',
    scoreLabel: 'Score',
    aDrive: 'a drive',
    same: 'Same',
    up: (n: string) => `Up ${n}`,
    down: (n: string) => `Down ${n}`,
    fewer: (n: string) => `${n} fewer`,
    more: (n: string) => `${n} more`,
    better: 'better',
    worse: 'more lost',
    caption: {
      /** A baseline computed on this phone from the driver's own earlier drives. */
      local: 'Compared with your own drives from the 8 weeks before these 4.',
      stored: 'Compared with your 8-week baseline.',
    },
    building: {
      title: 'Your first four weeks are the baseline',
      body: 'Once there are drives from before them, this card compares you with your earlier self — and with no one else.',
    },
    /** "Nothing is lost by the pause" was the same promise in a softer voice; this states the fact. */
    quiet:
      'No drives in the last 4 weeks to set against your baseline. The comparison picks up again with your next drive.',
    /** §10.1.4: compare with yourself first. Scoped to this screen — F5 adds opt-in crew boards. */
    note: 'The only comparison on this screen, and it is with your own earlier drives.',
    spokenScore: (current: string, text: string, word: string) =>
      `Score ${current}, ${text} from your baseline, ${word}`,
    spokenCategory: (label: string, text: string, word: string) =>
      `${label}, ${text} points a drive than your baseline, ${word}`,
    spokenSame: (label: string) => `${label}, same as your baseline`,
  },

  breakdown: {
    label: 'Where points went',
    summary: (label: string, pct: string, over: string) =>
      `${label} was ${pct} of the points you lost ${over}.`,
    none: (over: string) => `No points lost ${over}.`,
    hint: 'Opens this category',
    caption: 'Share of points lost',
    columns: { category: 'Category', share: 'Share', points: 'Points' },
    spoken: (label: string, pct: string, points: string) =>
      `${label}, ${pct} of points lost, ${points} points`,
  },

  highlights: {
    label: 'Highlights',
    none: 'Runs of three clean drives or more show up here.',
    run: {
      phone: (n: number) => `Phone-free for ${n} drives`,
      speeding: (n: number) => `Within the limit for ${n} drives`,
      braking: (n: number) => `Smooth braking for ${n} drives`,
      accel: (n: number) => `Smooth acceleration for ${n} drives`,
      cornering: (n: number) => `Steady cornering for ${n} drives`,
      focus: (n: number) => `Eyes on the road for ${n} drives`,
    } satisfies Record<EventCategory, (n: number) => string>,
  },

  conditions: {
    label: 'Conditions',
    day: 'Day',
    night: 'Night',
    dry: 'Dry',
    wet: 'Wet',
    none: 'No drives',
    drives: (n: number) => `${n} ${n === 1 ? 'drive' : 'drives'}`,
    /** §7.E E1: informational only. */
    note: 'How your drives went in each. For information only; nothing here is compared or scored.',
    spoken: (label: string, score: string, detail: string) => `${label}, score ${score}, ${detail}`,
    spokenNone: (label: string) => `${label}, no drives`,
  },

  /** §7.0 Empty: one sentence, not a breakdown of zeroes and a table of dashes. */
  quietPeriod: (over: string) => `No scored drives ${over}. Widen the period to see further back.`,

  entries: {
    totals: 'Totals & records',
    totalsSub: 'Miles, hours, safe days and bests',
    how: 'How scoring works',
    howSub: 'What counts, what does not, and why',
  },

  notEnough: {
    /** §7.B B1, verbatim shape. */
    building: (scored: number, needed: number) =>
      `Building your score: ${scored} of ${needed} drives`,
    /**
     * §10.1: no badge, level or reward is tied to mileage or trip count, which is implemented and
     * true. The older wording ("nothing here rewards driving more") reached past that to the
     * long-term score, which does follow recent driving — see `trend.sparse`.
     */
    body: (needed: number) =>
      `Insights start after ${needed} scored drives. Drive the way you normally would — there is no hurry, and nothing here is a reward for distance or trip count.`,
    spokenProgress: (scored: number, needed: number) =>
      `${scored} of ${needed} scored drives`,
  },

  category: {
    notFound: {
      title: "That isn't a category we score",
      body: 'Pick one from the overview.',
      action: 'Insights overview',
    },
    rates: {
      label: (over: string) => `Points lost ${over}`,
      total: 'Total',
      per100Mi: 'Per 100 miles',
      perHour: 'Per hour',
      drives: 'Drives affected',
      drivesValue: (n: number, of: number) => `${n} of ${of}`,
      /** No miles or no hours in the window: there is no rate to print. */
      noRate: '—',
      spokenRate: (label: string, value: string) => `${label}, ${value} points`,
    },
    /** §7.E E2: measured-and-clean is a celebration; not-measured is a different sentence. */
    notMeasured: {
      title: 'Nothing to measure here yet',
      noDrives: (over: string) => `No scored drives ${over}, so there is nothing to rate.`,
      noCamera: (over: string) =>
        `This is only measured on drives with camera mode on, and there were none ${over}.`,
      noLimit: (over: string) =>
        `Speeding is only counted where the posted limit is known, and it was not known on your drives ${over}.`,
      /**
       * Offered after any of the three, but only when there is a wider window to open: on `all`
       * there is nothing further back, and the sentence would name a move that does not exist.
       */
      widen: 'Widen the period to see further back.',
    },
    clean: {
      stamp: 'Clean',
      title: (label: string, over: string) => `Nothing lost to ${label} ${over}`,
      keepItUp: 'How to keep it up',
    },
    trend: {
      label: 'Points lost per 100 miles, by week',
      caption: (label: string) => `${label} per 100 miles by week`,
      from: (first: string, last: string, over: string) =>
        `From ${first} to ${last} points per 100 miles ${over}.`,
      one: (rate: string, week: string) => `${rate} points per 100 miles in the ${week}.`,
      none: (over: string) => `No scored weeks ${over}.`,
      capped: (n: number) => `Latest ${n} weeks shown.`,
      columns: { week: 'Week', rate: 'Per 100 mi', points: 'Points' },
      noDrives: 'No drives',
      spoken: (week: string, rate: string) => `${week}, ${rate} points per 100 miles`,
      spokenNone: (week: string) => `${week}, no drives`,
    },
    timeOfDay: {
      label: 'Time of day',
      caption: 'Points lost per 100 miles by time of day',
      buckets: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night' },
      most: (bucket: string, label: string, rate: string) =>
        `${bucket} drives lose the most to ${label}: ${rate} points per 100 miles.`,
      clean: (label: string, over: string) =>
        `No points lost to ${label} at any time of day ${over}.`,
      none: (over: string) => `No drives ${over}.`,
      bounds:
        'By when the drive started. Morning 5–11 AM · Afternoon 11 AM–5 PM · Evening 5–10 PM · Night 10 PM–5 AM.',
      columns: { time: 'Time of day', rate: 'Per 100 mi', drives: 'Drives' },
      spoken: (bucket: string, rate: string, drives: number) =>
        `${bucket}, ${rate} points per 100 miles, ${drives} ${drives === 1 ? 'drive' : 'drives'}`,
      spokenNone: (bucket: string) => `${bucket}, no drives`,
    },
    /** What §7.E E2 lists and this build cannot show yet (needs events by date range). */
    later:
      'Typical severity, road type and a private map of where it happens are coming in a later version.',
    tips: { label: 'Tips' },
    examples: {
      label: 'Example drives',
      hint: 'Opens the drive summary',
      cost: (points: string, label: string) => `${points} points to ${label}`,
      score: (score: string) => `Score ${score}`,
    },
    camera: {
      title: 'Focus and alertness is a camera-mode category',
      body: 'It counts eyes off the road and signs of drowsiness, and only on drives where camera mode was on. Camera mode is off, so there is nothing to show here — and nothing is being missed.',
      privacy:
        'Camera mode is optional, runs only on your phone, stores and sends nothing, and is never needed for rewards.',
      settings: 'Camera settings',
      settingsSoon: 'The camera settings screen arrives with Settings.',
    },
  },

  totals: {
    title: 'Totals & records',
    fields: {
      drives: 'Drives',
      miles: 'Miles',
      hours: 'Driving time',
      /** Not Home's SAFE DAYS (settled, since rewards began): this phone's own days (final review m8). */
      safeDays: 'Safe days on this phone',
      streak: 'Longest run of safe days',
      bestWeek: 'Best week',
      phoneFreeMiles: 'Phone-free miles',
      nightMiles: 'Night miles',
    },
    days: (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`,
    bestWeek: (week: string, score: string) => `${score} · ${week}`,
    noneYet: '—',
    /** §10.1: totals are descriptive. */
    note: 'These describe your driving. Nothing here earns points, badges or levels.',
    asDriver: 'Drives where you were the driver.',
    daysNote:
      "Safe days here are counted from the drives on this phone, once a day has synced. Home's safe days count only days confirmed since rewards began, so the two can differ.",
    empty: {
      title: 'Nothing on the record yet',
      body: 'Drives you take as the driver are totalled here.',
    },
  },

  how: {
    title: 'How scoring works',
    initialModel: 'Initial model',
    capsCaption: 'Most a category can cost one drive',
    capsSummary: (total: number) => `The caps add up to ${total}, the whole of one drive.`,
    capsColumns: { category: 'Category', cap: 'Cap' },
    capsSpoken: (label: string, cap: number) => `${label}, at most ${cap} points a drive`,
    changelog: 'Scoring versions',
    version: (v: number) => `Version ${v}`,
    versionSpoken: (v: number, date: string, summary: string) =>
      `Version ${v}, ${date}, ${summary}`,
  },
} as const;
