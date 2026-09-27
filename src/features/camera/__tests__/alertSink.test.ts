import type { AlertStyle } from '@/core/alerts/types';
import type { DmsAlertCommand } from '@/core/dms';

import { CALL_GAIN, createDmsAlertSink, HAPTIC_INTENSITY_FOR_TIER, MAX_REPEAT_MS, TIER3_GAIN_START } from '../alertSink';
import { cameraVoice } from '../copy';

function ports(opts: { voice?: boolean; call?: boolean; style?: AlertStyle } = {}) {
  const log: string[] = [];
  const volumes: number[] = [];
  let t = 0;
  const sink = createDmsAlertSink({
    audio: {
      activate: async (k) => void log.push(`activate:${k}`),
      play: async (level, o) => {
        log.push(`tone:${level}`);
        volumes.push(o.volume);
        t += 500; // a tone takes half a second
      },
      stop: async () => void log.push('audio.stop'),
      deactivate: async () => void log.push('deactivate'),
    },
    voice: {
      speak: async (text) => void log.push(`say:${text}`),
      stop: async () => void log.push('voice.stop'),
    },
    haptics: { pattern: async (k) => void log.push(`haptic:${k}`) },
    voiceEnabled: () => opts.voice ?? true,
    alertStyle: opts.style === undefined ? undefined : () => opts.style as AlertStyle,
    callActive: () => opts.call ?? false,
    now: () => t,
    wait: async (ms) => {
      t += ms;
      await Promise.resolve();
    },
  });
  return { sink, log, volumes, advance: (ms: number) => (t += ms) };
}

const audio = (l: string) => /^(activate|tone|say|audio\.stop|deactivate|voice\.stop)/.test(l);

let id = 0;
const cmd = (action: DmsAlertCommand['action'], tier: 1 | 2 | 3, kind: DmsAlertCommand['kind'], muted = false): DmsAlertCommand => ({
  id: (id += 1),
  action,
  tier,
  kind,
  tMs: 0,
  epochMs: 0,
  muted,
});

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

test('once: one tone of its tier and its phrase, then the session is released; one light pulse beside the tone', async () => {
  const { sink, log } = ports();
  sink.handle(cmd('once', 1, 'fatigue_early'));
  await sink.idle();
  expect(log.filter(audio)).toEqual(['activate:playback', 'tone:1', `say:${cameraVoice.fatigue_early}`, 'audio.stop', 'deactivate']);
  expect(log.filter((l) => l.startsWith('haptic:'))).toEqual(['haptic:1']);
  expect(HAPTIC_INTENSITY_FOR_TIER).toEqual({ 1: 1, 2: 2, 3: 4 });
});

test('vibration only: no session, tone or phrase at all; the pulses repeat on the tier cadence until the stop', async () => {
  const once = ports({ style: 'vibration' });
  once.sink.handle(cmd('once', 1, 'fatigue_early'));
  await once.sink.idle();
  expect(once.log).toEqual(['haptic:1']);

  const t3 = ports({ style: 'vibration' });
  t3.sink.handle(cmd('start', 3, 'sleep'));
  await flush(40);
  t3.sink.handle(cmd('stop', 3, 'sleep'));
  await t3.sink.idle();
  const pulses = t3.log.filter((l) => l === 'haptic:4').length;
  expect(pulses).toBeGreaterThan(1);
  // Nothing sounded: the stop's port calls are idle no-ops, and the session was never activated.
  expect(t3.log.filter((l) => !l.startsWith('haptic:'))).toEqual(['audio.stop', 'voice.stop']);
});

test('sound only: tones and phrases as usual, never a pulse', async () => {
  const { sink, log } = ports({ style: 'sound' });
  sink.handle(cmd('start', 2, 'distraction'));
  await flush(40);
  sink.handle(cmd('stop', 2, 'distraction'));
  await sink.idle();
  expect(log.some((l) => l.startsWith('haptic:'))).toBe(false);
  expect(log.filter((l) => l === 'tone:2').length).toBeGreaterThan(1);
  expect(log.slice(-2)).toEqual(['audio.stop', 'deactivate']);
});

test('a muted command (shadow mode) touches nothing', async () => {
  const { sink, log } = ports();
  sink.handle(cmd('once', 1, 'fatigue', true));
  sink.handle(cmd('start', 3, 'sleep', true));
  await sink.idle();
  expect(log).toEqual([]);
});

test('tier 2 repeats until its stop; the phrase once, a medium pulse with every tone', async () => {
  const { sink, log } = ports();
  sink.handle(cmd('start', 2, 'distraction'));
  await flush(60);
  sink.handle(cmd('stop', 2, 'distraction'));
  await sink.idle();
  const tones = log.filter((l) => l === 'tone:2').length;
  expect(tones).toBeGreaterThan(1);
  expect(log.filter((l) => l.startsWith('say:'))).toEqual([`say:${cameraVoice.distraction}`]);
  expect(log.filter((l) => l.startsWith('haptic:'))).toEqual(Array<string>(tones).fill('haptic:2'));
  expect(log.slice(-2)).toEqual(['audio.stop', 'deactivate']);
});

test('tier 3 sounds continuously, louder every 2 s up to full, the heaviest pulse with every tone, until its stop', async () => {
  const { sink, log, volumes } = ports();
  sink.handle(cmd('start', 3, 'sleep'));
  await flush(80);
  sink.handle(cmd('stop', 3, 'sleep'));
  await sink.idle();
  expect(volumes[0]).toBeCloseTo(TIER3_GAIN_START);
  expect(Math.max(...volumes)).toBeCloseTo(1);
  for (let i = 1; i < volumes.length; i++) expect(volumes[i]!).toBeGreaterThanOrEqual(volumes[i - 1]!);
  expect(log.filter((l) => l === 'haptic:4')).toHaveLength(volumes.length);
  expect(log).toContain(`say:${cameraVoice.sleep}`);
});

test('voice off, or a call: tones only (a call at half gain)', async () => {
  const off = ports({ voice: false });
  off.sink.handle(cmd('once', 1, 'fatigue'));
  await off.sink.idle();
  expect(off.log.some((l) => l.startsWith('say:'))).toBe(false);
  const call = ports({ call: true });
  call.sink.handle(cmd('once', 1, 'fatigue'));
  await call.sink.idle();
  expect(call.log.some((l) => l.startsWith('say:'))).toBe(false);
  expect(call.volumes).toEqual([CALL_GAIN]);
});

test('a start replaces the sounding alert; a once during a repeating alert is dropped; stopAll silences', async () => {
  const { sink, log } = ports();
  sink.handle(cmd('start', 2, 'distraction'));
  await flush(10);
  sink.handle(cmd('once', 1, 'fatigue'));
  sink.handle(cmd('start', 3, 'microsleep'));
  await flush(20);
  expect(log).toContain('tone:3');
  expect(log).not.toContain(`say:${cameraVoice.fatigue}`);
  await sink.stopAll();
  expect(log).toContain('voice.stop');
  await sink.idle();
});

test('a lost stop: a repeating alert ends by itself after MAX_REPEAT_MS', async () => {
  const { sink, log } = ports();
  sink.handle(cmd('start', 2, 'distraction'));
  await sink.idle();
  const tones = log.filter((l) => l === 'tone:2').length;
  expect(tones).toBeLessThanOrEqual(Math.ceil(MAX_REPEAT_MS / 1500) + 1);
  expect(log.slice(-1)).toEqual(['deactivate']);
});

test('a port that throws is reported and the rest still runs', async () => {
  const errors: unknown[] = [];
  const log: string[] = [];
  const sink = createDmsAlertSink({
    audio: {
      activate: async () => {
        throw new Error('busy');
      },
      play: async () => void log.push('tone'),
      stop: async () => {},
      deactivate: async () => void log.push('deactivate'),
    },
    voice: { speak: async () => void log.push('say'), stop: async () => {} },
    haptics: { pattern: async () => {} },
    voiceEnabled: () => true,
    callActive: () => false,
    onError: (e) => errors.push(e),
  });
  sink.handle(cmd('once', 1, 'fatigue'));
  await sink.idle();
  expect(errors).toHaveLength(1);
  expect(log).toEqual(['tone', 'say', 'deactivate']);
});
