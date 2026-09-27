import type { AlertLevel } from '@/core/alerts/types';

import { playTestAlert } from '../testAlert';

jest.mock('@/core/alerts/adapters', () => ({ createExpoAlertPorts: jest.fn() }));

function ports(opts: { toneFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    load: async () => ({
      audio: {
        activate: jest.fn(async (kind: string) => {
          calls.push(`activate:${kind}`);
        }),
        play: jest.fn(async (level: AlertLevel) => {
          calls.push(`tone:${level}`);
          if (opts.toneFails) throw new Error('no tone');
        }),
        stop: jest.fn(async () => {}),
        deactivate: jest.fn(async () => {
          calls.push('release');
        }),
      },
      voice: {
        speak: jest.fn(async (text: string) => {
          calls.push(`say:${text}`);
        }),
        stop: jest.fn(async () => {}),
      },
      haptics: {
        pattern: jest.fn(async (kind: string) => {
          calls.push(`pulse:${kind}`);
        }),
      },
    }),
  };
}

test('plays what a drive plays for an L2 warning: the tone and the phrase, the audio let go, then the pulse', async () => {
  const p = ports();
  expect(await playTestAlert({ loadPorts: p.load, voiceEnabled: () => true })).toBe('played');
  expect(p.calls).toEqual(['activate:playback', 'tone:2', 'say:Slow down', 'release', 'pulse:double']);
});

test('voice off: the tone and the pulse, no phrase', async () => {
  const p = ports();
  expect(await playTestAlert({ loadPorts: p.load, voiceEnabled: () => false })).toBe('played');
  expect(p.calls).not.toContain('say:Slow down');
  expect(p.calls).toContain('tone:2');
});

test('a tone that will not play is reported as failed', async () => {
  const p = ports({ toneFails: true });
  expect(await playTestAlert({ loadPorts: p.load, voiceEnabled: () => true })).toBe('failed');
});

test('ports that will not load: failed, without throwing', async () => {
  expect(
    await playTestAlert({
      loadPorts: async () => {
        throw new Error('no native module');
      },
    })
  ).toBe('failed');
});
