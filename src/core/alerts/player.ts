// The alert player: turns delivered alert decisions (`policy.ts`, product spec "Driving screen")
// into sound, speech and haptics.
//
// What it decides:
// - Level mapping: each event type maps to a tone level (`ALERT_LEVEL` in policy.ts). Level 1 is
//   the soft chime; levels 2 and 3 add the short voice line when voice is on. Every level vibrates,
//   at a strength the decision carries or the level implies (`HAPTIC_INTENSITY_FOR_LEVEL`). Audio
//   first, haptic last (the visual is the HUD's, drawn from the same decision).
// - Alert style (`alertStyle`, the Alerts and sounds setting): `vibration` plays no tone and no
//   voice and never activates or ducks the audio session; `sound` never vibrates; `both` (the
//   default) does both. The voice switch still governs speech under `both` and `sound`.
// - DashPal alerts (`src/dashcam/alerts.ts`): a decision may carry its own `tone`, a `stillWanted`
//   read (dropped unstarted once the dashcam stopped the alert), `voiceAlways` (the wake line),
//   `holdSession` (the session stays active between a continuous alert's repeats), `silent`
//   (haptic only: a routed-elsewhere alert, or a phone alert during a DashPal continuous one) and
//   `startWithinMs` (a DashPal critical: an audio session not active by then, or then a tone not
//   loaded or playing by then, fails, so the dashcam's buzzer takes it at once).
// - Held sessions: a `holdSession` item leaves the session active for its kind until the next item
//   without it, `stopCurrent()`, or `release(kind)` (the host's, once a speeding alert stops
//   repeating) releases it.
// - Feedback (`feedback`): a one-off nudge that is not a decision — the level-1 tone and a
//   vibration at the strength it names, on the same rules (style, call) and never a voice.
// - Audio session: level 1 honours the silent switch only when `l1RespectsSilentSwitch()` says so;
//   the drive host always answers false, so every alert plays on the playback session and carries
//   over music and road noise. Levels 2 and 3 always play on the playback session.
// - Ducking ends with the alert: the session is deactivated after each decision's last sound, so
//   music returns to full volume instead of staying ducked for the drive.
// - Loudness: the tone files are rendered near full scale (peak 0.9). Every per-level loudness,
//   including the drop during a phone call, is a named gain below — never baked into the files.
// - No overlap: a decision arriving while another plays waits for it.
//
// What it does not decide: whether to alert. It plays only what it is handed and ignores
// suppressed decisions outright, touching no port. `deliverable()` is re-read as each queued item
// starts, so a host can drop what is already queued.
//
// Releasing at drive end: every alert releases the session, but a release can fail (iOS "session
// busy"), and expo-audio re-activates the session by itself when an interruption such as a phone
// call ends. The host therefore calls `stopCurrent()` at drive end: while idle it releases the
// session once more, through the queue, so it cannot race a decision delivered a moment later.
//
// Failure is silent: no method rejects. A failing port is reported once through `onError`, the
// remaining steps still run, and the session is still released. Each step is bounded by
// `STEP_TIMEOUT_MS`, so a port that never settles cannot wedge the queue. No timer exists while
// nothing is playing.
//
// Background: the bound is a pumped timer (`src/lib/timers.ts`). With the app in the Android
// background JS timers are paused, so the next drive row or DashPal frame releases a step that
// overran instead; nothing else in the queue waits on a JS timer.
import { processTimers, type Timers } from "@/lib/timers";

import type {
  AlertDecision,
  AlertKind,
  AlertLevel,
  AlertStyle,
  AlertTone,
  AlertVoiceKey,
  HapticIntensity,
} from "./types";

export type SessionKind = "respectSilent" | "playback";

export interface AudioPort {
  /** Activate a session that ducks others; 'respectSilent' honours the silent switch, 'playback' does not. */
  activate(kind: SessionKind): Promise<void>;
  /**
   * Resolves when the tone finishes. `tone` replaces the level's own tone (a DashPal sound).
   * `startWithinMs`: rejects when the tone has neither loaded nor started playing by then.
   */
  play(level: AlertLevel, opts: { volume: number; tone?: AlertTone; startWithinMs?: number }): Promise<void>;
  stop(): Promise<void>;
  /** Deactivate so ducked audio returns to full volume. */
  deactivate(): Promise<void>;
}

export interface VoicePort {
  /** Resolves when speech finishes. */
  speak(text: string, opts: { volume: number }): Promise<void>;
  stop(): Promise<void>;
}

export interface HapticsPort {
  /** Vibrate at the given strength; resolves when the pattern has finished. */
  pattern(intensity: HapticIntensity): Promise<void>;
}

/** A short nudge that is not an alert decision. */
export interface AlertFeedback {
  id: string;
  /** epoch ms, row clock */
  ts: number;
  intensity: HapticIntensity;
}

export interface AlertPlayerDeps {
  audio: AudioPort;
  voice: VoicePort;
  haptics: HapticsPort;
  /** The voice setting, read live per alert. */
  voiceEnabled(): boolean;
  /** The Alerts and sounds style, read live per alert. Omitted (or throwing) means `both`. */
  alertStyle?(): AlertStyle;
  /** iOS only (drive-sense `call`): tones at `TONE_GAIN_IN_CALL`, no voice. */
  callActive(): boolean;
  /** Read live, once per decision: true lets level 1 honour the silent switch; false plays it on the playback session. */
  l1RespectsSilentSwitch(): boolean;
  /**
   * Re-read as each queued decision or announcement starts; false drops it without touching a port.
   * Omitted means always deliverable; a throwing read falls back to deliverable.
   */
  deliverable?(): boolean;
  onError?(err: unknown): void;
  /**
   * An alert could not sound: its session would not activate, or its tone would not play (or never
   * finished). Called in addition to `onError`, so the host can mark the drive's alerts unavailable
   * and the HUD can say so — a visual only, so the player still never rejects. A mode refused
   * but recovered on the playback session (`fellBack`) is not a failure: the alert still sounded.
   */
  onUnavailable?(): void;
  /**
   * An alert activated and played: sound works again, so a mark left by an earlier, transient
   * failure is cleared (the mark is not sticky for the whole drive).
   */
  onAvailable?(): void;
  /** The step bound's timers. Default: the process's pumped timers. */
  timers?: Timers;
}

export interface AlertPlayer {
  /** Audio first, then haptic; never rejects; deactivates after the last sound. */
  deliver(decision: AlertDecision): Promise<void>;
  /**
   * Long-press mute: silences the alert sounding now. One already waiting behind it still plays.
   * While idle it releases the audio session once more, through the queue — the host's drive-end
   * release. When an item is queued but not started, that item releases instead, and pays the
   * release on exit even if it plays nothing.
   */
  stopCurrent(): Promise<void>;
  /** A spoken announcement. Spoken on level 1's session rule; silent with voice off, on a call, or vibration-only. */
  announce(key: AlertVoiceKey): Promise<void>;
  /**
   * One short nudge — the level-1 tone and a vibration at `intensity`, no voice. Same queue, style
   * and call rules as `deliver`. Optional so silent stand-ins
   * and test doubles need not implement it; the host calls it only when present.
   */
  feedback?(feedback: AlertFeedback): Promise<void>;
  /**
   * Release the audio session a `holdSession` decision of `kind` left held (a speeding alert's
   * repeats), through the queue, so it also covers one playing or queued now: nothing is cut, and a
   * session held by another kind, or already released, is left alone. Optional like `feedback`; the
   * host calls it only when present.
   */
  release?(kind: AlertKind): Promise<void>;
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

/** Tone gain per level during a phone call (tones only, reduced volume). */
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

/**
 * How hard an alert vibrates when its decision carries no strength of its own: a nudge is one
 * pulse, a warning two, an urgent alert the heaviest pattern.
 */
export const HAPTIC_INTENSITY_FOR_LEVEL: Readonly<Record<AlertLevel, HapticIntensity>> = {
  1: 1,
  2: 2,
  3: 4,
};

const STYLES: readonly AlertStyle[] = ["both", "vibration", "sound"];

/** A stored or injected value that is not a style reads as the default, `both`. */
export function asAlertStyle(value: unknown): AlertStyle {
  return STYLES.includes(value as AlertStyle) ? (value as AlertStyle) : "both";
}

/** What one queued item plays: a decision's sound and pulse, or a feedback's. */
interface Playable {
  level: AlertLevel;
  /** The decision's kind (none for a feedback): who holds the session after a `holdSession` item. */
  kind?: AlertKind;
  /** Spoken (L2 and up, voice on — or `voiceAlways` — and no call) when present. */
  voice?: AlertVoiceKey;
  intensity: HapticIntensity;
  tone?: AlertTone;
  stillWanted?: () => boolean;
  voiceAlways?: boolean;
  holdSession?: boolean;
  silent?: boolean;
  startWithinMs?: number;
}

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
  const timers = deps.timers ?? processTimers;
  let queue: Promise<void> = Promise.resolve();
  let current: Run | null = null;
  /** Items enqueued whose task has not yet finished. */
  let pending = 0;
  /**
   * An idle `stopCurrent` deferred its release to a queued item. Cleared by any release;
   * an item that exits without releasing (dropped, or an announcement it skipped) pays it on exit.
   */
  let releaseOwed = false;
  /** The kind whose `holdSession` item left the session active, or null when it is released. */
  let heldBy: AlertKind | null = null;

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
  async function bounded(fn: () => Promise<void>, run?: Run, timeoutMs: number = STEP_TIMEOUT_MS): Promise<boolean> {
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = timers.setTimeout(
        () => reject(new Error("alert player: step timed out")),
        timeoutMs,
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
      timers.clearTimeout(timer);
    }
  }

  async function step(run: Run, fn: () => Promise<void>, timeoutMs?: number): Promise<boolean> {
    if (run.stopped) return true;
    return bounded(fn, run, timeoutMs);
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
    heldBy = null;
    await bounded(() => audio.deactivate());
  }

  function releaseViaQueue(): Promise<void> {
    return enqueue(releaseSession);
  }

  function style(): AlertStyle {
    const fn = deps.alertStyle;
    return fn ? asAlertStyle(read(() => fn.call(deps), "both")) : "both";
  }

  /**
   * One item on the queue: tone, then voice, then the session release (unless the style is
   * vibration-only, when the audio session is never touched), then the pulse (unless sound-only).
   */
  async function play(run: Run, item: Playable): Promise<void> {
    if (!deliverable()) return;
    const wanted = item.stillWanted;
    if (wanted && !read(wanted, true)) return;
    const chosen = style();
    const { level } = item;
    if (chosen !== "vibration" && !item.silent) {
      let hold = false;
      try {
        const onCall = read(() => deps.callActive(), false);
        const kind: SessionKind = level === 1 ? sessionForL1() : "playback";
        // An item that must start at once (a DashPal critical) gives the activation the same short
        // bound as the tone's start, and a failed or slow activation fails it there and then (the
        // dashcam's buzzer takes it), so it never waits out the 5 s step bound in silence.
        const startWithin = item.startWithinMs;
        const activated = await step(run, () => audio.activate(kind), startWithin);
        if (!activated && startWithin !== undefined) {
          unavailable();
        } else {
          const volume = (onCall ? TONE_GAIN_IN_CALL : TONE_GAIN)[level];
          const opts: { volume: number; tone?: AlertTone; startWithinMs?: number } = { volume };
          if (item.tone) opts.tone = item.tone;
          if (startWithin !== undefined) opts.startWithinMs = startWithin;
          const played = await step(run, () => audio.play(level, opts));
          // Silent for the driver, and they must be able to see that; a sound that worked
          // clears an earlier mark.
          if (!activated || !played) unavailable();
          else if (!run.stopped) available();
          const key = item.voice;
          if (
            level >= 2 &&
            key &&
            !onCall &&
            (item.voiceAlways === true || read(() => deps.voiceEnabled(), true))
          ) {
            await step(run, () => voice.speak(key, { volume: VOICE_GAIN }));
          }
        }
        // A continuous DashPal alert keeps the session (and the ducking) between repeats; a stop
        // releases it.
        hold = item.holdSession === true && activated && !run.stopped;
      } finally {
        if (!hold) await releaseSession();
        else heldBy = item.kind ?? null;
      }
    }
    if (chosen !== "sound") {
      await step(run, () => haptics.pattern(item.intensity));
    }
  }

  return {
    deliver(decision) {
      if (decision.suppressed || !isLevel(decision.level))
        return Promise.resolve();
      const level = decision.level;
      const item: Playable = {
        level,
        kind: decision.kind,
        intensity: decision.intensity ?? HAPTIC_INTENSITY_FOR_LEVEL[level],
      };
      if (decision.voice !== undefined) item.voice = decision.voice;
      if (decision.tone !== undefined) item.tone = decision.tone;
      if (decision.stillWanted !== undefined) item.stillWanted = decision.stillWanted;
      if (decision.voiceAlways) item.voiceAlways = true;
      if (decision.holdSession) item.holdSession = true;
      if (decision.silent) item.silent = true;
      const within = decision.startWithinMs;
      if (within !== undefined && Number.isFinite(within) && within > 0) item.startWithinMs = within;
      return enqueue((run) => play(run, item));
    },

    feedback(feedback) {
      return enqueue((run) =>
        play(run, { level: 1, intensity: feedback.intensity }),
      );
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
        // Through the queue, so it cannot race a decision delivered a moment later.
        await releaseViaQueue();
      } else {
        // An item is queued but not yet started. It releases on its way out — and if it exits
        // without playing (dropped, or a skipped announcement), it pays the owed release.
        releaseOwed = true;
      }
    },

    release(kind) {
      // Through the queue, so an item of `kind` playing or queued now (that will hold) is released too.
      return enqueue(async () => {
        if (heldBy === kind) await releaseSession();
      });
    },

    announce(key) {
      return enqueue(async (run) => {
        if (!deliverable()) return;
        if (read(() => deps.callActive(), false)) return;
        if (!read(() => deps.voiceEnabled(), true)) return;
        // Vibration-only: nothing is spoken, and the audio session stays untouched.
        if (style() === "vibration") return;
        try {
          await step(run, () => audio.activate(sessionForL1()));
          await step(run, () => voice.speak(key, { volume: VOICE_GAIN }));
        } finally {
          await releaseSession();
        }
      });
    },
  };
}
