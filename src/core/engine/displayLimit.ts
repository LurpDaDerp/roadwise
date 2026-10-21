// The limit the sign shows (product spec v3 "Driving screen"). Display only: the detectors judge
// every row against its own lookup (`limitMphFor`), never against this.
//
// A row with a limit shows it at once. A row without one (no road matched, a low-confidence match, a
// poor or lost fix) keeps showing the last limit while that was read `LIMIT_HOLD_MS` ago or less
// (row clock), so a gap between roads or a short dropout doesn't blank the sign; past that it is
// unknown ("-").

/** A limit the sign lost stays up this long (row clock) unless a new one is read. */
export const LIMIT_HOLD_MS = 10_000;

export type DisplayLimit = {
  /** The limit to show, whole mph, or null for "-". */
  mph: number | null;
  /** The last limit read, and the row it was read on (null before any). */
  lastMph: number | null;
  lastTs: number | null;
};

export const NO_DISPLAY_LIMIT: DisplayLimit = Object.freeze({ mph: null, lastMph: null, lastTs: null });

/** The next value from `prev` and a row at `ts` whose own limit is `mph` (null: none). */
export function nextDisplayLimit(prev: DisplayLimit, ts: number, mph: number | null): DisplayLimit {
  if (mph !== null) return { mph, lastMph: mph, lastTs: ts };
  const held = prev.lastMph !== null && prev.lastTs !== null && ts - prev.lastTs <= LIMIT_HOLD_MS ? prev.lastMph : null;
  return held === prev.mph ? prev : { ...prev, mph: held };
}
