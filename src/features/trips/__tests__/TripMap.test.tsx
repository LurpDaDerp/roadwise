import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { eventRow } from '@/data/queries/__fixtures__/rows';
import { toTripEventView } from '@/data/queries';
import { loadMaps, resetMapsCache, TripRouteField } from '@/features/trips/TripMap';
import type { LatLng } from '@/lib/geo';
import { ThemeProvider } from '@/ui/theme';

/**
 * This suite deliberately does **not** mock `react-native-maps`. The real package reaches for a
 * TurboModule the moment it is evaluated, which is exactly what happens in Expo Go, in a build
 * made before the native module landed, and here — so leaving it alone tests the absence for
 * real rather than pretending it.
 */

const POINTS: LatLng[] = Array.from({ length: 40 }, (_, i) => ({
  lat: 45.5 + i * 0.01,
  lng: -122.6,
}));

const events = [toTripEventView(eventRow())];

const draw = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

beforeEach(resetMapsCache);

test('a build without the native maps module answers null rather than throwing', () => {
  expect(loadMaps()).toBeNull();
  // Cached: the second call costs nothing, which is what keeps it out of every frame.
  expect(loadMaps()).toBeNull();
});

test('without the module the section says the map is unavailable and points at the timeline', async () => {
  await draw(<TripRouteField points={POINTS} events={events} hasRoute />);
  expect(screen.getByTestId('map-unavailable')).toBeOnTheScreen();
  expect(screen.getByText('Map unavailable')).toBeOnTheScreen();
  expect(screen.getByText('The timeline below has every moment of the drive.')).toBeOnTheScreen();
});

test('offline, the map is off and the copy says why', async () => {
  await draw(<TripRouteField points={POINTS} events={events} hasRoute online={false} />);
  expect(screen.getByTestId('map-offline')).toBeOnTheScreen();
  expect(
    screen.getByText("You're offline, so the map is off. The timeline below has every moment.")
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('map-unavailable')).toBeNull();
});

test('a drive whose route has aged out says so instead of showing an empty frame', async () => {
  await draw(<TripRouteField points={[]} events={events} hasRoute={false} />);
  expect(screen.getByTestId('no-route')).toBeOnTheScreen();
  expect(screen.getByText('No route saved for this drive')).toBeOnTheScreen();
});

test('the section can start collapsed, and nothing is drawn until it is opened', async () => {
  await draw(<TripRouteField points={POINTS} events={events} hasRoute initiallyOpen={false} />);
  expect(screen.getByRole('button', { name: 'Show map' })).toBeOnTheScreen();
  expect(screen.queryByTestId('map-unavailable')).toBeNull();
});
