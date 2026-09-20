// "How scoring works" content (§7.E E4): the plain-language version of §9.
//
// The purpose of this screen is trust, so the copy is honest about what the phone cannot see, it
// names what the score is not, and it says out loud that this is an initial model. Every number
// that could drift out of date is derived from `@scoring` rather than typed into prose: the caps
// below come from `CONSTANTS.CATEGORY`, so a tuning change updates the screen with the engine.
//
// Pure data: no React, no network, no I/O.
import { CATEGORY } from '@scoring';
import type { EventCategory } from '@scoring';

/** One block per E4 item, in the order they are read. */
export type ExplainerBlockId =
  | 'measured'
  | 'notMeasured'
  | 'caps'
  | 'confidence'
  | 'context'
  | 'disputes'
  | 'notAScore'
  | 'initialModel';

export interface ExplainerBlock {
  id: ExplainerBlockId;
  title: string;
  body: string;
  /** Optional list rendered under the body; a screen reader reads it as a list. */
  bullets?: readonly string[];
}

export interface CategoryCap {
  category: EventCategory;
  label: string;
  /** Most this category can take from one trip, in score points (§9.3). */
  cap: number;
  /** One line on what the category counts. */
  measures: string;
}

const CATEGORY_COPY: Record<EventCategory, { label: string; measures: string }> = {
  phone: { label: 'Phone use', measures: 'Handling, unlocking or switching apps while the car is moving' },
  speeding: { label: 'Speeding', measures: 'Holding a speed over the posted limit, where the limit is known' },
  braking: { label: 'Hard braking', measures: 'Slowing down harder than normal traffic asks for' },
  accel: { label: 'Rapid acceleration', measures: 'Pulling away or building speed harder than normal' },
  cornering: { label: 'Sharp cornering', measures: 'Taking a turn fast enough to push you sideways in the seat' },
  focus: { label: 'Focus and alertness', measures: 'Eyes off the road and signs of drowsiness, on camera drives only' },
};

/**
 * The per-category caps shown on E4, largest first. Derived from `CONSTANTS.CATEGORY` so the
 * screen can never disagree with the engine; the caps add up to 100 by construction (§9.3).
 */
export const categoryCaps: readonly CategoryCap[] = (Object.keys(CATEGORY) as EventCategory[])
  .map((category) => ({
    category,
    label: CATEGORY_COPY[category].label,
    cap: CATEGORY[category].cap,
    measures: CATEGORY_COPY[category].measures,
  }))
  .sort((a, b) => b.cap - a.cap || (a.category < b.category ? -1 : 1));

/** Sum of the per-category caps: the most a single trip can lose. 100 by design (§9.3). */
export const capTotal: number = categoryCaps.reduce((total, entry) => total + entry.cap, 0);

/** The E4 blocks, in reading order. */
export const scoringExplainer: readonly ExplainerBlock[] = [
  {
    id: 'measured',
    title: 'What we measure',
    body: 'A drive starts at 100 and only goes down for something we actually detected. Six behaviors can cost points, and every point lost is attached to a moment you can open and read the numbers behind. Anything we did not detect costs nothing.',
    bullets: [
      'Phone use while the car is moving',
      'Speeding, when the posted limit is known',
      'Hard braking',
      'Rapid acceleration',
      'Sharp cornering',
      'Eyes off the road and drowsiness, on camera drives only',
    ],
  },
  {
    id: 'notMeasured',
    title: 'What we do not measure',
    body: 'A phone in a mount cannot see most of what a car or a forward-facing camera could, so those things are never scored — not scored leniently, not at all. Where we have no data we say so on the trip rather than guessing.',
    bullets: [
      'Seat belts, following distance, lane keeping, signals and stop signs',
      'Speeding on a road where the posted limit is unknown to us',
      'Anything at all on a trip you were not driving',
      'A possible collision, which we never turn into a deduction',
      'A drive under half a mile or a couple of minutes, which is too short to judge',
      'Who else was in the car, and anything they said or did',
    ],
  },
  {
    id: 'caps',
    title: 'No one habit can take the whole drive',
    body: 'Each behavior has a cap on how much it can take from a single trip, and the caps add up to 100. Deductions are also divided by how far and how long you drove, so a long drive absorbs a moment that would sink a short one. A rough drive costs at most that drive.',
    bullets: categoryCaps.map((entry) => `${entry.label}: at most ${entry.cap} points a trip`),
  },
  {
    id: 'confidence',
    title: 'How sure we are changes what it costs',
    body: 'Every event carries a confidence, based on things like GPS accuracy, whether the location and motion sensors agree, and how good our speed-limit data is for that road. An event we are not confident about is shown as possible and costs nothing; one we are only partly confident about costs less than one we are sure of. A trip whose GPS was unreliable for too much of its length is not scored at all, and we show you why.',
  },
  {
    id: 'context',
    title: 'Night and weather count',
    body: 'The same action is harder to recover from in the dark or in bad weather, so phone use, speeding and focus events count for more at night, and speeding and harsh events count for more in rain or snow. The adjustment is capped, and the trip shows you when it was applied. Nothing is adjusted for where you drove or who you are.',
  },
  {
    id: 'disputes',
    title: 'If something is wrong, say so',
    body: 'Open the event and tap "This isn\'t right". Reports are accepted automatically up to a limit, and when one is accepted the event stops counting and your score is recalculated. Past that limit your report is still recorded, still used to improve detection, and you are told plainly that it was not applied — the limit is there so the score keeps its meaning.',
  },
  {
    id: 'notAScore',
    title: 'What this score is not',
    body: 'It is a coaching number for you, and nothing else. It describes six measurable habits on one drive, from one phone, with the limits above. It is not a judgment of you as a driver.',
    bullets: [
      'Not a finding of legal fault in anything that happened',
      'Not an insurance rating, and not shared with an insurer',
      'Not a measure of how good a driver you are overall',
      'Not a record anyone else can see unless you choose to share it',
    ],
  },
  {
    id: 'initialModel',
    title: 'This is an initial model',
    body: 'These thresholds and weights are our first version and we are still tuning them. They come from published driver-education guidance and our own testing against recorded drives, not from insurance data or a claims history. When we change the model we give it a new version number and leave already-scored trips exactly as they were, so your history stays honest.',
  },
];

export interface ScoringVersionEntry {
  version: number;
  /** ISO day, `YYYY-MM-DD`. */
  date: string;
  summary: string;
}

/**
 * Scoring-model changelog (§9.8: model changes are versioned and history is not silently
 * rewritten). Newest first; `ScoredTrip.scoringVersion` records which entry scored a trip.
 */
export const scoringChangelog: readonly ScoringVersionEntry[] = [
  { version: 1, date: '2026-09-20', summary: 'Initial model' },
];
