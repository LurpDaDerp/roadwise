// The alert player: turns the arbiter's delivered decisions into sound, speech and haptics
// (product spec §8.8 "Receiving a warning", §13.4 alert policy).
//
// What it decides:
// - Level mapping: L1 is a tone only; L2 is tone, voice (when enabled) and a double pulse; L3 is
//   tone, voice and the long pattern. Audio first, haptic last (§8.8 step 4 — the visual is the
//   HUD's, drawn by the host from the same decision).
// - Audio session per level (R14): L1 honours the silent switch only when the host says the trip is
//   mounted and the screen is on. iOS silences silent-switch-respecting categories on screen lock,
//   so a pocketed or locked L1 — the only level in the learning period — plays on the playback
//   session instead. L2 and L3 always play on the playback session.
// - Ducking ends with the alert (rev1: I9): the session is deactivated after each decision's last
//   sound, so music returns to full volume instead of staying ducked for the drive.
// - Loudness: the tone files are rendered near full scale (peak 0.9, P1). Every per-level loudness,
//   including the drop during a phone call, is a named gain below — never baked into the files.
//   L1 is soft by shape (one tone, gentle ramps), not by level: it must carry over music and road
//   noise from a pocket (§13.4, C5).
// - No overlap: a decision arriving while another plays waits for it.
// - Navigation prompts: §13.4 asks for a ≤ 2 s delay "where detectable". Another app's voice
//   guidance is not observable from here on either platform, so no delay is attempted.
//
// What it does not decide: whether to alert, or who is driving. It plays only what it is handed;
// the arbiter marks every passenger, muted or over-budget decision `suppressed` (product §8.15: a
// passenger hears no alerts) and this player ignores suppressed decisions outright, touching no
// port — so a passenger drive cannot sound even if its decisions reach the player.
//
// Failure is silent (SR9): no method rejects. A failing port is reported once through `onError`,
// the remaining steps still run, and the session is still released. Each step is bounded by
// `STEP_TIMEOUT_MS`, so a port that never settles cannot wedge the queue. No timer exists while
// nothing is playing.
import { t } from "@/i18n";

import type { AlertDecision, AlertLevel, AlertVoiceKey } from "./types";

export type SessionKind = "respectSilent" | "playback";

export interface AudioPort {
  /** Activate a session that ducks others; 'respectSilent' honours the silent switch, 'playback' does not. */
  activate(kind: SessionKind): Promise<void>;
  /** Resolves when the tone finishes. */
  play(level: AlertLevel, opts: { volume: number }): Promise<void>;
  stop(): Promise<void>;
  /** Deactivate so ducked audio returns to full volume (rev1: I9). */
  deactivate(): Promise<void>;
}

export interface VoicePort {
  /** Resolves when speech finishes. */
  speak(text: string, opts: { volume: number }): Promise<void>;
  stop(): Promise<void>;
}

export interface HapticsPort {
  pattern(kind: "double" | "long"): Promise<void>;
}

export interface AlertPlayerDeps {
  audio: AudioPort;
  voice: VoicePort;
  haptics: HapticsPort;
  /** Default true; H4 in M4 exposes the setting. */
  voiceEnabled(): boolean;
  /** iOS only (drive-sense `call`): tones at `TONE_GAIN_IN_CALL`, no voice. */
  callActive(): boolean;
  /** R14: true only when the trip is mounted and the screen is on; otherwise L1 plays on the playback session. */
  l1RespectsSilentSwitch(): boolean;
  onError?(err: unknown): void;
}

export interface AlertPlayer {
  /** Audio first, then haptic (§8.8); never rejects (SR9); deactivates after the last sound. */
  deliver(decision: AlertDecision): Promise<void>;
  /** Long-press mute: silences the alert sounding now. One already waiting behind it still plays. */
  stopCurrent(): Promise<void>;
  /** "Recording" at start (§8.4). Spoken on L1's session rule; silent with voice off or on a call. */
  announce(key: AlertVoiceKey): Promise<void>;
}

/**
 * Tone gain per level, applied on top of the full-scale files (0..1). Tunable on the device pass;
 * all 1.0 means the files play as rendered.
 */
export const TONE_GAIN: Readonly<Record<AlertLevel, number>> = {
  1: 1.0,
  2: 1.0,
  3: 1.0,
};

/** Tone gain per level during a phone call (§13.4 "tones only, reduced volume"). */
export const TONE_GAIN_IN_CALL: Readonly<Record<AlertLevel, number>> = {
  1: 0.5,
  2: 0.5,
  3: 0.5,
};

/** Speech volume (0..1) for alert phrases and the start announcement. */
export const VOICE_GAIN = 1.0;

/**
 * The longest any one step (activate, tone, phrase, pulse, release) may take before the player
 * gives up on it. The longest tone is 880 ms and phrases are ≤ 3 words.
 */
export const STEP_TIMEOUT_MS = 5000;

const HAPTIC_FOR_LEVEL: Readonly<Record<AlertLevel, "double" | "long" | null>> =
  {
    1: null,
    2: "double",
    3: "long",
  };

interface Run {
  stopped: boolean;
  /** Settles the step in progress at once (after a stop). */
  wake: () => void;
  woken: Promise<void>;
  done: Promise<void>;
}

function isLevel(level: unknown): level is AlertLevel {
  return level === 1 || level === 2 || level === 3;
}

export function createAlertPlayer(deps: AlertPlayerDeps): AlertPlayer {
  const { audio, voice, haptics } = deps;
  let queue: Promise<void> = Promise.resolve();
  let current: Run | null = null;

  function report(err: unknown): void {
    try {
      deps.onError?.(err);
    } catch {
      // A failing error sink must not make the player fail loudly either.
    }
  }

  function read<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      report(err);
      return fallback;
    }
  }

  /** Runs `fn` bounded by the step timeout (and, when given, a run's stop). Never rejects. */
  async function bounded(fn: () => Promise<void>, run?: Run): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("alert player: step timed out")),
        STEP_TIMEOUT_MS,
      );
    });
    try {
      let work: Promise<void>;
      try {
        work = fn();
      } catch (err) {
        work = Promise.reject(err);
      }
      await Promise.race(run ? [work, timeout, run.woken] : [work, timeout]);
    } catch (err) {
      // A port rejecting because the driver just stopped it is not a failure.
      if (!run?.stopped) report(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function step(run: Run, fn: () => Promise<void>): Promise<void> {
    if (run.stopped) return;
    await bounded(fn, run);
  }

  function enqueue(task: (run: Run) => Promise<void>): Promise<void> {
    const next = queue.then(async () => {
      let wake!: () => void;
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      let finish!: () => void;
      const run: Run = {
        stopped: false,
        wake,
        woken,
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      current = run;
      try {
        await task(run);
      } catch (err) {
        report(err);
      } finally {
        if (current === run) current = null;
        finish();
      }
    });
    queue = next;
    return next;
  }

  function sessionForL1(): SessionKind {
    return read(() => deps.l1RespectsSilentSwitch(), false)
      ? "respectSilent"
      : "playback";
  }

  return {
    deliver(decision) {
      if (decision.suppressed || !isLevel(decision.level))
        return Promise.resolve();
      const level = decision.level;
      return enqueue(async (run) => {
        try {
          const onCall = read(() => deps.callActive(), false);
          const kind: SessionKind = level === 1 ? sessionForL1() : "playback";
          await step(run, () => audio.activate(kind));
          const volume = (onCall ? TONE_GAIN_IN_CALL : TONE_GAIN)[level];
          await step(run, () => audio.play(level, { volume }));
          const key = decision.voice;
          if (
            level >= 2 &&
            key &&
            !onCall &&
            read(() => deps.voiceEnabled(), true)
          ) {
            await step(run, () => voice.speak(t(key), { volume: VOICE_GAIN }));
          }
        } finally {
          await bounded(() => audio.deactivate());
        }
        const haptic = HAPTIC_FOR_LEVEL[level];
        if (haptic) await step(run, () => haptics.pattern(haptic));
      });
    },

    async stopCurrent() {
      const run = current;
      if (run) run.stopped = true;
      await Promise.all([
        bounded(() => audio.stop()),
        bounded(() => voice.stop()),
      ]);
      if (run) {
        // The run releases the session itself, once, on its way out.
        run.wake();
        await run.done;
      } else {
        await bounded(() => audio.deactivate());
      }
    },

    announce(key) {
      return enqueue(async (run) => {
        if (read(() => deps.callActive(), false)) return;
        if (!read(() => deps.voiceEnabled(), true)) return;
        try {
          await step(run, () => audio.activate(sessionForL1()));
          await step(run, () => voice.speak(t(key), { volume: VOICE_GAIN }));
        } finally {
          await bounded(() => audio.deactivate());
        }
      });
    },
  };
}
