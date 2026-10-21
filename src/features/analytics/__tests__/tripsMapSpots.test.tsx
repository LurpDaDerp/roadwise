import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ComponentType, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { draw } from '@/features/drives/__fixtures__/drives';
import { PIN_PLACE } from '@/features/drives/Pin';
import { setMapsForTests, type MapsModule } from '@/features/settings/maps';
import { problemSpot } from '@/features/spots/__fixtures__/spots';
import { SPOT_INK } from '@/features/spots/ink';
import { ThemeProvider } from '@/ui/theme';

import type { MapPoint } from '../model';
import { SPOT_CASING_WIDTH, SPOT_LINE_WIDTH, TripsMapCard } from '../TripsMapCard';

const H = { includeHiddenElements: true } as const;

/** A maps module whose lines and pins are plain views carrying their props. */
function fakeMaps(): MapsModule {
  const MapView = ({ children }: { children?: ReactNode }) => <View testID="map-view">{children}</View>;
  const Polyline = ({ testID, ...rest }: { testID?: string }) => <View testID={testID ?? 'heat-line'} {...rest} />;
  const Marker = ({ children, testID, ...rest }: { children?: ReactNode; testID?: string }) => (
    <View testID={testID} {...rest}>
      {children}
    </View>
  );
  return { default: MapView as unknown as ComponentType, Polyline, Marker } as unknown as MapsModule;
}

const LINES: MapPoint[][] = [
  [
    { latitude: 47.64, longitude: -122.34 },
    { latitude: 47.65, longitude: -122.35 },
  ],
];
const REGION = { latitude: 47.645, longitude: -122.345, latitudeDelta: 0.02, longitudeDelta: 0.02 };

beforeEach(() => setMapsForTests(fakeMaps()));
afterEach(() => setMapsForTests(undefined));

test('with no spots the map draws only the heat lines, as it always has', async () => {
  await draw(<TripsMapCard routes={LINES} region={REGION} />);
  expect(screen.getAllByTestId('heat-line', H)).toHaveLength(1);
  expect(screen.queryByTestId(/^spot-/, H)).toBeNull();
});

test('each spot is a cased line in the spot ink over the heat lines, with a pin on top that opens it', async () => {
  const onSpot = jest.fn();
  const spots = [problemSpot(), problemSpot({ id: 'hard_brake:e2', kind: 'hard_brake', label: null, rank: 2 })];
  await draw(<TripsMapCard routes={LINES} region={REGION} spots={spots} onSpot={onSpot} />);
  for (const s of spots) {
    const casing = screen.getByTestId(`spot-casing-${s.id}`, H);
    const line = screen.getByTestId(`spot-line-${s.id}`, H);
    expect(casing.props).toMatchObject({ strokeColor: SPOT_INK.light.casing, strokeWidth: SPOT_CASING_WIDTH, zIndex: 1 });
    expect(line.props).toMatchObject({ strokeColor: SPOT_INK.light.line, strokeWidth: SPOT_LINE_WIDTH, zIndex: 2 });
    expect(line.props.coordinates).toEqual(s.segment.map((p) => ({ latitude: p.lat, longitude: p.lng })));
    expect(SPOT_CASING_WIDTH).toBeGreaterThan(SPOT_LINE_WIDTH);
    const pin = screen.getByTestId(`spot-pin-${s.id}`, H);
    expect(pin.props.zIndex).toBeGreaterThan(2);
    expect(pin.props.coordinate).toEqual({ latitude: s.pin.lat, longitude: s.pin.lng });
    // The view is symmetric about the pin, so the lone pin's placement puts its tip on the spot.
    expect(pin.props.anchor).toEqual(PIN_PLACE.anchor);
    expect(pin.props.centerOffset).toEqual(PIN_PLACE.centerOffset);
  }
  // Rank 1 sits above rank 2.
  expect(screen.getByTestId('spot-pin-speeding:e1', H).props.zIndex).toBeGreaterThan(screen.getByTestId('spot-pin-hard_brake:e2', H).props.zIndex);
  // The heat line is drawn first, under the spots.
  const all = screen.getAllByTestId(/heat-line|spot-casing|spot-line/, H).map((el) => el.props.testID as string);
  expect(all[0]).toBe('heat-line');

  // The chip: the street, else the kind's short word.
  expect(within(screen.getByTestId('spot-chip-speeding:e1', H)).getByText('Dexter Ave N', H)).toBeOnTheScreen();
  expect(within(screen.getByTestId('spot-chip-hard_brake:e2', H)).getByText('Braking', H)).toBeOnTheScreen();
  const chip = screen.getByTestId('spot-chip-speeding:e1', H);
  expect(StyleSheet.flatten(chip.props.style)).toMatchObject({ marginTop: 4, height: 22 });

  await fireEvent(screen.getByTestId('spot-pin-hard_brake:e2', H), 'press');
  expect(onSpot).toHaveBeenCalledWith('hard_brake:e2');
});

test('in dark mode the spot ink follows the dark tiles', async () => {
  await render(
    <ThemeProvider scheme="dark" reduceMotion>
      <TripsMapCard routes={LINES} region={REGION} spots={[problemSpot()]} />
    </ThemeProvider>
  );
  expect(screen.getByTestId('spot-line-speeding:e1', H).props.strokeColor).toBe(SPOT_INK.dark.line);
  expect(screen.getByTestId('spot-casing-speeding:e1', H).props.strokeColor).toBe(SPOT_INK.dark.casing);
});

test('the map stays hidden from screen readers; the spots card is its accessible list', async () => {
  await draw(<TripsMapCard routes={LINES} region={REGION} spots={[problemSpot()]} />);
  expect(screen.getByTestId('trips-map', H)).toHaveProp('accessibilityElementsHidden', true);
});
