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

/**
 * The reasons the summary's Report sheet offers (plan §4 "Disputes"): `hazard` (a hard brake),
 * `wrong_limit` (speeding), `mounted` ("My phone was mounted", a phone pickup only), `camera_wrong`
 * ("DashPal got it wrong").
 */
export const DISPUTE_REASONS = ['hazard', 'wrong_limit', 'mounted', 'camera_wrong'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/** `trips.origin`: noticed on its own (`auto`, iOS) or started from the Start card (`manual`). */
export const DRIVE_ORIGINS = ['auto', 'manual'] as const;
export type DriveOrigin = (typeof DRIVE_ORIGINS)[number];

/** `trips.start_source`: traced back over the rows, the motion history, or the first row. */
export const START_SOURCES = ['trace', 'motion', 'wake'] as const;
export type StartSource = (typeof START_SOURCES)[number];

/** `EndCause` as stored: a manual end cut at the last movement is `manual_still`. */
export const TRIP_END_CAUSES = ['manual', 'manual_still', 'stopped', 'walking', 'orphan', 'limit'] as const;
export type TripEndCause = (typeof TRIP_END_CAUSES)[number];

export interface TripRow {
  client_trip_id: string;
  started_at: number;
  ended_at: number | null;
  tz: string;
  local_day: string | null;
  miles: number;
  night_miles: number;
  duration_s: number;
  /** The start place (4 dp): the first recorded row, or the parked spot of a motion-history start. */
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
  /** 1 when no active event other than DashPal's; null until the drive is classified, and on an unscored one. */
  clean: Flag | null;
  counts_json: string | null;
  reason: string | null;
  merged_into: string | null;
  /** The server's finalize response (v4), verbatim. */
  result_json: string | null;
  server_id: string | null;
  sync_error: string | null;
  checkpoint_ts: number | null;
  created_at: number;
  updated_at: number;
  /** 1: started within `MERGE_GAP_S` of the end of the phone's previous drive (no warm-up). */
  continues: Flag;
  /** What ended it, on the phone that recorded it; null for a drive hydrated from the server. */
  end_cause: TripEndCause | null;
  /** The miles DashPal watched (`watchedMiles`); 0 without one. */
  watched_miles: number;
  /** How the drive started. */
  origin: DriveOrigin;
  /** 1: the in-drive "Not driving?" ran out of its 2-minute budget, so "Wasn't driving" is never offered. */
  not_driving_expired: Flag;
  /** Times the drive was re-opened because the car set off again within the upload hold. Local only. */
  continuations: number;
  /** When the end was decided (epoch ms); the upload hold and a re-open run from it. Null while recording. */
  finalized_at: number | null;
  /** Where the start came from; null on a drive started before it was recorded, or restored. */
  start_source: StartSource | null;
  /** The last journal row (iOS `seq`) the recorder made durable; null without a journal. */
  last_seq: number | null;
  /** The drive's chances to slip (scoring `Exposure`); null on a drive recorded before the counters. */
  slowdowns: number | null;
  speedups: number | null;
  turns: number | null;
  limit_s: number | null;
  moving_s: number | null;
  /** Seconds at driving speed watched for phone use (phone use's opportunities); 0 on a drive recorded before phone tracking. */
  phone_s: number;
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
  lat: number | null;
  lng: number | null;
  measured_json: string | null;
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

/** A problem spot's kind is the event type it is made of. */
export const SPOT_ROW_KINDS = ['speeding', 'hard_brake', 'hard_corner', 'hard_accel'] as const;
export type SpotRowKind = (typeof SPOT_ROW_KINDS)[number];
export const SPOT_STATES = ['active', 'cleared'] as const;
export type SpotState = (typeof SPOT_STATES)[number];

/** A `problem_spots` row (local only, replaced whole on every recompute). */
export interface ProblemSpotRow {
  id: string;
  kind: SpotRowKind;
  state: SpotState;
  /** The pin, 5 dp. */
  lat: number;
  lng: number;
  heading_deg: number;
  /** The coloured road: an encoded polyline (precision 5). */
  segment: string;
  limit_mph: number | null;
  hits: number;
  passes: number;
  recent_hits: number;
  recent_passes: number;
  rate: number;
  clean_streak: number;
  clean_needed: number;
  last_hit_at: number;
  last_hit_trip: string;
  last_pass_at: number;
  cleared_at: number | null;
  rank: number;
  label: string | null;
  label_at: number | null;
  computed_at: number;
}

/** What a recompute writes; the label carries over and `computed_at` is stamped by the repo. */
export type NewProblemSpot = Omit<ProblemSpotRow, 'label' | 'label_at' | 'computed_at'>;
