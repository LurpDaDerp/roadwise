import { fireEvent, render, screen } from '@testing-library/react-native';

import type { SpeedTrace } from '@/core/engine/speedTrace';
import { plainBundle } from '@/ui/sky/palette';
import { ThemeProvider } from '@/ui/theme';

import { draw, drive, event } from '../__fixtures__/drives';
import { formatClock } from '../format';
import { SpeedChart } from '../SpeedChart';

// Dynamic Type at the phone's default (jest's own window says 2×).
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

const H = { includeHiddenElements: true } as const;

/** A 24 min drive, one point a minute: 20 to 43 mph, a 35 limit from minute 10, no speed at minute 5. */
const TRACE: SpeedTrace = {
  widthS: 60,
  points: Array.from({ length: 24 }, (_, i) => ({ t: i * 60, v: i === 5 ? null : 20 + i, l: i >= 10 ? 35 : null })),
};

const d = drive({ speedTrace: TRACE });
const speeding = (id: string, minute: number, durationS: number, over = {}) =>
  event({ id, type: 'speeding', tier: 'moderate', startedAt: d.startedAt + minute * 60_000, durationS, ...over });

/** ARGB as react-native-svg holds a colour. */
const argb = (hex: string) => ({ payload: (0xff000000 | parseInt(hex.slice(1), 16)) >>> 0 });

test('nothing without a trace or with fewer than two points with a speed', async () => {
  await draw(<SpeedChart drive={drive({ speedTrace: null })} events={[]} units="mi" />);
  expect(screen.queryByTestId('speed-chart-card', H)).toBeNull();
  await draw(<SpeedChart drive={drive()} events={[]} units="mi" />);
  expect(screen.queryByTestId('speed-chart-card', H)).toBeNull();
  await draw(<SpeedChart drive={drive({ speedTrace: { widthS: 5, points: [{ t: 0, v: 30, l: 25 }, { t: 5, v: null, l: 25 }] } })} events={[]} units="mi" />);
  expect(screen.queryByTestId('speed-chart-card', H)).toBeNull();
});

test('titled "Speed" with its legend, the speed solid in the page ink and the limit dashed in the muted ink', async () => {
  await draw(<SpeedChart drive={d} events={[]} units="mi" />);
  const light = plainBundle('light').colors;
  expect(screen.getByTestId('speed-chart-title')).toHaveTextContent('Speed');
  expect(screen.getByTestId('speed-chart-legend', H)).toHaveTextContent('Your speed·Speed limit');
  // The missing minute never breaks the line: one unbroken path.
  const runs = screen.getAllByTestId('speed-chart-speed', H);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.props.stroke).toMatchObject(argb(light.text));
  const limit = screen.getByTestId('speed-chart-limit', H);
  expect(limit.props.stroke).toMatchObject(argb(light.textMuted));
  expect(limit.props.strokeDasharray).toBeTruthy();
});

test('Y from 0 to the fastest value rounded up to 10, with units; X from the start to the end clock times', async () => {
  await draw(<SpeedChart drive={d} events={[]} units="mi" />);
  expect(screen.getAllByTestId('speed-chart-y-label', H).map((n) => n.props.children)).toEqual(['50 mph', '25 mph', '0 mph']);
  expect(screen.getByTestId('speed-chart-start', H)).toHaveTextContent(formatClock(d.startedAt));
  expect(screen.getByTestId('speed-chart-end', H)).toHaveTextContent(formatClock(d.endedAt!));
});

test('in km/h for a kilometre driver', async () => {
  await draw(<SpeedChart drive={d} events={[]} units="km" />);
  // 43 mph is 69 km/h.
  expect(screen.getAllByTestId('speed-chart-y-label', H).map((n) => n.props.children)).toEqual(['70 km/h', '35 km/h', '0 km/h']);
});

test('each active speeding episode is a band in its tier colour; one removed by a report is not', async () => {
  const light = plainBundle('light').colors;
  await draw(<SpeedChart drive={d} events={[speeding('s1', 12, 40), speeding('s2', 18, 30, { tier: 'severe' }), speeding('s3', 20, 20, { removed: true }), event()]} units="mi" />);
  const bands = screen.getAllByTestId('speed-chart-band', H);
  expect(bands).toHaveLength(2);
  expect(bands[0]!.props.fill).toMatchObject(argb(light.signal.moderate.fill));
  expect(bands[1]!.props.fill).toMatchObject(argb(light.signal.severe.fill));
});

test('one element for a screen reader, saying how often and how long it was over the limit', async () => {
  await draw(<SpeedChart drive={d} events={[speeding('s1', 12, 40), speeding('s2', 18, 30)]} units="mi" />);
  const chart = screen.getByTestId('speed-chart');
  expect(chart).toHaveProp('accessible', true);
  expect(chart).toHaveProp('accessibilityRole', 'image');
  expect(chart).toHaveProp('accessibilityLabel', 'Speed chart. Over the limit 2 times, 1 minute 10 seconds in all.');
  await draw(<SpeedChart drive={d} events={[]} units="mi" />);
  expect(screen.getByTestId('speed-chart')).toHaveProp('accessibilityLabel', 'Speed chart. Never over the limit.');
});

test('the plot takes the width the card lays out', async () => {
  await draw(<SpeedChart drive={d} events={[]} units="mi" />);
  const before = screen.getByTestId('speed-chart-plot', H).props.width as number;
  await fireEvent(screen.getByTestId('speed-chart'), 'layout', { nativeEvent: { layout: { width: 500, height: 200 } } });
  const after = screen.getByTestId('speed-chart-plot', H).props.width as number;
  expect(after).toBeGreaterThan(before);
  expect(after).toBeLessThan(500);
});

test('dark mode draws in the dark ink', async () => {
  const dark = plainBundle('dark').colors;
  await render(
    <ThemeProvider scheme="dark" reduceMotion>
      <SpeedChart drive={d} events={[]} units="mi" />
    </ThemeProvider>
  );
  expect(screen.getAllByTestId('speed-chart-speed', H)[0]!.props.stroke).toMatchObject(argb(dark.text));
});
