// "Not driving?" (modes plan §3.6): the small link on the driving screen (and the hint on the iOS
// lock screen) that discards a drive the phone took for one. It is there only while its budget
// lasts: 2 minutes of the driving screen focused and RoadWise in front, on the row clock, counted
// per drive and kept across a relaunch. Once spent it is gone for that drive (the trip row says
// `not_driving_expired`, so "Wasn't driving" is never offered for it either).
import { createSettingsRepo, type Db } from '@/data/db';

/** Settings key; wiped at sign-out (`SIGN_OUT_SETTINGS`). */
export const NOT_DRIVING_KEY = 'drive.notDriving';
/** The visible time the option lasts, ms. */
export const NOT_DRIVING_BUDGET_MS = 120_000;
/** The budget is written at least this often while it is spent (plus every flag change and the expiry). */
export const NOT_DRIVING_PERSIST_EVERY_MS = 5_000;

export interface NotDrivingBudget {
  clientTripId: string;
  /** Visible ms spent so far (never above the budget). */
  spentMs: number;
  /** The budget ran out: the option is gone for this drive. */
  expired: boolean;
  /** Host clock of the last change. */
  updatedAt: number;
}

/** A fresh budget for a drive. */
export const freshBudget = (clientTripId: string, now: number): NotDrivingBudget => ({ clientTripId, spentMs: 0, expired: false, updatedAt: now });

/** The budget after `dtMs` more visible time (a negative or non-finite `dt` adds nothing). Pure. */
export function spend(b: NotDrivingBudget, dtMs: number, now: number): NotDrivingBudget {
  if (b.expired) return b;
  const add = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  if (add === 0) return b;
  const spentMs = Math.min(NOT_DRIVING_BUDGET_MS, b.spentMs + add);
  return { clientTripId: b.clientTripId, spentMs, expired: spentMs >= NOT_DRIVING_BUDGET_MS, updatedAt: now };
}

/** A stored budget, or null when absent or not one. */
export function parseBudget(raw: unknown): NotDrivingBudget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientTripId !== 'string' || r.clientTripId.length === 0) return null;
  if (typeof r.spentMs !== 'number' || !Number.isFinite(r.spentMs) || r.spentMs < 0) return null;
  if (typeof r.expired !== 'boolean' || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null;
  const spentMs = Math.min(NOT_DRIVING_BUDGET_MS, r.spentMs);
  return { clientTripId: r.clientTripId, spentMs, expired: r.expired || spentMs >= NOT_DRIVING_BUDGET_MS, updatedAt: r.updatedAt };
}

export async function readBudget(db: Db): Promise<NotDrivingBudget | null> {
  return parseBudget(await createSettingsRepo(db).get<unknown>(NOT_DRIVING_KEY));
}

export async function writeBudget(db: Db, b: NotDrivingBudget): Promise<void> {
  await createSettingsRepo(db).set(NOT_DRIVING_KEY, b);
}

/** The drive's own stored budget (another drive's is ignored), or a fresh one. */
export async function budgetFor(db: Db, clientTripId: string, now: number): Promise<NotDrivingBudget> {
  const stored = await readBudget(db);
  return stored !== null && stored.clientTripId === clientTripId ? stored : freshBudget(clientTripId, now);
}
