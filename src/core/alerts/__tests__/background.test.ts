// Phone alerts with the app in the Android background: JS timers are paused there (React Native's
// JavaTimerManager, no headless task), and only native events reach JS — the tone's finish, the
// drive's rows. The real expo ports and the real player run over a timer base that never fires while
// paused; a row is modelled as the host's pump.
import { Platform as mockPlatform, Vibration } from 'react-native';

import { createPausableTimerBase, type PausableTimerBase } from '@/lib/__fixtures__/pausableTimers';
import { createPumpedTimers, type PumpedTimers } from '@/lib/timers';

import { flushMicrotasks, nativeAudio } from '../__fixtures__/expoNative';
import { ANDROID_VIBRATION, createExpoAlertPorts } from '../adapters';
import { createAlertPlayer, STEP_TIMEOUT_MS, type AlertPlayer } from '../player';
import type { AlertDecision } from '../types';

jest.mock('expo-audio', () => jest.requireActual('../__fixtures__/expoNative').expoAudioMock());
jest.mock('expo-speech', () => jest.requireActual('../__fixtures__/expoNative').expoSpeechMock());

interface Rig {
  base: PausableTimerBase;
  timers: PumpedTimers;
  player: AlertPlayer;
  tones: { level: number; at: number }[];
  vibrations: { pattern: number[]; at: number }[];
  /** a drive row: the host pumps the process timers first */
  row(): void;
}

let restoreOS: (() => void) | null = null;

beforeEach(() => {
  nativeAudio.reset();
  restoreOS = jest.replaceProperty(mockPlatform, 'OS', 'android').restore;
});

afterEach(() => {
  restoreOS?.();
  restoreOS = null;
  jest.restoreAllMocks();
});

async function rig(o: { haptics?: 'background-aware' | 'waits-pattern' } = {}): Promise<Rig> {
  const base = createPausableTimerBase(1_000_000);
  const timers = createPumpedTimers(base);
  const tones: Rig['tones'] = [];
  const vibrations: Rig['vibrations'] = [];
  jest.spyOn(Vibration, 'vibrate').mockImplementation((p) => {
    vibrations.push({ pattern: [...(p as number[])], at: base.now() });
  });
  jest.spyOn(Vibration, 'cancel').mockImplementation(() => {});
  const ports = await createExpoAlertPorts({
    timers,
    timersPaused: o.haptics === 'waits-pattern' ? () => false : () => base.paused(),
  });
  const player = createAlertPlayer({
    ...ports,
    audio: {
      ...ports.audio,
      play: (level, opts) => {
        tones.push({ level, at: base.now() });
        return ports.audio.play(level, opts);
      },
    },
    timers,
    voiceEnabled: () => false,
    callActive: () => false,
    l1RespectsSilentSwitch: () => false,
  });
  return { base, timers, player, tones, vibrations, row: () => timers.pump() };
}

const brake = (id: string, at: number): AlertDecision => ({ id, level: 2, kind: 'hard_brake', ts: at, intensity: 3 });

function settledFlag(p: Promise<void>): { done: boolean } {
  const f = { done: false };
  void p.then(() => {
    f.done = true;
  });
  return f;
}

describe('phone alerts with JS timers paused (Android, app in the background)', () => {
  it('two alerts 5 s apart both sound and vibrate, with no row and no timer in between', async () => {
    const r = await rig();
    r.base.pause(true);
    const first = settledFlag(r.player.deliver(brake('a', r.base.now())));
    await flushMicrotasks();
    expect(first.done).toBe(true);
    r.base.advance(5000);
    const second = settledFlag(r.player.deliver(brake('b', r.base.now())));
    await flushMicrotasks();
    expect(second.done).toBe(true);
    expect(r.tones.map((t) => t.level)).toEqual([2, 2]);
    expect(r.vibrations.map((v) => v.pattern)).toEqual([[...ANDROID_VIBRATION[3]], [...ANDROID_VIBRATION[3]]]);
    expect(r.vibrations[1]!.at - r.vibrations[0]!.at).toBe(5000);
    // Nothing left armed: the tone fallbacks and step bounds were cleared as each step settled.
    expect(r.timers.pending()).toBe(0);
  });

  it('a step that waits on a timer (a tone that never reports its finish) is released by the next row, and the alert behind it plays', async () => {
    const r = await rig();
    r.base.pause(true);
    nativeAudio.next.push('loadedOnly');
    const first = settledFlag(r.player.deliver(brake('a', r.base.now())));
    await flushMicrotasks();
    const second = settledFlag(r.player.deliver(brake('b', r.base.now())));
    r.base.advance(4000); // the tone's fallback is long due, but paused JS timers never fire it
    await flushMicrotasks();
    expect(first.done).toBe(false);
    expect(r.tones).toHaveLength(1);
    r.row();
    await flushMicrotasks();
    expect(first.done).toBe(true);
    expect(second.done).toBe(true);
    expect(r.tones).toHaveLength(2);
    expect(r.vibrations).toHaveLength(2);
  });

  it('a port that never settles is cut by the step bound on the first row past it', async () => {
    const r = await rig();
    r.base.pause(true);
    const hung = createAlertPlayer({
      audio: { activate: () => new Promise<void>(() => {}), play: async () => {}, stop: async () => {}, deactivate: async () => {} },
      voice: { speak: async () => {}, stop: async () => {} },
      haptics: { pattern: async () => {} },
      timers: r.timers,
      voiceEnabled: () => false,
      callActive: () => false,
      l1RespectsSilentSwitch: () => false,
    });
    const first = settledFlag(hung.deliver(brake('a', r.base.now())));
    await flushMicrotasks(); // the activation step has started
    r.base.advance(STEP_TIMEOUT_MS - 1);
    r.row();
    await flushMicrotasks();
    expect(first.done).toBe(false);
    r.base.advance(2);
    r.row();
    await flushMicrotasks();
    expect(first.done).toBe(true);
  });

  it('with timers running the haptic still waits its pattern out, so pulses never stack', async () => {
    const r = await rig();
    const first = settledFlag(r.player.deliver(brake('a', r.base.now())));
    await flushMicrotasks();
    expect(r.vibrations).toHaveLength(1);
    expect(first.done).toBe(false);
    r.base.advance(ANDROID_VIBRATION[3].reduce((a, b) => a + b, 0));
    await flushMicrotasks();
    expect(first.done).toBe(true);
  });

  it('even a haptic that waits its pattern out is released by the next row while paused', async () => {
    const r = await rig({ haptics: 'waits-pattern' });
    r.base.pause(true);
    const first = settledFlag(r.player.deliver(brake('a', r.base.now())));
    const second = settledFlag(r.player.deliver(brake('b', r.base.now())));
    await flushMicrotasks();
    r.base.advance(2000);
    await flushMicrotasks();
    expect(first.done).toBe(false);
    r.row();
    await flushMicrotasks();
    expect(first.done).toBe(true);
    expect(second.done).toBe(false); // its own pattern now runs to the next row
    r.base.advance(1000);
    r.row();
    await flushMicrotasks();
    expect(second.done).toBe(true);
    expect(r.tones).toHaveLength(2);
  });
});
