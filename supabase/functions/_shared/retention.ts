// Trace retention (ruling "B6 retention"): a raw trace is kept 14 days from the end of its drive
// (0008's purge counts from least(upload, drive end)), the dispute window, and then deleted.
//
// A stored `trace_path` alone does not say the object still exists: apply_trip records the path
// before the Wi-Fi upload lands, and an upload can race the purge (review B6 r1 n3). Past
// retention the trace is gone by policy (deleted, being deleted within a purge cycle, or deleted
// on arrival), so a re-score after that point treats the trip as having no trace and takes the
// `no_trace` downgrade honestly, whatever the column still says.

export const TRACE_RETENTION_MS = 14 * 86_400_000;

/** Whether a trip's trace can still exist at `nowMs`: a path is stored and retention has not run out. */
export const traceRetained = (trip: { tracePath: string | null; endedAt: number }, nowMs: number): boolean =>
  trip.tracePath !== null && trip.endedAt >= nowMs - TRACE_RETENTION_MS;
