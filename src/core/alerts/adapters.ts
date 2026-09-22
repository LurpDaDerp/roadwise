// The real ports behind the alert player: expo-audio for tones and the audio session, expo-speech
// for phrases, expo-haptics for pulses. Loaded lazily, so nothing native is touched until the host
// asks for the ports, and no native player exists until an alert actually plays.
//
// Session mapping (confirmed against expo-audio 57.0.5's native sources):
// - `activate(kind)` → `setAudioModeAsync({ playsInSilentMode, interruptionMode: 'duckOthers',
//   shouldPlayInBackground: true, allowsRecording: false })` then `setIsAudioActiveAsync(true)`.
//   iOS: `playsInSilentMode: true` is the `.playback` category with `.duckOthers`; `false` is
//   `.ambient`, which honours the silent switch (and cannot duck — the mounted, screen-on L1 only).
//   Android: `playsInSilentMode: false` drops `play()` while the ringer is silent or vibrate, and
//   `setIsAudioActiveAsync(true)` must precede `play()` after a release or play is refused.
// - `deactivate()` → `setIsAudioActiveAsync(false)`. iOS: `setActive(false,
//   .notifyOthersOnDeactivation)`, so ducked music comes back up. Android: abandons audio focus.
// - Tone players are created with `keepAudioSessionActive: true`: otherwise iOS deactivates the
//   session 100 ms after the tone ends, un-ducking music under the phrase that follows. The player
//   releases the session itself, once, after the last sound (rev1: I9).
// - Each tone player is removed as soon as its tone ends: an Android expo-audio player runs a
//   status loop every `updateInterval` for as long as it exists, which would be a timer running
//   while the app is armed but idle (design §3.5).
import type { AudioPlayer as ExpoAudioPlayer } from "expo-audio";

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

  const audio: AudioPort = {
    async activate(kind: SessionKind) {
      await Audio.setAudioModeAsync({
        playsInSilentMode: kind === "playback",
        interruptionMode: "duckOthers",
        shouldPlayInBackground: true,
        allowsRecording: false,
      });
      await Audio.setIsAudioActiveAsync(true);
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
        const timer = setTimeout(
          finish,
          TONE_MS[level] + TONE_FINISH_MARGIN_MS,
        );
        const subscription = player.addListener(
          "playbackStatusUpdate",
          (status) => {
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
