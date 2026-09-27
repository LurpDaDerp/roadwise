// The camera's alerts, through the app's existing alert ports (expo-audio tones, expo-speech, expo-haptics:
// `createExpoAlertPorts`), mapped from the DMS controller's `DmsAlertCommand`s (src/core/dms/README.md "Alerts"):
//
// - the tone is the tier's (the M3 player's L1–L3 tones); the voice line is the kind's (`cameraVoice`), spoken once at
//   the start when voice is on (the Alerts & sounds switch) and no call is active (then tones only, at half gain);
// - Tier 3 (`microsleep`, `sleep`, `unresponsive`, `microsleep_nod`) sounds continuously until `stop`, louder every 2 s
//   (0.6 → 1.0), with the long haptic; Tier 2 (`distraction`, `cumulative`, `eyes_on_road`) repeats every 1 s until
//   `stop`, with the double haptic; `once` is a single tone and phrase;
// - a `start` replaces whatever the camera was sounding; a `once` while a repeating alert sounds is dropped (the
//   repeating one is the more urgent); a muted command (shadow mode) touches nothing;
// - a repeating alert is capped at MAX_REPEAT_MS even without its `stop` (the controller always sends one; the cap is
//   a backstop against a lost command), and `stopAll` (drive end, gate close, dispose) silences at once.
// Failure is silent: a port that throws or never settles (bounded by STEP_TIMEOUT_MS) is reported once per alert and
// the rest still runs; nothing here rejects.
import type { AudioPort, HapticsPort, VoicePort } from '@/core/alerts/player';
import type { DmsAlertCommand } from '@/core/dms';

import { cameraVoice } from './copy';

export const STEP_TIMEOUT_MS = 5000;
export const TIER2_REPEAT_MS = 1000;
export const TIER3_RAMP_EVERY_MS = 2000;
export const TIER3_GAIN_START = 0.6;
export const TIER3_GAIN_STEP = 0.2;
export const CALL_GAIN = 0.5;
export const MAX_REPEAT_MS = 120_000;

export interface DmsAlertSinkDeps {
  audio: AudioPort;
  voice: VoicePort;
  haptics: HapticsPort;
  voiceEnabled(): boolean;
  callActive(): boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  onError?: (e: unknown) => void;
}

export interface DmsAlertSink {
  handle(cmd: DmsAlertCommand): void;
  stopAll(): Promise<void>;
  /** resolves once nothing is sounding (tests) */
  idle(): Promise<void>;
}

interface Run {
  cmd: DmsAlertCommand;
  cancelled: boolean;
  done: Promise<void>;
}

export function createDmsAlertSink(deps: DmsAlertSinkDeps): DmsAlertSink {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let current: Run | null = null;
  let onceChain: Promise<void> = Promise.resolve();
  /** every repeating alert still winding down (a cancelled one releases the session after its last step) */
  const running = new Set<Promise<void>>();

  async function step(what: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        what(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STEP_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      try {
        deps.onError?.(e);
      } catch {
        // nobody left to tell
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  const inCall = (): boolean => {
    try {
      return deps.callActive();
    } catch {
      return false;
    }
  };
  const speaks = (): boolean => {
    try {
      return deps.voiceEnabled() && !inCall();
    } catch {
      return true;
    }
  };

  async function sound(cmd: DmsAlertCommand, run: Run | null): Promise<void> {
    await step(() => deps.audio.activate('playback'));
    const t0 = now();
    let first = true;
    for (;;) {
      if (run?.cancelled) break;
      const elapsed = now() - t0;
      const ramp = cmd.tier === 3 ? Math.min(1, TIER3_GAIN_START + TIER3_GAIN_STEP * Math.floor(elapsed / TIER3_RAMP_EVERY_MS)) : 1;
      await step(() => deps.audio.play(cmd.tier, { volume: ramp * (inCall() ? CALL_GAIN : 1) }));
      if (run?.cancelled) break;
      if (first) {
        first = false;
        if (cmd.tier >= 2) void step(() => deps.haptics.pattern(cmd.tier === 3 ? 'long' : 'double'));
        if (speaks()) await step(() => deps.voice.speak(cameraVoice[cmd.kind], { volume: 1 }));
      }
      if (run === null || run.cancelled || now() - t0 >= MAX_REPEAT_MS) break;
      if (cmd.tier === 2) await wait(TIER2_REPEAT_MS);
    }
    await step(() => deps.audio.stop());
    await step(() => deps.audio.deactivate());
  }

  async function cancel(): Promise<void> {
    const run = current;
    if (run === null) return;
    run.cancelled = true;
    current = null;
    await Promise.all([step(() => deps.audio.stop()), step(() => deps.voice.stop())]);
    await run.done;
  }

  return {
    handle(cmd) {
      if (cmd.muted) return;
      if (cmd.action === 'stop') {
        if (current !== null && current.cmd.kind === cmd.kind) void cancel();
        return;
      }
      if (cmd.action === 'once') {
        if (current !== null) return;
        onceChain = onceChain.then(() => sound(cmd, null));
        return;
      }
      const previous = current;
      const run: Run = { cmd, cancelled: false, done: Promise.resolve() };
      current = run;
      run.done = (async () => {
        if (previous !== null) {
          previous.cancelled = true;
          await previous.done;
        }
        await onceChain;
        await sound(cmd, run);
        if (current === run) current = null;
      })();
      running.add(run.done);
      void run.done.then(() => running.delete(run.done));
    },
    async stopAll() {
      await cancel();
      await onceChain;
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
      await onceChain;
    },
  };
}
