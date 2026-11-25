import type { NewTrip } from '@/data/db/types';

/** The server's id for the drive (a uuid, as its stored answer needs). */
export const SERVER_ID = '00000000-0000-4000-8000-000000000777';

/**
 * A finished drive with every trip column set (`archived_at` too, unless `over` clears it), the
 * speed trace, the stored server answer and the integrity block included. A list read checked
 * against it shows that leaving those three in SQLite drops no field a list shows.
 */
export function fullTrip(clientTripId: string, startedAt: number, over: Partial<NewTrip> = {}): NewTrip {
  return {
    client_trip_id: clientTripId,
    started_at: startedAt,
    ended_at: startedAt + 1_200_000,
    tz: 'America/Los_Angeles',
    local_day: '2023-11-14',
    miles: 11.4,
    night_miles: 2.5,
    duration_s: 1200,
    start_lat: 47.6062,
    start_lng: -122.3321,
    end_lat: 47.7,
    end_lng: -122.3,
    polyline: 'trimmed',
    from_label: 'Home',
    to_label: 'Work',
    max_speed_mph: 61,
    integrity_json: JSON.stringify({ mockLocation: false, motionMismatch: false, validGnssPct: 100, maxSpeedMph: 61 }),
    status: 'scored',
    clean: 1,
    counts_json: JSON.stringify({ speeding: 0, hardBrake: 0, hardAccel: 0, hardCorner: 0, pickups: 0 }),
    reason: 'ok',
    result_json: JSON.stringify({ tripId: SERVER_ID, clientTripId, mergedInto: null, scored: true, reason: null, eventIds: [], rating: { safetyRating: 91, ranked: true }, challenges: [], achievements: [] }),
    server_id: SERVER_ID,
    sync_error: 'too_old',
    checkpoint_ts: startedAt + 1_190_000,
    continues: 1,
    end_cause: 'walking',
    watched_miles: 9.5,
    watched_s: 917,
    origin: 'auto',
    not_driving_expired: 1,
    finalized_at: startedAt + 1_300_000,
    start_source: 'motion',
    last_seq: 42,
    slowdowns: 4,
    speedups: 5,
    turns: 3,
    limit_s: 900,
    moving_s: 1100,
    phone_s: 1000,
    archived_at: startedAt + 200 * 86_400_000,
    route_full: 'whole',
    from_place: 'home',
    to_place: 'work',
    car_uid: 'AA:BB:CC:DD:EE:FF',
    car_name: 'Civic',
    end_lat_full: 47.70012,
    end_lng_full: -122.30034,
    speed_trace_json: JSON.stringify({ w: 5, p: [[0, 12.5, 25], [5, 30, 35], [10, null, null]] }),
    limit_buckets_json: JSON.stringify({ low: { s: 10, m: 120 }, mid: { s: 600, m: 9000 }, high: { s: 3, m: 90 } }),
    weather: 'rain',
    practice_supervisor: 'Dad',
    ...over,
  };
}
