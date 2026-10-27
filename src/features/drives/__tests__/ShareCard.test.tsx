import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { processColor } from 'react-native';
import { useState } from 'react';

import { ThemeProvider } from '@/ui';
import { plainBundle } from '@/ui/sky/palette';

import { draw, press, ROUTE } from '../__fixtures__/drives';
import { textsUnder } from '../__fixtures__/texts';
import { resetMapsCache } from '../RouteMap';
import { MAP_BAND, MAP_BOX, ShareSheet, type ShareCardData } from '../ShareCard';
import { bandAlpha, MAP_TIMEOUT_MS, routePath, shareFrame } from '../ShareMap';
import { meritCardStops, meritInk } from '../merit';

jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => 'file:///card.png') }));

const mockTakeSnapshot = jest.fn<Promise<string>, [unknown]>(async () => 'file:///map.png');

jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  class MapView extends React.Component<{ onMapReady?: () => void; testID?: string }> {
    takeSnapshot = mockTakeSnapshot;
    componentDidMount() {
      // The native map reports ready after it mounts, never during.
      void Promise.resolve().then(() => this.props.onMapReady?.());
    }
    render() {
      return <View {...this.props} />;
    }
  }
  return { __esModule: true, default: MapView, Marker: View, Polyline: View };
});

/** The map layers are hidden from screen readers (the card says it all), so queries look inside. */
const H = { includeHiddenElements: true } as const;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharing = () => require('expo-sharing') as { shareAsync: jest.Mock };

const data: ShareCardData = { runs: [ROUTE], miles: 12, durationS: 1440, score: 92, tier: 4, units: 'mi' };

const sheet = (visible = true, d: ShareCardData = data) => <ShareSheet visible={visible} data={d} onClose={jest.fn()} />;

/** Every string drawn on the card, in order. */
function cardTexts(): string[] {
  return textsUnder('share-card').map((x) => x.text);
}
const themed = (visible: boolean) => (
  <ThemeProvider scheme="light" reduceMotion>
    {sheet(visible)}
  </ThemeProvider>
);

/** The snapshot arrives and its image loads into the card. */
async function mapLoads() {
  await act(async () => {});
  await fireEvent(screen.getByTestId('share-map-image', H), 'load');
}

beforeEach(() => {
  resetMapsCache();
  mockTakeSnapshot.mockReset();
  mockTakeSnapshot.mockImplementation(async () => 'file:///map.png');
  sharing().shareAsync.mockClear();
});

test('Show map is off every time the sheet opens', async () => {
  const { rerender } = await draw(sheet());
  expect(screen.getByTestId('share-map-toggle')).toHaveProp('value', false);
  await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
  expect(screen.getByTestId('share-map-toggle')).toHaveProp('value', true);
  await rerender(themed(false));
  await rerender(themed(true));
  expect(screen.getByTestId('share-map-toggle')).toHaveProp('value', false);
  expect(screen.queryByTestId('share-map', H)).toBeNull();
});

test('off: the card is the plain route sketch, no map, and Share never waits on one', async () => {
  await draw(sheet());
  expect(screen.queryByTestId('share-map', H)).toBeNull();
  expect(screen.queryByTestId('share-map-view', H)).toBeNull();
  expect(screen.queryByTestId('share-map-note')).toBeNull();
  await press(screen.getByTestId('share-image'));
  expect(mockTakeSnapshot).not.toHaveBeenCalled();
  expect(sharing().shareAsync).toHaveBeenCalledWith('file:///card.png', expect.objectContaining({ mimeType: 'image/png' }));
});

test('on: the snapshot of the route area is the backdrop, the route is drawn over it, and the footnote says so', async () => {
  await draw(sheet());
  await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
  expect(screen.getByTestId('share-map-view', H)).toHaveProp('userInterfaceStyle', 'dark');
  expect(screen.getByTestId('share-map-view', H)).toHaveProp('showsPointsOfInterests', false);
  expect(screen.getByTestId('share-map-view', H)).toHaveProp('scrollEnabled', false);
  expect(screen.getByTestId('share-map-note')).toHaveTextContent('The map shows the area around your trimmed route.');
  await mapLoads();
  // The snapshot renders the card's own region at the card's size.
  const frame = shareFrame([ROUTE], 320, 400, MAP_BOX)!;
  expect(mockTakeSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({
      width: 320,
      height: 400,
      format: 'png',
      result: 'file',
      region: expect.objectContaining({ latitudeDelta: frame.north - frame.south, longitudeDelta: frame.east - frame.west }),
    })
  );
  expect(screen.getByTestId('share-map-image', H)).toHaveProp('source', { uri: 'file:///map.png' });
  expect(screen.queryByTestId('share-map-view', H)).toBeNull();
  expect(screen.getByTestId('share-map-route', H)).toBeOnTheScreen();
  await press(screen.getByTestId('share-image'));
  expect(sharing().shareAsync).toHaveBeenCalledTimes(1);
});

test('a map that fails to load says so and shares nothing; Share tries it again', async () => {
  mockTakeSnapshot.mockImplementation(async () => {
    throw new Error('offline');
  });
  await draw(sheet());
  await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
  await act(async () => {});
  expect(screen.getByTestId('share-map-error')).toHaveTextContent(/Couldn't load the map\. Turn off Show map or try again\.$/);
  expect(screen.queryByTestId('share-map-route', H)).toBeNull();
  await press(screen.getByTestId('share-image'));
  await act(async () => {});
  expect(mockTakeSnapshot).toHaveBeenCalledTimes(2);
  expect(sharing().shareAsync).not.toHaveBeenCalled();
  expect(screen.getByTestId('share-map-error')).toBeOnTheScreen();
  // Turning the map off shares the plain card.
  await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', false);
  expect(screen.queryByTestId('share-map-error')).toBeNull();
  await press(screen.getByTestId('share-image'));
  expect(sharing().shareAsync).toHaveBeenCalledTimes(1);
});

test('Share waits for a map still loading, and shares nothing when it never arrives', async () => {
  jest.useFakeTimers();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureRef } = require('react-native-view-shot') as { captureRef: jest.Mock };
    captureRef.mockClear();
    mockTakeSnapshot.mockImplementation(() => new Promise(() => {}));
    await draw(sheet());
    await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
    await act(async () => jest.advanceTimersByTime(MAP_TIMEOUT_MS - 1));
    expect(screen.queryByTestId('share-map-error')).toBeNull();
    // Share is pressed while the map is still loading: nothing is captured yet.
    const pressed = press(screen.getByTestId('share-image'));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(captureRef).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await pressed;
    expect(screen.getByTestId('share-map-error')).toBeOnTheScreen();
    expect(captureRef).not.toHaveBeenCalled();
    expect(sharing().shareAsync).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('a share left waiting for the map when the sheet closes never resumes on a later map', async () => {
  let setShown: (v: boolean) => void = () => {};
  function Controlled() {
    const [shown, set] = useState(true);
    setShown = set;
    return <ShareSheet visible={shown} data={data} onClose={jest.fn()} />;
  }
  jest.useFakeTimers();
  try {
    // The first map never arrives; Share waits on it, and the sheet closes meanwhile.
    mockTakeSnapshot.mockImplementationOnce(() => new Promise(() => {}));
    await draw(<Controlled />);
    await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
    setTimeout(() => setShown(false), 10);
    const pressed = press(screen.getByTestId('share-image'));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(10);
    await pressed;
    // Opened again later, with Show map switched on and the map loading this time.
    await act(async () => setShown(true));
    await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
    await mapLoads();
    expect(screen.getByTestId('share-map-route', H)).toBeOnTheScreen();
    expect(sharing().shareAsync).not.toHaveBeenCalled();
    // A tap of its own shares.
    await press(screen.getByTestId('share-image'));
    expect(sharing().shareAsync).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('the route is framed inside the box and lands on it through the same projection', () => {
  const box = MAP_BOX;
  const b = shareFrame([ROUTE], 320, 400, box)!;
  expect(b.north).toBeGreaterThan(b.south);
  expect(b.east).toBeGreaterThan(b.west);
  const d = routePath([ROUTE], b, 320, 400)!;
  const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  for (const [x, y] of pts) {
    expect(x).toBeGreaterThanOrEqual(box.left - 0.1);
    expect(x).toBeLessThanOrEqual(box.right + 0.1);
    expect(y).toBeGreaterThanOrEqual(box.top - 0.1);
    expect(y).toBeLessThanOrEqual(box.bottom + 0.1);
  }
  // The route fills the box on its longer side: tall here, so top to bottom.
  const ys = pts.map((p) => p[1]);
  expect(Math.min(...ys)).toBeCloseTo(box.top, 0);
  expect(Math.max(...ys)).toBeCloseTo(box.bottom, 0);
  // Two runs stay two subpaths; no route frames nothing.
  expect(routePath([ROUTE.slice(0, 10), ROUTE.slice(20)], b, 320, 400)!.match(/M/g)).toHaveLength(2);
  expect(shareFrame([[ROUTE[0]!]], 320, 400, box)).toBeNull();
});

test('the sky fades the map out over long eased stretches: solid behind the wordmark and the facts, soft around the route', async () => {
  // Opaque behind the wordmark (ends near y = 44) and the facts' text (starts near y = 252): 4.5:1 holds.
  expect(bandAlpha(0, MAP_BAND)).toBe(1);
  expect(bandAlpha(40, MAP_BAND)).toBe(1);
  expect(bandAlpha(252, MAP_BAND)).toBeGreaterThanOrEqual(0.97);
  expect(bandAlpha(300, MAP_BAND)).toBe(1);
  // Nothing covers the map in the clear middle, and the fades are long (never a hard edge).
  expect(bandAlpha(MAP_BAND.topEnd, MAP_BAND)).toBe(0);
  expect(bandAlpha(MAP_BAND.bottomStart, MAP_BAND)).toBe(0);
  expect(MAP_BAND.topEnd - MAP_BAND.topSolid).toBeGreaterThanOrEqual(60);
  expect(MAP_BAND.bottomSolid - MAP_BAND.bottomStart).toBeGreaterThanOrEqual(100);
  // The route's edges keep clear of both solid zones, and the sky covers them under half.
  expect(MAP_BOX.top - MAP_BAND.topSolid).toBeGreaterThanOrEqual(36);
  expect(MAP_BAND.bottomSolid - MAP_BOX.bottom).toBeGreaterThanOrEqual(48);
  expect(bandAlpha(MAP_BOX.top, MAP_BAND)).toBeLessThan(0.5);
  expect(bandAlpha(MAP_BOX.bottom, MAP_BAND)).toBeLessThan(0.5);
  // Eased: the cover only grows towards the facts, and only shrinks away from the wordmark.
  let last = 1;
  for (let y = MAP_BAND.topSolid; y <= MAP_BAND.topEnd; y += 4) {
    expect(bandAlpha(y, MAP_BAND)).toBeLessThanOrEqual(last);
    last = bandAlpha(y, MAP_BAND);
  }
  last = 0;
  for (let y = MAP_BAND.bottomStart; y <= MAP_BAND.bottomSolid; y += 4) {
    expect(bandAlpha(y, MAP_BAND)).toBeGreaterThanOrEqual(last);
    last = bandAlpha(y, MAP_BAND);
  }
  // Both gradients are multi-stop on the card, the preview and the shared image alike.
  await draw(sheet());
  await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
  for (const id of ['share-map-fade-top', 'share-map-fade-bottom']) {
    const g = screen.getByTestId(id, H);
    expect(g.props.colors.length).toBeGreaterThanOrEqual(5);
    expect(g.props.locations).toHaveLength(g.props.colors.length);
  }
});

describe('the card holds only time, distance and score', () => {
  test("a tiered drive: the wordmark, then the icon beside the score and distance and time, each labelled, in the tier's ink", async () => {
    await draw(sheet());
    expect(cardTexts()).toEqual(['RoadWise', '92', 'score', '12.0 mi', 'distance', '24 min', 'time']);
    const card = screen.getByTestId('share-card');
    expect(within(card).getByTestId('share-facts-icon', H)).toBeTruthy();
    const ink = meritInk(4, meritCardStops(4));
    for (const id of ['share-facts-score', 'share-facts-distance', 'share-facts-time']) expect(within(card).getByTestId(id)).toHaveStyle({ color: ink });
    // no date, place, event count, rating, badge, points or tier name
    const all = cardTexts().join(' ');
    expect(all).not.toMatch(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)|→|event|Safety Rating|Clean drive|pts?|points|merit|Home|School/i);
    expect(within(card).getByLabelText('Score 92 out of 100, 12.0 miles, 24 minutes, merit 4 of 5.')).toBeOnTheScreen();
    // A fixed-size image: its text never follows Dynamic Type.
    expect(within(card).getByTestId('share-facts-score')).toHaveProp('allowFontScaling', false);
    expect(within(card).getByTestId('share-facts-score')).toHaveStyle({ fontSize: 44 });
    expect(within(card).getByTestId('share-facts-distance')).toHaveStyle({ fontSize: 28 });
  });

  test('a tiered drive: the background is its merit gradient, with white ink', async () => {
    await draw(sheet());
    expect(screen.getByTestId('share-card-bg').props.colors).toEqual(meritCardStops(4).map((c) => processColor(c)));
    expect(screen.getByTestId('share-wordmark')).toHaveStyle({ color: '#FFFFFF' });
    const ink = meritInk(4, meritCardStops(4));
    expect(screen.getByTestId('share-facts-score')).toHaveStyle({ color: ink });
    expect(screen.getByTestId('share-facts-distance-label')).toBeTruthy();
  });

  test('with the map on, the map fades into the merit background and the credit is 70 % white', async () => {
    await draw(sheet());
    await fireEvent(screen.getByTestId('share-map-toggle'), 'valueChange', true);
    const fade = screen.getByTestId('share-map-fade-top', H);
    expect(fade.props.colors[0]).toBe(processColor(meritCardStops(4)[0]));
    expect(within(screen.getByTestId('share-card')).getByText('Map © Apple')).toHaveStyle({ color: 'rgba(255, 255, 255, 0.7)' });
  });

  test('a drive with no score shows a dash, no icon, and the plain ink', async () => {
    await draw(sheet(true, { ...data, score: null, tier: null, miles: 0.3, durationS: 70 }));
    expect(cardTexts()).toEqual(['RoadWise', '—', 'score', '0.3 mi', 'distance', '1 min', 'time']);
    expect(screen.queryByTestId('share-facts-icon', H)).toBeNull();
    expect(screen.getByTestId('share-facts-score')).toHaveStyle({ color: plainBundle('light').onScene.text });
    // no tier: the hour's sky, not a merit gradient
    expect(screen.getByTestId('share-card-bg').props.colors).toEqual(plainBundle('light').sky.scene.map((c) => processColor(c)));
    expect(screen.getByLabelText('No score, 0.3 miles, 1 minute.')).toBeOnTheScreen();
  });

  test('the "Show map" switch is still there, off when the sheet opens', async () => {
    await draw(sheet());
    expect(screen.getByTestId('share-map-toggle')).toHaveProp('value', false);
  });
});
