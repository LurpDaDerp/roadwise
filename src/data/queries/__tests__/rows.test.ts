import type { EventRow } from '@/data/db/types';
import { toLocalDriveEvent } from '@/data/queries/rows';

const row = (over: Partial<EventRow> = {}): EventRow => ({
  id: 'e1',
  client_trip_id: 't1',
  type: 'phone_handling',
  tier: 'severe',
  started_at: 1_700_000_000_000,
  duration_s: 40,
  units: 2,
  stopped_in_traffic: 0,
  lat: null,
  lng: null,
  measured_json: '{"mounted":false}',
  penalty: 16,
  status: 'active',
  dispute_status: 'none',
  dispute_reason: null,
  dispute_message: null,
  ...over,
});

test('a drive event keeps its units, so phone handling is scored by its 15-s blocks', () => {
  expect(toLocalDriveEvent(row())).toMatchObject({ type: 'phone_handling', units: 2, durationS: 40, measured: { mounted: false }, removed: false });
  expect(toLocalDriveEvent(row({ units: null })).units).toBeNull();
  expect(toLocalDriveEvent(row({ type: 'hard_brake', tier: 'minor', units: null, status: 'removed' }))).toMatchObject({ units: null, removed: true });
});
