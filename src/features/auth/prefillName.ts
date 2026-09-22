/**
 * The name step's starting value, from the sign-in provider (M0 M-6).
 *
 * `handle_new_user` only reads `display_name` from the signup metadata, so after Apple or Google
 * sign-up `profiles.display_name` is usually empty while the provider's name sits in the auth
 * user's metadata: `display_name` (set on Apple's first sign-in), then Google's `full_name`, then
 * `name`. The metadata is client- or provider-chosen, so it is cleaned the way the signup trigger
 * cleans it — control, bidi and zero-width characters out, trimmed, at most 40 characters as
 * Postgres counts them — and the result always fits the `profiles.display_name` CHECK. It is only
 * a suggestion: the driver edits it before anything is saved.
 */

export const NAME_MAX_CHARS = 40;

/** The part of a Supabase `User` this reads. */
export interface NameSource {
  user_metadata?: Record<string, unknown> | null;
}

const CANDIDATE_KEYS = ['display_name', 'full_name', 'name'] as const;

/** Line breaks and tabs separate words, so they become a space rather than vanishing. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
/**
 * Every control (Cc) and format (Cf) character: the bidi embeddings, overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), the marks (U+200E, U+200F, U+061C), zero-width characters
 * (U+200B–U+200D, U+2060, U+FEFF) and the soft hyphen. A name has no use for any of them.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

export function clean(raw: string): string {
  const flat = raw.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  // Array.from walks code points, which is what char_length counts, and never splits a pair.
  return Array.from(flat).slice(0, NAME_MAX_CHARS).join('').trim();
}

export function prefillName(user: NameSource | null | undefined): string {
  const meta = user?.user_metadata;
  if (!meta) return '';
  for (const key of CANDIDATE_KEYS) {
    const value = meta[key];
    if (typeof value !== 'string') continue;
    const name = clean(value);
    if (name !== '') return name;
  }
  return '';
}
