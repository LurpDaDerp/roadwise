/**
 * The background-location disclosure as family sharing needs it (pd-2, which names family sharing).
 *
 * - New accounts accept pd-2 at the normal disclosure screen (`BackgroundDisclosure`).
 * - An account that accepted pd-1 is not asked again up front: the Family tab's "share my location"
 *   prompt shows pd-2's new words (`DISCLOSURE_FAMILY_TEXT`), and confirming records pd-2. An account
 *   that has seen no disclosure at all is shown all of pd-2 there.
 * - Confirming records the versioned `background_location` consent first (the server refuses to turn
 *   sharing on, or to take a post, without it), then the phone's affirmation, bound to the account.
 * - Every family post needs this account's affirmation at pd-2 or later (`familyDisclosureAccepted`).
 */
import {
  affirmationCovers,
  affirmationFor,
  ARMING_DISCLOSURE_MIN_VERSION,
  FAMILY_DISCLOSURE_MIN_VERSION,
} from '@/core/permissions/disclosure';
import { DISCLOSURE_AFFIRMED_KEY } from '@/core/permissions/keys';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { DISCLOSURE_FAMILY_TEXT, DISCLOSURE_TEXT, DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';

export type RecordFamilyConsent = (
  userId: string,
  consent: { type: 'background_location'; version: string }
) => Promise<unknown>;

/** Whether `uid` has affirmed a disclosure that names family sharing, on this phone. */
export async function familyDisclosureAccepted(db: Db, uid: string): Promise<boolean> {
  const raw = await createSettingsRepo(db).get<unknown>(DISCLOSURE_AFFIRMED_KEY);
  return affirmationCovers(raw, uid, FAMILY_DISCLOSURE_MIN_VERSION);
}

/**
 * The disclosure words the sharing prompt adds for `uid`: only pd-2's new words when the account has
 * already affirmed the earlier disclosure (it has seen the rest), otherwise all of pd-2.
 */
export async function familyDisclosureWords(db: Db, uid: string): Promise<string> {
  const raw = await createSettingsRepo(db).get<unknown>(DISCLOSURE_AFFIRMED_KEY);
  if (affirmationCovers(raw, uid, ARMING_DISCLOSURE_MIN_VERSION)) return DISCLOSURE_FAMILY_TEXT;
  return `${DISCLOSURE_TEXT.heading}\n\n${DISCLOSURE_TEXT.body}`;
}

/**
 * Records `uid`'s acceptance of the current disclosure (pd-2): the consent row the server checks,
 * then the phone's affirmation (never lowering a newer one). Throws when the consent could not be
 * recorded, so sharing is not turned on without it.
 */
export async function acceptFamilyDisclosure(db: Db, uid: string, now: number, record: RecordFamilyConsent): Promise<void> {
  await record(uid, { type: 'background_location', version: DISCLOSURE_VERSION });
  const settings = createSettingsRepo(db);
  const current = await settings.get<unknown>(DISCLOSURE_AFFIRMED_KEY);
  if (!affirmationCovers(current, uid, DISCLOSURE_VERSION)) {
    await settings.set(DISCLOSURE_AFFIRMED_KEY, affirmationFor(DISCLOSURE_VERSION, uid, now));
  }
}
