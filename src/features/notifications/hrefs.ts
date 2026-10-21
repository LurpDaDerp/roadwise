/**
 * The app's ONE deep-link allowlist: the routes a notification tap may open (`responses.ts`) and
 * the only links onboarding may hold and replay (`authGuard.ts`). Anchored, so a held or pushed
 * value can only ever be one of these screens. Nothing here starts a drive (plan §7).
 *
 * The driving screen is not in the list: only the drive's own notes open it, the recording note
 * (`kind: 'driveRecording'`, posted by the iPhone while a drive records) and the phone reminder
 * (`kind: 'phoneReminder'`, posted when the phone is picked up with RoadWise in the background),
 * and neither is ever held or replayed (`drivingHrefOf`).
 */

export const SUMMARY_HREF = /^\/drives\/([A-Za-z0-9-]{1,64})(?:\?fresh=1)?$/;

export const ALLOWED_HREFS: readonly RegExp[] = [SUMMARY_HREF, /^\/drives$/, /^\/home$/, /^\/leagues$/, /^\/friends$/];

/** Whether `url` is exactly one of the allowlisted routes. */
export const isAllowedHref = (url: unknown): url is string => typeof url === 'string' && ALLOWED_HREFS.some((re) => re.test(url));

/** The driving screen, and the kinds of the notes that may open it. */
export const DRIVE_HREF = '/drive';
export const DRIVE_RECORDING_KIND = 'driveRecording';
/** The reminder posted when the phone is picked up during a drive with RoadWise in the background. */
export const PHONE_REMINDER_KIND = 'phoneReminder';

const DRIVING_KINDS: readonly unknown[] = [DRIVE_RECORDING_KIND, PHONE_REMINDER_KIND];

/**
 * `/drive` for the drive's recording note or its phone reminder, else null: no other note, and no
 * other path, opens the driving screen.
 */
export function drivingHrefOf(data: unknown): typeof DRIVE_HREF | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  return DRIVING_KINDS.includes(d.kind) && d.url === DRIVE_HREF ? DRIVE_HREF : null;
}
