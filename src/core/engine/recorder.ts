// The checkpoint recorder: the engine hands `onCheckpoint` the session every `CHECKPOINT_ROWS`
// rows and once more before finalize. The first time it sees a drive it writes the `recording`
// row (how the drive started, where, and from what); then it appends the rows not yet durable and
// advances the mark (and, on iOS, the last native journal `seq` made durable) — in one transaction,
// so a crash leaves either the whole checkpoint or none of it. What it leaves behind is exactly what
// `recovery.ts` continues or finalizes from after a process death, and where the host resumes
// draining the native journal (`trips.last_seq`).
import { createSamplesRepo, createTripsRepo, type Db, type TripPatch } from '@/data/db';
import { dayKey } from '@/lib/time';

import type { EngineDeps, TripSession } from './engine.types';

export interface RecorderOptions {
  /** IANA zone of the device, stored on the trip row when it is created. */
  tz: string;
  now: () => number;
}

export interface Recorder {
  onCheckpoint: EngineDeps['onCheckpoint'];
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

export function createRecorder(db: Db, opts: RecorderOptions): Recorder {
  const trips = createTripsRepo(db);
  const samples = createSamplesRepo(db);

  async function onCheckpoint(session: Readonly<TripSession>): Promise<void> {
    const id = session.clientTripId;
    await db.transaction(async (tx) => {
      const stamp = opts.now();
      const place = session.startPlace;
      const trip =
        (await trips.get(id, tx)) ??
        (await trips.insert(
          {
            client_trip_id: id,
            started_at: Math.round(session.startedAt),
            tz: opts.tz,
            local_day: dayKey(new Date(session.startedAt), opts.tz),
            status: 'recording',
            continues: session.warmup.continues ? 1 : 0,
            origin: session.origin,
            start_source: session.startSource,
            start_lat: place === null ? null : round4(place.lat),
            start_lng: place === null ? null : round4(place.lng),
          },
          stamp,
          tx
        ));
      // The rows beyond the durable mark; the mark is what survives a crash, so it is the one to trust.
      const since = trip.checkpoint_ts ?? Number.NEGATIVE_INFINITY;
      const fresh = session.pending.filter((row) => row.ts > since);
      if (fresh.length > 0) await samples.appendMany(id, fresh.map((row) => ({ ts: row.ts, row })), tx);
      const last = session.lastRowTs;
      const patch: TripPatch = last !== null && last > since ? { checkpoint_ts: Math.round(last) } : {};
      if (session.lastSeq !== null && session.lastSeq !== trip.last_seq) patch.last_seq = session.lastSeq;
      await trips.update(id, patch, stamp, tx);
    });
  }

  return { onCheckpoint };
}
