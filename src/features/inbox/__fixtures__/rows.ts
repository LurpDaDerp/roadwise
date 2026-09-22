/**
 * Inbox row builders. Times are pinned to the query fixtures' `T0` (Monday 2026-01-05 12:00 UTC)
 * so a "today" in a given zone is arithmetic a reader can do on paper.
 */
import { T0 } from '@/data/queries/__fixtures__/rows';
import type { InboxRow } from '@/features/inbox/api';

export const USER = '11111111-1111-4111-8111-111111111111';

let seq = 0;
/** A fresh uuid-shaped id per call. */
export function nextId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** A drive-summary row for `trip-1`, created at T0, unread, never pushed. */
export function inboxRow(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: '00000000-0000-4000-8000-999999999999',
    user_id: USER,
    type: 'trip_summary',
    payload: {
      clientTripId: 'trip-1',
      startedAt: iso(T0),
      endedAt: iso(T0 + 30 * 60_000),
      distanceM: 16093.44,
      status: 'provisional',
      roleUnknown: false,
      scorableIfDriver: true,
    },
    ref_id: null,
    deliver_after: iso(T0),
    read_at: null,
    dismissed_at: null,
    pushed_at: null,
    created_at: iso(T0),
    ...over,
  };
}

export function lapseRow(over: Partial<InboxRow> = {}): InboxRow {
  return inboxRow({
    type: 'permission_lapsed',
    payload: { permission: 'location_always', platform: 'ios', deviceId: 'dev-1' },
    ...over,
  });
}
