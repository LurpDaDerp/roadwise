/**
 * The recap's commute line (pure): how this drive's events compare with the driver's usual drive
 * on the same commute leg (Home → Work, Work → Home, Home → School, School → Home;
 * `@/core/places/commute`). Said only when this drive did as well or better: a worse drive gets no
 * line (coaching, never guilt).
 */
import { commuteDrives, type CommutePlace } from '@/core/places/commute';
import { isScoredDrive, type LocalDrive } from '@/data/queries/rows';
import { COMMUTE_CARD_DAYS, COMMUTE_MIN_LEG_DRIVES, median } from '@/features/analytics/commuteModel';

import { recapCopy } from './copy';

const DAY_MS = 86_400_000;

/** The usual drive is read from the leg's drives that started this many days before this one… */
export const COMPARE_DAYS = COMMUTE_CARD_DAYS;
/** …at least this many of them. */
export const COMPARE_MIN_DRIVES = COMMUTE_MIN_LEG_DRIVES;

export type CommuteCompareKind = 'fewer' | 'clean' | 'same';

export interface CommuteCompare {
  kind: CommuteCompareKind;
  /** "Fewer events than your usual Home → Work". */
  text: string;
  /** The same for a screen reader ("… your usual Home to Work"). */
  spoken: string;
}

type CompareDrive = Pick<
  LocalDrive,
  'clientTripId' | 'startedAt' | 'status' | 'reason' | 'archived' | 'counts' | 'fromPlace' | 'toPlace' | 'start' | 'end' | 'tz'
>;

/** A drive's events as the stats count them: speeding, hard brakes, starts and turns, and phone pickups (DashPal's never). */
export const commuteEvents = (d: Pick<LocalDrive, 'counts'>): number =>
  d.counts.speeding + d.counts.hardBrake + d.counts.hardAccel + d.counts.hardCorner + d.counts.pickups;

const counted = (d: CompareDrive): boolean => d.archived !== true && isScoredDrive(d) && Number.isFinite(d.startedAt);

/**
 * The line for `drive` against the driver's other drives, or null. `drive` must be scored and on a
 * commute leg (its stored start and end places, neither moved; `commuteDrives`). Its usual is the
 * median events of the other scored drives on the same leg that started in the `COMPARE_DAYS` days
 * before it (none after it), from `COMPARE_MIN_DRIVES` of them on. Fewer events than the usual:
 * "Fewer events than…"; the same with none: "Clean, like…"; the same with some: "Same as…"; more: null.
 */
export function commuteCompare(drive: CompareDrive, others: readonly CompareDrive[], places: readonly CommutePlace[]): CommuteCompare | null {
  if (places.length === 0 || !counted(drive)) return null;
  const leg = commuteDrives([drive], places)[0];
  if (leg === undefined) return null;
  const since = drive.startedAt - COMPARE_DAYS * DAY_MS;
  const pool = others.filter((d) => d.clientTripId !== drive.clientTripId && counted(d) && d.startedAt >= since && d.startedAt < drive.startedAt);
  const baseline = commuteDrives(pool, places).find((l) => l.id === leg.id)?.drives ?? [];
  if (baseline.length < COMPARE_MIN_DRIVES) return null;
  const usual = median(baseline.map(commuteEvents));
  const mine = commuteEvents(drive);
  if (mine > usual) return null;
  const kind: CommuteCompareKind = mine < usual ? 'fewer' : mine === 0 ? 'clean' : 'same';
  const say = recapCopy.commute[kind];
  return { kind, text: say(`${leg.from.name} → ${leg.to.name}`), spoken: say(`${leg.from.name} to ${leg.to.name}`) };
}
