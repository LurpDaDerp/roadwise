/**
 * Every word the drive recap, the share card and the history say (ui.md §3.5, plan 3.18). Plain,
 * warm and short; no em dashes, no exclamation marks. A merit tier has no name: it shows only as
 * its icon and colour, and a screen reader hears its number.
 */
import type { MeritTier } from '@scoring';

export const recapCopy = {
  /** The share card's and the hero's three facts, lowercase, the same on both. */
  facts: {
    score: 'score',
    distance: 'distance',
    time: 'time',
    /** "Score 92 out of 100, 12.0 miles, 24 minutes, merit 4 of 5." */
    spoken: (score: number | null, dist: string, time: string, tier: MeritTier | null) =>
      score === null ? `No score, ${dist}, ${time}.` : `Score ${score} out of 100, ${dist}, ${time}${tier === null ? '' : `, merit ${tier} of 5`}.`,
  },
  share: 'Share',
  notSynced: "Not synced yet. We'll keep trying.",
  startNote: 'Started on its own',
  endNote: {
    stopped: (min: number) => `Ended after ${min} min parked`,
    walking: 'Ended when you walked away',
    limit: 'Ended at the 12-hour limit',
    manual_still: 'Ends where the car stopped',
  },
  states: {
    recording: { title: 'Drive in progress', body: 'Your score shows up when the drive ends.' },
    tooShort: { title: 'Too short to score', body: (dist: string, min: number) => `Drives under ${dist} that take under ${min} min don't get a score.` },
    notScored: { title: 'Not scored', body: "This drive didn't get a score." },
    notDriving: { title: 'Marked as not driving', body: "This drive doesn't count toward your Safety Rating." },
    merged: { title: 'Added to your last drive', body: 'You set off again within 5 minutes, so the two count as one drive.', action: 'Open that drive' },
  },
  notScoredWhy: {
    spoofed: "This drive's location didn't look right, so it wasn't scored.",
    implausible: "Something about this drive didn't add up, so it wasn't scored.",
  } as Readonly<Record<string, string>>,
  events: {
    title: (n: number) => `Events · ${n}`,
    spokenTitle: (n: number) => (n === 1 ? '1 event' : `${n} events`),
    none: 'No events. Smooth all the way.',
    more: 'Show more',
    less: 'Show less',
    moreHint: (n: number) => `Shows ${n} more ${n === 1 ? 'event' : 'events'}`,
    lessHint: 'Hides the extra events',
    selectHint: 'Circles it on the route map',
    report: 'Report',
  },
  notDriving: {
    label: (left: number | null) => (left === null ? "Wasn't driving" : `Wasn't driving (${left} left this month)`),
    title: "Wasn't driving?",
    body: "Use this if someone else was behind the wheel. This drive won't count toward your Safety Rating.",
    left: (left: number | null) => (left === null ? 'You can do this 2 times a month.' : `You can do this 2 times a month. You have ${left} left.`),
    error: "That didn't go through. It works within a day of the drive.",
    confirm: "Yes, I wasn't driving",
    cancel: 'Cancel',
  },
  refusals: {
    too_old: 'This drive is more than a day old, so it can’t be marked.',
    no_uses_left: 'You’ve used both “Wasn’t driving” marks this month.',
    already_marked: 'This drive was already marked as not driving.',
    not_driving_expired: 'The “Not driving?” option on that drive ran out, so it can’t be marked.',
  } as Readonly<Record<string, string>>,
  report: {
    sent: "Thanks. We'll check it and update this drive.",
    accepted: 'Report accepted · event removed',
  },
  history: {
    title: 'Your drives',
    score: 'score',
    notSynced: 'not synced',
    words: { recording: 'Recording', too_short: 'Too short', not_scored: 'Not scored', not_driving: 'Not driving', merged: 'Merged' },
    week: (n: number, dist: string) => `${n} ${n === 1 ? 'drive' : 'drives'} · ${dist}`,
    emptyAuto: { title: 'No drives yet', body: "Your drives show up here after you've driven. RoadWise notices them on its own." },
    emptyManual: { title: 'No drives yet', body: 'Swipe Start drive on Home before you pull out. Every drive shows up here.' },
  },
} as const;
