// A problem spot's nudge on the driving screen (spots design §7.5): its words per kind, read out as
// an alert, for 4 s on the row clock, never the one standing at mount or one already 4 s old.
import { act, render, screen, within } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { SPOT_NUDGE_MS } from '@/core/spots/constants';
import type { SpotKind, SpotNudge } from '@/core/spots/types';
import { HUD } from '@/ui/drive';

import { SpotNudgeLine, useSpotNudgeFlash } from '../SpotNudge';

const T = 1_790_000_000_000;
const nudge = (kind: SpotKind, at: number, spotId = 's1'): SpotNudge => ({ key: `${spotId}@${at}`, spotId, kind, at });

function Probe({ n, rowTs }: { n: SpotNudge | null; rowTs: number | null }) {
  const f = useSpotNudgeFlash(n, rowTs, () => Date.now());
  return <Text testID="f">{f === null ? 'none' : `${f.kind}@${f.until - T}`}</Text>;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
});
afterEach(() => jest.useRealTimers());

test('the four lines, one per kind, four words at most', async () => {
  const lines: Record<SpotKind, string> = {
    speeding: 'Watch your speed here',
    hard_brake: 'Brake early here',
    hard_corner: 'Take this turn slower',
    hard_accel: 'Start gently here',
  };
  for (const [kind, words] of Object.entries(lines) as [SpotKind, string][]) {
    const r = await render(<SpotNudgeLine nudge={nudge(kind, T)} palette={HUD.day} compact={false} />);
    expect(within(screen.getByTestId('hud-spot')).getByText(words)).toBeTruthy();
    expect(words.split(' ').length).toBeLessThanOrEqual(4);
    await r.unmount();
  }
});

test('a place pin in the screen ink on a chrome bar, never a tier colour; read out as an alert; no touch target', async () => {
  await render(<SpotNudgeLine nudge={nudge('speeding', T)} palette={HUD.night} compact />);
  const bar = screen.getByTestId('hud-spot');
  expect(bar).toHaveStyle({ backgroundColor: HUD.night.chrome, borderColor: HUD.night.chromeEdge, borderWidth: 2 });
  expect(screen.getByRole('alert')).toHaveProp('accessibilityLabel', 'Watch your speed here');
  expect(screen.getByTestId('hud-spot-icon', { includeHiddenElements: true })).toHaveStyle({ color: HUD.night.ink });
  expect(screen.getByText('Watch your speed here')).toHaveStyle({ fontSize: 16 });
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('a new nudge shows for 4 s on the row clock, then not again', async () => {
  expect(SPOT_NUDGE_MS).toBe(4000);
  const r = await render(<Probe n={null} rowTs={T} />);
  await r.rerender(<Probe n={nudge('hard_brake', T + 1000)} rowTs={T + 1000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('hard_brake@4000');
  await act(() => jest.advanceTimersByTime(3999));
  expect(screen.getByTestId('f')).toHaveTextContent(/hard_brake/);
  await act(() => jest.advanceTimersByTime(1));
  expect(screen.getByTestId('f')).toHaveTextContent('none');
  await r.rerender(<Probe n={nudge('hard_brake', T + 1000)} rowTs={T + 6000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test('one that reaches the screen 1 s late shows for the 3 s left; 4 s late, never', async () => {
  const r = await render(<Probe n={null} rowTs={T} />);
  await r.rerender(<Probe n={nudge('speeding', T)} rowTs={T + 1000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('speeding@3000');
  await r.rerender(<Probe n={nudge('speeding', T + 2000, 's2')} rowTs={T + 6000} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test('the nudge standing when the screen mounts is not shown', async () => {
  await render(<Probe n={nudge('hard_corner', T)} rowTs={T} />);
  expect(screen.getByTestId('f')).toHaveTextContent('none');
});

test.each([false, true])('no self-scaling text (adjustsFontSizeToFit, minimumFontScale): one line, tail-ellipsized, on whole points (compact %s)', async (compact) => {
  await render(<SpotNudgeLine nudge={nudge('speeding', T)} palette={HUD.day} compact={compact} />);
  const el = screen.getByText('Watch your speed here');
  expect(el.props.adjustsFontSizeToFit).toBeUndefined();
  expect(el.props.minimumFontScale).toBeUndefined();
  expect(el.props.allowFontScaling).toBe(false);
  expect(el.props.numberOfLines).toBe(1);
  // centred in the bar's 36 pt content box (40 less its outlines): the top is a whole number of points
  const { lineHeight } = StyleSheet.flatten(el.props.style) as { lineHeight: number };
  expect(Number.isInteger((36 - lineHeight) / 2)).toBe(true);
});
