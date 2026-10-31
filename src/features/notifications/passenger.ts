/**
 * The recap notification's one action (product spec "Notifications"): on an automatic drive's
 * recap, "I wasn't driving". It opens the app to a confirm with no score on it ("Mark as a
 * passenger ride?"); "Mark as passenger" marks the drive not driving with no monthly mark used
 * (`markNotDriving(…, { via: 'notification' })`). The confirm is offered only while that drive's
 * recap was never opened (`wasRecapSeen`) and within 30 minutes of the drive's end; otherwise the
 * action just opens the recap.
 */
import { Alert } from 'react-native';

import { createTripsRepo, type Db, type TripRow } from '@/data/db';
import { wasRecapSeen } from '@/features/drives/recapSeen';

/** The category of an automatic drive's recap (`content.categoryIdentifier`). */
export const PASSENGER_CATEGORY_ID = 'autoDriveRecap';
/** Its one action. */
export const PASSENGER_ACTION_ID = 'notDriving';
/** The confirm is offered this long after the drive's end. */
export const PASSENGER_WINDOW_MS = 30 * 60_000;
/** `content.data.kind` of a recap (`DRIVE_SUMMARY_KIND` in summaryNotifier.ts). */
const RECAP_KIND = 'driveSummary';
const TRIP_ID = /^[A-Za-z0-9-]{1,64}$/;

export const passengerCopy = {
  action: 'I wasn’t driving',
  title: 'Mark as a passenger ride?',
  body: 'It won’t count toward your rating.',
  confirm: 'Mark as passenger',
  cancel: 'Cancel',
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** The drive a tap on the recap's "I wasn't driving" names, or null for any other response. */
export function passengerTapOf(response: unknown): string | null {
  if (!isRecord(response) || response.actionIdentifier !== PASSENGER_ACTION_ID) return null;
  const n = response.notification;
  if (!isRecord(n) || !isRecord(n.request) || !isRecord(n.request.content)) return null;
  const data = n.request.content.data;
  if (!isRecord(data) || data.kind !== RECAP_KIND) return null;
  return typeof data.clientTripId === 'string' && TRIP_ID.test(data.clientTripId) ? data.clientTripId : null;
}

/** A drive whose recap carries the action: noticed on its own, its "Not driving?" never run out. */
const carriesAction = (t: Pick<TripRow, 'origin' | 'not_driving_expired'>): boolean => t.origin === 'auto' && t.not_driving_expired !== 1;

/** The recap's category for this drive (the notifier's `category`): the action's, or none. */
export function recapCategory(db: Db): (clientTripId: string) => Promise<string | null> {
  return async (clientTripId) => {
    const t = await createTripsRepo(db).get(clientTripId);
    return t !== null && carriesAction(t) ? PASSENGER_CATEGORY_ID : null;
  };
}

/**
 * Whether the confirm is offered for this drive now: an automatic drive, kept (scored, unscored or
 * waiting for its upload), its "Not driving?" never run out, no refusal on it, ended no more than
 * 30 minutes ago, and its recap never opened.
 */
export async function passengerOffered(db: Db, clientTripId: string, now: number): Promise<boolean> {
  const t = await createTripsRepo(db).get(clientTripId);
  if (t === null || !carriesAction(t) || t.ended_at === null || t.sync_error !== null) return false;
  if (t.status !== 'scored' && t.status !== 'unscored' && t.status !== 'pending') return false;
  if (now - t.ended_at > PASSENGER_WINDOW_MS) return false;
  return !(await wasRecapSeen(db, clientTripId));
}

/** The confirm: resolves true for "Mark as passenger". No score, nothing about the drive. */
export function confirmPassenger(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      passengerCopy.title,
      passengerCopy.body,
      [
        { text: passengerCopy.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: passengerCopy.confirm, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}
