// The one-line notice Home shows after a drive that was not kept (product spec v3 "Ending on its
// own"; Home). Written on every drop (the newest overwrites the last), read on Home, cleared by OK,
// a successful Start or sign-out. A device setting: no OS notification is ever sent for a drop.
// It carries how the drive began: Home says something only for a Start-card drive, never for an
// automatic one (which the driver never asked for).
import type { DriveOrigin, EndCause } from '@/core/engine/engine.types';
import type { DropReason } from '@/core/engine/finalize';
import { createSettingsRepo, type Db } from '@/data/db';

export const DROP_NOTICE_KEY = 'drive.dropNotice';

export interface DropNotice {
  clientTripId: string;
  cause: EndCause;
  reason: DropReason;
  /** epoch ms the drop was written. */
  at: number;
  /** How the drive began. Absent on a notice an older build wrote (every drive was a Start then). */
  origin?: DriveOrigin;
}

const CAUSES: readonly EndCause[] = ['manual', 'stopped', 'walking', 'orphan', 'limit'];
// `cancelled` ("Not driving?") is never written; it parses so a value from any build reads.
const REASONS: readonly DropReason[] = ['no_movement', 'no_gps', 'not_driven', 'too_short', 'cancelled'];

/** A stored notice, or null when absent or not one. */
export function parseDropNotice(raw: unknown): DropNotice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientTripId !== 'string' || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  if (!CAUSES.includes(r.cause as EndCause) || !REASONS.includes(r.reason as DropReason)) return null;
  const notice: DropNotice = { clientTripId: r.clientTripId, cause: r.cause as EndCause, reason: r.reason as DropReason, at: r.at };
  if (r.origin === 'auto' || r.origin === 'manual') notice.origin = r.origin;
  return notice;
}

/** Whether Home says anything about this drop: only for a drive started from the Start card. */
export const isManualDrop = (n: DropNotice): boolean => n.origin !== 'auto';

export async function writeDropNotice(db: Db, notice: DropNotice): Promise<void> {
  await createSettingsRepo(db).set(DROP_NOTICE_KEY, notice);
}

export async function readDropNotice(db: Db): Promise<DropNotice | null> {
  return parseDropNotice(await createSettingsRepo(db).get<unknown>(DROP_NOTICE_KEY));
}

export async function clearDropNotice(db: Db): Promise<void> {
  await createSettingsRepo(db).remove(DROP_NOTICE_KEY);
}
