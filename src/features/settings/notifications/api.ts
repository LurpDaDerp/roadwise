/**
 * The three pushes v3 sends and their quiet hours, over `get_notification_prefs` /
 * `set_notification_prefs` (`supabase/migrations/0005_push.sql`). A save sends only the fields
 * that changed (null means "unchanged" on the server) plus this phone's time zone, so quiet hours
 * are read in the zone the driver is in.
 */
import { callRpc } from '@/data/server/rpc';
import { deviceZone } from '@/lib/deviceZone';

export interface NotificationPrefs {
  weekly_recap: boolean;
  leagues: boolean;
  social: boolean;
  quiet_enabled: boolean;
  /** `HH:MM`. */
  quiet_start: string;
  quiet_end: string;
  tz: string | null;
}

export type PrefsPatch = Partial<Omit<NotificationPrefs, 'tz'>>;

export const PREFS_KEY = ['notificationPrefs'] as const;

/** The RPC's arguments for a patch: `p_<field>` for each field present, plus the zone. */
export function prefsArgs(patch: PrefsPatch, tz: string | null): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) args[`p_${k}`] = v;
  if (tz) args.p_tz = tz;
  return args;
}

export function readPrefs(): Promise<NotificationPrefs> {
  return callRpc<NotificationPrefs>('get_notification_prefs');
}

export function savePrefs(patch: PrefsPatch, tz: string | null = currentZone()): Promise<NotificationPrefs> {
  return callRpc<NotificationPrefs>('set_notification_prefs', prefsArgs(patch, tz));
}

/** The phone's zone as the server accepts it. */
export function currentZone(): string {
  return deviceZone();
}
