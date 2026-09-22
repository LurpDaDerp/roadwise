// The real ports behind the alert player: expo-audio for tones and the audio session, expo-speech
// for phrases, expo-haptics for pulses. Loaded lazily, so nothing native is touched until the host
// asks for the ports, and no native player exists until an alert actually plays.
//
// Session mapping (confirmed against expo-audio 57.0.5's native sources):
// - `activate(kind)` → `setAudioModeAsync(audioModeFor(kind, Platform.OS))` then
//   `setIsAudioActiveAsync(true)`.
//   - `playback` (every platform): `{ playsInSilentMode: true, interruptionMode: 'duckOthers',
//     shouldPlayInBackground: true, allowsRecording: false }`. iOS: the `.playback` category with
//     `.duckOthers`, mixable, so it can start from the background with `UIBackgroundModes: audio`.
//   - `respectSilent` on iOS: `{ playsInSilentMode: false, interruptionMode: 'mixWithOthers',
//     shouldPlayInBackground: false, allowsRecording: false }` → the `.ambient` category: honours the
//     silent switch and mixes with music (it cannot duck). It is the only silent-switch mode iOS
//     accepts: `AudioUtils.validateAudioMode` (ios/AudioUtils.swift) throws when
//     `playsInSilentMode == false` is combined with `duckOthers`, with `allowsRecording`, or with
//     `shouldPlayInBackground` (review P2-C1). `.ambient` is silenced in the background, which is why
//     the host asks for it only while RoadWise is mounted AND frontmost (R14 as amended, P2-I1).
//   - `respectSilent` on Android: `{ playsInSilentMode: false, interruptionMode: 'duckOthers',
//     shouldPlayInBackground: true, allowsRecording: false }`. Android has no validator, and
//     `mixWithOthers` would skip the audio-focus request, so music would not duck.
//     `playsInSilentMode: false` drops `play()` while the ringer is silent or vibrate, and
//     `setIsAudioActiveAsync(true)` must precede `play()` after a release or play is refused.
//   - A mode the native side refuses falls back to the `playback` mode — a defined, audible mode —
//     never to whatever category an earlier alert left behind; `activate` then rejects with the
//     original error so the player reports it.
// - `deactivate()` → `setIsAudioActiveAsync(false)`. iOS: `setActive(false,
//   .notifyOthersOnDeactivation)`, so ducked music comes back up. Android: abandons audio focus.
// - Tone players are created with `keepAudioSessionActive: true`: otherwise iOS deactivates the
//   session 100 ms after the tone ends, un-ducking music under the phrase that follows. The player
//   releases the session itself, once, after the last sound (rev1: I9).
// - Each tone player is removed as soon as its tone ends: an Android expo-audio player runs a
//   status loop every `updateInterval` for as long as it exists, which would be a timer running
//   while the app is armed but idle (design §3.5).
import type { AudioMode, AudioPlayer as ExpoAudioPlayer } from "expo-audio";
import { Platform } from "react-native";

import type {
  AlertPlayerDeps,
  AudioPort,
  HapticsPort,
  SessionKind,
  VoicePort,
} from "./player";
import type { AlertLevel } from "./types";

/** The tone lengths P1 rendered (ms): L1 180, L2 300, L3 880. */
export const TONE_MS: Readonly<Record<AlertLevel, number>> = {
  1: 180,
  2: 300,
  3: 880,
};

/**
 * How long past its length a tone may go without a finish event before `play` resolves anyway —
 * Android silently drops `play()` under a silent ringer on the respect-silent session, and never
 * reports a finish. Covers the load of a local asset too.
 */
export const TONE_FINISH_MARGIN_MS = 1500;

/** Gap between the two pulses of the L2 double pulse, and between the beats of L3's long pattern. */
export const HAPTIC_GAP_MS = 140;

/** A failed iOS deactivation (the session still busy) is retried once after this long. */
export const DEACTIVATE_RETRY_MS = 150;

/** The session a `playback` activation asks for, on every platform; also the fallback mode. */
export const PLAYBACK_MODE: Readonly<Partial<AudioMode>> = {
  playsInSilentMode: true,
  interruptionMode: "duckOthers",
  shouldPlayInBackground: true,
  allowsRecording: false,
};

/** iOS `respectSilent`: `.ambient`, the only silent-switch mode expo-audio's iOS validator accepts. */
export const IOS_RESPECT_SILENT_MODE: Readonly<Partial<AudioMode>> = {
  playsInSilentMode: false,
  interruptionMode: "mixWithOthers",
  shouldPlayInBackground: false,
  allowsRecording: false,
};

/** Android `respectSilent`: ducks through audio focus; drops `play()` under a silent ringer. */
export const ANDROID_RESPECT_SILENT_MODE: Readonly<Partial<AudioMode>> = {
  playsInSilentMode: false,
  interruptionMode: "duckOthers",
  shouldPlayInBackground: true,
  allowsRecording: false,
};

export function audioModeFor(
  kind: SessionKind,
  os: string,
): Readonly<Partial<AudioMode>> {
  if (kind === "playback") return PLAYBACK_MODE;
  return os === "ios" ? IOS_RESPECT_SILENT_MODE : ANDROID_RESPECT_SILENT_MODE;
}

function toneSource(level: AlertLevel): number {
  // Static requires, so Metro bundles the three files.
  switch (level) {
    case 1:
      return require("../../../assets/sounds/l1.wav") as number;
    case 2:
      return require("../../../assets/sounds/l2.wav") as number;
    case 3:
      return require("../../../assets/sounds/l3.wav") as number;
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function createExpoAlertPorts(): Promise<
  Pick<AlertPlayerDeps, "audio" | "voice" | "haptics">
> {
  // Deferred requires rather than `import()`: Metro inlines them just the same, and Jest's CommonJS
  // runtime has no dynamic-import support without `--experimental-vm-modules`.
  await Promise.resolve();
  /* eslint-disable @typescript-eslint/no-require-imports -- deferred native modules, see above */
  const Audio = require("expo-audio") as typeof import("expo-audio");
  const Speech = require("expo-speech") as typeof import("expo-speech");
  const Haptics = require("expo-haptics") as typeof import("expo-haptics");
  /* eslint-enable @typescript-eslint/no-require-imports */

  let tone: { player: ExpoAudioPlayer; finish: () => void } | null = null;
  /** The session kind last activated: L1 on Android's respect-silent one may be dropped on purpose. */
  let lastKind: SessionKind | null = null;

  const audio: AudioPort = {
    async activate(kind: SessionKind) {
      lastKind = kind;
      let refused: { err: unknown } | null = null;
      try {
        await Audio.setAudioModeAsync({ ...audioModeFor(kind, Platform.OS) });
      } catch (err) {
        // Never play in a leftover category: fall back to the defined, audible playback mode.
        refused = { err };
        await Audio.setAudioModeAsync({ ...PLAYBACK_MODE });
      }
      await Audio.setIsAudioActiveAsync(true);
      // Reported, but marked: the alert still sounds on the playback session, so the player must
      // not call it unavailable (final review I2).
      if (refused) {
        throw Object.assign(new Error('audio mode refused; the playback session is used instead'), {
          cause: refused.err,
          fellBack: true,
        });
      }
    },

    play(level, { volume }) {
      tone?.finish();
      return new Promise<void>((resolve, reject) => {
        let player: ExpoAudioPlayer;
        try {
          player = Audio.createAudioPlayer(toneSource(level), {
            keepAudioSessionActive: true,
          });
        } catch (err) {
          reject(err);
          return;
        }
        let settled = false;
        // Whether the player ever said it loaded or played (final re-review n2): a tone that never
        // did was not heard, and must not count as played.
        let heard = false;
        // Android's silent ringer can drop L1 on the respect-silent session: silence there is the
        // chosen behaviour, not a failure.
        const silentDropAllowed = Platform.OS === "android" && level === 1 && lastKind === "respectSilent";
        const release = () => {
          settled = true;
          clearTimeout(timer);
          subscription.remove();
          if (tone?.player === player) tone = null;
          try {
            player.remove();
          } catch {
            // Already released natively; nothing left to free.
          }
        };
        const finish = () => {
          if (settled) return;
          release();
          resolve();
        };
        const timer = setTimeout(() => {
          if (heard || silentDropAllowed) {
            finish();
            return;
          }
          if (settled) return;
          release();
          reject(new Error("the alert tone never loaded or played"));
        }, TONE_MS[level] + TONE_FINISH_MARGIN_MS);
        const subscription = player.addListener(
          "playbackStatusUpdate",
          (status) => {
            if (status.isLoaded || status.playing || status.didJustFinish) heard = true;
            if (status.didJustFinish) finish();
          },
        );
        tone = { player, finish };
        try {
          player.volume = volume;
          player.play();
        } catch (err) {
          release();
          reject(err);
        }
      });
    },

    async stop() {
      const current = tone;
      if (!current) return;
      try {
        current.player.pause();
      } finally {
        current.finish();
      }
    },

    async deactivate() {
      try {
        await Audio.setIsAudioActiveAsync(false);
      } catch {
        await sleep(DEACTIVATE_RETRY_MS);
        await Audio.setIsAudioActiveAsync(false);
      }
    },
  };

  const voice: VoicePort = {
    speak(text, { volume }) {
      return new Promise<void>((resolve, reject) => {
        Speech.speak(text, {
          volume,
          // Speak inside the app's (ducking, background-capable) session on iOS.
          useApplicationAudioSession: true,
          onDone: () => resolve(),
          onStopped: () => resolve(),
          onError: (err) => reject(err),
        });
      });
    },
    async stop() {
      await Speech.stop();
    },
  };

  const haptics: HapticsPort = {
    async pattern(kind) {
      if (kind === "double") {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        await sleep(HAPTIC_GAP_MS);
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        return;
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      await sleep(HAPTIC_GAP_MS);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      await sleep(HAPTIC_GAP_MS);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    },
  };

  return { audio, voice, haptics };
}
