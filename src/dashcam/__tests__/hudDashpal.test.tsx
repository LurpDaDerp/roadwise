// The driving screen's DashPal hooks (drive-screen design §5.5): the flash is never stale, not even
// for one render, and carries the JS time it ends; the held alert follows the link.
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { DashcamVisual } from '../alerts';
import { createFakeDashcamRuntime, PAIRED } from '../__fixtures__/fakeRuntime';
import { setActiveDashcam } from '../registry';
import { useDashpalFlash, useDashpalHeld } from '../ui/HudDashpal';

const T = 1_790_000_000_000;
let now = T;
const clock = () => now;

/** Every render's flash, in order. */
let seen: (string | null)[] = [];
function FlashProbe() {
  const f = useDashpalFlash(clock);
  seen.push(f === null ? null : `${f.key}@${f.until}`);
  return <Text testID="flash">{f === null ? 'none' : f.key}</Text>;
}
function HeldProbe() {
  const h = useDashpalHeld();
  return <Text testID="held">{h === null ? 'none' : `${h.sound}/${h.tier}/${h.level}/${h.since}`}</Text>;
}

const visual = (key: string, at: number): DashcamVisual => ({ key, alertId: 1, sound: 1, tier: 2, level: 0, onPhone: true, at, resend: false });

beforeEach(() => {
  jest.useFakeTimers();
  now = T;
  seen = [];
});
afterEach(async () => {
  await act(async () => setActiveDashcam(null));
  jest.useRealTimers();
});

test('a visual 5 s old at mount is never returned, not even on the first render', async () => {
  setActiveDashcam(createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected', visual: visual('1:1:0', T - 5000) } }));
  await render(<FlashProbe />);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((v) => v === null)).toBe(true);
});

test('a fresh visual shows until at + 1.5 s, with that end time; then it is gone', async () => {
  const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
  setActiveDashcam(rt);
  await render(<FlashProbe />);
  await act(async () => rt.set({ link: { visual: visual('2:1:0', T) } }));
  expect(screen.getByTestId('flash')).toHaveTextContent('2:1:0');
  expect(seen.at(-1)).toBe(`2:1:0@${T + 1500}`);
  now = T + 1499;
  await act(async () => jest.advanceTimersByTime(1499));
  expect(screen.getByTestId('flash')).toHaveTextContent('2:1:0');
  now = T + 1500;
  await act(async () => jest.advanceTimersByTime(1));
  expect(screen.getByTestId('flash')).toHaveTextContent('none');
});

test('a visual 1 s old at mount shows for the 0.5 s left', async () => {
  setActiveDashcam(createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected', visual: visual('3:1:0', T - 1000) } }));
  await render(<FlashProbe />);
  expect(screen.getByTestId('flash')).toHaveTextContent('3:1:0');
  now = T + 500;
  await act(async () => jest.advanceTimersByTime(500));
  expect(screen.getByTestId('flash')).toHaveTextContent('none');
});

test('held follows the link: none, an alert, none again', async () => {
  const rt = createFakeDashcamRuntime({ link: { paired: PAIRED, lifecycle: 'connected' } });
  setActiveDashcam(rt);
  await render(<HeldProbe />);
  expect(screen.getByTestId('held')).toHaveTextContent('none');
  await act(async () => rt.set({ link: { held: { sound: 3, tier: 3, level: 1, since: T } } }));
  expect(screen.getByTestId('held')).toHaveTextContent(`3/3/1/${T}`);
  await act(async () => rt.set({ link: { held: null } }));
  expect(screen.getByTestId('held')).toHaveTextContent('none');
});
