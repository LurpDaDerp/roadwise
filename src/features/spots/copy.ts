/**
 * Every word about problem spots: the Analytics card and sheet, the map's label chips, and the
 * driving screen's nudge lines (which the sheet quotes). Plain and calm: a spot is a place to
 * watch, never a verdict; a spot that goes away is "cleared", never "fixed".
 */
import type { SpotKind } from '@/core/spots/types';

/** The eight directions of travel, each a 45° sector centred on it, clockwise from north. */
export const DIRECTIONS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const spotsCopy = {
  card: {
    title: 'Spots to watch',
    caption: 'Last 4 months',
    empty: 'None right now. A place shows up here when the same thing keeps happening there.',
    cleared: (n: number): string => (n === 1 ? '1 spot cleared in the last 30 days. Nice driving.' : `${n} spots cleared in the last 30 days. Nice driving.`),
    gettingBetter: 'Getting better',
    rowHint: 'Opens what happens here',
    /** A row for a screen reader: "Dexter Ave N. Speeding, heading south. 4 of your last 6 drives here." */
    rowLabel: (title: string, kind: string, dir: Direction, howOften: string, better: boolean): string =>
      `${title}. ${kind}, heading ${dir}. ${howOften}.${better ? ' Getting better.' : ''}`,
  },
  /** What a spot is, as a row's kind and the sheet's subtitle. */
  kindTitle: { speeding: 'Speeding', hard_brake: 'Hard braking', hard_corner: 'Sharp turns', hard_accel: 'Hard starts' } satisfies Record<SpotKind, string>,
  /** The map's label chip when the spot has no street name. */
  mapChip: { speeding: 'Speeding', hard_brake: 'Braking', hard_corner: 'Turn', hard_accel: 'Start' } satisfies Record<SpotKind, string>,
  /** A spot's title when the phone found no street for it. */
  fallbackTitle: (dir: Direction): string => `Spot heading ${dir}`,
  /** How often it happens: "4 of your last 6 drives here", or "Your last 3 drives here" when every one. */
  howOften: (hits: number, passes: number): string => (hits >= passes ? `Your last ${passes} drives here` : `${hits} of your last ${passes} drives here`),
  sheet: {
    subtitle: (kind: string, dir: Direction): string => `${kind} · heading ${dir}`,
    /** "Over the 35 mph limit". */
    overLimit: (limit: string): string => `Over the ${limit} limit`,
    overUnknownLimit: 'Over the speed limit',
    what: { hard_brake: 'Braking hard', hard_corner: 'Turning fast', hard_accel: 'Pulling away hard' } satisfies Record<Exclude<SpotKind, 'speeding'>, string>,
    lastTime: 'Last time',
    openDrive: 'Open drive',
    openDriveLabel: "Open that drive's summary",
    clearsAfter: (k: number): string => `Clears after ${k} clean drives in a row here`,
    cleanRun: (c: number): string => (c === 1 ? '1 clean drive in a row here' : `${c} clean drives in a row here`),
    moreToClear: (left: number): string => `${left} more and it clears`,
    tip: {
      speeding: 'Ease off a little before you get here.',
      hard_brake: 'Look further ahead and start slowing sooner.',
      hard_corner: 'Slow down before the turn, not in it.',
      hard_accel: 'Roll onto the gas smoothly as you pull away.',
    } satisfies Record<SpotKind, string>,
    /** The driving screen's line for this spot, quoted. */
    hudNote: (line: string): string => `With RoadWise open, “${line}” shows as you come up to it.`,
  },
  /**
   * The driving screen's nudge, one silent line as the car comes up to a spot: at most four words
   * (the one exception to the screen's three), short enough for the band at its largest type.
   */
  nudge: {
    speeding: 'Watch your speed here',
    hard_brake: 'Brake early here',
    hard_corner: 'Take this turn slower',
    hard_accel: 'Start gently here',
  } satisfies Record<SpotKind, string>,
} as const;
