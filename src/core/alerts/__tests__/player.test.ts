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
  flags: {
    voice: boolean;
    call: boolean;
    l1Silent: boolean;
    deliverable: boolean;
  };
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
  const flags = {
    voice: true,
    call: false,
    l1Silent: false,
    deliverable: true,
  };
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
      deliverable: () => flags.deliverable,
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
    it("L1 respects the silent switch only when the host says the trip is mounted and RoadWise is frontmost (R14 as amended, P2-I1)", async () => {
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

  describe("a release deferred to a queued item is never lost (P2-N1)", () => {
    // The sequence the re-review names: a call ends (expo-audio re-activates the session), the
    // host calls stopCurrent while an item is queued but not started, and that item then exits
    // without playing. The session must still be released exactly once.
    it("call ends → stopCurrent → the queued decision is dropped by deliverable(): released once", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      r.flags.deliverable = false;
      // Several decisions queued at the role switch, so they are still queued when stopCurrent
      // decides whether to release itself or leave it to them.
      const delivering = [1, 2, 3].map((n) =>
        player.deliver(decision(1, { id: `q${n}` })),
      );
      const stopping = player.stopCurrent();
      await Promise.all([...delivering, stopping]);
      expect(r.calls.some((c) => c.startsWith("play"))).toBe(false);
      expect(count(r.calls, "deactivate")).toBe(1);
    });

    it("call ends → stopCurrent → the queued announcement is skipped (voice off, or on a call): released once", async () => {
      for (const skip of ["voiceOff", "onCall"] as const) {
        const r = rig();
        const player = createAlertPlayer(r.deps);
        if (skip === "voiceOff") r.flags.voice = false;
        else r.flags.call = true;
        const announcing = [1, 2, 3].map(() =>
          player.announce("alert.recording"),
        );
        const stopping = player.stopCurrent();
        await Promise.all([...announcing, stopping]);
        expect(r.calls.some((c) => c.startsWith("speak"))).toBe(false);
        expect(count(r.calls, "deactivate")).toBe(1);
      }
    });

    it("an owed release is paid once, not again by a later item that plays", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      r.flags.deliverable = false;
      const dropped = [1, 2, 3].map((n) =>
        player.deliver(decision(1, { id: `q${n}` })),
      );
      const stopping = player.stopCurrent();
      await Promise.all([...dropped, stopping]);
      r.flags.deliverable = true;
      await player.deliver(decision(2));
      // one for the owed release, one for the L2 itself
      expect(count(r.calls, "deactivate")).toBe(2);
    });
  });

  describe("an idle long press cannot race the next alert (P2-M1)", () => {
    it("a long press just after a decision is delivered leaves the release to that decision", async () => {
      const r = rig();
      const player = createAlertPlayer(r.deps);
      const delivering = player.deliver(decision(1));
      const stopping = player.stopCurrent();
      await Promise.all([delivering, stopping]);
      expect(count(r.calls, "deactivate")).toBe(1);
      expect(r.calls.indexOf("deactivate")).toBeGreaterThan(
        r.calls.indexOf(`play:1@${TONE_GAIN[1]}`),
      );
    });

    it("an idle release runs through the queue, ahead of a decision delivered a moment later", async () => {
      let finishRelease!: () => void;
      const r = rig({
        audio: {
          deactivate: () =>
            new Promise<void>((resolve) => {
              r.calls.push("deactivate");
              finishRelease = resolve;
            }),
        },
      });
      const player = createAlertPlayer(r.deps);
      const stopping = player.stopCurrent();
      await flush();
      const delivering = player.deliver(decision(1));
      await flush();
      // the decision waits for the release in flight
      expect(r.calls).toEqual(["audio.stop", "voice.stop", "deactivate"]);
      finishRelease();
      await stopping;
      await flush();
      finishRelease();
      await delivering;
      expect(r.calls).toEqual([
        "audio.stop",
        "voice.stop",
        "deactivate",
        "activate:playback",
        `play:1@${TONE_GAIN[1]}`,
        "deactivate",
      ]);
    });
  });

  describe("the drive-end release (P2-M2: stopCurrent at close)", () => {
    it("after an alert whose release failed, the idle stopCurrent releases the session again", async () => {
      let failNext = true;
      const r = rig({
        audio: {
          deactivate: async () => {
            r.calls.push("deactivate");
            if (failNext) {
              failNext = false;
              throw new Error("session busy");
            }
          },
        },
      });
      const player = createAlertPlayer(r.deps);
      await player.deliver(decision(1));
      expect(r.errors).toHaveLength(1);
      await player.stopCurrent();
      expect(count(r.calls, "deactivate")).toBe(2);
      expect(r.errors).toHaveLength(1);
    });

    it("a failing idle release is reported once and never rejects", async () => {
      const r = rig({
        audio: { deactivate: () => Promise.reject(new Error("busy")) },
      });
      await expect(
        createAlertPlayer(r.deps).stopCurrent(),
      ).resolves.toBeUndefined();
      expect(r.errors).toHaveLength(1);
    });
  });

  describe("a role switch drops what is already queued (P2-M4, §8.15)", () => {
    it("a decision queued when the driver becomes a passenger touches no port", async () => {
      const r = rig({ holdPlay: true });
      const player = createAlertPlayer(r.deps);
      const first = player.deliver(decision(2));
      const queued = player.deliver(decision(1, { id: "queued" }));
      const announced = player.announce("alert.recording");
      await flush();
      r.flags.deliverable = false;
      r.release();
      await Promise.all([first, queued, announced]);
      expect(r.calls.filter((c) => c.startsWith("play"))).toEqual([
        `play:2@${TONE_GAIN[2]}`,
      ]);
      expect(r.calls.filter((c) => c.startsWith("activate"))).toHaveLength(1);
      expect(r.calls.some((c) => c.includes(t("alert.recording")))).toBe(false);
      expect(count(r.calls, "deactivate")).toBe(1);
    });

    it("no deliverable dependency means always deliverable; a throwing one is reported and still sounds", async () => {
      const r = rig();
      delete r.deps.deliverable;
      await createAlertPlayer(r.deps).deliver(decision(1));
      expect(r.calls).toContain(`play:1@${TONE_GAIN[1]}`);
      const r2 = rig();
      r2.deps.deliverable = () => {
        throw new Error("role");
      };
      await createAlertPlayer(r2.deps).deliver(decision(1));
      expect(r2.errors).toHaveLength(1);
      expect(r2.calls).toContain(`play:1@${TONE_GAIN[1]}`);
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

describe("a sound that could not play is reported as unavailable (final review I2)", () => {
  function withUnavailable(overrides: Parameters<typeof rig>[0] = {}) {
    const r = rig(overrides);
    let unavailable = 0;
    const player = createAlertPlayer({ ...r.deps, onUnavailable: () => (unavailable += 1) });
    return { r, player, unavailable: () => unavailable };
  }

  it("a tone that fails to play calls onUnavailable, and the session is still released", async () => {
    const t = withUnavailable({
      audio: {
        play: async () => {
          throw new Error("player could not be created");
        },
      },
    });
    await t.player.deliver(decision(2));
    expect(t.unavailable()).toBe(1);
    expect(t.r.calls).toContain("deactivate");
  });

  it("a session that will not activate calls it too", async () => {
    const t = withUnavailable({
      audio: {
        activate: async () => {
          throw new Error("both modes refused");
        },
      },
    });
    await t.player.deliver(decision(1));
    expect(t.unavailable()).toBe(1);
  });

  it("a mode refused but recovered on the playback session is not unavailable: the alert still sounded", async () => {
    const t = withUnavailable({
      audio: {
        activate: async () => {
          throw Object.assign(new Error("audio mode refused"), { fellBack: true });
        },
      },
    });
    await t.player.deliver(decision(1));
    expect(t.unavailable()).toBe(0);
    expect(t.r.errors).toHaveLength(1);
  });

  it("a tone that never finishes (timeout) is unavailable", async () => {
    jest.useFakeTimers();
    try {
      const t = withUnavailable({ audio: { play: () => new Promise<void>(() => {}) } });
      const done = t.player.deliver(decision(3));
      await jest.advanceTimersByTimeAsync(STEP_TIMEOUT_MS * 4);
      await done;
      expect(t.unavailable()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("negative control: an alert that played, or that the driver stopped, is not unavailable", async () => {
    const ok = withUnavailable();
    await ok.player.deliver(decision(2));
    expect(ok.unavailable()).toBe(0);

    const held = withUnavailable({ holdPlay: true });
    const playing = held.player.deliver(decision(2));
    await flush();
    await held.player.stopCurrent();
    await playing;
    expect(held.unavailable()).toBe(0);
  });
});

describe("a later alert that sounds clears the mark (final re-review n2)", () => {
  it("onAvailable follows every decision that activated and played; never one that failed", async () => {
    let fail = true;
    const r = rig({
      audio: {
        play: async () => {
          if (fail) throw new Error("transient");
        },
      },
    });
    const seen: string[] = [];
    const player = createAlertPlayer({
      ...r.deps,
      onUnavailable: () => seen.push("unavailable"),
      onAvailable: () => seen.push("available"),
    });
    await player.deliver(decision(2));
    fail = false;
    await player.deliver(decision(2));
    expect(seen).toEqual(["unavailable", "available"]);
  });
});
