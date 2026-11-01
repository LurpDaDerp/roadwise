import { fireEvent, render, screen } from '@testing-library/react-native';
import { Component, type ComponentType, type ReactNode } from 'react';
import { View } from 'react-native';

import { draw, press } from '@/features/drives/__fixtures__/drives';
import { awayFrom } from '@/features/drives/route';
import { RECENTER_MS } from '@/features/drives/RouteMap';
import { setMapsForTests, type MapsModule, type Region } from '@/features/settings/maps';
import { ThemeProvider } from '@/ui/theme';

import type { MapPoint } from '../model';
import { awayOnMap, TripsMapCard } from '../TripsMapCard';

const animateToRegion = jest.fn();

/** A maps module whose map is a plain view carrying its props, with the engine's `animateToRegion`. */
function fakeMaps(): MapsModule {
  class MapView extends Component<{ children?: ReactNode }> {
    animateToRegion = animateToRegion;
    render() {
      const { children, ...rest } = this.props;
      return (
        <View testID="map-view" {...rest}>
          {children}
        </View>
      );
    }
  }
  const Polyline = () => <View testID="heat-line" />;
  return { default: MapView as unknown as ComponentType, Polyline, Marker: View } as unknown as MapsModule;
}

const LINES: MapPoint[][] = [
  [
    { latitude: 47.64, longitude: -122.34 },
    { latitude: 47.65, longitude: -122.35 },
  ],
];
const REGION: Region = { latitude: 47.645, longitude: -122.345, latitudeDelta: 0.02, longitudeDelta: 0.02 };
/** The card's map: 360 wide, 320 tall. */
const ASPECT = 360 / 320;
const K = Math.cos((REGION.latitude * Math.PI) / 180);
/** What the engine reports for the framing view on that map: the height fits, the width is wider. */
const SHOWN: Region = { ...REGION, longitudeDelta: (REGION.latitudeDelta / K) * ASPECT };

const H = { includeHiddenElements: true } as const;
const map = () => screen.getByTestId('map-view', H);
const settle = (r: Region) => fireEvent(map(), 'regionChangeComplete', r);
const layout = () => fireEvent(screen.getByTestId('trips-map-frame'), 'layout', { nativeEvent: { layout: { width: 360, height: 320 } } });

beforeEach(() => {
  setMapsForTests(fakeMaps());
  animateToRegion.mockClear();
});
afterEach(() => setMapsForTests(undefined));

describe('awayOnMap', () => {
  test('the framing view as a wide map shows it is home, where the square-map rule would call it away', () => {
    expect(awayFrom(SHOWN, REGION)).toBe(true);
    expect(awayOnMap(SHOWN, REGION, ASPECT)).toBe(false);
  });

  test('more than a tenth of a drag or zoom is away; less is not', () => {
    const span = SHOWN.longitudeDelta;
    expect(awayOnMap({ ...SHOWN, longitude: SHOWN.longitude + span * 0.05 }, REGION, ASPECT)).toBe(false);
    expect(awayOnMap({ ...SHOWN, longitude: SHOWN.longitude + span * 0.15 }, REGION, ASPECT)).toBe(true);
    expect(awayOnMap({ ...SHOWN, latitudeDelta: SHOWN.latitudeDelta / 1.5, longitudeDelta: SHOWN.longitudeDelta / 1.5 }, REGION, ASPECT)).toBe(true);
    expect(awayOnMap({ ...SHOWN, latitudeDelta: SHOWN.latitudeDelta * 2, longitudeDelta: SHOWN.longitudeDelta * 2 }, REGION, ASPECT)).toBe(true);
  });
});

test('Recenter shows once the map is dragged or zoomed off its framing view, animates back and hides', async () => {
  await draw(<TripsMapCard routes={LINES} region={REGION} />);
  await layout();
  expect(screen.queryByTestId('trips-map-recenter')).toBeNull();
  // The map stays hidden from screen readers; the button sits outside it.
  expect(screen.getByTestId('trips-map', H)).toHaveProp('accessibilityElementsHidden', true);

  // The engine's own framing of the opening view: home.
  await settle(SHOWN);
  expect(screen.queryByTestId('trips-map-recenter')).toBeNull();

  // Zoomed in 3 times: away.
  await settle({ ...SHOWN, latitudeDelta: SHOWN.latitudeDelta / 3, longitudeDelta: SHOWN.longitudeDelta / 3 });
  const button = screen.getByRole('button', { name: 'Recenter map' });
  expect(button).toHaveProp('accessibilityHint', 'Shows all your trips again');
  // Reduce Motion (the test theme's) jumps instead of gliding.
  await press(button);
  expect(animateToRegion).toHaveBeenCalledWith(REGION, 0);
  expect(screen.queryByTestId('trips-map-recenter')).toBeNull();

  // A drag alone shows it too.
  await settle({ ...SHOWN, longitude: SHOWN.longitude + SHOWN.longitudeDelta / 2 });
  expect(screen.getByTestId('trips-map-recenter')).toBeOnTheScreen();
});

test('with motion on, Recenter glides back as the recap map does', async () => {
  await render(
    <ThemeProvider scheme="light" reduceMotion={false}>
      <TripsMapCard routes={LINES} region={REGION} />
    </ThemeProvider>
  );
  await layout();
  await settle({ ...SHOWN, longitude: SHOWN.longitude + SHOWN.longitudeDelta });
  await press(screen.getByTestId('trips-map-recenter'));
  expect(animateToRegion).toHaveBeenCalledWith(REGION, RECENTER_MS);
});

test('each new focus of the tab takes the map back to its framing view and hides Recenter', async () => {
  const card = (focusCount: number, region: Region | null = REGION) => (
    <ThemeProvider scheme="light" reduceMotion={false}>
      <TripsMapCard routes={region ? LINES : []} region={region} focusCount={focusCount} />
    </ThemeProvider>
  );
  const { rerender } = await render(card(0));
  await layout();
  // Opening needs nothing: the map opens on the framing view.
  expect(animateToRegion).not.toHaveBeenCalled();

  await settle({ ...SHOWN, longitude: SHOWN.longitude + SHOWN.longitudeDelta });
  expect(screen.getByTestId('trips-map-recenter')).toBeOnTheScreen();

  await rerender(card(1));
  expect(animateToRegion).toHaveBeenCalledTimes(1);
  expect(animateToRegion).toHaveBeenCalledWith(REGION, RECENTER_MS);
  expect(screen.queryByTestId('trips-map-recenter')).toBeNull();

  // Any later focus does it again, even with the map left where it was.
  await rerender(card(2));
  expect(animateToRegion).toHaveBeenCalledTimes(2);

  // A plain re-render with the same focus and routes leaves the map alone.
  await rerender(card(2));
  expect(animateToRegion).toHaveBeenCalledTimes(2);

  // New routes framed differently: back to their new framing view.
  const wider = { ...REGION, latitudeDelta: 0.05, longitudeDelta: 0.05 };
  await rerender(card(2, { ...wider }));
  expect(animateToRegion).toHaveBeenLastCalledWith(wider, RECENTER_MS);
  // The same framing in a new object is no change.
  await rerender(card(2, { ...wider }));
  expect(animateToRegion).toHaveBeenCalledTimes(3);

  // Moved off the view, the map stays put when the routes change (a drive restore landing mid-drag);
  // Recenter keeps showing and goes to the newest framing view.
  await settle({ ...SHOWN, longitude: SHOWN.longitude + SHOWN.longitudeDelta });
  const widest = { ...REGION, latitudeDelta: 0.08, longitudeDelta: 0.08 };
  await rerender(card(2, widest));
  expect(animateToRegion).toHaveBeenCalledTimes(3);
  await press(screen.getByTestId('trips-map-recenter'));
  expect(animateToRegion).toHaveBeenLastCalledWith(widest, RECENTER_MS);
  expect(screen.queryByTestId('trips-map-recenter')).toBeNull();
  // A focus still takes a moved map back.
  await settle({ ...SHOWN, longitude: SHOWN.longitude + SHOWN.longitudeDelta });
  await rerender(card(3, widest));
  expect(animateToRegion).toHaveBeenCalledTimes(5);
  expect(screen.queryByTestId('trips-map-recenter')).toBeNull();
});

test('a map that has only just appeared (the first trips) is left on the view it opens on', async () => {
  const card = (region: Region | null) => (
    <ThemeProvider scheme="light" reduceMotion={false}>
      <TripsMapCard routes={region ? LINES : []} region={region} focusCount={1} />
    </ThemeProvider>
  );
  const { rerender } = await render(card(null));
  expect(screen.getByTestId('trips-map-empty')).toBeOnTheScreen();
  await rerender(card(REGION));
  expect(map()).toHaveProp('initialRegion', REGION);
  expect(animateToRegion).not.toHaveBeenCalled();
});
