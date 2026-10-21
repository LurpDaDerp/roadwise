// The halo's shake on an event: once per event, fresh on the row clock, only in front, sized by tier.
import { act, render } from '@testing-library/react-native';
import type { Tier } from '@scoring';
import { AppState } from 'react-native';

import type { EventShake } from '@/core/engine/engine.types';
import type { HaloShake } from '@/ui/drive';

import { useEventShake } from '../useEventShake';

const T = 1_790_000_000_000;
const ev = (key: string, tier: Tier, at: number): EventShake => ({ key, tier, at });

const seen: (HaloShake | null)[] = [];
function Probe({ e, rowTs }: { e: EventShake | null; rowTs: number | null }) {
  seen.push(useEventShake(e, rowTs));
  return null;
}

let listener: ((s: string) => void) | null = null;
let spy: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  seen.length = 0;
  listener = null;
  spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, fn: (s: string) => void) => {
    listener = fn;
    return { remove: () => {} };
  }) as unknown as typeof AppState.addEventListener);
});
afterEach(() => {
  spy.mockRestore();
  jest.useRealTimers();
});

test('a new event shakes for what is left of 1.5 s on the row clock, with its tier, then not again', async () => {
  const r = await render(<Probe e={null} rowTs={T} />);
  expect(seen.at(-1)).toBeNull();
  await r.rerender(<Probe e={ev('hard_brake:1', 'severe', T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).toEqual({ key: `hard_brake:1@${T + 1000}`, tier: 'severe' });
  await act(() => jest.advanceTimersByTime(1500));
  expect(seen.at(-1)).toBeNull();
  await r.rerender(<Probe e={ev('hard_brake:1', 'severe', T + 1000)} rowTs={T + 2000} />);
  expect(seen.at(-1)).toBeNull();
});

test("a speeding episode's grace end shakes with the episode's tier", async () => {
  const r = await render(<Probe e={null} rowTs={T} />);
  await r.rerender(<Probe e={ev('speeding:2:grace', 'minor', T + 5000)} rowTs={T + 5000} />);
  expect(seen.at(-1)).toEqual({ key: `speeding:2:grace@${T + 5000}`, tier: 'minor' });
});

test('one that happened 1.5 s or more before the row it reaches the screen with never shakes', async () => {
  const r = await render(<Probe e={null} rowTs={T} />);
  await r.rerender(<Probe e={ev('hard_corner:2', 'moderate', T)} rowTs={T + 1500} />);
  expect(seen.at(-1)).toBeNull();
});

test('the one standing when the screen mounts never shakes', async () => {
  await render(<Probe e={ev('hard_brake:1', 'severe', T)} rowTs={T} />);
  expect(seen.every((s) => s === null)).toBe(true);
});

test('one first seen while RoadWise is not in front never shakes, also after it comes back', async () => {
  const r = await render(<Probe e={null} rowTs={T} />);
  await act(async () => listener!('background'));
  await r.rerender(<Probe e={ev('hard_accel:3', 'moderate', T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).toBeNull();
  await act(async () => listener!('active'));
  await r.rerender(<Probe e={ev('hard_accel:3', 'moderate', T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).toBeNull();
  // the next one, in front, shakes
  await r.rerender(<Probe e={ev('hard_brake:4', 'minor', T + 2000)} rowTs={T + 2000} />);
  expect(seen.at(-1)).toEqual({ key: `hard_brake:4@${T + 2000}`, tier: 'minor' });
});

test('a shake cut short by leaving the app never replays on coming back', async () => {
  const r = await render(<Probe e={null} rowTs={T} />);
  await r.rerender(<Probe e={ev('hard_brake:1', 'severe', T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).not.toBeNull();
  await act(async () => listener!('background'));
  expect(seen.at(-1)).toBeNull();
  await act(async () => listener!('active'));
  expect(seen.at(-1)).toBeNull();
});
