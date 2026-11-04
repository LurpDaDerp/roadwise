/**
 * "Are you driving?" (iPhone with the car link): the note the drive host posts on an automatic drive
 * whose route never held the driver's car (`src/drive/passengerCheck.ts`). Its tap goes to
 * `NotificationsHost`, which hands the drive to the app's handler (the root layout: the same as the
 * driving screen's "Not driving?") before anything is held for a drive, then opens Home. Pure: the
 * kind, the identifier and the parse of a tapped note's `data`.
 */

/** `content.data.kind` of the note. */
export const PASSENGER_CHECK_KIND = 'passengerCheck';
/** One note per drive: posted and removed by this identifier. */
export const passengerCheckId = (clientTripId: string): string => `drive-passenger:${clientTripId}`;

const TRIP_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The drive a tapped "Are you driving?" names, or null for any other note's data. */
export function passengerCheckOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== PASSENGER_CHECK_KIND) return null;
  return typeof d.clientTripId === 'string' && TRIP_ID.test(d.clientTripId) ? d.clientTripId : null;
}
