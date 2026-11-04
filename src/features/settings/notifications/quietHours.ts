/**
 * The driver's quiet hours as this phone last saw them. They are the server's (`NotificationPrefs`),
 * and the server applies them to its pushes; a notification the phone schedules itself (the weather
 * heads-up before the commute) applies them on the phone, from this copy. The Notifications screen
 * writes it each time it loads or saves the prefs, and the foreground sync each time the server
 * answers it (it asks for them once when the phone has no copy). A copy that changes plans the
 * heads-ups again. Absent (not read from the server yet): the server's own default for a driver
 * who never changed them (`DEFAULT_QUIET_HOURS`, on from 10 PM to 7 AM). Cleared at sign-out
 * (`SIGN_OUT_SETTINGS`) and by the device wipe.
 */
import type { NotificationPrefs } from './api';

export const QUIET_HOURS_KEY = 'notifications.quietHours';

export interface QuietHours {
  enabled: boolean;
  /** `HH:MM`, the phone's local time; `start = end` does nothing. */
  start: string;
  end: string;
}

/** The server's quiet hours for a driver with no saved prefs (`get_notification_prefs`, `0005_push.sql`). */
export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: true, start: '22:00', end: '07:00' };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` as minutes of the day, or null when it isn't one. */
export function minutesOfClock(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const quietOf = (p: Pick<NotificationPrefs, 'quiet_enabled' | 'quiet_start' | 'quiet_end'>): QuietHours => ({
  enabled: p.quiet_enabled,
  start: p.quiet_start,
  end: p.quiet_end,
});

/** The stored copy, read leniently: anything malformed is no quiet hours. */
export function parseQuietHours(raw: unknown): QuietHours | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.enabled !== 'boolean' || typeof q.start !== 'string' || typeof q.end !== 'string') return null;
  if (minutesOfClock(q.start) === null || minutesOfClock(q.end) === null) return null;
  return { enabled: q.enabled, start: q.start, end: q.end };
}

/** Prefs as the server answered them (an RPC's unknown answer), or null when it isn't that shape. */
export function quietOfAnswer(answer: unknown): QuietHours | null {
  if (!answer || typeof answer !== 'object') return null;
  const p = answer as Record<string, unknown>;
  return parseQuietHours({ enabled: p.quiet_enabled, start: p.quiet_start, end: p.quiet_end });
}

type Store = { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };

/** The quiet hours a phone-scheduled notification keeps to: the copy, else the server's default. */
export async function readQuietHours(store: Pick<Store, 'get'>): Promise<QuietHours> {
  return parseQuietHours(await store.get<unknown>(QUIET_HOURS_KEY)) ?? DEFAULT_QUIET_HOURS;
}

/** Whether the phone holds a copy at all. */
export async function hasQuietHours(store: Pick<Store, 'get'>): Promise<boolean> {
  return parseQuietHours(await store.get<unknown>(QUIET_HOURS_KEY)) !== null;
}

/**
 * Keep the copy in step with what the server said (written only when it changed). Resolves true
 * when the quiet hours a heads-up keeps to changed (the default counts as the copy held before).
 */
export async function rememberQuietHours(store: Store, quiet: QuietHours): Promise<boolean> {
  const stored = parseQuietHours(await store.get<unknown>(QUIET_HOURS_KEY).catch(() => null));
  const same = (a: QuietHours) => a.enabled === quiet.enabled && a.start === quiet.start && a.end === quiet.end;
  if (stored && same(stored)) return false;
  await store.set(QUIET_HOURS_KEY, quiet);
  return !same(stored ?? DEFAULT_QUIET_HOURS);
}
