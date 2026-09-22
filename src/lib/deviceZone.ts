import { normaliseZone } from '@/core/engine/finalize';

/**
 * The phone's time zone, normalised exactly as a drive's zone is (`normaliseZone`): an offset id
 * such as `GMT+05:00` becomes `Etc/GMT-5`, an unknown one `UTC`. The one helper every client
 * surface uses (final review m2): the inbox's "Today", the local cap, the summary's quiet hours, the
 * permission report and the notification preferences all decide the day in the same zone, which is
 * also the zone `push-sender` uses.
 */
export function deviceZone(): string {
  try {
    return normaliseZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'UTC';
  }
}
