import { act, screen } from '@testing-library/react-native';

import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  brokenDb,
  clearQueryClients,
  press,
  routerDouble,
  slowDb,
  world,
} from '@/features/trips/__fixtures__/render';
import { resetNetForTests, setSharedNet, type NetAdapter } from '@/data/net/net';
import { TripDetailScreen } from '@/features/trips/TripDetailScreen';
import type { LatLng } from '@/lib/geo';
import { encodePolyline } from '@/lib/polyline';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

// A build that *has* the native maps module. The real package reaches for a TurboModule at import
// time, so the "no module" half of the branch is a separate suite (`TripMap.test.tsx`) with no
// mock at all, which is the honest way to test it.
jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const MapView = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, { testID: 'map-view' }, children);
  const Polyline = (props: {
    coordinates: { latitude: number; longitude: number }[];
    lineDashPattern?: number[];
  }) =>
    React.createElement(View, {
      testID: props.lineDashPattern ? 'polyline-over' : 'polyline-normal',
      accessibilityValue: { now: props.coordinates.length },
    });
  const Marker = (props: { title?: string }) =>
    React.createElement(View, { testID: `marker:${props.title ?? ''}` });
  return { __esModule: true, default: MapView, Polyline, Marker };
});

const ID = 'trip-1';
const hidden = { includeHiddenElements: true } as const;

const line = (n: number): LatLng[] =>
  Array.from({ length: n }, (_, i) => ({ lat: 45.5 + i * 0.01, lng: -122.6 }));
const POINTS = line(40);
const POLYLINE = encodePolyline(POINTS);

const scored = tripRow({
  client_trip_id: ID,
  score: 84,
  status: 'provisional',
  sync_state: 'synced',
  polyline: POLYLINE,
  category_deductions_json: JSON.stringify(deductions({ speeding: 6, phone: 4 })),
});

const speeding = eventRow({
  id: 'e-speeding',
  client_trip_id: ID,
  category: 'speeding',
  started_at: T0 + 60_000,
  duration_s: 38,
  deduction: 6,
  severity: '3.5',
  lat: POINTS[20]?.lat ?? 45.5,
  lng: POINTS[20]?.lng ?? -122.6,
  measured_json: JSON.stringify({ speedMps: 21, limitMps: 15.6, overMps: 5.4 }),
});

const possible = eventRow({
  id: 'e-possible',
  client_trip_id: ID,
  category: 'phone',
  started_at: T0 + 120_000,
  duration_s: 12,
  deduction: 0,
  severity: '0.7',
  confidence: 0.4,
  status: 'possible',
  lat: null,
  lng: null,
  measured_json: JSON.stringify({ speedMps: 15 }),
});

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
  mockRouter.dismissTo.mockClear();
});
afterEach(clearQueryClients);
afterEach(() => resetNetForTests());

/** The network adapter the launch shares with the screens, held in a state the test flips. */
function networkIs(initial: boolean) {
  let online = initial;
  const listeners = new Set<(s: { online: boolean; wifi: boolean }) => void>();
  const adapter: NetAdapter = {
    isOnline: () => online,
    isWifi: () => false,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  setSharedNet(adapter);
  return {
    set(next: boolean) {
      online = next;
      for (const l of [...listeners]) l({ online, wifi: false });
    },
  };
}

describe('while the drive is read', () => {
  test('the screen is drawn as a skeleton, never a spinner', async () => {
    const w = await world({ trips: [scored] });
    const slow = slowDb(w.db, 200);
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />, slow);
    expect(screen.getByRole('progressbar', { name: 'Loading this drive' })).toBeOnTheScreen();
    expect(await screen.findByTestId('trip-detail')).toBeOnTheScreen();
    await act(() => slow.idle());
  });

  test('a timeline that cannot be read fails the screen rather than printing a shorter drive', async () => {
    const w = await world({ trips: [scored] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />, brokenDb());
    expect(await screen.findByText("Couldn't open this drive.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  test('a drive that is not on the record is an empty state', async () => {
    const w = await world();
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    expect(await screen.findByText("This drive isn't on your record")).toBeOnTheScreen();
  });
});

describe('a drive with a route and two moments', () => {
  const open = async () => {
    const w = await world({ trips: [scored], events: [speeding, possible] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');
    return w;
  };

  test('prints the drive: header, score, route, timeline, categories, conditions, quality', async () => {
    await open();
    expect(screen.getByText('Near Home → Near Lincoln HS')).toBeOnTheScreen();
    expect(screen.getByTestId('detail-score')).toHaveTextContent('84');
    expect(screen.getByText('Good')).toBeOnTheScreen();
    expect(screen.getByTestId('map-view', hidden)).toBeOnTheScreen();
    expect(screen.getByTestId('timeline')).toBeOnTheScreen();
    expect(screen.getByTestId('category-bars')).toBeOnTheScreen();
    expect(screen.getByTestId('conditions')).toBeOnTheScreen();
    expect(screen.getByTestId('quality')).toBeOnTheScreen();
  });

  test('the road is drawn in two patterns: the over-limit stretch is dashed, the rest is not', async () => {
    await open();
    expect(screen.getAllByTestId('polyline-over', hidden).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('polyline-normal', hidden).length).toBeGreaterThan(0);
    // Both are named in words under the map, so the pattern is readable without the map.
    expect(screen.getByLabelText('Over the limit')).toBeOnTheScreen();
    expect(screen.getByLabelText('Within the limit')).toBeOnTheScreen();
  });

  test('a pin carries the measurement, and only an event with a location gets one', async () => {
    await open();
    expect(screen.getByTestId('marker:47 mph in a 35 zone for 38 s', hidden)).toBeOnTheScreen();
    expect(screen.queryByTestId('marker:Phone handled for 12 s at 34 mph', hidden)).toBeNull();
  });

  test('the map says the ends are trimmed, and is hidden from a screen reader', async () => {
    await open();
    expect(
      screen.getByText('The first and last few hundred metres are left off the map.')
    ).toBeOnTheScreen();
    // Hidden: the timeline below says everything the pins do, in words.
    expect(screen.queryByTestId('map-view')).toBeNull();
  });

  test('the map can be hidden, and the timeline is still the whole drive', async () => {
    await open();
    await press(screen.getByRole('button', { name: 'Hide map' }));
    expect(screen.queryByTestId('map-view', hidden)).toBeNull();
    expect(screen.getByRole('button', { name: 'Show map' })).toBeOnTheScreen();
    expect(screen.getByTestId('timeline')).toBeOnTheScreen();
  });

  test('a capped category never prints a moment that contradicts its own bar', async () => {
    // Two phone pickups at 32 and 8 before the cap; the phone cap is 30, so that is what the
    // drive lost — and what the two rows have to add up to.
    const w = await world({
      trips: [
        tripRow({
          client_trip_id: ID,
          score: 70,
          category_deductions_json: JSON.stringify(deductions({ phone: 30 })),
        }),
      ],
      events: [
        eventRow({ id: 'p1', client_trip_id: ID, category: 'phone', deduction: 32, duration_s: 18, measured_json: '{}' }),
        eventRow({ id: 'p2', client_trip_id: ID, category: 'phone', deduction: 8, duration_s: 5, measured_json: '{}' }),
      ],
    });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByTestId('timeline-p1').props.accessibilityLabel).toContain('minus 24 points');
    expect(screen.getByTestId('timeline-p2').props.accessibilityLabel).toContain('minus 6 points');
    // The raw figure never appears: it would sit directly above a bar reading "30 of 30".
    expect(screen.queryByText('−32')).toBeNull();
  });

  test('every moment is one row a screen reader reads whole, with what it cost', async () => {
    await open();
    expect(
      screen.getByLabelText(/Speeding, 47 mph in a 35 zone for 38 s, Severe, minus 6 points/)
    ).toBeOnTheScreen();
  });

  test('a low-confidence moment is on the timeline, labelled and costing nothing', async () => {
    await open();
    expect(screen.getByText('Detected, not counted')).toBeOnTheScreen();
    const row = screen.getByTestId('timeline-e-possible');
    expect(row.props.accessibilityLabel).toContain('Detected, not counted');
    expect(row.props.accessibilityLabel).not.toContain('minus');
  });

  test('a speeding moment with an uncertain reading says so, on screen and to a screen reader', async () => {
    const unsure = eventRow({ ...speeding, id: 'e-unsure', confidence: 0.6, started_at: T0 + 90_000 });
    const w = await world({ trips: [scored], events: [speeding, unsure] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');
    expect(screen.getByTestId('reading-uncertain-e-unsure')).toHaveTextContent('uncertain reading');
    expect(screen.getByTestId('timeline-e-unsure').props.accessibilityLabel).toContain('uncertain reading');
    // Negative control: the confident speeding moment carries no such label.
    expect(screen.queryByTestId('reading-uncertain-e-speeding')).toBeNull();
    expect(screen.getByTestId('timeline-e-speeding').props.accessibilityLabel).not.toContain('uncertain reading');
  });

  test('tapping a moment opens it', async () => {
    await open();
    await press(screen.getByTestId('timeline-e-speeding'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/trips/[clientTripId]/events/[eventId]',
      params: { clientTripId: ID, eventId: 'e-speeding' },
    });
  });

  test('Edit drive opens D5; sharing waits for its cards', async () => {
    await open();
    await press(screen.getByRole('button', { name: 'Edit drive' }));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/(app)/trips/[clientTripId]/edit',
      params: { clientTripId: ID },
    });
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
  });

  test('the data-quality grade is a button into how scoring works', async () => {
    await open();
    await press(screen.getByTestId('quality-stamp'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/(app)/insights/how-scoring-works');
  });
});

describe('a drive without a route', () => {
  test('says the route is gone and why, and still prints the timeline', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, polyline: null })],
      events: [speeding],
    });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByTestId('no-route')).toBeOnTheScreen();
    expect(screen.getByText('No route saved for this drive')).toBeOnTheScreen();
    expect(screen.getByText(/kept for 90 days/)).toBeOnTheScreen();
    expect(screen.queryByTestId('map-view', hidden)).toBeNull();
    expect(screen.getByTestId('timeline')).toBeOnTheScreen();
  });
});

describe('a clean drive', () => {
  test('has nothing on its timeline, and says so instead of showing an empty list', async () => {
    const w = await world({
      trips: [tripRow({ client_trip_id: ID, score: 100, polyline: POLYLINE })],
    });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByTestId('clean-drive')).toBeOnTheScreen();
    expect(screen.getByText('Nothing came up on this drive.')).toBeOnTheScreen();
    expect(screen.queryByTestId('timeline')).toBeNull();
  });
});

describe('a drive with no score', () => {
  test('says why, and does not print a points-lost chart that would mean nothing', async () => {
    const w = await world({
      trips: [
        tripRow({ client_trip_id: ID, role: 'passenger', score: null, status: 'unscored' }),
      ],
      events: [speeding],
    });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByText("You weren't driving, so this drive isn't scored.")).toBeOnTheScreen();
    expect(screen.getByTestId('unscored-note')).toBeOnTheScreen();
    expect(screen.queryByTestId('category-bars')).toBeNull();
  });
});

describe('the conditions and the data behind them', () => {
  test('night, rain, limit coverage and the camera are words, not icons alone', async () => {
    const w = await world({
      trips: [
        tripRow({
          client_trip_id: ID,
          conditions_json: JSON.stringify({
            night: true,
            precipitation: true,
            hadSevereEvent: false,
          }),
          limit_coverage_pct: 72,
          camera_session: 1,
        }),
      ],
    });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByLabelText('Light: Night')).toBeOnTheScreen();
    expect(screen.getByLabelText('Weather: Rain')).toBeOnTheScreen();
    expect(screen.getByLabelText('Limits known: 72% of the drive')).toBeOnTheScreen();
    expect(screen.getByLabelText('Camera: On for this drive')).toBeOnTheScreen();
  });

  test('a drive crash recovery finished says its tail is missing', async () => {
    const w = await world({ trips: [tripRow({ client_trip_id: ID, incomplete: 1 })] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByTestId('quality-recovered')).toBeOnTheScreen();
    expect(screen.getByText(/the tail of this drive is missing/)).toBeOnTheScreen();
  });
});

describe('the network (plan D2)', () => {
  test('offline, the route field says so instead of drawing a map that cannot load', async () => {
    networkIs(false);
    const w = await world({ trips: [scored], events: [speeding, possible] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');

    expect(screen.getByTestId('map-offline')).toBeOnTheScreen();
    expect(
      screen.getByText("You're offline, so the map is off. The timeline below has every moment.")
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('map-view', hidden)).toBeNull();
    // The timeline is the whole account either way.
    expect(screen.getByTestId('timeline')).toBeOnTheScreen();
  });

  test('coming back online brings the map back without leaving the screen', async () => {
    const net = networkIs(false);
    const w = await world({ trips: [scored], events: [speeding, possible] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('map-offline');

    await act(async () => net.set(true));

    expect(screen.queryByTestId('map-offline')).toBeNull();
    expect(screen.getByTestId('map-view', hidden)).toBeOnTheScreen();
  });

  test('with no network state read yet, the screen does not claim to be offline', async () => {
    const w = await world({ trips: [scored], events: [speeding, possible] });
    await w.renderScreen(<TripDetailScreen clientTripId={ID} />);
    await screen.findByTestId('trip-detail');
    expect(screen.queryByTestId('map-offline')).toBeNull();
    expect(screen.getByTestId('map-view', hidden)).toBeOnTheScreen();
  });
});
