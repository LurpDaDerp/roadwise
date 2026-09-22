// The background-location disclosure's affirmation, as arming and the screens read it (Task 19
// round 1, security I-1). Auto-record never arms without THIS account having affirmed the
// disclosure: the drive host checks it (defence in depth), and every screen that can turn
// auto-record on opens the disclosure first when it is missing.
//
// - Stored under `DISCLOSURE_AFFIRMED_KEY` as `{ version, at, uid }`. The uid binds it to the
//   account that saw the words, so it no longer relies on the handover wipe having run.
// - Compared against `ARMING_DISCLOSURE_MIN_VERSION` as a MINIMUM: a copy-only revision of the
//   disclosure (a new `DISCLOSURE_VERSION`) disarms nobody. Raise the minimum only when a new
//   disclosure must be affirmed before anyone arms again (a counsel-list decision).
// - Migration: an affirmation written before the uid was stored has no `uid` and does not count.
//   No build carrying one has shipped (the interim detection screen was a release gate), so the
//   only phones affected are development phones, which see the repair reason and re-affirm.
//
// Pure: no settings access here.

/** The oldest disclosure whose affirmation still lets auto-record arm. */
export const ARMING_DISCLOSURE_MIN_VERSION = 'pd-1';

export interface DisclosureAffirmation {
  /** `DISCLOSURE_VERSION` of the words shown, `pd-<n>`. */
  version: string;
  /** Epoch ms of Continue. */
  at: number;
  /** The account the disclosure was shown to. */
  uid: string;
}

const VERSION = /^pd-(\d+)$/;

/** `version` is a well-formed `pd-<n>` at or above `min`. */
export function disclosureVersionAtLeast(version: string, min: string): boolean {
  const v = VERSION.exec(version);
  const m = VERSION.exec(min);
  if (v === null || m === null) return false;
  return Number(v[1]) >= Number(m[1]);
}

/** What Continue stores. */
export function affirmationFor(version: string, uid: string, at: number): DisclosureAffirmation {
  return { version, at, uid };
}

/**
 * Whether the stored affirmation `raw` covers `uid`: well formed, made by that account, and for
 * words at or above `min`. Anything else — none, another account, no uid (written before round 1),
 * an older disclosure, a malformed value — does not.
 */
export function affirmationCovers(
  raw: unknown,
  uid: string | null,
  min: string = ARMING_DISCLOSURE_MIN_VERSION
): boolean {
  if (uid === null || uid === '' || typeof raw !== 'object' || raw === null) return false;
  const a = raw as Record<string, unknown>;
  return (
    typeof a.version === 'string' &&
    typeof a.uid === 'string' &&
    a.uid === uid &&
    disclosureVersionAtLeast(a.version, min)
  );
}
