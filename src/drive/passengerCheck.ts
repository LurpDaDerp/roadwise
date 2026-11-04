// "Are you driving?" (iPhone with the car link, round 14): an automatic drive whose route never held
// the driver's car may be a ride in someone else's. The host asks once, by a notification, when
// every rule below holds; a tap stops the drive as "Not driving?" does. Pure, but for the one read
// of which paired cars have proven their link.
//
// Asked only when ALL hold:
// 1. an automatic drive recording on an iPhone build with the car link, no longer waiting, whose
//    "Not driving?" can still be used (the tap's cancel is then accepted);
// 2. at least one paired car, whose link is proven: a kept drive of the last 30 days was in one of
//    the paired cars (so the car does connect when it is driven);
// 3. Bluetooth is known to be on (allowed and powered; anything else, unknown included: never);
// 4. since the drive opened the route never held a paired car, any CarPlay or any Bluetooth or
//    CarPlay output at all (headphones or another car's audio leave it unclear), and holds none now
//    (native's "gone since" in this drive counts as having held one);
// 5. the car has been at driving speed for 3 minutes at least, and moves now (10 mph or more);
// 6. RoadWise is in the background (in front or merely inactive it waits), notifications may show (granted or
//    provisional; never asked), and it was not asked on this drive yet.
// The host reads Bluetooth and the notification permission last, only once everything else holds.
import type { RadioState } from '@/core/permissions/adapters';
import type { Db } from '@/data/db';
import { mphToMps } from '@/lib/units';

/** Asked once the car has been at driving speed this long. */
export const PASSENGER_AFTER_DRIVING_MS = 180_000;
/** The car must be moving at this speed or more as it is asked. */
export const PASSENGER_MOVING_MPS = mphToMps(10);
/** A paired car's link is proven by a kept drive in it within this long. */
export const PASSENGER_PROVEN_MS = 30 * 24 * 60 * 60_000;
/** Bluetooth and the notification permission are read again at most this often while the rest holds. */
export const PASSENGER_READ_EVERY_MS = 30_000;

export interface PassengerFacts {
  /** An iPhone build with the car link, recording for real (no dry run). */
  carLink: boolean;
  origin: 'auto' | 'manual' | null;
  recording: boolean;
  /** A Start-card drive still waiting for driving speed. */
  waiting: boolean;
  /** "Not driving?" can still be used on this drive (its budget lasts). */
  notDrivingAvailable: boolean;
  /** Paired cars now. */
  pairedCars: number;
  /** One of the paired cars was the car of a kept drive in the last 30 days. */
  linkProven: boolean;
  /** The link was read as the drive opened (the tally exists). */
  linkKnown: boolean;
  pairedEver: boolean;
  carPlayEver: boolean;
  audioEver: boolean;
  audioNow: boolean;
  /** When the car first reached driving speed (row clock), or null. */
  droveAt: number | null;
  /** The newest live row's time and its known, trusted GPS speed (null: none). */
  rowTs: number;
  rowSpeedMps: number | null;
  /** RoadWise is in front: anything but the background (inactive, with Control Center or a call over it, still counts). */
  appActive: boolean;
  /** Already asked on this drive. */
  asked: boolean;
}

/** Every rule but Bluetooth and the notification permission (the host reads those only then). */
export function passengerDue(f: PassengerFacts): boolean {
  if (!f.carLink || f.origin !== 'auto' || !f.recording || f.waiting || !f.notDrivingAvailable || f.asked) return false;
  if (f.pairedCars < 1 || !f.linkProven || !f.linkKnown) return false;
  if (f.pairedEver || f.carPlayEver || f.audioEver || f.audioNow) return false;
  if (f.droveAt === null || f.rowTs - f.droveAt < PASSENGER_AFTER_DRIVING_MS) return false;
  if (f.rowSpeedMps === null || !(f.rowSpeedMps >= PASSENGER_MOVING_MPS)) return false;
  return !f.appActive;
}

/** All of it: the rest, Bluetooth on (known), and notifications allowed. */
export const passengerReady = (f: PassengerFacts, bluetooth: RadioState | null, notificationsAllowed: boolean): boolean =>
  passengerDue(f) && bluetooth === 'on' && notificationsAllowed;

/**
 * The paired cars (`uids`) that were the car of a kept drive (any stored drive no longer
 * recording) ending in the 30 days before `now`. A failed read proves nothing.
 */
export async function readProvenCars(db: Db, uids: readonly string[], now: number): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  try {
    const { rows } = await db.execute(
      `SELECT DISTINCT car_uid FROM trips WHERE car_uid IS NOT NULL AND status <> 'recording' AND ended_at IS NOT NULL AND ended_at >= ?`,
      [now - PASSENGER_PROVEN_MS]
    );
    const seen = new Set(rows.map((r) => r.car_uid).filter((u): u is string => typeof u === 'string'));
    return new Set(uids.filter((u) => seen.has(u)));
  } catch {
    return new Set();
  }
}

/** Settings: the drive already asked "Are you driving?" (its trip id), so a relaunch mid-drive asks no more. */
export const PASSENGER_ASKED_KEY = 'drive.passengerAsked';
