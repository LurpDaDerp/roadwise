// The halo's shake when points come off: once per deduction, fresh on the row clock, only in front.
import { act, render } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { HaloDeduction } from '@/ui/drive';

import { useDeductionShake, type LiveDeduction } from '../useDeductionShake';

const T = 1_790_000_000_000;
const ded = (key: string, points: number, at: number): LiveDeduction => ({ key, points, at });

const seen: (HaloDeduction | null)[] = [];
function Probe({ d, rowTs }: { d: LiveDeduction | null; rowTs: number | null }) {
  seen.push(useDeductionShake(d, rowTs));
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

test('a new deduction shakes for what is left of 1.5 s on the row clock, then not again', async () => {
  const r = await render(<Probe d={null} rowTs={T} />);
  expect(seen.at(-1)).toBeNull();
  await r.rerender(<Probe d={ded('hard_brake:1', 20, T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).toEqual({ key: `hard_brake:1@${T + 1000}`, points: 20 });
  await act(() => jest.advanceTimersByTime(1500));
  expect(seen.at(-1)).toBeNull();
  await r.rerender(<Probe d={ded('hard_brake:1', 20, T + 1000)} rowTs={T + 2000} />);
  expect(seen.at(-1)).toBeNull();
});

test('one that came off 1.5 s or more before the row it reaches the screen with never shakes', async () => {
  const r = await render(<Probe d={null} rowTs={T} />);
  await r.rerender(<Probe d={ded('speeding:2', 12, T)} rowTs={T + 1500} />);
  expect(seen.at(-1)).toBeNull();
});

test('one first seen while RoadWise is not in front never shakes, also after it comes back', async () => {
  const r = await render(<Probe d={null} rowTs={T} />);
  await act(async () => listener!('background'));
  await r.rerender(<Probe d={ded('phone_pickup:3', 32, T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).toBeNull();
  await act(async () => listener!('active'));
  await r.rerender(<Probe d={ded('phone_pickup:3', 32, T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).toBeNull();
  // the next one, in front, shakes
  await r.rerender(<Probe d={ded('hard_brake:4', 20, T + 2000)} rowTs={T + 2000} />);
  expect(seen.at(-1)).toEqual({ key: `hard_brake:4@${T + 2000}`, points: 20 });
});

test('a shake cut short by leaving the app never replays on coming back', async () => {
  const r = await render(<Probe d={null} rowTs={T} />);
  await r.rerender(<Probe d={ded('hard_brake:1', 20, T + 1000)} rowTs={T + 1000} />);
  expect(seen.at(-1)).not.toBeNull();
  await act(async () => listener!('background'));
  expect(seen.at(-1)).toBeNull();
  await act(async () => listener!('active'));
  expect(seen.at(-1)).toBeNull();
});
