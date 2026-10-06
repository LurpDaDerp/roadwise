import { screen } from '@testing-library/react-native';

import { draw, event, ROUTE } from '../__fixtures__/drives';
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

test('the route is drawn in runs coloured by their worst event, with instant events as dots', async () => {
  await draw(
    <RouteMap
      points={ROUTE}
      events={[event(), event({ id: 's', type: 'speeding', tier: 'severe', durationS: 30, lat: ROUTE[3]!.lat, lng: ROUTE[3]!.lng })]}
      highlighted={null}
    />
  );
  expect(screen.getByTestId('map-canvas', H)).toBeOnTheScreen();
  expect(screen.getAllByTestId('polyline', H)).toHaveLength(3);
  expect(screen.getByTestId('dot-e1', H)).toBeOnTheScreen();
  expect(screen.queryByTestId('map-highlight', H)).toBeNull();
  expect(screen.getByText('Severe', H)).toBeOnTheScreen();
});

test('the highlighted event gets a ring on the map', async () => {
  const e = event();
  await draw(<RouteMap points={ROUTE} events={[e]} highlighted={e} />);
  expect(screen.getByTestId('map-highlight', H)).toBeOnTheScreen();
});

test('no route: a plain note instead of an empty map', async () => {
  await draw(<RouteMap points={[]} events={[]} highlighted={null} />);
  expect(screen.getByTestId('no-route')).toBeOnTheScreen();
});
