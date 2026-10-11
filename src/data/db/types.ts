/**
 * Typed shapes for the rows in `schema.ts`. They mirror the stored columns exactly — snake_case,
 * `*_json` left as TEXT — and the repositories parse at the edge.
 */
import type { EventType, Tier } from '@scoring';

export type Flag = 0 | 1;

/** `trips.status` (plan §10 `DriveStatus`). */
export type TripStatus = 'recording' | 'pending' | 'scored' | 'unscored' | 'not_driving' | 'merged' | 'failed';
export const TRIP_STATUSES: readonly TripStatus[] = [
  'recording',
  'pending',
  'scored',
  'unscored',
  'not_driving',
  'merged',
  'failed',
];

export type QueueStatus = 'pending' | 'inflight' | 'done' | 'failed';
export const QUEUE_STATUSES: readonly QueueStatus[] = ['pending', 'inflight', 'done', 'failed'];

export type EventStatus = 'active' | 'removed';
export type DisputeStatus = 'none' | 'pending' | 'accepted' | 'rejected';
export const DISPUTE_STATUSES: readonly DisputeStatus[] = ['none', 'pending', 'accepted', 'rejected'];

/** The reasons the summary's Report sheet offers (plan §4 "Disputes"); `camera_wrong` is "DashPal got it wrong". */
export const DISPUTE_REASONS = ['hazard', 'wrong_limit', 'mounted', 'camera_wrong'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export interface TripRow {
  client_trip_id: string;
  started_at: number;
  ended_at: number | null;
  tz: string;
  local_day: string | null;
  miles: number;
  safe_miles: number;
  night_miles: number;
  duration_s: number;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  polyline: string | null;
  from_label: string | null;
  to_label: string | null;
  max_speed_mph: number;
  integrity_json: string | null;
  status: TripStatus;
  points_net: number | null;
  /** 1 while `points_net`/`breakdown_json` are the local estimate; 0 once the server answered. */
  estimate: Flag;
  breakdown_json: string | null;
  clean: Flag | null;
  counts_json: string | null;
  reason: string | null;
  merged_into: string | null;
  /** The server's finalize response, verbatim. */
  result_json: string | null;
  server_id: string | null;
  sync_error: string | null;
  checkpoint_ts: number | null;
  created_at: number;
  updated_at: number;
}

export type NewTrip = Pick<TripRow, 'client_trip_id' | 'started_at' | 'tz' | 'status'> &
  Partial<Omit<TripRow, 'client_trip_id' | 'created_at' | 'updated_at'>>;

export type TripPatch = Partial<Omit<TripRow, 'client_trip_id' | 'created_at' | 'updated_at'>>;

export interface EventRow {
  id: string;
  client_trip_id: string;
  type: EventType;
  tier: Tier;
  started_at: number;
  duration_s: number;
  units: number | null;
  stopped_in_traffic: Flag;
  lat: number | null;
  lng: number | null;
  measured_json: string | null;
  penalty: number | null;
  status: EventStatus;
  dispute_status: DisputeStatus;
  dispute_reason: string | null;
  dispute_message: string | null;
}

export type NewEvent = Pick<EventRow, 'id' | 'client_trip_id' | 'type' | 'tier' | 'started_at'> & Partial<EventRow>;

export type EventPatch = Partial<Omit<EventRow, 'id' | 'client_trip_id'>>;

export interface SampleRow {
  client_trip_id: string;
  ts: number;
  row_json: string;
}

export interface QueueItem {
  id: number;
  kind: string;
  payload_json: string;
  /** Unique; re-enqueueing the same work is a no-op. */
  idempotency_key: string;
  status: QueueStatus;
  /** Failed attempts so far; drives the backoff ladder. */
  attempts: number;
  next_attempt_at: number;
  claimed_at: number | null;
  /** The signed-in user this work was queued for; the runner posts it only under that session. */
  owner_uid: string | null;
  last_error: string | null;
  created_at: number;
}

export interface TileRow {
  tile_key: string;
  expires_at: number;
  segments_json: string;
}

/** A tile with its segments already parsed — what callers of the tiles repo actually want. */
export interface Tile<T> {
  tile_key: string;
  expires_at: number;
  segments: T;
}

export interface SettingRow {
  key: string;
  value_json: string;
}
