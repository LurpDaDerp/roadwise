// The checkpoint recorder: the engine hands `onCheckpoint` the session every `CHECKPOINT_ROWS`
// rows and once more before finalize. The first time it sees a drive it writes the `recording`
// row; then it appends the rows not yet durable and advances the mark — in one transaction, so a
// crash leaves either the whole checkpoint or none of it. What it leaves behind is exactly what
// `recovery.ts` continues or finalizes from after a process death.
import { createSamplesRepo, createTripsRepo, type Db } from '@/data/db';
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

export function createRecorder(db: Db, opts: RecorderOptions): Recorder {
  const trips = createTripsRepo(db);
  const samples = createSamplesRepo(db);

  async function onCheckpoint(session: Readonly<TripSession>): Promise<void> {
    const id = session.clientTripId;
    await db.transaction(async (tx) => {
      const stamp = opts.now();
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
          },
          stamp,
          tx
        ));
      // The rows beyond the durable mark; the mark is what survives a crash, so it is the one to trust.
      const since = trip.checkpoint_ts ?? Number.NEGATIVE_INFINITY;
      const fresh = session.pending.filter((row) => row.ts > since);
      if (fresh.length > 0) await samples.appendMany(id, fresh.map((row) => ({ ts: row.ts, row })), tx);
      const last = session.lastRowTs;
      await trips.update(id, last !== null && last > since ? { checkpoint_ts: Math.round(last) } : {}, stamp, tx);
    });
  }

  return { onCheckpoint };
}
