import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

/**
 * Settings › Appearance: which look the app wears on this phone.
 *
 * - `adaptive` (the default): the sky follows the time of day and the weather, and the driving
 *   screen judges night by the sun.
 * - `light` / `dark`: the static looks, the same day and night (the driving screen too).
 * - `system`: the static look for the phone's own Light / Dark setting, following it live.
 *
 * Kept on the phone only (AsyncStorage, read before the first frame behind the splash), never sent
 * to the server, and not cleared by a sign-out or a handover: it is a preference of this phone, not
 * of the driver's account. Lives outside `src/ui/sky` so the driving screen never reaches for it.
 */
export type AppearanceChoice = 'adaptive' | 'light' | 'dark' | 'system';

export const APPEARANCE_CHOICES: readonly AppearanceChoice[] = ['adaptive', 'light', 'dark', 'system'];

export const APPEARANCE_KEY = 'roadwise.appearance.v1';

/** A stored read that takes longer than this gives way to Adaptive, so the splash never waits on it. */
export const APPEARANCE_LOAD_TIMEOUT_MS = 1000;

/** The slice of AsyncStorage the choice uses. */
export type AppearanceStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type AppearanceState = {
  choice: AppearanceChoice;
  /** The stored choice has been read (or could not be, and Adaptive stands). */
  loaded: boolean;
};

/** Anything but a known choice (nothing stored, an older or unknown value) reads as Adaptive. */
export function parseAppearance(raw: unknown): AppearanceChoice {
  return typeof raw === 'string' && (APPEARANCE_CHOICES as readonly string[]).includes(raw) ? (raw as AppearanceChoice) : 'adaptive';
}

/**
 * Hand the look of what RoadWise does not draw (the keyboard, alerts, pickers, maps) back to the
 * phone's own Light / Dark setting. Without it, a scheme the app forced earlier would stick.
 */
export function followPhoneScheme(): void {
  try {
    Appearance.setColorScheme?.('unspecified');
  } catch {
    // An older runtime without the override: the phone's setting already rules.
  }
}

export type AppearanceStore = {
  /** Reads the stored choice once; later calls share the first read. Never rejects. */
  load(): Promise<void>;
  get(): AppearanceState;
  /** The new choice lands at once and is saved in the background. */
  set(choice: AppearanceChoice): void;
  subscribe(listener: () => void): () => void;
};

export function createAppearanceStore(
  storage: AppearanceStorage | null,
  opts: { follow?: () => void; timeoutMs?: number } = {}
): AppearanceStore {
  const follow = opts.follow ?? followPhoneScheme;
  const timeoutMs = opts.timeoutMs ?? APPEARANCE_LOAD_TIMEOUT_MS;
  // With nothing to read, Adaptive stands from the start: nothing waits.
  let state: AppearanceState = { choice: 'adaptive', loaded: storage === null };
  // A choice made in Settings outranks a stored read still on its way.
  let chosen = false;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: AppearanceState) => {
    if (next.choice === state.choice && next.loaded === state.loaded) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  return {
    load() {
      if (loading) return loading;
      if (storage === null) {
        loading = Promise.resolve();
        return loading;
      }
      loading = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          publish({ ...state, loaded: true });
          resolve();
        }, timeoutMs);
        let read: Promise<string | null>;
        try {
          read = storage.getItem(APPEARANCE_KEY);
        } catch {
          read = Promise.resolve(null);
        }
        read
          .catch(() => null)
          .then((raw) => {
            clearTimeout(timer);
            if (chosen) publish({ ...state, loaded: true });
            else publish({ choice: parseAppearance(raw), loaded: true });
            resolve();
          });
      });
      return loading;
    },
    get: () => state,
    set(choice) {
      chosen = true;
      // Before anything renders with the new choice: under System the next render must already
      // read the phone's own scheme, not the one the app forced last.
      if (choice === 'system') follow();
      publish({ choice, loaded: true });
      if (storage) {
        try {
          void storage.setItem(APPEARANCE_KEY, choice).catch(() => {});
        } catch {
          // Not saved: the choice still holds until RoadWise closes.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function asyncStorage(): AppearanceStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
    const s = (require('@react-native-async-storage/async-storage') as { default?: AppearanceStorage }).default;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

/** The phone's choice, for the app's life. The root layout starts its read at module load. */
export const appearance: AppearanceStore = createAppearanceStore(asyncStorage());

/** The current choice, re-rendering on every change. */
export function useAppearance(store: AppearanceStore = appearance): AppearanceState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
