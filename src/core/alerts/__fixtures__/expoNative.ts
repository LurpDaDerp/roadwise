// expo-audio and expo-speech as native events reach JS: a tone reports loaded, then finished, as
// soon as it plays (no JS timer involved), speech reports done. Use from a test file:
//   jest.mock('expo-audio', () => jest.requireActual('<path>/expoNative').expoAudioMock());
//   jest.mock('expo-speech', () => jest.requireActual('<path>/expoNative').expoSpeechMock());

type Status = { isLoaded?: boolean; playing?: boolean; didJustFinish: boolean };

/**
 * How the next tone behaves: `finish` reports loaded then finished; `loadedOnly` reports loaded and
 * never finishes (only the port's fallback timer ends it); `never` reports nothing at all (a tone
 * that never loads: the port's timers fail it).
 */
export type ToneBehaviour = 'finish' | 'loadedOnly' | 'never';

export const nativeAudio = {
  /** Behaviours for the next tones, in order; empty means `finish`. */
  next: [] as ToneBehaviour[],
  created: 0,
  reset(): void {
    nativeAudio.next.length = 0;
    nativeAudio.created = 0;
  },
};

export function expoAudioMock() {
  return {
    setAudioModeAsync: jest.fn(async () => {}),
    setIsAudioActiveAsync: jest.fn(async () => {}),
    createAudioPlayer: jest.fn(() => {
      nativeAudio.created += 1;
      const behaviour = nativeAudio.next.shift() ?? 'finish';
      let listener: ((s: Status) => void) | null = null;
      return {
        volume: 1,
        addListener: (_event: string, fn: (s: Status) => void) => {
          listener = fn;
          return { remove: () => (listener = null) };
        },
        play: () => {
          if (behaviour === 'never') return;
          queueMicrotask(() => {
            listener?.({ isLoaded: true, playing: true, didJustFinish: false });
            if (behaviour === 'finish') queueMicrotask(() => listener?.({ isLoaded: true, didJustFinish: true }));
          });
        },
        pause: () => {},
        remove: () => {},
      };
    }),
  };
}

export function expoSpeechMock() {
  return {
    speak: jest.fn((_text: string, o: { onDone?: () => void }) => {
      queueMicrotask(() => o.onDone?.());
    }),
    stop: jest.fn(async () => {}),
  };
}

/** Let every queued microtask and promise continuation run (no timer is involved). */
export async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
