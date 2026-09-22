import { screen } from '@testing-library/react-native';

import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';
import { EventListScreen } from '@/features/trips/EventListScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ID = 'trip-1';

const trip = tripRow({
  client_trip_id: ID,
  score: 84,
  category_deductions_json: JSON.stringify(deductions({ speeding: 9 })),
});

const speeding = (id: string, confidence: number, at: number) =>
  eventRow({ id, client_trip_id: ID, category: 'speeding', confidence, started_at: T0 + at });

afterEach(clearQueryClients);

describe('D3 list: uncertain reading', () => {
  test('a speeding moment with an uncertain reading is labelled in the list; a confident one is not', async () => {
    const w = await world({
      trips: [trip],
      events: [speeding('unsure', 0.6, 60_000), speeding('sure', 0.9, 120_000)],
    });
    await w.renderScreen(<EventListScreen clientTripId={ID} />);
    await screen.findByTestId('event-timeline');
    expect(screen.getByTestId('reading-uncertain-unsure')).toHaveTextContent('uncertain reading');
    expect(screen.getByTestId('timeline-unsure').props.accessibilityLabel).toContain('uncertain reading');
    // Negative control.
    expect(screen.queryByTestId('reading-uncertain-sure')).toBeNull();
    expect(screen.getByTestId('timeline-sure').props.accessibilityLabel).not.toContain('uncertain reading');
  });
});
