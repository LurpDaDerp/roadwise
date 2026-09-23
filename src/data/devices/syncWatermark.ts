/**
 * The phone's sync watermark (M5 ruling R-A): `devices.synced_through` says "every drive this phone
 * ended before this instant is on the server", and `devices.signed_out_at` says "this phone no
 * longer speaks for its former owner". The server settles a reward day only once every recently
 * active phone of the user reports a watermark past the day's close (or 72 h after it, whatever the
 * watermarks say), so a phone that still holds an unsent drive delays its owner's own credit instead
 * of letting the day settle without it. Both columns can only DELAY credit: the server clamps
 * `synced_through` to `now()`, and a signed-out phone simply stops holding days.
 *
 * - **Only after a clean drain.** The runner calls `onCleanDrain(startedAt)` at the end of every
 *   drain that ran; the value is written only when, after it, no `finalize-trip`, `set-role` or
 *   `dispute` item — the kinds that change a day's facts — is still pending, in flight or retryable,
 *   and no local trip is open (`computeWatermark`). An item the server refused for good does not
 *   hold it (the 72 h cap covers that day); a `trace-upload` or `delete-trip` never does.
 * - **About hourly.** A write only when the value moved ≥ 1 h since the last write for this account
 *   and install, or a 02:00 local boundary (the wall close) lies between them, or the clock moved
 *   back. No drain, wake or timer of its own: it rides the runner's drains, which never run while
 *   recording, offline, or while the app is armed and idle in the background (design §3.5).
 * - **The owner is the stored one** (`readOwner`), never `auth.getSession()` — an offline token
 *   refresh must not read as "nobody" (M4 H2 lesson), and a handover must not write under the next
 *   driver. RLS scopes the PATCH to the session's own rows besides.
 * - **Errors are swallowed.** A missed write only delays the owner's own credit, at most to the cap.
 * - **Sign-out** (`onSignOut`, a before-sign-out task inside the sign-out's 2 s budget) writes
 *   `signed_out_at = now()` only when `computeWatermark` would allow a write (rev2: m1a): a phone
 *   signed out with a drive still to upload keeps holding its days, bounded by the 72 h cap.
 */
import type { Db } from '@/data/db/driver';
import { REFUSED_NEVER } from '@/data/db/queue';
import type { SettingsRepo } from '@/data/db/settings';

import { asError, LAST_UPSERT_KEY, type DevicesClient } from './register';

/** Settings key: the last watermark written, `{ uid, deviceId, at }` (epoch ms of the value). */
export const WATERMARK_WRITTEN_KEY = 'sync.watermarkWritten';
/** The throttle: a write only when the value advanced at least this much (or crossed 02:00 local). */
export const WATERMARK_MIN_STEP_MS = 60 * 60 * 1000;
/** The wall-clock hour a reward day closes (§R2, `REWARDS.SETTLE_WALL_CLOCK_H`). */
export const SETTLE_HOUR = 2;
/** The sign-out's own budget, like M4's token release (`BEFORE_SIGN_OUT_BUDGET_MS`). */
export const SIGN_OUT_BUDGET_MS = 2_000;
/**
 * A drain's write is abandoned after this long: the runner awaits `onCleanDrain` inside its drain,
 * so a request that hung would otherwise hold every later drain of this process.
 */
export const DRAIN_WRITE_BUDGET_MS = 10_000;

/** The queue kinds that can change a day's facts before it settles (`src/data/sync/kinds.ts`). */
export const WATERMARK_HOLDING_KINDS = ['finalize-trip', 'set-role', 'dispute'] as const;

/**
 * The drain that started at `drainStartedAt` was clean: returns `drainStartedAt`, or null when a
 * day-changing item is still owed or a local trip is open.
 *
 * "Owed" is pending, in flight, or failed only because its retries ran out (the next reconnect or
 * launch reopens those, `reopenRetryable`). An item the server refused for good is marked with
 * `REFUSED_NEVER` and does not hold it. A trip is open while its row is `recording`: the engine's
 * ending and finalizing phases keep the row there until `finalizeTrip` writes its status and the
 * queue item in one transaction, so there is no moment when neither holds.
 */
export async function computeWatermark(db: Db, drainStartedAt: number): Promise<number | null> {
  const kinds = WATERMARK_HOLDING_KINDS.map(() => '?').join(', ');
  const { rows: owed } = await db.execute(
    `SELECT COUNT(*) AS n FROM sync_queue
      WHERE kind IN (${kinds})
        AND (status IN ('pending', 'inflight') OR (status = 'failed' AND next_attempt_at <> ?))`,
    [...WATERMARK_HOLDING_KINDS, REFUSED_NEVER]
  );
  if (Number(owed[0]?.n ?? 0) > 0) return null;
  const { rows: open } = await db.execute(
    "SELECT COUNT(*) AS n FROM trips WHERE status = 'recording'"
  );
  if (Number(open[0]?.n ?? 0) > 0) return null;
  return drainStartedAt;
}

/** The wall date `YYYY-MM-DD` whose 02:00 close is the latest one at or before `at`, in `tz`. */
function settleDayOf(at: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const date = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  if (part('hour') < SETTLE_HOUR) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Whether a wall-clock 02:00 in `tz` lies in `(from, to]`. Compared on wall clocks, so a
 * spring-forward night (02:00 does not exist, 01:59 → 03:00) still counts as crossing it.
 */
export function crossesSettleBoundary(from: number, to: number, tz: string): boolean {
  try {
    return settleDayOf(from, tz) !== settleDayOf(to, tz);
  } catch {
    // An unknown zone: treat every hour as a boundary rather than miss one.
    return true;
  }
}

/**
 * The one `devices` update the writer sends: this install's row of `userId`, answering the ids it
 * reached. A seam rather than the client itself, so the writer is tested against a small double;
 * `watermarkClientFor` adapts the app client.
 */
export interface WatermarkClient {
  updateDevice(args: {
    userId: string;
    deviceId: string;
    patch: { synced_through: string } | { signed_out_at: string };
    signal?: AbortSignal;
  }): PromiseLike<{ data: unknown; error: unknown }>;
}

/** The app client as the writer's seam. */
export function watermarkClientFor(client: DevicesClient): WatermarkClient {
  return {
    updateDevice({ userId, deviceId, patch, signal }) {
      const query = client.from('devices').update(patch).eq('user_id', userId).eq('id', deviceId).select('id');
      return signal ? query.abortSignal(signal) : query;
    },
  };
}

export interface WatermarkWriterDeps {
  db: Db;
  supabase: WatermarkClient;
  settings: Pick<SettingsRepo, 'get' | 'set' | 'remove'>;
  /** The stored device owner, fenced locally; null when nobody may be written for. Never the network. */
  readOwner: () => Promise<string | null>;
  /** This install's id (`readInstallId`); null before the device is registered. */
  deviceId: () => Promise<string | null>;
  now: () => number;
  /** The zone the 02:00 boundary is judged in. Default: UTC (the bootstrap passes the device's). */
  tz?: () => string;
  /** Default: `SIGN_OUT_BUDGET_MS`. */
  signOutBudgetMs?: number;
  /** Default: `DRAIN_WRITE_BUDGET_MS`. */
  drainBudgetMs?: number;
  onError?: (error: unknown, context: string) => void;
}

export interface WatermarkWriter {
  onCleanDrain(drainStartedAt: number): Promise<void>;
  onSignOut(): Promise<void>;
}

interface Written {
  uid: string;
  deviceId: string;
  at: number;
}

function parseWritten(raw: unknown): Written | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.uid !== 'string' || typeof r.deviceId !== 'string' || typeof r.at !== 'number') return null;
  return { uid: r.uid, deviceId: r.deviceId, at: r.at };
}

export function createWatermarkWriter(deps: WatermarkWriterDeps): WatermarkWriter {
  const tz = deps.tz ?? (() => 'UTC');
  const report = (error: unknown, context: string): void => deps.onError?.(error, context);

  /** One PATCH of this install's row; true only when it reached the row. */
  async function patch(
    owner: string,
    deviceId: string,
    values: { synced_through: string } | { signed_out_at: string },
    signal?: AbortSignal
  ): Promise<boolean> {
    const { data, error } = await deps.supabase.updateDevice({ userId: owner, deviceId, patch: values, signal });
    if (error) throw asError(error, 'devices watermark update failed');
    if (!Array.isArray(data) || data.length === 0) throw new Error('no device row for this install');
    return true;
  }

  async function due(owner: string, deviceId: string, value: number): Promise<boolean> {
    const last = parseWritten(await deps.settings.get<unknown>(WATERMARK_WRITTEN_KEY));
    if (last === null || last.uid !== owner || last.deviceId !== deviceId) return true;
    if (value < last.at) return true; // a clock that moved back does not keep the throttle shut
    if (value - last.at >= WATERMARK_MIN_STEP_MS) return true;
    return crossesSettleBoundary(last.at, value, tz());
  }

  /** Run `work` with an abort signal, for at most `ms`; the timer is cleared either way. */
  async function bounded(ms: number, work: (signal: AbortSignal) => Promise<void>, context: string): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, ms);
    });
    try {
      await Promise.race([
        work(controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) report(asError(error, `${context} failed`), context);
        }),
        budget,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async onCleanDrain(drainStartedAt) {
      await bounded(
        deps.drainBudgetMs ?? DRAIN_WRITE_BUDGET_MS,
        async (signal) => {
          const value = await computeWatermark(deps.db, drainStartedAt);
          if (value === null) return;
          const owner = await deps.readOwner();
          if (owner === null) return;
          const deviceId = await deps.deviceId();
          if (deviceId === null) return;
          if (!(await due(owner, deviceId, value))) return;
          await patch(owner, deviceId, { synced_through: new Date(value).toISOString() }, signal);
          // Only a write that landed moves the throttle; an abandoned one is tried at the next drain.
          if (signal.aborted) return;
          const written: Written = { uid: owner, deviceId, at: value };
          await deps.settings.set(WATERMARK_WRITTEN_KEY, written);
        },
        'sync watermark'
      );
    },

    async onSignOut() {
      await bounded(
        deps.signOutBudgetMs ?? SIGN_OUT_BUDGET_MS,
        async (signal) => {
          const at = deps.now();
          // rev2 m1a: a phone with a drive still to upload keeps holding its days (the cap bounds it).
          if ((await computeWatermark(deps.db, at)) === null) return;
          const owner = await deps.readOwner();
          if (owner === null || signal.aborted) return;
          const deviceId = await deps.deviceId();
          if (deviceId === null || signal.aborted) return;
          await patch(owner, deviceId, { signed_out_at: new Date(at).toISOString() }, signal);
          // Signing back in re-enrols the phone at once: neither the upsert (which clears
          // signed_out_at) nor the next watermark may be throttled by this account's last stamps.
          await deps.settings.remove(WATERMARK_WRITTEN_KEY);
          await deps.settings.remove(LAST_UPSERT_KEY);
        },
        'sync watermark sign-out'
      );
    },
  };
}
