import { Ionicons } from '@expo/vector-icons';
import { fireEvent, screen, within } from '@testing-library/react-native';

import { PLACE_ICON } from '@/features/places/model';
import { contrastRatio, tokens } from '@/ui';

import { draw, event, press, ROUTE } from '../__fixtures__/drives';
import { EVENT_ICON } from '../format';
import { pinAnchor, PIN_PLACE as PLACE, START } from '../Pin';
import { END_DOT, END_INK, END_ON, END_Z, endPlace, PIN, PIN_PLACE, RECENTER_MS, resetMapsCache, RING_INK, RouteMap, START_Z, startUnderPin, type RouteEnds } from '../RouteMap';

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
        event({ id: 'p', type: 'hard_accel', tier: 'severe', lat: null, lng: null }),
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

test('a lead-in from where the drive began is a thin dashed line in the route green, framed with the route', async () => {
  const parked = { lat: ROUTE[0]!.lat - 0.05, lng: ROUTE[0]!.lng };
  await draw(<RouteMap runs={[ROUTE]} lead={[parked, ROUTE[0]!]} events={[]} highlighted={null} />);
  const lead = screen.getByTestId('route-lead-in', H);
  expect(lead).toHaveProp('lineDashPattern', [4, 6]);
  expect(lead).toHaveProp('strokeWidth', 3);
  expect(lead).toHaveProp('accessibilityHint', tokens.color.light.signal.clean.fill);
  expect(lead).toHaveProp('coordinates', [
    { latitude: parked.lat, longitude: parked.lng },
    { latitude: ROUTE[0]!.lat, longitude: ROUTE[0]!.lng },
  ]);
  // The route itself is still one solid line, and the opening view reaches down to the start.
  expect(screen.getAllByTestId('polyline', H)).toHaveLength(1);
  const region = screen.getByTestId('map-view', H).props.initialRegion as { latitude: number; latitudeDelta: number };
  expect(region.latitude - region.latitudeDelta / 2).toBeLessThan(parked.lat);
});

test('no lead-in: no dashed line', async () => {
  await draw(<RouteMap runs={[ROUTE]} events={[]} highlighted={null} />);
  expect(screen.queryByTestId('route-lead-in', H)).toBeNull();
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

test('the pin lives in its own module: the route map re-exports its size and placement', () => {
  expect(PIN_PLACE).toBe(PLACE);
  expect(PIN).toMatchObject({ width: 32, height: 44, tipY: 42 });
  // A wider view (a pin with a label chip) keeps its tip on the coordinate on both engines.
  expect(pinAnchor(100, 44, 16, 42)).toEqual({ anchor: { x: 0.16, y: 42 / 44 }, centerOffset: { x: 34, y: -20 } });
  expect(pinAnchor(32, 44, 16, 42)).toEqual(PLACE);
});

describe('the drive’s ends', () => {
  const glyph = (name: keyof typeof Ionicons.glyphMap) => String.fromCodePoint(Number(Ionicons.glyphMap[name]));
  const ends = (over: Partial<RouteEnds> = {}): RouteEnds => ({ fromLabel: 'Home', toLabel: 'Work', fromPlace: 'home', toPlace: 'work', ...over });
  const at = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });
  /** The view a marker snapshots: the disc or pin inside it. */
  const viewOf = (id: string) => within(screen.getByTestId(id, H)).getByTestId(`${id}-view`, H);

  test('a plain start circle centred on the route’s first point, an ink pin with a white dot tipped on its last', async () => {
    await draw(<RouteMap runs={[ROUTE]} events={[]} highlighted={null} />);
    const start = screen.getByTestId('map-start', H);
    expect(start).toHaveProp('coordinate', at(ROUTE[0]!));
    expect(start).toHaveProp('anchor', { x: 0.5, y: 0.5 });
    expect(start).toHaveProp('centerOffset', { x: 0, y: 0 });
    // The 20 pt disc with 2 pt all round for its shadow; no icon in its face.
    expect(viewOf('map-start')).toHaveStyle({ width: START.plain + 4, height: START.plain + 4 });
    expect(within(start).queryByText(/./, H)).toBeNull();

    const end = screen.getByTestId('map-end', H);
    expect(end).toHaveProp('coordinate', at(ROUTE[29]!));
    // The event pins' teardrop and placement: the tip on the spot on both engines.
    expect(end).toHaveProp('anchor', PIN_PLACE.anchor);
    expect(end).toHaveProp('centerOffset', PIN_PLACE.centerOffset);
    expect(viewOf('map-end')).toHaveStyle({ width: PIN.width, height: PIN.height });
    expect(within(end).getByTestId('map-end-dot', H)).toHaveStyle({ width: END_DOT, height: END_DOT, backgroundColor: '#FFFFFF' });
    expect(within(end).queryByText(/./, H)).toBeNull();
  });

  test('with a lead-in the start circle sits where the drive began, at the dashed line’s far end', async () => {
    const parked = { lat: ROUTE[0]!.lat - 0.05, lng: ROUTE[0]!.lng };
    await draw(<RouteMap runs={[ROUTE]} lead={[parked, ROUTE[0]!]} events={[]} highlighted={null} />);
    expect(screen.getByTestId('map-start', H)).toHaveProp('coordinate', at(parked));
    expect(screen.getByTestId('map-end', H)).toHaveProp('coordinate', at(ROUTE[29]!));
  });

  test('Home to Work: the start disc grows to hold the house, the pin’s head holds the briefcase', async () => {
    await draw(<RouteMap runs={[ROUTE]} ends={ends()} events={[]} highlighted={null} />);
    const start = screen.getByTestId('map-start', H);
    expect(within(start).getByText(glyph(PLACE_ICON.home), H)).toBeOnTheScreen();
    expect(viewOf('map-start')).toHaveStyle({ width: START.place + 4, height: START.place + 4 });
    const end = screen.getByTestId('map-end', H);
    expect(within(end).getByText(glyph(PLACE_ICON.work), H)).toBeOnTheScreen();
    expect(within(end).queryByTestId('map-end-dot', H)).toBeNull();
    // The same placements whatever they hold.
    expect(start).toHaveProp('anchor', { x: 0.5, y: 0.5 });
    expect(end).toHaveProp('anchor', PIN_PLACE.anchor);
    expect(screen.getByTestId('map-summary')).toHaveProp('accessibilityLabel', 'Route map, from Home to Work, no events marked');
  });

  test('School at either end wears the school icon; the places screens use the same icons', async () => {
    await draw(<RouteMap runs={[ROUTE]} ends={ends({ fromLabel: 'School', toLabel: 'Home', fromPlace: 'school', toPlace: 'home' })} events={[]} highlighted={null} />);
    expect(within(screen.getByTestId('map-start', H)).getByText(glyph('school-outline'), H)).toBeOnTheScreen();
    expect(within(screen.getByTestId('map-end', H)).getByText(glyph('home-outline'), H)).toBeOnTheScreen();
    expect(PLACE_ICON).toEqual({ home: 'home-outline', work: 'briefcase-outline', school: 'school-outline', custom: 'location-outline' });
  });

  test.each([
    ['a place of your own', { fromLabel: 'Gym', toLabel: 'Grandma', fromPlace: 'place-1', toPlace: 'place-2' }],
    ['an end that matched no place', { fromLabel: 'Fremont', toLabel: 'Ballard', fromPlace: null, toPlace: null }],
    ['a drive from before places were kept', { fromPlace: undefined, toPlace: undefined }],
  ] as const)('%s: the plain circle and pin', async (_, over) => {
    const e = ends(over);
    await draw(<RouteMap runs={[ROUTE]} ends={e} events={[]} highlighted={null} />);
    expect(within(screen.getByTestId('map-start', H)).queryByText(/./, H)).toBeNull();
    expect(viewOf('map-start')).toHaveStyle({ width: START.plain + 4 });
    expect(within(screen.getByTestId('map-end', H)).getByTestId('map-end-dot', H)).toBeOnTheScreen();
    expect(screen.getByTestId('map-summary')).toHaveProp('accessibilityLabel', `Route map, from ${e.fromLabel} to ${e.toLabel}, no events marked`);
  });

  test('endPlace reads only Home, Work and School from the stored place', () => {
    expect(endPlace('home')).toBe('home');
    expect(endPlace('work')).toBe('work');
    expect(endPlace('school')).toBe('school');
    for (const id of ['place-1', '', null, undefined]) expect(endPlace(id)).toBeNull();
  });

  test('a restored drive (trimmed runs, no labels or places): plain markers at the ends of what is drawn', async () => {
    const restored = ends({ fromLabel: null, toLabel: null, fromPlace: null, toPlace: null });
    // Two runs around a privacy cut, then a lone fix that is never drawn.
    await draw(<RouteMap runs={[ROUTE.slice(3, 10), ROUTE.slice(15, 26), [ROUTE[28]!]]} ends={restored} events={[event()]} highlighted={null} />);
    expect(screen.getByTestId('map-start', H)).toHaveProp('coordinate', at(ROUTE[3]!));
    expect(screen.getByTestId('map-end', H)).toHaveProp('coordinate', at(ROUTE[25]!));
    expect(within(screen.getByTestId('map-end', H)).getByTestId('map-end-dot', H)).toBeOnTheScreen();
    expect(screen.getByTestId('map-summary')).toHaveProp('accessibilityLabel', 'Route map, 1 hard brake');
  });

  test('one end labelled: named as the recap’s line names it', async () => {
    await draw(<RouteMap runs={[ROUTE]} ends={ends({ fromLabel: null, fromPlace: null })} events={[event()]} highlighted={null} />);
    expect(screen.getByTestId('map-summary')).toHaveProp('accessibilityLabel', 'Route map, from Start to Work, 1 hard brake');
  });

  test('no route: no markers', async () => {
    await draw(<RouteMap runs={[[ROUTE[0]!]]} ends={ends()} events={[]} highlighted={null} />);
    expect(screen.getByTestId('no-route')).toBeOnTheScreen();
    expect(screen.queryByTestId('map-start', H)).toBeNull();
    expect(screen.queryByTestId('map-end', H)).toBeNull();
  });

  test('over the route and the event marks, under the ring and the pins; silent and not buttons', async () => {
    const e = event({ id: 'end', tier: 'severe', lat: ROUTE[29]!.lat, lng: ROUTE[29]!.lng });
    await draw(
      <RouteMap
        runs={[ROUTE]}
        ends={ends()}
        events={[e, event({ id: 's', type: 'speeding', tier: 'severe', durationS: 60, lat: ROUTE[3]!.lat, lng: ROUTE[3]!.lng })]}
        highlighted={e}
      />
    );
    await fireEvent(screen.getByTestId('map-canvas', H), 'layout', { nativeEvent: { layout: { width: 340, height: 340 } } });
    const z = (id: string) => screen.getByTestId(id, H).props.zIndex as number;
    expect(START_Z).toBeGreaterThan(z('stretch-s'));
    expect(z('map-start')).toBe(START_Z);
    expect(z('map-end')).toBe(END_Z);
    expect(END_Z).toBeGreaterThan(START_Z);
    expect(z('map-highlight')).toBeGreaterThan(END_Z);
    expect(z('pin-end')).toBeGreaterThan(z('map-highlight'));
    for (const id of ['map-start', 'map-end']) {
      const m = screen.getByTestId(id, H);
      expect(m.props.onPress).toBeUndefined();
      expect(m).toHaveProp('accessibilityElementsHidden', true);
      expect(m).toHaveProp('importantForAccessibility', 'no-hide-descendants');
      expect(m).toHaveProp('tracksViewChanges', true); // still painting: frozen once settled
    }
    // The pin at the end still opens its card.
    await fireEvent.press(screen.getByTestId('pin-end'));
    expect(screen.getByTestId('map-event-title')).toHaveTextContent('Hard brake');
  });

  test('the ends’ ink and its white rim hold on light and dark map tiles', () => {
    expect(END_INK).toBe(tokens.color.light.primary);
    expect(END_ON).toBe(tokens.color.light.onPrimary);
    for (const tile of ['#F9F5ED', '#FFFFFF']) expect(contrastRatio(END_INK, tile)).toBeGreaterThanOrEqual(3);
    for (const tile of ['#242424', '#2B2B2B']) expect(contrastRatio('#FFFFFF', tile)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(END_ON, END_INK)).toBeGreaterThanOrEqual(4.5);
    // Apart from every tier colour and the green route.
    for (const s of Object.values(tokens.color.light.signal)) expect(contrastRatio(END_INK, s.fill)).toBeGreaterThanOrEqual(3);
  });
});

describe('a drive back to where it began', () => {
  const glyph = (name: keyof typeof Ionicons.glyphMap) => String.fromCodePoint(Number(Ionicons.glyphMap[name]));
  const home: RouteEnds = { fromLabel: 'Home', toLabel: 'Home', fromPlace: 'home', toPlace: 'home' };
  const end = ROUTE[29]!;
  // Parked about 25 m east of where the drive ended.
  const parked = { lat: end.lat, lng: end.lng + 0.0003 };

  test('the pin’s head carries Home; the start under it is the plain circle until zooming in parts them', async () => {
    await draw(<RouteMap runs={[ROUTE]} lead={[parked, ROUTE[0]!]} ends={home} events={[]} highlighted={null} />);
    await fireEvent(screen.getByTestId('map-canvas', H), 'layout', { nativeEvent: { layout: { width: 340, height: 340 } } });
    const start = () => screen.getByTestId('map-start', H);
    expect(within(screen.getByTestId('map-end', H)).getByText(glyph('home-outline'), H)).toBeOnTheScreen();
    expect(within(start()).queryByText(/./, H)).toBeNull();
    expect(within(start()).getByTestId('map-start-view', H)).toHaveStyle({ width: START.plain + 4 });
    expect(start()).toHaveProp('tracksViewChanges', true); // redrawn as it changes

    // Zoomed in 64×: 25 m is about 60 points, clear of the pin, and the start shows Home again.
    const fitted = screen.getByTestId('map-view', H).props.initialRegion as { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
    await fireEvent(screen.getByTestId('map-view', H), 'regionChangeComplete', { ...fitted, latitudeDelta: fitted.latitudeDelta / 64, longitudeDelta: fitted.longitudeDelta / 64 });
    expect(within(start()).getByText(glyph('home-outline'), H)).toBeOnTheScreen();
    // The summary names both ends whatever the zoom.
    expect(screen.getByTestId('map-summary')).toHaveProp('accessibilityLabel', 'Route map, from Home to Home, no events marked');
  });

  test('startUnderPin: anywhere a 30 pt disc would touch the 32 × 44 pin standing on the end', () => {
    const mPerPx = 1; // one metre a point
    const away = (east: number, north: number) => ({ lat: end.lat + north / 111_320, lng: end.lng + east / (111_320 * Math.cos((end.lat * Math.PI) / 180)) });
    expect(startUnderPin(away(0, 0), end, mPerPx)).toBe(true);
    expect(startUnderPin(away(30, 0), end, mPerPx)).toBe(true);
    expect(startUnderPin(away(0, 56), end, mPerPx)).toBe(true); // just above the head
    expect(startUnderPin(away(0, -14), end, mPerPx)).toBe(true); // just below the tip
    expect(startUnderPin(away(32, 0), end, mPerPx)).toBe(false);
    expect(startUnderPin(away(0, 58), end, mPerPx)).toBe(false);
    expect(startUnderPin(away(0, -16), end, mPerPx)).toBe(false);
    expect(startUnderPin(away(0, 0), end, 0)).toBe(false); // no scale before layout
  });
});
