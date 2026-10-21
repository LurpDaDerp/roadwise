// Which flash bursts the halo (drive-screen design §4.6, §5.7).
import { act, render } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';

import type { BurstSource, HaloBurst } from '@/ui/drive';

import { newBurstMemory, stepHaloBurst, useHaloBurst } from '../useHaloBurst';

const T = 1_790_000_000_000;
const event = (at: number, until: number, type: 'hard_brake' | 'speeding' | 'hard_corner' = 'hard_brake'): BurstSource => ({ kind: 'event', type, at, until });
const dashpal = (key: string, until: number, tier = 3, o: { sound?: number; resend?: boolean } = {}): BurstSource => ({
  kind: 'dashpal',
  key,
  sound: o.sound ?? 3,
  tier,
  resend: o.resend ?? false,
  until,
});

describe('stepHaloBurst', () => {
  const cand = (k: string, until: number, severity = 1, pulses: 1 | 2 | 3 = 3) => ({ key: k, severity, pulses, until });

  test('overlapping flashes: the one first seen latest bursts once; the older never bursts after it; nothing re-bursts as one ends', () => {
    const m = newBurstMemory();
    const a = cand('event:hard_brake:1', T + 1500);
    const b = cand('dashpal:1:7:0', T + 200 + 1500, 0.75);
    expect(stepHaloBurst(m, [a], T, true)).toMatchObject({ key: a.key, pulses: 3 });
    // the DashPal flash arrives 200 ms later: it takes over
    expect(stepHaloBurst(m, [a, b], T + 200, true)).toMatchObject({ key: b.key, severity: 0.75 });
    // the event flash outlives nothing; the DashPal one stays the burst while both show
    expect(stepHaloBurst(m, [a, b], T + 400, true)).toMatchObject({ key: b.key });
    // the event flash ends: still the same burst, never the event one again
    expect(stepHaloBurst(m, [b], T + 1500, true)).toMatchObject({ key: b.key });
    // the DashPal flash ends: nothing
    expect(stepHaloBurst(m, [], T + 1700, true)).toBeNull();
    expect(stepHaloBurst(m, [a], T + 1800, true)).toBeNull();
  });

  test('two new flashes seen in the same render: the later-seen tie goes to the stronger, the other never bursts', () => {
    const m = newBurstMemory();
    const a = cand('event:hard_brake:1', T + 1500, 1);
    const b = cand('dashpal:1:1:0', T + 1500, 0.45, 1);
    expect(stepHaloBurst(m, [a, b], T, true)).toMatchObject({ key: a.key });
    expect(stepHaloBurst(m, [b], T + 100, true)).toBeNull();
  });

  test('the pulses fit what is left of the flash: under 400 ms none, 900 ms two, a full flash three', () => {
    expect(stepHaloBurst(newBurstMemory(), [cand('k1', T + 399)], T, true)).toBeNull();
    expect(stepHaloBurst(newBurstMemory(), [cand('k2', T + 900)], T, true)).toMatchObject({ pulses: 2 });
    expect(stepHaloBurst(newBurstMemory(), [cand('k3', T + 1500)], T, true)).toMatchObject({ pulses: 3 });
    expect(stepHaloBurst(newBurstMemory(), [cand('k4', T + 1500, 0.45, 1)], T, true)).toMatchObject({ pulses: 1 });
    // a flash too short to burst is passed over for good
    const m = newBurstMemory();
    expect(stepHaloBurst(m, [cand('k5', T + 300)], T, true)).toBeNull();
    expect(stepHaloBurst(m, [cand('k5', T + 300)], T + 10, true)).toBeNull();
  });

  test('a flash seen while RoadWise is not in front never bursts, also once it is back', () => {
    const m = newBurstMemory();
    const a = cand('dashpal:9:1:0', T + 1500);
    expect(stepHaloBurst(m, [a], T, false)).toBeNull();
    expect(stepHaloBurst(m, [a], T + 100, true)).toBeNull();
  });

  test('a repeated render returns the same burst object (nothing replays)', () => {
    const m = newBurstMemory();
    const a = cand('event:hard_brake:5', T + 1500);
    const first = stepHaloBurst(m, [a], T, true);
    expect(stepHaloBurst(m, [a], T + 1, true)).toBe(first);
    expect(stepHaloBurst(m, [a], T + 1, true)).toBe(first);
  });

  test('the played list stays bounded', () => {
    const m = newBurstMemory();
    for (let i = 0; i < 40; i += 1) stepHaloBurst(m, [cand(`k${i}`, T + i * 2000 + 1500)], T + i * 2000, true);
    expect(m.played.length).toBeLessThanOrEqual(16);
    expect(m.firstSeen.size).toBe(1);
  });
});

describe('useHaloBurst', () => {
  let seen: (HaloBurst | null)[] = [];
  function Probe({ p, d, now }: { p: BurstSource | null; d: BurstSource | null; now: number }) {
    const b = useHaloBurst({ event: p, dashpal: d, now });
    seen.push(b);
    return <Text>{b?.key ?? 'none'}</Text>;
  }
  beforeEach(() => {
    seen = [];
  });

  test('a speeding alert and a resend never burst; a hard brake and driver not visible do', async () => {
    const r = await render(<Probe p={event(T, T + 1500, 'speeding')} d={dashpal('2:1:0', T + 1500, 3, { resend: true })} now={T} />);
    expect(seen.at(-1)).toBeNull();
    await r.rerender(<Probe p={event(T + 20, T + 1520)} d={null} now={T + 20} />);
    expect(seen.at(-1)).toMatchObject({ key: `event:hard_brake:${T + 20}`, severity: 1, pulses: 3 });
    await r.rerender(<Probe p={null} d={dashpal('1:1:0', T + 1540, 2, { sound: 6 })} now={T + 40} />);
    expect(seen.at(-1)).toMatchObject({ key: 'dashpal:1:1:0', pulses: 3 });
  });

  test('a flash that arrives while the app is in the background never bursts, also after it comes back', async () => {
    let listener: ((s: string) => void) | null = null;
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, fn: (s: string) => void) => {
      listener = fn;
      return { remove: () => {} };
    }) as unknown as typeof AppState.addEventListener);
    const r = await render(<Probe p={null} d={null} now={T} />);
    await act(async () => listener!('background'));
    await r.rerender(<Probe p={null} d={dashpal('5:1:0', T + 1600)} now={T + 100} />);
    expect(seen.at(-1)).toBeNull();
    await act(async () => listener!('active'));
    await r.rerender(<Probe p={null} d={dashpal('5:1:0', T + 1600)} now={T + 200} />);
    expect(seen.at(-1)).toBeNull();
    spy.mockRestore();
  });
});
