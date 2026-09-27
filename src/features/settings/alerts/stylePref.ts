/**
 * The alert style (Alerts and sounds): sound and vibration (the default), vibration only, or sound
 * only. For a phone in a pocket or on the seat, where a tone is jarring and a buzz is not.
 *
 * Read synchronously per alert by the player and the camera's alert sink, so the value lives in a
 * module cache that the launch fills from device settings (`loadAlertStylePref`, in bootstrap
 * before the player is made) and every change writes through (`setAlertStylePref`). Until the
 * launch has read it, and whenever the stored value is unreadable, the style is `both`: the
 * default that is never silent.
 *
 * Device-local (the `settings` table), like the voice switch: it describes this phone, and the
 * handover wipe resets it with every other setting.
 */
import { asAlertStyle } from '@/core/alerts/player';
import type { AlertStyle } from '@/core/alerts/types';
import type { SettingsRepo } from '@/data/db/settings';

export const ALERT_STYLE_PREF_KEY = 'alerts.style';

export const ALERT_STYLES: readonly AlertStyle[] = ['both', 'vibration', 'sound'];

let style: AlertStyle = 'both';
const listeners = new Set<(style: AlertStyle) => void>();

function apply(next: AlertStyle): void {
  if (next === style) return;
  style = next;
  for (const listener of [...listeners]) listener(next);
}

/** The player's `alertStyle`: the cached value, read live. */
export function alertStylePref(): AlertStyle {
  return style;
}

/** Fills the cache from device settings. Never rejects: a failed read keeps the cached value. */
export async function loadAlertStylePref(settings: Pick<SettingsRepo, 'get'>): Promise<AlertStyle> {
  try {
    apply(asAlertStyle(await settings.get<unknown>(ALERT_STYLE_PREF_KEY)));
  } catch {
    // The launch goes on with what the cache holds.
  }
  return style;
}

/** Saves the choice, then updates the cache. Rejects when the write fails, changing nothing. */
export async function setAlertStylePref(settings: Pick<SettingsRepo, 'set'>, next: AlertStyle): Promise<void> {
  await settings.set(ALERT_STYLE_PREF_KEY, next);
  apply(next);
}

/** Told of every change after it is saved. Returns the unsubscribe. */
export function subscribeAlertStylePref(listener: (style: AlertStyle) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: back to the launch default. */
export function resetAlertStylePrefForTests(): void {
  style = 'both';
  listeners.clear();
}
