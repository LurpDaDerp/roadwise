// The expo ports against mocked native modules: the session option names and order, a tone that
// resolves on its finish event (or its bounded fallback), players freed after each tone, speech
// resolving on done/stop, and the haptic patterns.
//
// `setAudioModeAsync` is mocked faithfully, not permissively (review P2-C1): on iOS it applies
// expo-audio 57.0.5's own `AudioUtils.validateAudioMode` (ios/AudioUtils.swift), over the native
// record's defaults for omitted fields (ios/AudioRecords.swift), and rejects exactly what the
// native module rejects. The JS layer hands the mode to iOS unchanged (build/ExpoAudio.js).
// Android has no validator, so there the mock accepts anything, as the native module does.
import * as Audio from "expo-audio";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
// `mock` prefix: the hoisted jest.mock factory below may reference it (read at call time).
import { Platform as mockPlatform } from "react-native";

import {
  ANDROID_RESPECT_SILENT_MODE,
  createExpoAlertPorts,
  IOS_RESPECT_SILENT_MODE,
  PLAYBACK_MODE,
  TONE_FINISH_MARGIN_MS,
  TONE_MS,
} from "../adapters";

/**
 * expo-audio 57.0.5 `AudioUtils.validateAudioMode`, rule for rule, over `AudioMode`'s native
 * defaults (`playsInSilentMode` false, `interruptionMode` mixWithOthers, `allowsRecording` false,
 * `shouldPlayInBackground` false).
 */
function mockValidateAudioModeIOS(partial: Record<string, unknown>): void {
  const mode = {
    playsInSilentMode: false,
    interruptionMode: "mixWithOthers",
    allowsRecording: false,
    shouldPlayInBackground: false,
    ...partial,
  };
  if (!mode.playsInSilentMode && mode.interruptionMode === "duckOthers") {
    throw new Error(
      "InvalidAudioModeException: playsInSilentMode == false and duckOthers == true cannot be set on iOS",
    );
  }
  if (!mode.playsInSilentMode && mode.allowsRecording) {
    throw new Error(
      "InvalidAudioModeException: playsInSilentMode == false and allowsRecording == true cannot be set on iOS",
    );
  }
  if (!mode.playsInSilentMode && mode.shouldPlayInBackground) {
    throw new Error(
      "InvalidAudioModeException: playsInSilentMode == false and staysActiveInBackground == true cannot be set on iOS.",
    );
  }
}

type Listener = (status: { didJustFinish: boolean }) => void;

interface FakePlayer {
  volume: number;
  play: jest.Mock;
  pause: jest.Mock;
  remove: jest.Mock;
  listener: Listener | null;
  subscriptionRemoved: boolean;
  addListener: jest.Mock;
}

const mockPlayers: FakePlayer[] = [];

jest.mock("expo-audio", () => ({
  setAudioModeAsync: jest.fn(async (mode: Record<string, unknown>) => {
    if (mockPlatform.OS === "ios") mockValidateAudioModeIOS(mode);
  }),
  setIsAudioActiveAsync: jest.fn(async () => {}),
  createAudioPlayer: jest.fn(() => {
    const player: FakePlayer = {
      volume: 1,
      play: jest.fn(),
      pause: jest.fn(),
      remove: jest.fn(),
      listener: null,
      subscriptionRemoved: false,
      addListener: jest.fn((_event: string, listener: Listener) => {
        player.listener = listener;
        return {
          remove: () => {
            player.subscriptionRemoved = true;
          },
        };
      }),
    };
    mockPlayers.push(player);
    return player;
  }),
}));

type SpeechOptions = {
  volume?: number;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (e: Error) => void;
};
const mockSpoken: { text: string; options: SpeechOptions }[] = [];
jest.mock("expo-speech", () => ({
  speak: jest.fn((text: string, options: SpeechOptions) => {
    mockSpoken.push({ text, options });
  }),
  stop: jest.fn(async () => {}),
}));

jest.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Heavy: "heavy" },
  NotificationFeedbackType: { Warning: "warning" },
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
}));

// jest-expo stubs every asset to the same value; give each tone file its own so the mapping shows.
jest.mock("../../../../assets/sounds/l1.wav", () => "l1.wav");
jest.mock("../../../../assets/sounds/l2.wav", () => "l2.wav");
jest.mock("../../../../assets/sounds/l3.wav", () => "l3.wav");

const audioMock = Audio as unknown as {
  setAudioModeAsync: jest.Mock;
  setIsAudioActiveAsync: jest.Mock;
  createAudioPlayer: jest.Mock;
};

beforeEach(() => {
  mockPlayers.length = 0;
  mockSpoken.length = 0;
  jest.clearAllMocks();
});

describe("expo alert ports", () => {
  it("creates no native player until a tone plays", async () => {
    await createExpoAlertPorts();
    expect(audioMock.createAudioPlayer).not.toHaveBeenCalled();
    expect(audioMock.setAudioModeAsync).not.toHaveBeenCalled();
  });

  describe("the validateAudioMode-faithful mock itself", () => {
    it("rejects on iOS the three combinations the native validator rejects, including the old respectSilent mode", () => {
      const oldRespectSilent = {
        playsInSilentMode: false,
        interruptionMode: "duckOthers",
        shouldPlayInBackground: true,
        allowsRecording: false,
      };
      expect(() => mockValidateAudioModeIOS(oldRespectSilent)).toThrow(
        "duckOthers",
      );
      expect(() =>
        mockValidateAudioModeIOS({
          playsInSilentMode: false,
          allowsRecording: true,
        }),
      ).toThrow("allowsRecording");
      expect(() =>
        mockValidateAudioModeIOS({
          playsInSilentMode: false,
          shouldPlayInBackground: true,
        }),
      ).toThrow("staysActiveInBackground");
      // omitted fields take the native defaults: `{}` is plain `.ambient`, which is valid
      expect(() => mockValidateAudioModeIOS({})).not.toThrow();
      expect(() =>
        mockValidateAudioModeIOS({ ...PLAYBACK_MODE }),
      ).not.toThrow();
      expect(() =>
        mockValidateAudioModeIOS({ ...IOS_RESPECT_SILENT_MODE }),
      ).not.toThrow();
    });
  });

  describe("activate", () => {
    let restoreOS: (() => void) | null = null;
    const setOS = (os: "ios" | "android") => {
      restoreOS = jest.replaceProperty(mockPlatform, "OS", os).restore;
    };
    afterEach(() => {
      restoreOS?.();
      restoreOS = null;
    });

    it("iOS: playback is a ducking, background, no-recording mode, and audio is enabled after it", async () => {
      setOS("ios");
      const { audio } = await createExpoAlertPorts();
      await expect(audio.activate("playback")).resolves.toBeUndefined();
      expect(audioMock.setAudioModeAsync.mock.calls).toEqual([
        [
          {
            playsInSilentMode: true,
            interruptionMode: "duckOthers",
            shouldPlayInBackground: true,
            allowsRecording: false,
          },
        ],
      ]);
      expect(audioMock.setIsAudioActiveAsync.mock.calls).toEqual([[true]]);
      expect(
        audioMock.setIsAudioActiveAsync.mock.invocationCallOrder[0]!,
      ).toBeGreaterThan(
        audioMock.setAudioModeAsync.mock.invocationCallOrder[0]!,
      );
    });

    it("iOS: respectSilent resolves on a mode the native validator accepts (.ambient: mix, no duck, no background)", async () => {
      setOS("ios");
      const { audio } = await createExpoAlertPorts();
      await expect(audio.activate("respectSilent")).resolves.toBeUndefined();
      expect(audioMock.setAudioModeAsync.mock.calls).toEqual([
        [
          {
            playsInSilentMode: false,
            interruptionMode: "mixWithOthers",
            shouldPlayInBackground: false,
            allowsRecording: false,
          },
        ],
      ]);
      expect(audioMock.setIsAudioActiveAsync.mock.calls).toEqual([[true]]);
    });

    it("Android: respectSilent keeps duckOthers (audio focus) and background playback", async () => {
      setOS("android");
      const { audio } = await createExpoAlertPorts();
      await expect(audio.activate("respectSilent")).resolves.toBeUndefined();
      await expect(audio.activate("playback")).resolves.toBeUndefined();
      expect(audioMock.setAudioModeAsync.mock.calls).toEqual([
        [
          {
            playsInSilentMode: false,
            interruptionMode: "duckOthers",
            shouldPlayInBackground: true,
            allowsRecording: false,
          },
        ],
        [{ ...PLAYBACK_MODE }],
      ]);
      expect(ANDROID_RESPECT_SILENT_MODE.interruptionMode).toBe("duckOthers");
    });

    it("a refused mode falls back to the playback mode, enables audio, then rejects with the original error", async () => {
      setOS("ios");
      const { audio } = await createExpoAlertPorts();
      audioMock.setAudioModeAsync.mockRejectedValueOnce(new Error("refused"));
      await expect(audio.activate("respectSilent")).rejects.toThrow("refused");
      expect(audioMock.setAudioModeAsync.mock.calls).toEqual([
        [{ ...IOS_RESPECT_SILENT_MODE }],
        [{ ...PLAYBACK_MODE }],
      ]);
      expect(audioMock.setIsAudioActiveAsync.mock.calls).toEqual([[true]]);
    });

    it("when even the fallback is refused, activate rejects and does not enable audio", async () => {
      setOS("ios");
      const { audio } = await createExpoAlertPorts();
      audioMock.setAudioModeAsync
        .mockRejectedValueOnce(new Error("refused"))
        .mockRejectedValueOnce(new Error("fallback refused"));
      await expect(audio.activate("playback")).rejects.toThrow(
        "fallback refused",
      );
      expect(audioMock.setIsAudioActiveAsync).not.toHaveBeenCalled();
    });
  });

  it("deactivate releases audio, retrying once if the session is busy", async () => {
    jest.useFakeTimers();
    try {
      const { audio } = await createExpoAlertPorts();
      await audio.deactivate();
      expect(audioMock.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);
      audioMock.setIsAudioActiveAsync.mockRejectedValueOnce(new Error("busy"));
      const releasing = audio.deactivate();
      await jest.advanceTimersByTimeAsync(200);
      await releasing;
      expect(audioMock.setIsAudioActiveAsync.mock.calls).toEqual([
        [false],
        [false],
        [false],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a tone plays at the given volume, keeps the session, resolves on finish and frees its player", async () => {
    const { audio } = await createExpoAlertPorts();
    let done = false;
    const playing = audio.play(2, { volume: 0.5 }).then(() => {
      done = true;
    });
    expect(audioMock.createAudioPlayer).toHaveBeenCalledWith(
      expect.anything(),
      { keepAudioSessionActive: true },
    );
    const player = mockPlayers[0]!;
    expect(player.volume).toBe(0.5);
    expect(player.play).toHaveBeenCalledTimes(1);
    player.listener!({ didJustFinish: false });
    await Promise.resolve();
    expect(done).toBe(false);
    player.listener!({ didJustFinish: true });
    await playing;
    expect(player.remove).toHaveBeenCalledTimes(1);
    expect(player.subscriptionRemoved).toBe(true);
  });

  it("each level plays its own file", async () => {
    const { audio } = await createExpoAlertPorts();
    for (const level of [1, 2, 3] as const) {
      const p = audio.play(level, { volume: 1 });
      mockPlayers[mockPlayers.length - 1]!.listener!({ didJustFinish: true });
      await p;
    }
    const sources = audioMock.createAudioPlayer.mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(sources).toEqual(["l1.wav", "l2.wav", "l3.wav"]);
  });

  it("a tone with no finish event resolves after its length plus the margin", async () => {
    jest.useFakeTimers();
    try {
      const { audio } = await createExpoAlertPorts();
      let done = false;
      const playing = audio.play(3, { volume: 1 }).then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(
        TONE_MS[3] + TONE_FINISH_MARGIN_MS - 10,
      );
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(20);
      await playing;
      expect(mockPlayers[0]!.remove).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stop pauses the tone, resolves its play and frees the player; stop when idle is a no-op", async () => {
    const { audio } = await createExpoAlertPorts();
    await audio.stop();
    const playing = audio.play(1, { volume: 1 });
    await audio.stop();
    await playing;
    expect(mockPlayers[0]!.pause).toHaveBeenCalled();
    expect(mockPlayers[0]!.remove).toHaveBeenCalled();
  });

  it("a player that cannot be created rejects play", async () => {
    const { audio } = await createExpoAlertPorts();
    audioMock.createAudioPlayer.mockImplementationOnce(() => {
      throw new Error("no asset");
    });
    await expect(audio.play(1, { volume: 1 })).rejects.toThrow("no asset");
  });

  it("a player that fails to start rejects play and is freed", async () => {
    jest.useFakeTimers();
    try {
      const { audio } = await createExpoAlertPorts();
      const playing = audio.play(1, { volume: 1 });
      // createAudioPlayer ran synchronously inside play; make its play() throw on the next tone
      expect(mockPlayers).toHaveLength(1);
      mockPlayers[0]!.listener!({ didJustFinish: true });
      await playing;
      audioMock.createAudioPlayer.mockImplementationOnce(() => {
        const p = {
          volume: 1,
          play: jest.fn(() => {
            throw new Error("focus refused");
          }),
          pause: jest.fn(),
          remove: jest.fn(),
          addListener: jest.fn(() => ({ remove: jest.fn() })),
        };
        mockPlayers.push(p as unknown as FakePlayer);
        return p;
      });
      await expect(audio.play(2, { volume: 1 })).rejects.toThrow(
        "focus refused",
      );
      expect(mockPlayers[1]!.remove).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("speech uses the app session at the given volume and resolves on done or stop", async () => {
    const { voice } = await createExpoAlertPorts();
    const first = voice.speak("Phone down", { volume: 0.8 });
    expect(mockSpoken[0]!.text).toBe("Phone down");
    expect(mockSpoken[0]!.options).toMatchObject({
      volume: 0.8,
      useApplicationAudioSession: true,
    });
    mockSpoken[0]!.options.onDone!();
    await first;
    const second = voice.speak("Eyes up", { volume: 1 });
    mockSpoken[1]!.options.onStopped!();
    await second;
    const third = voice.speak("Slow down", { volume: 1 });
    mockSpoken[2]!.options.onError!(new Error("tts"));
    await expect(third).rejects.toThrow("tts");
    await voice.stop();
    expect(Speech.stop).toHaveBeenCalled();
  });

  it("haptics: a double pulse is two heavy impacts; the long pattern is a warning and two impacts", async () => {
    const { haptics } = await createExpoAlertPorts();
    await haptics.pattern("double");
    expect((Haptics.impactAsync as jest.Mock).mock.calls).toEqual([
      ["heavy"],
      ["heavy"],
    ]);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    jest.clearAllMocks();
    await haptics.pattern("long");
    expect((Haptics.notificationAsync as jest.Mock).mock.calls).toEqual([
      ["warning"],
    ]);
    expect((Haptics.impactAsync as jest.Mock).mock.calls).toEqual([
      ["heavy"],
      ["heavy"],
    ]);
  });
});
