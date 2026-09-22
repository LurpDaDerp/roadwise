/**
 * One change event for everything that moves SQLite under a mounted screen (M2 carry-over 6).
 *
 * M2 shipped two: `queue:changed` (something was queued) and `sync:applied` (a drain pass settled
 * something). M3 adds two more sources — hydration restoring a driver's history from the server,
 * and the drive host finalizing a trip — so the pair collapses into one event that says **what**
 * moved the rows. Every listener hears every source and decides for itself:
 *
 * - the sync runner wakes on `enqueue` and `finalize` (there is new work), and ignores `sync` (its
 *   own pass) and `hydrate` (nothing was queued);
 * - the query cache invalidates on all four.
 *
 * **Delivery is on a macrotask, never inline.** The callers that matter emit from inside, or at
 * the very end of, a write: `finalizeTrip` enqueues inside the transaction that writes the trip
 * row, and a drain pass emits as its last statement. A listener that woke a drain inline would
 * meet SQLite's write lock (or, under sql.js, an illegal nested BEGIN); by the time a
 * `setTimeout(0)` runs, the transaction has committed and every row the listener reads is there.
 *
 * **Coalescing.** A burst of the same bare event (ten enqueues in one batch) is delivered once. A
 * `sync` event carries the pass's counts, so two of those in one macrotask are both delivered —
 * a listener counting settled work must not lose one. Nothing is scheduled while no one listens.
 *
 * **Isolation.** Each listener is guarded: one that throws is reported to the emitter's `onError`
 * and the rest still hear the event, so an invalidation bug cannot fail the drain that fired it.
 */

/** What moved the rows. */
export type ChangeSource = 'enqueue' | 'sync' | 'hydrate' | 'finalize';

/** What a drain pass settled — the counts a `sync` change carries. */
export type SyncApplied = Readonly<{ done: number; failed: number; deferred: number }>;

export interface DataChange {
  source: ChangeSource;
  /** Present on `sync`: what the pass that just ended settled. */
  result?: SyncApplied;
}

type Listener = (e: DataChange) => void;

interface Pending {
  change: DataChange;
  onError?: (err: unknown) => void;
}

const listeners = new Set<Listener>();
let pending: Pending[] = [];
let scheduled = false;

/** Subscribe to every change; the returned function unsubscribes and is safe to call twice. */
export function onDataChanged(fn: (e: DataChange) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function report(error: unknown, onError: ((err: unknown) => void) | undefined): void {
  if (onError) {
    try {
      onError(error);
    } catch {
      // A reporter that throws has nobody left to report to.
    }
    return;
  }
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[data] change listener:', error);
}

function flush(): void {
  scheduled = false;
  const batch = pending;
  pending = [];
  for (const { change, onError } of batch) {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        report(error, onError);
      }
    }
  }
}

/**
 * Announce a change, delivered once the current transaction has had its chance to commit. A bare
 * event already waiting to be delivered absorbs a second of the same source.
 */
export function emitDataChanged(e: DataChange, onError?: (err: unknown) => void): void {
  if (listeners.size === 0) return;
  const change: DataChange = e.result === undefined ? { source: e.source } : { ...e };
  if (change.result === undefined) {
    const same = pending.find((p) => p.change.source === change.source && p.change.result === undefined);
    if (same) return;
  }
  pending.push({ change, onError });
  if (scheduled) return;
  scheduled = true;
  setTimeout(flush, 0);
}
