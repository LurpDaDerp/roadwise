import { newClientTripId, newIdempotencyKey } from '@/lib/ids';

// babel-plugin-jest-hoist lifts this above the import at transform time.
jest.mock('expo-crypto', () => ({ randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' }));

test('client trip id is a uuid', () => expect(newClientTripId()).toMatch(/^[0-9a-f-]{36}$/));
test('idempotency key is prefixed', () => expect(newIdempotencyKey('trip')).toBe('trip:123e4567-e89b-42d3-a456-426614174000'));
