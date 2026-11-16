// Android speech warm-up (adapters.ts, "Speech on Android"): the engine is bound as each drive
// opens, and a phone with no voice skips phrases so alerts play their tone alone. iPhone untouched.
import { setSpeechModuleForTests } from "@drive-sense/speech";
import { Platform as mockPlatform } from "react-native";

import {
  createExpoAlertPorts,
  resetSpeechWarmForTests,
  speechHasNoVoice,
  warmSpeech,
  warmSpeechAsDrivesOpen,
} from "../adapters";

const mockVoices: { list: unknown[] | Error } = { list: [] };
const mockSpeak = jest.fn((_text: string, options: { onDone?: () => void }) => {
  options.onDone?.();
});
const mockGetVoices = jest.fn(async () => {
  if (mockVoices.list instanceof Error) throw mockVoices.list;
  return mockVoices.list;
});

jest.mock("expo-speech", () => ({
  speak: (text: string, options: { onDone?: () => void }) => mockSpeak(text, options),
  stop: jest.fn(async () => {}),
  getAvailableVoicesAsync: () => mockGetVoices(),
}));
jest.mock("expo-audio", () => ({}));

let restoreOS: (() => void) | null = null;
const setOS = (os: "ios" | "android") => {
  restoreOS = jest.replaceProperty(mockPlatform, "OS", os).restore;
};

beforeEach(() => {
  resetSpeechWarmForTests();
  mockVoices.list = [];
  mockSpeak.mockClear();
  mockGetVoices.mockClear();
});
afterEach(() => {
  restoreOS?.();
  restoreOS = null;
});

describe("warmSpeech", () => {
  it("iPhone: never touches the speech engine and always speaks", async () => {
    setOS("ios");
    await warmSpeech();
    expect(mockGetVoices).not.toHaveBeenCalled();
    expect(speechHasNoVoice()).toBe(false);
    const { voice } = await createExpoAlertPorts();
    await voice.speak("Slow down", { volume: 1 });
    expect(mockSpeak).toHaveBeenCalledTimes(1);
  });

  it("Android with a voice: the engine is bound and phrases are spoken", async () => {
    setOS("android");
    mockVoices.list = [{ identifier: "en-us-x-sfg", language: "en-US" }];
    await warmSpeech();
    expect(mockGetVoices).toHaveBeenCalledTimes(1);
    expect(speechHasNoVoice()).toBe(false);
    const { voice } = await createExpoAlertPorts();
    await voice.speak("Slow down", { volume: 1 });
    expect(mockSpeak).toHaveBeenCalledTimes(1);
  });

  it("Android with no voice: the phrase resolves at once without speaking", async () => {
    setOS("android");
    mockVoices.list = [];
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(true);
    const { voice } = await createExpoAlertPorts();
    await expect(voice.speak("Slow down", { volume: 1 })).resolves.toBeUndefined();
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it("Android before any warm-up, or when the warm-up cannot tell: speech is as it was", async () => {
    setOS("android");
    const { voice } = await createExpoAlertPorts();
    await voice.speak("Slow down", { volume: 1 });
    expect(mockSpeak).toHaveBeenCalledTimes(1);
    mockVoices.list = new Error("engine gone");
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(false);
  });

  it("a voice installed later is found by the next warm-up", async () => {
    setOS("android");
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(true);
    mockVoices.list = [{ identifier: "v" }];
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(false);
  });

  it("one warm-up at a time", async () => {
    setOS("android");
    await Promise.all([warmSpeech(), warmSpeech(), warmSpeech()]);
    expect(mockGetVoices).toHaveBeenCalledTimes(1);
  });
});

// Android's own engine (drive-sense's AlertSpeech): the process's, so speech survives the activity
// being destroyed while a drive records behind (expo-speech's engine is shut down for good then).
describe("Android with drive-sense's speech engine", () => {
  function fakeNative(o: { count?: number | null | Error; outcome?: string } = {}) {
    const calls: string[] = [];
    return {
      calls,
      module: {
        speakAlert: jest.fn(async (text: string, volume: number) => {
          calls.push(`speak:${text}:${volume}`);
          return o.outcome ?? "done";
        }),
        stopAlertSpeech: jest.fn(async () => {
          calls.push("stop");
        }),
        alertVoiceCount: jest.fn(async () => {
          calls.push("count");
          if (o.count instanceof Error) throw o.count;
          return o.count === undefined ? 2 : o.count;
        }),
      },
    };
  }
  afterEach(() => setSpeechModuleForTests(undefined));

  it("phrases, stops and the warm-up go to the native engine; expo-speech is never touched", async () => {
    setOS("android");
    const n = fakeNative();
    setSpeechModuleForTests(n.module);
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(false);
    const { voice } = await createExpoAlertPorts();
    await voice.speak("Slow down", { volume: 0.8 });
    await voice.stop();
    expect(n.calls).toEqual(["count", "speak:Slow down:0.8", "stop"]);
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockGetVoices).not.toHaveBeenCalled();
  });

  it("a stopped phrase resolves; one the engine could not say rejects (the player moves on at once)", async () => {
    setOS("android");
    setSpeechModuleForTests(fakeNative({ outcome: "stopped" }).module);
    await expect((await createExpoAlertPorts()).voice.speak("Slow down", { volume: 1 })).resolves.toBeUndefined();
    setSpeechModuleForTests(fakeNative({ outcome: "error" }).module);
    await expect((await createExpoAlertPorts()).voice.speak("Slow down", { volume: 1 })).rejects.toThrow("speech failed");
  });

  it("no voice skips phrases; an unreadable count leaves speech as it was", async () => {
    setOS("android");
    const none = fakeNative({ count: 0 });
    setSpeechModuleForTests(none.module);
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(true);
    await (await createExpoAlertPorts()).voice.speak("Slow down", { volume: 1 });
    expect(none.calls).toEqual(["count"]);
    setSpeechModuleForTests(fakeNative({ count: null }).module);
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(false);
    setSpeechModuleForTests(fakeNative({ count: new Error("binder died") }).module);
    await warmSpeech();
    expect(speechHasNoVoice()).toBe(false);
  });

  it("iPhone keeps expo-speech even where the native functions exist", async () => {
    setOS("ios");
    const n = fakeNative();
    setSpeechModuleForTests(n.module);
    await (await createExpoAlertPorts()).voice.speak("Slow down", { volume: 1 });
    expect(mockSpeak).toHaveBeenCalledTimes(1);
    expect(n.calls).toEqual([]);
  });
});

describe("warmSpeechAsDrivesOpen", () => {
  type S = { status: string; dryRun: boolean };
  function fakeHost(initial: S) {
    let state = initial;
    const fns = new Set<(s: S) => void>();
    return {
      snapshot: () => state,
      subscribe: (fn: (s: S) => void) => {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      set(next: S) {
        state = next;
        fns.forEach((fn) => fn(state));
      },
      listeners: () => fns.size,
    };
  }
  const flush = () => new Promise<void>((r) => setImmediate(() => r()));

  it("iPhone: does not subscribe", () => {
    setOS("ios");
    const host = fakeHost({ status: "idle", dryRun: false });
    warmSpeechAsDrivesOpen(host, () => true)();
    expect(host.listeners()).toBe(0);
  });

  it("Android: warms once as each drive opens, not on every row, and never for a simulation", async () => {
    setOS("android");
    mockVoices.list = [{ identifier: "v" }];
    const host = fakeHost({ status: "idle", dryRun: false });
    const stop = warmSpeechAsDrivesOpen(host, () => true);
    expect(mockGetVoices).not.toHaveBeenCalled();
    host.set({ status: "recording", dryRun: false });
    await flush();
    host.set({ status: "recording", dryRun: false });
    host.set({ status: "finalizing", dryRun: false });
    await flush();
    expect(mockGetVoices).toHaveBeenCalledTimes(1);
    host.set({ status: "idle", dryRun: false });
    host.set({ status: "recording", dryRun: true });
    await flush();
    expect(mockGetVoices).toHaveBeenCalledTimes(1);
    host.set({ status: "idle", dryRun: false });
    host.set({ status: "recording", dryRun: false });
    await flush();
    expect(mockGetVoices).toHaveBeenCalledTimes(2);
    stop();
    expect(host.listeners()).toBe(0);
  });

  it("Android: a drive already open at launch (an adopted one) warms at once", async () => {
    setOS("android");
    const host = fakeHost({ status: "recording", dryRun: false });
    warmSpeechAsDrivesOpen(host, () => true);
    await flush();
    expect(mockGetVoices).toHaveBeenCalledTimes(1);
  });

  it("Android: vibration-only (nothing is ever spoken) does not bind the engine", async () => {
    setOS("android");
    const host = fakeHost({ status: "idle", dryRun: false });
    warmSpeechAsDrivesOpen(host, () => false);
    host.set({ status: "recording", dryRun: false });
    await flush();
    expect(mockGetVoices).not.toHaveBeenCalled();
  });
});
