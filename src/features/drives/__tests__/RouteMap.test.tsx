import { Ionicons } from '@expo/vector-icons';
import { fireEvent, screen, within } from '@testing-library/react-native';

import { contrastRatio, tokens } from '@/ui';

import { draw, event, press, ROUTE } from '../__fixtures__/drives';
import { EVENT_ICON } from '../format';
import { RECENTER_MS, resetMapsCache, RING_INK, RouteMap } from '../RouteMap';

/** The map is hidden from screen readers (the breakdown says it all), so queries must look inside. */
const H = { includeHiddenElements: true } as const;

const mockAnimateToRegion = jest.fn();

jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const pass = (name: string) => {
    const C = ({ children, testID, strokeColor, ...rest }: { children?: React.ReactNode; testID?: string; strokeColor?: string }) => (
      <View testID={testID ?? name} accessibilityHint={strokeColor} {...rest}>
        {children}
      </View>
    );
    return C;
  };
  class MapView extends React.Component<{ children?: React.ReactNode }> {
    animateToRegion = mockAnimateToRegion;
    render() {
      const { children, ...rest } = this.props;
      return (
        <View testID="map-view" {...rest}>
          {children}
        </View>
      );
    }
  }
  return { __esModule: true, default: MapView, Marker: pass('marker'), Polyline: pass('polyline') };
});

beforeEach(() => {
  resetMapsCache();
  mockAnimateToRegion.mockClear();
});

test('the map is a square with no legend, a pin per event with its icon, and the summary spoken', async () => {
  await draw(
    <RouteMap
      runs={[ROUTE]}
      events={[
        event(),
        event({ id: 'b2', tier: 'severe', lat: ROUTE[15]!.lat, lng: ROUTE[15]!.lng }),
        event({ id: 's', type: 'speeding', tier: 'severe', durationS: 30, lat: ROUTE[3]!.lat, lng: ROUTE[3]!.lng }),
        event({ id: 'p', type: 'phone_pickup', tier: 'severe', lat: null, lng: null }),
      ]}
      highlighted={null}
    />
  );
  expect(screen.getByTestId('map-canvas', H)).toHaveStyle({ width: '100%', aspectRatio: 1 });
  expect(screen.getByTestId('map-summary')).toHaveProp('accessibilityLabel', 'Route map, 2 hard brakes, 1 speeding');
  for (const word of ['Clean', 'Minor', 'Moderate', 'Severe']) expect(screen.queryByText(word, H)).toBeNull();

  // Each pin wears its event's icon glyph, the same icon the receipt and counters use.
  const glyph = (name: keyof typeof Ionicons.glyphMap) => String.fromCodePoint(Number(Ionicons.glyphMap[name]));
  expect(within(screen.getByTestId('pin-e1', H)).getByText(glyph(EVENT_ICON.hard_brake), H)).toBeOnTheScreen();
  expect(within(screen.getByTestId('pin-b2', H)).getByText(glyph(EVENT_ICON.hard_brake), H)).toBeOnTheScreen();
  expect(within(screen.getByTestId('pin-s', H)).getByText(glyph(EVENT_ICON.speeding), H)).toBeOnTheScreen();
  expect(screen.queryByTestId('pin-p', H)).toBeNull(); // inside a privacy zone: off the map
  expect(screen.queryByTestId('map-highlight', H)).toBeNull();
});

test('each event colours its stretch by tier once laid out, and a stretch too short to see is a dot', async () => {
  await draw(
    <RouteMap
      runs={[ROUTE]}
      events={[event(), event({ id: 's', type: 'speeding', tier: 'severe', durationS: 60, lat: ROUTE[3]!.lat, lng: ROUTE[3]!.lng })]}
      highlighted={null}
    />
  );
  // Before layout nothing is known about the zoom: every mark is a dot.
  expect(screen.getByTestId('dot-s', H)).toBeOnTheScreen();
  await fireEvent(screen.getByTestId('map-canvas', H), 'layout', { nativeEvent: { layout: { width: 340, height: 340 } } });
  // A minute of speeding is a line in red over the green route; a one-second brake stays a dot.
  expect(screen.getByTestId('stretch-s', H)).toHaveProp('accessibilityHint', tokens.color.light.signal.severe.fill);
  expect(screen.queryByTestId('dot-s', H)).toBeNull();
  expect(screen.getByTestId('dot-e1', H)).toBeOnTheScreen();
  expect(screen.getAllByTestId('polyline', H)).toHaveLength(1);
  expect(screen.getByTestId('polyline', H)).toHaveProp('accessibilityHint', tokens.color.light.signal.clean.fill);
});

test('the highlighted event gets a ring on the map', async () => {
  const e = event();
  await draw(<RouteMap runs={[ROUTE]} events={[e]} highlighted={e} />);
  expect(screen.getByTestId('map-highlight', H)).toBeOnTheScreen();
});

test('a route in two visible runs is two polylines, not one line across the privacy cut', async () => {
  await draw(<RouteMap runs={[ROUTE.slice(0, 10), ROUTE.slice(20)]} events={[]} highlighted={null} />);
  expect(screen.getAllByTestId('polyline', H)).toHaveLength(2);
});

test('no route: a plain note instead of an empty map', async () => {
  await draw(<RouteMap runs={[]} events={[]} highlighted={null} />);
  expect(screen.getByTestId('no-route')).toBeOnTheScreen();
});

test('each pin is a teardrop whose tip sits on the spot on both map engines', async () => {
  await draw(<RouteMap runs={[ROUTE]} events={[event()]} highlighted={null} />);
  const pin = screen.getByTestId('pin-e1');
  // Google Maps: the tip's fraction of the 32 × 44 view. Apple Maps centres the view, so it is
  // lifted by the tip's distance below the centre (42 − 22 = 20 points).
  expect(pin).toHaveProp('anchor', { x: 0.5, y: 42 / 44 });
  expect(pin).toHaveProp('centerOffset', { x: 0, y: -20 });
  expect(pin).toHaveProp('coordinate', { latitude: ROUTE[10]!.lat, longitude: ROUTE[10]!.lng });
});

test('tapping a pin opens a card with the event, how long it lasted, its tier and time; close or a map tap shuts it', async () => {
  await draw(
    <RouteMap
      runs={[ROUTE]}
      events={[event({ tier: 'moderate', durationS: 2 }), event({ id: 's', type: 'speeding', tier: 'severe', durationS: 65, lat: ROUTE[3]!.lat, lng: ROUTE[3]!.lng })]}
      highlighted={null}
    />
  );
  expect(screen.queryByTestId('map-event-card')).toBeNull();
  const pin = screen.getByLabelText('Hard brake, 2 seconds, moderate');
  expect(pin).toHaveProp('accessibilityRole', 'button');
  expect(screen.getByLabelText('Speeding, 1 minute 5 seconds, severe')).toBeOnTheScreen();

  await fireEvent.press(pin);
  expect(screen.getByTestId('map-event-title')).toHaveTextContent('Hard brake');
  expect(screen.getByTestId('map-event-detail')).toHaveTextContent(/^Lasted 2 s · Moderate · 1:09\sPM$/);
  expect(screen.getByTestId('pin-e1')).toHaveProp('zIndex', 20); // the chosen pin comes to the front

  await fireEvent.press(screen.getByTestId('pin-s'));
  expect(screen.getByTestId('map-event-detail')).toHaveTextContent(/^Lasted 1 min 5 s · Severe/);

  await fireEvent.press(screen.getByTestId('map-event-close'));
  expect(screen.queryByTestId('map-event-card')).toBeNull();

  await fireEvent.press(screen.getByTestId('pin-s'));
  // The map's own report of the same touch keeps the card; a later tap elsewhere shuts it.
  await fireEvent(screen.getByTestId('map-view'), 'press', { nativeEvent: { action: 'marker-press' } });
  expect(screen.getByTestId('map-event-card')).toBeOnTheScreen();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 1000);
  await fireEvent(screen.getByTestId('map-view'), 'press', { nativeEvent: {} });
  clock.mockRestore();
  expect(screen.queryByTestId('map-event-card')).toBeNull();
});

test('the map pans and zooms freely; off its opening view a Recenter button brings the whole route back', async () => {
  await draw(<RouteMap runs={[ROUTE]} events={[event({ id: 's', type: 'speeding', tier: 'severe', durationS: 8 })]} highlighted={null} />);
  const map = screen.getByTestId('map-view');
  expect(map).toHaveProp('zoomEnabled', true);
  expect(map).toHaveProp('scrollEnabled', true);
  expect(map).toHaveProp('rotateEnabled', false);
  expect(map).toHaveProp('pitchEnabled', false);
  expect(map).not.toHaveProp('liteMode', true);
  expect(map.props.minZoomLevel).toBeUndefined();
  expect(screen.queryByTestId('map-recenter')).toBeNull();

  await fireEvent(screen.getByTestId('map-canvas'), 'layout', { nativeEvent: { layout: { width: 340, height: 340 } } });
  const fitted = screen.getByTestId('map-view').props.initialRegion as { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
  expect(screen.getByTestId('map-view').props.minZoomLevel).toBeUndefined();
  expect(screen.getByTestId('dot-s', H)).toBeOnTheScreen(); // 8 s of speeding is too short to see at first

  // Zoomed in 8×: the stretch is long enough to draw as a line.
  const zoomedIn = { ...fitted, latitudeDelta: fitted.latitudeDelta / 8, longitudeDelta: fitted.longitudeDelta / 8 };
  await fireEvent(screen.getByTestId('map-view'), 'regionChangeComplete', zoomedIn);
  expect(screen.getByTestId('stretch-s')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Recenter map' })).toBeOnTheScreen();

  // Zoomed out past the opening view: allowed, nothing pulls it back.
  const out = { ...fitted, latitudeDelta: fitted.latitudeDelta * 4, longitudeDelta: fitted.longitudeDelta * 4 };
  await fireEvent(screen.getByTestId('map-view'), 'regionChangeComplete', out);
  expect(mockAnimateToRegion).not.toHaveBeenCalled();
  expect(screen.getByTestId('map-recenter')).toBeOnTheScreen();

  // Recenter animates back to the view that frames the route, and steps aside.
  await press(screen.getByTestId('map-recenter'));
  expect(mockAnimateToRegion).toHaveBeenCalledWith(fitted, RECENTER_MS);
  expect(screen.queryByTestId('map-recenter')).toBeNull();
  // The map reports where it settled: back home, so it stays hidden.
  await fireEvent(screen.getByTestId('map-view'), 'regionChangeComplete', fitted);
  expect(screen.queryByTestId('map-recenter')).toBeNull();

  // A drag alone shows it too.
  await fireEvent(screen.getByTestId('map-view'), 'regionChangeComplete', { ...fitted, latitude: fitted.latitude + fitted.latitudeDelta, longitude: fitted.longitude + fitted.longitudeDelta });
  expect(screen.getByTestId('map-recenter')).toBeOnTheScreen();
});

test('a ring circles the head of the highlighted pin, under the pins so the pin still takes the tap', async () => {
  const e = event();
  await draw(<RouteMap runs={[ROUTE]} events={[e]} highlighted={e} />);
  const ring = screen.getByTestId('map-highlight', H);
  // A 44-point ring whose centre is 27 points above the spot, the pin head's centre.
  expect(ring).toHaveProp('anchor', { x: 0.5, y: 1 });
  expect(ring).toHaveProp('centerOffset', { x: 0, y: -49 / 2 });
  expect(ring.props.zIndex).toBeLessThan(screen.getByTestId('pin-e1').props.zIndex);
});

test('the highlight ring keeps 3:1 on light and dark map tiles alike', async () => {
  // Light tiles (cream, white) and dark ones (the night greys).
  for (const tile of ['#F9F5ED', '#FFFFFF', '#242424', '#2B2B2B']) expect(contrastRatio(RING_INK, tile)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(RING_INK, '#2B2B2B')).toBeCloseTo(3.47, 2);
  const e = event();
  await draw(<RouteMap runs={[ROUTE]} events={[e]} highlighted={e} />);
  expect(within(screen.getByTestId('map-highlight', H)).getByTestId('map-highlight-ring', H)).toHaveStyle({ borderColor: RING_INK });
});
