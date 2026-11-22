import { screen } from '@testing-library/react-native';
import { Component, type ComponentType, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { TripsMapCard } from '@/features/analytics/TripsMapCard';
import { draw, ROUTE } from '@/features/drives/__fixtures__/drives';
import { loadMaps as loadRouteMaps, resetMapsCache, RouteMap } from '@/features/drives/RouteMap';

import { googleMapKeyMissing, loadMaps, MAX_LAT_DELTA, MAX_LNG_DELTA, regionFor, setMapsForTests, setMapsKeyForTests, type MapsModule } from '../maps';

const H = { includeHiddenElements: true } as const;

/** The maps module RouteMap requires at render time: a plain view carrying the map's props. */
jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View: V } = jest.requireActual<typeof import('react-native')>('react-native');
  class MapView extends React.Component<{ children?: React.ReactNode }> {
    render() {
      const { children, ...rest } = this.props;
      return (
        <V testID="map-view" {...rest}>
          {children}
        </V>
      );
    }
  }
  return { __esModule: true, default: MapView, Marker: V, Polyline: V };
});

function fakeMaps(): MapsModule {
  class MapView extends Component<{ children?: ReactNode }> {
    render() {
      const { children, ...rest } = this.props;
      return (
        <View testID="map-view" {...rest}>
          {children}
        </View>
      );
    }
  }
  return { default: MapView as unknown as ComponentType, Polyline: View, Marker: View } as unknown as MapsModule;
}

const LINES = [
  [
    { latitude: 47.64, longitude: -122.34 },
    { latitude: 47.65, longitude: -122.35 },
  ],
];
const REGION = { latitude: 47.645, longitude: -122.345, latitudeDelta: 0.02, longitudeDelta: 0.02 };

beforeEach(() => {
  resetMapsCache();
  setMapsForTests(fakeMaps());
});
afterEach(() => {
  setMapsKeyForTests(undefined);
  setMapsForTests(undefined);
});

describe('an Android build', () => {
  let restoreOS: () => void;
  beforeEach(() => {
    restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
  });
  afterEach(() => restoreOS());

  test("without a Google Maps key has no maps at all: Google's SDK would end the app on the first map", () => {
    for (const key of [undefined, '']) {
      setMapsKeyForTests({ key });
      expect(googleMapKeyMissing()).toBe(true);
      expect(loadMaps()).toBeNull();
      expect(loadRouteMaps()).toBeNull();
    }
  });

  test('with a key has its maps', () => {
    setMapsKeyForTests({ key: 'AIza-test' });
    expect(googleMapKeyMissing()).toBe(false);
    expect(loadMaps()).not.toBeNull();
    expect(loadRouteMaps()).not.toBeNull();
  });

  test("the key is the bundle's EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY, the variable app.config.ts puts in the manifest", () => {
    const before = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
    try {
      process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY = 'AIza-from-env';
      expect(loadMaps()).not.toBeNull();
      process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY = '';
      expect(loadMaps()).toBeNull();
      delete process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
      expect(loadMaps()).toBeNull();
    } finally {
      if (before === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
      else process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY = before;
    }
  });

  test('without a key the recap shows its route sketch and All trips its "no map" line; no map view is made', async () => {
    setMapsKeyForTests({ key: undefined });
    await draw(<RouteMap runs={[ROUTE]} events={[]} highlighted={null} />);
    expect(screen.getByTestId('map-unavailable', H)).toBeOnTheScreen();
    expect(screen.queryByTestId('map-view', H)).toBeNull();
    await draw(<TripsMapCard routes={LINES} region={REGION} />);
    expect(screen.getByTestId('trips-map-nomap')).toBeOnTheScreen();
    expect(screen.queryByTestId('map-view', H)).toBeNull();
  });
});

test("iPhone needs no key (Apple's map): its maps are there whatever the Android variable says", async () => {
  setMapsKeyForTests({ key: undefined });
  expect(googleMapKeyMissing('ios')).toBe(false);
  expect(loadMaps()).not.toBeNull();
  expect(loadRouteMaps()).not.toBeNull();
  await draw(<TripsMapCard routes={LINES} region={REGION} />);
  expect(screen.getByTestId('map-view', H)).toBeOnTheScreen();
});

describe('regionFor (the heat map)', () => {
  test('fits the points with a margin', () => {
    expect(
      regionFor([
        { lat: 47.6, lng: -122.3 },
        { lat: 47.7, lng: -122.4 },
      ])
    ).toEqual({ latitude: expect.closeTo(47.65, 9), longitude: expect.closeTo(-122.35, 9), latitudeDelta: expect.closeTo(0.125, 9), longitudeDelta: expect.closeTo(0.125, 9) });
  });

  test('is never wider than the whole world, so neither map engine gets a span it rejects or wraps', () => {
    // Seattle and Auckland: 296.9° of longitude apart, 371° with the margin.
    const r = regionFor([
      { lat: 47.6, lng: -122.3 },
      { lat: -36.8, lng: 174.6 },
    ])!;
    expect(r.longitudeDelta).toBe(MAX_LNG_DELTA);
    expect(r.longitudeDelta).toBeLessThan(360);
    expect(r.latitudeDelta).toBeCloseTo(105.5, 6);
    const poles = regionFor([
      { lat: 80, lng: 0 },
      { lat: -80, lng: 1 },
    ])!;
    expect(poles.latitudeDelta).toBe(MAX_LAT_DELTA);
    expect(poles.latitudeDelta).toBeLessThan(180);
  });
});
