/**
 * `get_passenger_rides`: how many passenger rides a driver claimed this month (in their own time
 * zone): the in-drive "Not driving?", the recap notification's "I wasn't driving" and "Wasn't
 * driving" all count. The driver's own (no id) for Analytics; a friend's for their profile (the
 * server answers "profile not found" for anyone else). It refetches when a drive upload or a drive
 * action settles (`./invalidate.ts`).
 */
import { type UseQueryResult } from '@tanstack/react-query';

import { SERVER_SLOW_STALE_MS, useServerQuery } from './useServerQuery';

export interface PassengerRides {
  this_month: number;
}

/** `userId`: a friend's, or null for the driver's own. */
export function usePassengerRides(userId: string | null, opts: { enabled?: boolean } = {}): UseQueryResult<PassengerRides> {
  return useServerQuery<PassengerRides>(['passengerRides', userId ?? 'me'], 'get_passenger_rides', userId === null ? undefined : { p_user_id: userId }, {
    enabled: opts.enabled ?? true,
    staleMs: SERVER_SLOW_STALE_MS,
  });
}

/** The count to show, or null when unknown or none. */
export function passengerRidesShown(q: Pick<UseQueryResult<PassengerRides>, 'data'>): number | null {
  const n = q.data?.this_month;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
