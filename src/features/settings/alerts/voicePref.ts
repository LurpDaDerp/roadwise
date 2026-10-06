/**
 * Voice alerts (spec: "an optional short voice line"; plan §10 `alerts.voice`, default off). Tones
 * and haptics are never switched off here; only the spoken phrase.
 *
 * The alert player asks `voiceEnabled()` synchronously as each alert plays, so the value lives in a
 * module cache that the launch fills from device settings (`loadVoicePref`, in bootstrap before the
 * player is made) and every change writes through (`setVoicePref`). Until the launch has read it,
 * and whenever the stored value is unreadable, voice is OFF, the plan's default.
 *
 * It is device-local (the `settings` table): it describes this phone's speaker, and the handover
 * wipe resets it with every other setting.
 */
import type { SettingsRepo } from '@/data/db/settings';

export const VOICE_PREF_KEY = 'alerts.voice';

let voiceOn = false;
const listeners = new Set<(on: boolean) => void>();

function apply(on: boolean): void {
  if (on === voiceOn) return;
  voiceOn = on;
  for (const listener of [...listeners]) listener(on);
}

/** The player's `voiceEnabled`: the cached value, read live. */
export function voicePrefEnabled(): boolean {
  return voiceOn;
}

/** Fills the cache from device settings. Never rejects: a failed read keeps the cached value. */
export async function loadVoicePref(settings: Pick<SettingsRepo, 'get'>): Promise<boolean> {
  try {
    const stored = await settings.get<unknown>(VOICE_PREF_KEY);
    apply(typeof stored === 'boolean' ? stored : false);
  } catch {
    // The launch goes on with what the cache holds (off, unless this process already read "on").
  }
  return voiceOn;
}

/** Saves the switch, then updates the cache. Rejects when the write fails, changing nothing. */
export async function setVoicePref(settings: Pick<SettingsRepo, 'set'>, on: boolean): Promise<void> {
  await settings.set(VOICE_PREF_KEY, on);
  apply(on);
}

/** Told of every change after it is saved. Returns the unsubscribe. */
export function subscribeVoicePref(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: back to the launch default. */
export function resetVoicePrefForTests(): void {
  voiceOn = false;
  listeners.clear();
}
