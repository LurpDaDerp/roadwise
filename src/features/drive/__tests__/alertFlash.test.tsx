// The phone's event flash on the driving screen (drive-screen design §4.9): what is left of 1.5 s on
// the row clock, never a stale one, never the one standing at mount.
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { type HudAlert, useAlertFlash } from '../EventBanner';

const T = 1_790_000_000_000;
let now = T;
function Probe({ alert, rowTs }: { alert: HudAlert | null; rowTs: number | null }) {
  const f = useAlertFlash(alert, rowTs, 1500, () => now);
  return <Text testID="f">{f === null ? 'none' : `${f.type}@${f.until - T}`}</Text>;
}
const brake = (at: number): HudAlert => ({ type: 'hard_brake', tier: 'severe', at });

beforeEach(() => {
  jest.useFakeTimers();
  now = T;
});
afterEach(() => jest.useRealTimers());

test('a live alert (raised on the newest row) shows for 1.5 s with its end time', async () => {
  const r = await render(<Probe alert={null} rowTs={T - 1000} />);
  await r.rerender(<Probe alert={brake(T)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent('hard_brake@1500');
  await act(() => jest.advanceTimersByTime(1499));
  expect(screen.getByTestId('f')).toHaveTextContent('hard_brake@1500');
  await act(() => jest.advanceTimersByTime(1));
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test('an alert 1 s old on the row clock shows for the 0.5 s left', async () => {
  const r = await render(<Probe alert={null} rowTs={T} />);
  await r.rerender(<Probe alert={brake(T - 1000)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent('hard_brake@500');
  await act(() => jest.advanceTimersByTime(500));
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test('an alert 5 s old (raised while RoadWise was in the background) never shows; nor does the standing one at mount', async () => {
  const r = await render(<Probe alert={brake(T - 9000)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
  await r.rerender(<Probe alert={brake(T - 5000)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test('a stale alert arriving over a fresh one takes the fresh one down (nothing sticks)', async () => {
  const r = await render(<Probe alert={null} rowTs={T} />);
  await r.rerender(<Probe alert={brake(T)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent(/hard_brake/);
  await r.rerender(<Probe alert={{ type: 'hard_corner', tier: 'minor', at: T - 4000 }} rowTs={T + 1000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
  await act(() => jest.advanceTimersByTime(5000));
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test('no row yet counts as age 0; a repeated alert (same type, new time) is a new flash', async () => {
  const r = await render(<Probe alert={null} rowTs={null} />);
  await r.rerender(<Probe alert={brake(T)} rowTs={null} />);
  expect(screen.getByTestId('f')).toHaveTextContent('hard_brake@1500');
  await act(() => jest.advanceTimersByTime(2000));
  now = T + 60_000;
  await r.rerender(<Probe alert={{ type: 'hard_corner', tier: 'moderate', at: T + 60_000 }} rowTs={T + 60_000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('hard_corner@61500');
  now = T + 120_000;
  await r.rerender(<Probe alert={{ type: 'hard_corner', tier: 'moderate', at: T + 120_000 }} rowTs={T + 120_000} />);
  expect(screen.getByTestId('f')).toHaveTextContent(/hard_corner@121500/);
});
