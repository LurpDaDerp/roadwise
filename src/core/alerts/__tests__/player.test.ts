import { t } from "@/i18n";

import {
  createAlertPlayer,
  STEP_TIMEOUT_MS,
  TONE_GAIN,
  TONE_GAIN_IN_CALL,
  VOICE_GAIN,
  type AlertPlayerDeps,
  type AudioPort,
  type HapticsPort,
  type SessionKind,
  type VoicePort,
} from "../player";
import type { AlertDecision, AlertLevel } from "../types";

type Call = string;

interface Rig {
  deps: AlertPlayerDeps;
  calls: Call[];
  errors: unknown[];
  flags: { voice: boolean; call: boolean; l1Silent: boolean };
  /** Resolves the tone currently held by `holdPlay`. */
  release: () => void;
}

function rig(
  overrides: {
    audio?: Partial<AudioPort>;
    voice?: Partial<VoicePort>;
    haptics?: Partial<HapticsPort>;
    holdPlay?: boolean;
  } = {},
): Rig {
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const flags = { voice: true, call: false, l1Silent: false };
  let pendingPlay: (() => void) | null = null;

  const audio: AudioPort = {
    activate: async (kind: SessionKind) => {
      calls.push(`activate:${kind}`);
    },
    play: (level: AlertLevel, opts) => {
      calls.push(`play:${level}@${opts.volume}`);
      if (!overrides.holdPlay) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pendingPlay = resolve;
      });
    },
    stop: async () => {
      calls.push("audio.stop");
      pendingPlay?.();
      pendingPlay = null;
    },
    deactivate: async () => {
      calls.push("deactivate");
    },
    ...overrides.audio,
  };
  const voice: VoicePort = {
    speak: async (text, opts) => {
      calls.push(`speak:${text}@${opts.volume}`);
    },
    stop: async () => {
      calls.push("voice.stop");
    },
    ...overrides.voice,
  };
  const haptics: HapticsPort = {
    pattern: async (kind) => {
      calls.push(`haptic:${kind}`);
    },
    ...overrides.haptics,
  };

  return {
    calls,
    errors,
    flags,
    release: () => {
      pendingPlay?.();
      pendingPlay = null;
    },
    deps: {
      audio,
      voice,
      haptics,
      voiceEnabled: () => flags.voice,
      callActive: () => flags.call,
      l1RespectsSilentSwitch: () => flags.l1Silent,
      onError: (err) => errors.push(err),
    },
  };
}

function decision(
  level: AlertLevel,
  extra: Partial<AlertDecision> = {},
): AlertDecision {
  return {
    id: `d${level}`,
    level,
    kind: level === 1 ? "speeding" : level === 2 ? "phone" : "drowsy",
    ts: 1_700_000_000_000,
    voice:
      level === 1
        ? "alert.easeOff"
        : level === 2
          ? "alert.phoneDown"
          : "alert.drowsy",
    ...extra,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const count = (calls: Call[], what: Call) =>
  calls.filter((c) => c === what).length;

describe("alert player", () => {
  describe("call order per level (audio first, then haptic; §8.8)", () => {
    it("L1 is a tone only, on the playback session when the silent switch does not apply", async () => {
      const r = rig();
      await createAlertPlayer(r.deps).deliver(decision(1));
      expect(r.calls).toEqual([
        "activate:playback",
        `play:1@${TONE_GAIN[1]}`,
        "deactivate",
      ]);
    });

    it("L2 is tone, voice, release, then a double pulse", async () => {
      const r = rig();
      await createAlertPlayer(r.deps).deliver(decision(2));
      expect(r.calls).toEqual([
        "activate:playback",
        `play:2@${TONE_GAIN[2]}`,
        `speak:${t("alert.phoneDown")}@${VOICE_GAIN}`,
        "deactivate",
        "haptic:double",
      ]);
    });

    it("L3 is tone, voice, release, then the long pattern", async () => {
      const r = rig();
      await createAlertPlayer(r.deps).deliver(decision(3));
      expect(r.calls).toEqual([
        "activate:playback",
        `play:3@${TONE_GAIN[3]}`,
        `speak:${t("alert.drowsy")}@${VOICE_GAIN}`,
        "deactivate",
        "haptic:long",
      ]);
    });

    it("an L2 without a voice key still sounds its tone and pulse", async () => {
      const r = rig();
      await createAlertPlayer(r.deps).deliver(
        decision(2, { voice: undefined }),
      );
      expect(r.calls).toEqual([
        "activate:playback",
        `play:2@${TONE_GAIN[2]}`,
        "deactivate",
        "haptic:double",
      ]);
    });
  });

  describe("session kind (R14)", () => {
    it("L1 respects the silent switch only when the host says the trip is mounted with the screen on", async () => {
      const r = rig();
      r.flags.l1Silent = true;
      const player = createAlertPlayer(r.deps);
      await player.deliver(decision(1));
      r.flags.l1Silent = false;
      await player.deliver(decision(1, { id: "again" }));
      expect(r.calls.filter((c) => c.startsWith("activate"))).toEqual([
        "activate:respectSilent",
        "activate:playback",
      ]);
    });

    it("L2 and L3 always use the playback session, whatever the L1 rule says", async () => {
      const r = rig();
      r.flags.l1Silent = true;
      const player = createAlertPlayer(r.deps);
      await player.deliver(decision(2));
      await player.deliver(decision(3));
      expect(r.calls.filter((c) => c.startsWith("activate"))).toEqual([
        "activate:playback",
        "activate:playback",
      ]);
    });
  });

  it("voice off: tones and haptics only", async () => {
    const r = rig();
    r.flags.voice = false;
    const player = createAlertPlayer(r.deps);
    await player.deliver(decision(2));
    await player.deliver(decision(3));
    expect(r.calls.some((c) => c.startsWith("speak"))).toBe(false);
    expect(r.calls).toContain("haptic:double");
    expect(r.calls).toContain("haptic:long");
  });

  it("call active: tones at the in-call gain, no voice, haptics kept", async () => {
    const r = rig();
    r.flags.call = true;
    const player = createAlertPlayer(r.deps);
    await player.deliver(decision(1));
    await player.deliver(decision(2));
    await player.deliver(decision(3));
    expect(r.calls.filter((c) => c.startsWith("play"))).toEqual([
      `play:1@${TONE_GAIN_IN_CALL[1]}`,
      `play:2@${TONE_GAIN_IN_CALL[2]}`,
      `play:3@${TONE_GAIN_IN_CALL[3]}`,
    ]);
    expect(r.calls.some((c) => c.startsWith("speak"))).toBe(false);
    expect(r.calls).toContain("haptic:long");
  });

  describe("gains (tone files are full scale; loudness lives here)", () => {
    it("every level has a gain in (0, 1], and the in-call gain is quieter", () => {
      for (const level of [1, 2, 3] as const) {
        expect(TONE_GAIN[level]).toBeGreaterThan(0);
        expect(TONE_GAIN[level]).toBeLessThanOrEqual(1);
        expect(TONE_GAIN_IN_CALL[level]).toBeGreaterThan(0);
        expect(TONE_GAIN_IN_CALL[level]).toBeLessThan(TONE_GAIN[level]);
      }
      expect(TONE_GAIN_IN_CALL).toEqual({ 1: 0.5, 2: 0.5, 3: 0.5 });
    });
  });

  describe("releasing the session so music un-ducks (I9)", () => {
    it("deactivates exactly once after the last sound of each decision", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      await player.deliver(decision(1));
      expect(count(r.calls, "deactivate")).toBe(1);
      await player.deliver(decision(2));
      expect(count(r.calls, "deactivate")).toBe(2);
      await player.deliver(decision(3));
      expect(count(r.calls, "deactivate")).toBe(3);
    });

    it("stopCurrent stops tone and voice, skips the rest of that alert, and deactivates once", async () => {
      const r = rig({ holdPlay: true });
      const player = createAlertPlayer(r.deps);
      const delivering = player.deliver(decision(2));
      await flush();
      expect(r.calls).toContain(`play:2@${TONE_GAIN[2]}`);
      await player.stopCurrent();
      await delivering;
      expect(r.calls).toContain("audio.stop");
      expect(r.calls).toContain("voice.stop");
      expect(r.calls.some((c) => c.startsWith("speak"))).toBe(false);
      expect(r.calls.some((c) => c.startsWith("haptic"))).toBe(false);
      expect(count(r.calls, "deactivate")).toBe(1);
    });

    it("stopCurrent while idle still stops and releases the session", async () => {
      const r = rig();
      await createAlertPlayer(r.deps).stopCurrent();
      expect(r.calls).toEqual(["audio.stop", "voice.stop", "deactivate"]);
    });

    it("stopCurrent silences only the alert sounding now; one already waiting still plays", async () => {
      const r = rig({ holdPlay: true });
      const player = createAlertPlayer(r.deps);
      const first = player.deliver(decision(2));
      const second = player.deliver(decision(1, { id: "next" }));
      await flush();
      await player.stopCurrent();
      await first;
      r.release();
      // the queued L1 now plays; release its held tone once it starts
      await flush();
      r.release();
      await second;
      expect(r.calls.filter((c) => c.startsWith("play"))).toEqual([
        `play:2@${TONE_GAIN[2]}`,
        `play:1@${TONE_GAIN[1]}`,
      ]);
      expect(count(r.calls, "deactivate")).toBe(2);
    });
  });

  describe("no overlap", () => {
    it("a second decision waits for the first to finish", async () => {
      const r = rig({ holdPlay: true });
      const player = createAlertPlayer(r.deps);
      const first = player.deliver(decision(3));
      const second = player.deliver(decision(1, { id: "l1" }));
      await flush();
      expect(r.calls).toEqual(["activate:playback", `play:3@${TONE_GAIN[3]}`]);
      r.release();
      await first;
      await flush();
      r.release();
      await second;
      const firstDeactivate = r.calls.indexOf("deactivate");
      const secondActivate = r.calls.lastIndexOf("activate:playback");
      expect(firstDeactivate).toBeGreaterThan(-1);
      expect(secondActivate).toBeGreaterThan(firstDeactivate);
      expect(r.calls.indexOf("haptic:long")).toBeLessThan(secondActivate);
    });
  });

  describe("fails silently (SR9)", () => {
    it("a rejecting tone: deliver resolves, onError once, voice and haptic still go, session released", async () => {
      const boom = new Error("tone failed");
      const r = rig({ audio: { play: () => Promise.reject(boom) } });
      await expect(
        createAlertPlayer(r.deps).deliver(decision(2)),
      ).resolves.toBeUndefined();
      expect(r.errors).toEqual([boom]);
      expect(r.calls).toEqual([
        "activate:playback",
        `speak:${t("alert.phoneDown")}@${VOICE_GAIN}`,
        "deactivate",
        "haptic:double",
      ]);
    });

    it("a rejecting activate still tries the tone and still releases", async () => {
      const r = rig({
        audio: { activate: () => Promise.reject(new Error("session")) },
      });
      await createAlertPlayer(r.deps).deliver(decision(1));
      expect(r.errors).toHaveLength(1);
      expect(r.calls).toEqual([`play:1@${TONE_GAIN[1]}`, "deactivate"]);
    });

    it("a rejecting voice, haptic or deactivate each report once and never reject", async () => {
      for (const broken of ["voice", "haptics", "deactivate"] as const) {
        const fail = () => Promise.reject(new Error(broken));
        const r = rig(
          broken === "voice"
            ? { voice: { speak: fail } }
            : broken === "haptics"
              ? { haptics: { pattern: fail } }
              : { audio: { deactivate: fail } },
        );
        const player = createAlertPlayer(r.deps);
        await expect(player.deliver(decision(3))).resolves.toBeUndefined();
        expect(r.errors).toHaveLength(1);
        // and the player is still usable afterwards
        await expect(
          player.deliver(decision(1, { id: "after" })),
        ).resolves.toBeUndefined();
      }
    });

    it("a throwing setting read is reported and the alert still sounds", async () => {
      const r = rig();
      r.deps.voiceEnabled = () => {
        throw new Error("settings");
      };
      await createAlertPlayer(r.deps).deliver(decision(2));
      expect(r.errors).toHaveLength(1);
      expect(r.calls).toContain(`play:2@${TONE_GAIN[2]}`);
      expect(r.calls).toContain("deactivate");
    });

    it("a port that never settles cannot wedge the queue", async () => {
      jest.useFakeTimers();
      try {
        const r = rig({ audio: { play: () => new Promise<void>(() => {}) } });
        const player = createAlertPlayer(r.deps);
        const first = player.deliver(decision(1));
        const second = player.deliver(decision(1, { id: "next" }));
        await jest.advanceTimersByTimeAsync(STEP_TIMEOUT_MS * 2 + 10);
        await first;
        await second;
        expect(count(r.calls, "deactivate")).toBe(2);
        expect(r.errors).toHaveLength(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it("works with no onError supplied", async () => {
      const r = rig({ audio: { play: () => Promise.reject(new Error("x")) } });
      delete r.deps.onError;
      await expect(
        createAlertPlayer(r.deps).deliver(decision(1)),
      ).resolves.toBeUndefined();
    });
  });

  describe("nothing sounds for an undelivered decision (passenger, muted, over budget)", () => {
    it("a suppressed decision touches no port", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      for (const level of [1, 2, 3] as const) {
        await player.deliver(decision(level, { suppressed: true }));
      }
      expect(r.calls).toEqual([]);
    });

    it("an out-of-range level touches no port", async () => {
      const r = rig();
      await createAlertPlayer(r.deps).deliver({
        ...decision(1),
        level: 4 as AlertLevel,
      });
      expect(r.calls).toEqual([]);
    });
  });

  describe('announce ("Recording" at drive start, §8.4)', () => {
    it("speaks the phrase on the L1 session rule and releases", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      await player.announce("alert.recording");
      r.flags.l1Silent = true;
      await player.announce("alert.recording");
      expect(r.calls).toEqual([
        "activate:playback",
        `speak:${t("alert.recording")}@${VOICE_GAIN}`,
        "deactivate",
        "activate:respectSilent",
        `speak:${t("alert.recording")}@${VOICE_GAIN}`,
        "deactivate",
      ]);
    });

    it("stays silent with voice off or on a call", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      r.flags.voice = false;
      await player.announce("alert.recording");
      r.flags.voice = true;
      r.flags.call = true;
      await player.announce("alert.recording");
      expect(r.calls).toEqual([]);
    });

    it("a failing voice is reported, never thrown, and the session is released", async () => {
      const r = rig({
        voice: { speak: () => Promise.reject(new Error("tts")) },
      });
      await expect(
        createAlertPlayer(r.deps).announce("alert.recording"),
      ).resolves.toBeUndefined();
      expect(r.errors).toHaveLength(1);
      expect(r.calls).toEqual(["activate:playback", "deactivate"]);
    });
  });
});
