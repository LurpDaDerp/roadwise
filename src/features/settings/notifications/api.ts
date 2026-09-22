/**
 * H6's server calls on `notification_prefs` (migration 0007): read the caller's row, and write a
 * patch of it.
 *
 * - **Only granted columns.** 0007 grants INSERT on `user_id` plus the preference columns, and
 *   UPDATE on the preference columns only. So a write is an update without `user_id`, then — when
 *   the account has no row yet — an insert with it; never a PostgREST upsert, whose `DO UPDATE SET
 *   user_id` is refused (42501). A patch key outside the grants is dropped, never sent.
 * - **Only what changed.** A null quiet field means "use `app_config.notification_defaults`", so a
 *   write carries only the fields the driver (or the sync) actually changed: the config keeps
 *   governing everything nobody touched.
 * - **RLS decides whose row.** Every call is filtered to the caller's own `user_id` as well.
 */
import { z } from 'zod';

import { deviceZone } from '@/lib/deviceZone';
import { supabase } from '@/data/supabase/client';
import type { TablesUpdate } from '@/data/supabase/types';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@/notifications/catalog';

/** The row's columns this build reads, listed (never `*`). */
export const PREFS_COLUMNS =
  'user_id,categories,quiet_enabled,quiet_start,quiet_end,tz,local_sent_day,local_sent_count';

/** The columns a client may write after insert (0007's UPDATE grant). */
export const PREFS_WRITABLE = [
  'categories',
  'quiet_enabled',
  'quiet_start',
  'quiet_end',
  'tz',
  'local_sent_day',
  'local_sent_count',
] as const;

const KNOWN = new Set<string>(NOTIFICATION_CATEGORIES);

export const PrefsSchema = z.object({
  user_id: z.string(),
  // Only the catalog's categories with boolean values; anything else is dropped, not fatal.
  categories: z
    .record(z.string(), z.unknown())
    .transform((raw) => {
      const out: Partial<Record<NotificationCategory, boolean>> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (KNOWN.has(k) && typeof v === 'boolean') out[k as NotificationCategory] = v;
      }
      return out;
    }),
  quiet_enabled: z.boolean().nullable(),
  quiet_start: z.string().nullable(),
  quiet_end: z.string().nullable(),
  tz: z.string().nullable(),
  local_sent_day: z.string().nullable(),
  local_sent_count: z.number().int(),
});

export type PrefsRow = z.infer<typeof PrefsSchema>;

export interface PrefsPatch {
  categories?: Partial<Record<NotificationCategory, boolean>>;
  quiet_enabled?: boolean | null;
  /** `HH:MM`. */
  quiet_start?: string | null;
  quiet_end?: string | null;
  tz?: string;
  local_sent_day?: string;
  local_sent_count?: number;
}

/** The slice of the Supabase client these calls use; a test passes a fake. */
export type PrefsClient = Pick<typeof supabase, 'from'>;

/** The request never reached the server. */
export class PrefsOfflineError extends Error {
  override readonly name = 'PrefsOfflineError';
  constructor(readonly cause?: unknown) {
    super('notification prefs: the server could not be reached');
  }
}

interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}

function check(reply: Reply): void {
  if (!reply.error) return;
  if (reply.status === 0) throw new PrefsOfflineError(reply.error);
  throw reply.error;
}

const codeOf = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;

function firstRow(data: unknown): PrefsRow | null {
  if (!Array.isArray(data)) return null;
  for (const raw of data) {
    const parsed = PrefsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** The caller's row, or null when the account has none yet. */
export async function readPrefs(userId: string, client: PrefsClient = supabase): Promise<PrefsRow | null> {
  const reply = (await client
    .from('notification_prefs')
    .select(PREFS_COLUMNS)
    .eq('user_id', userId)
    .limit(1)) as unknown as Reply;
  check(reply);
  return firstRow(reply.data);
}

/** The patch's granted columns only (a caller's stray `user_id` is dropped). */
function writable(patch: PrefsPatch): TablesUpdate<'notification_prefs'> {
  const out: Record<string, unknown> = {};
  for (const key of PREFS_WRITABLE) {
    if (key in patch && patch[key] !== undefined) out[key] = patch[key];
  }
  return out as TablesUpdate<'notification_prefs'>;
}

/**
 * Write `patch` to the caller's row: an update, then an insert with `user_id` when there is no row,
 * then one more update if another writer created the row in between (23505). Resolves with the row
 * as stored. An empty patch writes nothing.
 */
export async function savePrefs(
  userId: string,
  patch: PrefsPatch,
  client: PrefsClient = supabase
): Promise<PrefsRow> {
  const values = writable(patch);
  if (Object.keys(values).length === 0) {
    const row = await readPrefs(userId, client);
    return row ?? PrefsSchema.parse({ ...EMPTY_ROW, user_id: userId });
  }
  const update = async (): Promise<PrefsRow | null> => {
    const reply = (await client
      .from('notification_prefs')
      .update(values)
      .eq('user_id', userId)
      .select(PREFS_COLUMNS)) as unknown as Reply;
    check(reply);
    return firstRow(reply.data);
  };

  const updated = await update();
  if (updated) return updated;

  const inserted = (await client
    .from('notification_prefs')
    .insert({ user_id: userId, ...values })
    .select(PREFS_COLUMNS)) as unknown as Reply;
  if (inserted.error && codeOf(inserted.error) === '23505') {
    const again = await update();
    if (again) return again;
  }
  check(inserted);
  const row = firstRow(inserted.data);
  if (!row) throw new Error('notification prefs: the write returned no row');
  return row;
}

const EMPTY_ROW = {
  categories: {},
  quiet_enabled: null,
  quiet_start: null,
  quiet_end: null,
  tz: null,
  local_sent_day: null,
  local_sent_count: 0,
};

/** The phone's zone as the server will accept it (the same normalisation as a drive's zone). */
export function currentZone(): string {
  return deviceZone();
}
