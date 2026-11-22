import { render, screen } from '@testing-library/react-native';
import { Component, type ComponentType, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { TripsMapCard } from '@/features/analytics/TripsMapCard';
import { draw, ROUTE } from '@/features/drives/__fixtures__/drives';
import { resetMapsCache, RouteMap } from '@/features/drives/RouteMap';
import { RouteHeatMap } from '@/features/profile/RouteHeatMap';
import { ThemeProvider } from '@/ui/theme';

import { setMapsForTests, setMapsKeyForTests, type MapsModule } from '../maps';
import { androidMapLook, mapStyleFor } from '../mapStyle';

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

const POI_OFF = { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] };
const DARK_LAND = { elementType: 'geometry', stylers: [{ color: '#242424' }] };
const LINES = [
  [
    { latitude: 47.64, longitude: -122.34 },
    { latitude: 47.65, longitude: -122.35 },
  ],
];
const REGION = { latitude: 47.645, longitude: -122.345, latitudeDelta: 0.02, longitudeDelta: 0.02 };
const POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

beforeEach(() => {
  resetMapsCache();
  setMapsForTests(fakeMaps());
});
afterEach(() => setMapsForTests(undefined));

describe('mapStyleFor / androidMapLook', () => {
  test('both schemes hide points of interest; the dark one is Apple-dark greys', () => {
    expect(mapStyleFor('light')).toContainEqual(POI_OFF);
    expect(mapStyleFor('light')).not.toContainEqual(DARK_LAND);
    expect(mapStyleFor('dark')).toContainEqual(POI_OFF);
    expect(mapStyleFor('dark')).toContainEqual(DARK_LAND);
  });

  test('Android gets the scheme, the style and a key per scheme; iPhone gets nothing', () => {
    expect(androidMapLook('dark', 'android')).toEqual({ key: 'map-dark', userInterfaceStyle: 'dark', customMapStyle: mapStyleFor('dark') });
    expect(androidMapLook('light', 'android')?.key).toBe('map-light');
    expect(androidMapLook('dark', 'ios')).toBeNull();
  });
});

describe('the maps', () => {
  const themed = (scheme: 'light' | 'dark', ui: ReactNode) => (
    <ThemeProvider scheme={scheme} reduceMotion>
      {ui}
    </ThemeProvider>
  );

  test('iPhone: no style and no scheme key; the trip map follows the system by itself', async () => {
    await draw(<RouteMap runs={[ROUTE]} events={[]} highlighted={null} />);
    const map = screen.getByTestId('map-view', H);
    expect(map.props.customMapStyle).toBeUndefined();
    expect(map.props.userInterfaceStyle).toBeUndefined();
  });

  describe('Android', () => {
    let restoreOS: () => void;
    beforeEach(() => {
      restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
      // A build with a Google Maps key: without one there are no maps on Android (mapsKey.test).
      setMapsKeyForTests({ key: 'AIza-test' });
    });
    afterEach(() => {
      restoreOS();
      setMapsKeyForTests(undefined);
    });

    test("the trip map takes the system's scheme, dark and quiet in dark mode", async () => {
      const rn = jest.requireActual<typeof import('react-native')>('react-native');
      const scheme = jest.spyOn(rn, 'useColorScheme').mockReturnValue('dark');
      try {
        await draw(<RouteMap runs={[ROUTE]} events={[]} highlighted={null} />);
        const map = screen.getByTestId('map-view', H);
        expect(map.props.userInterfaceStyle).toBe('dark');
        expect(map.props.customMapStyle).toEqual(mapStyleFor('dark'));
      } finally {
        scheme.mockRestore();
      }
    });

    test('All trips and the heat map follow the app scheme, remade when it flips', async () => {
      const ui = (scheme: 'light' | 'dark') => themed(scheme, <TripsMapCard routes={LINES} region={REGION} />);
      const { rerender } = await render(ui('light'));
      expect(screen.getByTestId('map-view', H).props.customMapStyle).toEqual(mapStyleFor('light'));
      await rerender(ui('dark'));
      const dark = screen.getByTestId('map-view', H);
      expect(dark.props.userInterfaceStyle).toBe('dark');
      expect(dark.props.customMapStyle).toEqual(mapStyleFor('dark'));

      await render(themed('dark', <RouteHeatMap polylines={[POLYLINE]} testID="heat" />));
      const heat = screen.getByTestId('map-view', H);
      expect(heat.props.userInterfaceStyle).toBe('dark');
      expect(heat.props.customMapStyle).toEqual(mapStyleFor('dark'));
    });
  });
});
