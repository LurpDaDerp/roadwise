// Android's spoken alerts: `speakAlert`, `stopAlertSpeech` and `alertVoiceCount` of the Kotlin
// DriveSense module (AlertSpeech.kt), the phone's text-to-speech engine bound on the application
// context and owned by the process. expo-speech's Android engine is the activity's, shut down for
// good when the activity is destroyed while the drive and JS run on behind the location service, so
// every later phrase in that process went silent. iPhone keeps expo-speech: these are not in
// DRIVE_SENSE_METHODS and the iOS module has none.
import { requireOptionalNativeModule } from 'expo-modules-core';

/** The Android-only speech functions of the DriveSense module (`AsyncFunction` in DriveSenseModule.kt). */
export const ANDROID_SPEECH_METHODS = ['speakAlert', 'stopAlertSpeech', 'alertVoiceCount'] as const;

/** The native speech engine, when this build has it (an Android build with AlertSpeech); null elsewhere. */
export interface NativeSpeech {
  /** Speaks after anything queued; resolves once it is said or stopped, rejects when it could not be said. */
  speak(text: string, volume: number): Promise<void>;
  /** Stops the phrase speaking and those queued (each resolves). */
  stop(): Promise<void>;
  /** How many voices the engine has (binding it now): 0 with none, null when it can't be read. Never rejects. */
  voiceCount(): Promise<number | null>;
}

type SpeechModule = {
  speakAlert?: (text: string, volume: number) => Promise<unknown>;
  stopAlertSpeech?: () => Promise<unknown>;
  alertVoiceCount?: () => Promise<unknown>;
};

let moduleForTests: SpeechModule | null | undefined;

/** Tests: stand in for the native module (null: none); undefined goes back to the real lookup. */
export function setSpeechModuleForTests(m: SpeechModule | null | undefined): void {
  moduleForTests = m;
}

const lookup = (): SpeechModule | null => (moduleForTests !== undefined ? moduleForTests : (requireOptionalNativeModule<SpeechModule>('DriveSense') ?? null));

/**
 * The native speech engine, or null where the build has none (iOS, Jest, Expo Go, an Android build
 * made before it): the caller then uses expo-speech as before.
 */
export function nativeSpeech(): NativeSpeech | null {
  const m = lookup();
  if (!m || typeof m.speakAlert !== 'function' || typeof m.stopAlertSpeech !== 'function' || typeof m.alertVoiceCount !== 'function') return null;
  const speakFn = m.speakAlert.bind(m);
  const stopFn = m.stopAlertSpeech.bind(m);
  const countFn = m.alertVoiceCount.bind(m);
  return {
    async speak(text, volume) {
      const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
      const outcome = await speakFn(text, v);
      if (outcome !== 'done' && outcome !== 'stopped') throw new Error('speech failed');
    },
    async stop() {
      await stopFn();
    },
    async voiceCount() {
      try {
        const n = await countFn();
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
      } catch {
        return null;
      }
    },
  };
}
