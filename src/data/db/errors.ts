/**
 * Errors the repositories raise for conditions a caller can reasonably branch on. Everything
 * else surfaces as the driver's own SQLite error.
 */

/**
 * A child row (an event, a sample) referenced a `client_trip_id` with no trip behind it.
 *
 * Thrown by an explicit check rather than left to the foreign key, because inside a transaction
 * on device foreign keys may not be enforced at all — `expo-sqlite` runs an exclusive
 * transaction on its own connection and opens it before handing the handle over, and
 * `PRAGMA foreign_keys` is per-connection and a no-op once a transaction is open. See the note
 * on `createExpoDb`.
 */
export class MissingTripError extends Error {
  readonly clientTripId: string;

  constructor(clientTripId: string) {
    super(`no trip with client_trip_id "${clientTripId}"`);
    this.name = 'MissingTripError';
    this.clientTripId = clientTripId;
    // Subclassing a built-in survives down-levelling only if the prototype is restored by hand;
    // without this, `instanceof MissingTripError` can be false under some Babel targets.
    Object.setPrototypeOf(this, MissingTripError.prototype);
  }
}
