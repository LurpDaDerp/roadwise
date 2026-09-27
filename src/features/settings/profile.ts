/**
 * H1's one edit: the first name. Cleaned exactly as onboarding cleans it (`clean`: control, bidi
 * and zero-width characters out, trimmed, at most 40 as Postgres counts), so the profiles CHECK can
 * never refuse it, and written through the only profiles write path (`updateOwnProfile`).
 */
import { clean } from '@/features/auth/prefillName';
import { updateOwnProfile } from '@/data/supabase/profile';

export type SaveNameResult = { ok: true; name: string } | { ok: false; reason: 'empty' | 'failed' };

export interface SaveNameDeps {
  update?: (userId: string, patch: { display_name: string }) => Promise<unknown>;
  /** The session's `refreshProfile`, so Home and this screen show the saved name. */
  refresh: () => Promise<void>;
}

export async function saveDisplayName(userId: string, raw: string, deps: SaveNameDeps): Promise<SaveNameResult> {
  const name = clean(raw);
  if (name === '') return { ok: false, reason: 'empty' };
  try {
    await (deps.update ?? updateOwnProfile)(userId, { display_name: name });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  // The write landed; a refresh that fails only delays the new name on screen.
  await deps.refresh().catch(() => undefined);
  return { ok: true, name };
}
