// The one-line notice Home shows after a drive that was not kept (product spec v3 "Ending on its
// own"; Home). Written on every drop (the newest overwrites the last), read on Home, cleared by OK,
// a successful Start or sign-out. A device setting: no OS notification is ever sent for a drop.
import type { EndCause } from '@/core/engine/engine.types';
import type { DropReason } from '@/core/engine/finalize';
import { createSettingsRepo, type Db } from '@/data/db';

export const DROP_NOTICE_KEY = 'drive.dropNotice';

export interface DropNotice {
  clientTripId: string;
  cause: EndCause;
  reason: DropReason;
  /** epoch ms the drop was written. */
  at: number;
}

const CAUSES: readonly EndCause[] = ['manual', 'stopped', 'walking', 'orphan', 'limit'];
const REASONS: readonly DropReason[] = ['no_movement', 'no_gps'];

/** A stored notice, or null when absent or not one. */
export function parseDropNotice(raw: unknown): DropNotice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientTripId !== 'string' || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  if (!CAUSES.includes(r.cause as EndCause) || !REASONS.includes(r.reason as DropReason)) return null;
  return { clientTripId: r.clientTripId, cause: r.cause as EndCause, reason: r.reason as DropReason, at: r.at };
}

export async function writeDropNotice(db: Db, notice: DropNotice): Promise<void> {
  await createSettingsRepo(db).set(DROP_NOTICE_KEY, notice);
}

export async function readDropNotice(db: Db): Promise<DropNotice | null> {
  return parseDropNotice(await createSettingsRepo(db).get<unknown>(DROP_NOTICE_KEY));
}

export async function clearDropNotice(db: Db): Promise<void> {
  await createSettingsRepo(db).remove(DROP_NOTICE_KEY);
}
