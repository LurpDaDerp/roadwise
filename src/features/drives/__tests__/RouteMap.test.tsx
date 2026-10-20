import { Ionicons } from '@expo/vector-icons';
import { fireEvent, screen, within } from '@testing-library/react-native';

import { tokens } from '@/ui';

import { draw, event, ROUTE } from '../__fixtures__/drives';
import { EVENT_ICON } from '../format';
import { resetMapsCache, RouteMap } from '../RouteMap';

/** The map is hidden from screen readers (the breakdown says it all), so queries must look inside. */
const H = { includeHiddenElements: true } as const;

jest.mock('react-native-maps', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const pass = (name: string) => {
    const C = ({ children, testID, ...rest }: { children?: React.ReactNode; testID?: string; strokeColor?: string }) => (
      <View testID={testID ?? name} accessibilityHint={rest.strokeColor}>
        {children}
      </View>
    );
    return C;
  };
  return { __esModule: true, default: pass('map-view'), Marker: pass('marker'), Polyline: pass('polyline') };
});

beforeEach(resetMapsCache);

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
  const map = screen.getByTestId('map-canvas', H);
  expect(map).toHaveStyle({ width: '100%', aspectRatio: 1 });
  expect(map).toHaveProp('accessibilityLabel', 'Route map, 2 hard brakes, 1 speeding');
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
