// The alert player: turns the arbiter's delivered decisions into sound, speech and haptics
// (product spec §8.8 "Receiving a warning", §13.4 alert policy).
//
// What it decides:
// - Level mapping: L1 is a tone only; L2 is tone, voice (when enabled) and a double pulse; L3 is
//   tone, voice and the long pattern. Audio first, haptic last (§8.8 step 4 — the visual is the
//   HUD's, drawn by the host from the same decision).
// - Audio session per level (R14, as amended by ruling P2-I1): L1 honours the silent switch only
//   when the host says the trip is mounted AND RoadWise is frontmost (`AppState.currentState ===
//   'active'`). iOS silences silent-switch-respecting categories whenever the app is not frontmost —
//   on screen lock, and also with the screen on behind a navigation app — so any other L1 (the only
//   level in the learning period) plays on the playback session instead. L2 and L3 always play on
//   the playback session.
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
// port — so a passenger drive cannot sound even if its decisions reach the player. A decision
// already queued when the driver switches to passenger is dropped too: `deliverable()` is re-read
// as each queued item starts (review P2-M4).
//
// Releasing at drive end (review P2-M2): every alert releases the session, but a release can fail
// (iOS "session busy"), and expo-audio re-activates the session by itself when an interruption such
// as a phone call ends. The host therefore calls `stopCurrent()` at drive close (H1 does, in
// `afterClose`) and may call it when a phone call ends while no alert plays: while idle it releases
// the session once more, through the queue, so it cannot race a decision delivered a moment later.
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
  /**
   * R14 as amended (P2-I1): true only when the trip is mounted AND `AppState.currentState ===
   * 'active'` (RoadWise frontmost, so the screen is on and unlocked and the HUD visible). Read live,
   * once per decision. Otherwise L1 plays on the playback session.
   */
  l1RespectsSilentSwitch(): boolean;
  /**
   * Re-read as each queued decision or announcement starts; false drops it without touching a port.
   * H1 wires it to "not a passenger" so a decision queued at the moment of a role switch stays
   * silent (§8.15). Omitted means always deliverable; a throwing read falls back to deliverable.
   */
  deliverable?(): boolean;
  onError?(err: unknown): void;
  /**
   * An alert could not sound: its session would not activate, or its tone would not play (or never
   * finished). Called in addition to `onError`, so the host can mark the drive's alerts unavailable
   * and the HUD can say so (final review I2) — a visual only, so SR9 still holds. A mode refused
   * but recovered on the playback session (`fellBack`) is not a failure: the alert still sounded.
   */
  onUnavailable?(): void;
  /**
   * An alert activated and played: sound works again, so a mark left by an earlier, transient
   * failure is cleared (final re-review n2 — the mark is not sticky for the whole drive).
   */
  onAvailable?(): void;
}

export interface AlertPlayer {
  /** Audio first, then haptic (§8.8); never rejects (SR9); deactivates after the last sound. */
  deliver(decision: AlertDecision): Promise<void>;
  /**
   * Long-press mute: silences the alert sounding now. One already waiting behind it still plays.
   * While idle it releases the audio session once more, through the queue (P2-M1) — the host's
   * drive-end release (P2-M2). When an item is queued but not started, that item releases instead,
   * and pays the release on exit even if it plays nothing (P2-N1).
   */
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

/** An activation whose mode was refused but which then played on the playback session. */
function isFellBack(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { fellBack?: unknown }).fellBack === true;
}

function isLevel(level: unknown): level is AlertLevel {
  return level === 1 || level === 2 || level === 3;
}

export function createAlertPlayer(deps: AlertPlayerDeps): AlertPlayer {
  const { audio, voice, haptics } = deps;
  let queue: Promise<void> = Promise.resolve();
  let current: Run | null = null;
  /** Items enqueued whose task has not yet finished. */
  let pending = 0;
  /**
   * An idle `stopCurrent` deferred its release to a queued item (P2-N1). Cleared by any release;
   * an item that exits without releasing (dropped, or an announcement it skipped) pays it on exit.
   */
  let releaseOwed = false;

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

  function unavailable(): void {
    try {
      deps.onUnavailable?.();
    } catch (err) {
      report(err);
    }
  }

  function available(): void {
    try {
      deps.onAvailable?.();
    } catch (err) {
      report(err);
    }
  }

  /**
   * Runs `fn` bounded by the step timeout (and, when given, a run's stop). Never rejects. Resolves
   * false when the step failed (a rejection or a timeout), true otherwise — a step the driver
   * stopped, or an activation that fell back to the audible playback session, is not a failure.
   */
  async function bounded(fn: () => Promise<void>, run?: Run): Promise<boolean> {
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
      return true;
    } catch (err) {
      // A port rejecting because the driver just stopped it is not a failure.
      if (run?.stopped) return true;
      report(err);
      return isFellBack(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function step(run: Run, fn: () => Promise<void>): Promise<boolean> {
    if (run.stopped) return true;
    return bounded(fn, run);
  }

  function enqueue(task: (run: Run) => Promise<void>): Promise<void> {
    pending += 1;
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
        if (releaseOwed) await releaseSession();
        if (current === run) current = null;
        pending -= 1;
        finish();
      }
    });
    queue = next;
    return next;
  }

  function deliverable(): boolean {
    const fn = deps.deliverable;
    return fn ? read(() => fn.call(deps), true) : true;
  }

  function sessionForL1(): SessionKind {
    return read(() => deps.l1RespectsSilentSwitch(), false)
      ? "respectSilent"
      : "playback";
  }

  /** Every release goes through here, so it settles a release an idle stopCurrent left owed. */
  async function releaseSession(): Promise<void> {
    releaseOwed = false;
    await bounded(() => audio.deactivate());
  }

  function releaseViaQueue(): Promise<void> {
    return enqueue(releaseSession);
  }

  return {
    deliver(decision) {
      if (decision.suppressed || !isLevel(decision.level))
        return Promise.resolve();
      const level = decision.level;
      return enqueue(async (run) => {
        if (!deliverable()) return;
        try {
          const onCall = read(() => deps.callActive(), false);
          const kind: SessionKind = level === 1 ? sessionForL1() : "playback";
          const activated = await step(run, () => audio.activate(kind));
          const volume = (onCall ? TONE_GAIN_IN_CALL : TONE_GAIN)[level];
          const played = await step(run, () => audio.play(level, { volume }));
          // Silent for the driver, and they must be able to see that (I2); a sound that worked
          // clears an earlier mark (n2).
          if (!activated || !played) unavailable();
          else if (!run.stopped) available();
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
          await releaseSession();
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
      } else if (pending === 0) {
        // Through the queue, so it cannot race a decision delivered a moment later (P2-M1).
        await releaseViaQueue();
      } else {
        // An item is queued but not yet started. It releases on its way out — and if it exits
        // without playing (dropped, or a skipped announcement), it pays the owed release (P2-N1).
        releaseOwed = true;
      }
    },

    announce(key) {
      return enqueue(async (run) => {
        if (!deliverable()) return;
        if (read(() => deps.callActive(), false)) return;
        if (!read(() => deps.voiceEnabled(), true)) return;
        try {
          await step(run, () => audio.activate(sessionForL1()));
          await step(run, () => voice.speak(t(key), { volume: VOICE_GAIN }));
        } finally {
          await releaseSession();
        }
      });
    },
  };
}
