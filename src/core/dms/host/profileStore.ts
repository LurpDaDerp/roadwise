// The only profile store (plan Privacy 7, rev1 S-M2): the settings table, one key, bound to the uid. It is
// never a file, SecureStore or a table of its own, so the handover wipe (DEVICE_TABLES includes
// `settings`) and the u13 purge (`dms.profile` is not in KEPT_SETTINGS) clear it by construction. A
// different uid never loads it: the mismatch removes the key. M7 also calls clear() on sign-out and
// account deletion.
import { parseProfile, type DmsProfileV1 } from '../engine/profile';

export const DMS_PROFILE_KEY = 'dms.profile';

export interface DmsProfileStore {
  /** The signed-in uid's profile, parsed; null when absent, someone else's or malformed. */
  load(): Promise<DmsProfileV1 | null>;
  save(p: DmsProfileV1): Promise<void>;
  clear(): Promise<void>;
}

export interface SettingsLike {
  get<T>(k: string): Promise<T | null>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string): Promise<boolean>;
}

export function createSettingsProfileStore(settings: SettingsLike, uid: string): DmsProfileStore {
  return {
    async load() {
      const stored = await settings.get<unknown>(DMS_PROFILE_KEY);
      if (stored === null || stored === undefined) return null;
      const o = typeof stored === 'object' ? (stored as { uid?: unknown; profile?: unknown }) : null;
      const profile = o !== null && o.uid === uid ? parseProfile(o.profile) : null;
      if (profile === null) await settings.remove(DMS_PROFILE_KEY); // someone else's, or unreadable
      return profile;
    },
    async save(p) {
      await settings.set(DMS_PROFILE_KEY, { uid, profile: p });
    },
    async clear() {
      await settings.remove(DMS_PROFILE_KEY);
    },
  };
}
