/** @jest-environment node */
import { QueryClient } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo } from '@/data/db/spots';
import type { NewProblemSpot } from '@/data/db/types';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import { claimSpotBadge, SPOT_CLAIMED_KEY, SPOT_PENDING_KEY } from '../claimSpotBadge';

const UID = '00000000-0000-4000-8000-000000000001';

function spot(id: string, clearedAt: number | null): NewProblemSpot {
  return {
    id,
    kind: 'hard_brake',
    state: clearedAt === null ? 'active' : 'cleared',
    lat: 40,
    lng: -74,
    heading_deg: 0,
    segment: '',
    limit_mph: null,
    hits: 3,
    passes: 5,
    recent_hits: 1,
    recent_passes: 3,
    rate: 0.5,
    clean_streak: clearedAt === null ? 0 : 3,
    clean_needed: 3,
    last_hit_at: 1,
    last_hit_trip: 'trip',
    last_pass_at: 2,
    cleared_at: clearedAt,
    rank: 1,
  };
}

let db: Db;
let qc: QueryClient;
let call: jest.Mock<Promise<unknown>, ['claim_spot_cleared']>;

const seed = (rows: NewProblemSpot[]) => createSpotsRepo(db).replaceAll(rows, { computedAt: 1, drives: 1 }, []);
const flag = () => createSettingsRepo(db).get<boolean>(SPOT_CLAIMED_KEY);
const cacheSummary = (achievements: string[]) => qc.setQueryData(['server', UID, 'summary'], { achievements });

beforeEach(async () => {
  db = await createTestDb();
  qc = new QueryClient();
  call = jest.fn(async (_fn: 'claim_spot_cleared') => ['spot_cleared'] as unknown);
});
afterEach(() => qc.clear());

it('claims once a spot has cleared: sets the flag and refetches the summary', async () => {
  await seed([spot('a', null), spot('b', 1000)]);
  cacheSummary(['first_drive']);
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('claimed');
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith('claim_spot_cleared');
  expect(await flag()).toBe(true);
  expect(qc.getQueryState(['server', UID, 'summary'])?.isInvalidated).toBe(true);
  // the flag stops every later call
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('held');
  expect(call).toHaveBeenCalledTimes(1);
});

it('claims nothing while no spot has cleared', async () => {
  await seed([spot('a', null)]);
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('none-cleared');
  expect(call).not.toHaveBeenCalled();
  expect(await flag()).toBeNull();
});

it('a summary that already holds the badge sends no claim and sets the flag', async () => {
  await seed([spot('b', 1000)]);
  cacheSummary(['first_drive', 'spot_cleared']);
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('held');
  expect(call).not.toHaveBeenCalled();
  expect(await flag()).toBe(true);
});

it('a failed claim stays silent, sets no flag, and the next one tries again', async () => {
  await seed([spot('b', 1000)]);
  call.mockRejectedValueOnce(new Error('offline'));
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('failed');
  expect(await flag()).toBeNull();
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('claimed');
  expect(call).toHaveBeenCalledTimes(2);
  expect(await flag()).toBe(true);
});

it('two claims at once send one request', async () => {
  await seed([spot('b', 1000)]);
  const [a, b] = await Promise.all([claimSpotBadge({ db, queryClient: qc, call }), claimSpotBadge({ db, queryClient: qc, call })]);
  expect([a, b]).toEqual(['claimed', 'claimed']);
  expect(call).toHaveBeenCalledTimes(1);
});

it('a failed claim is still owed after the cleared spot has left the table', async () => {
  await seed([spot('b', 1000)]);
  call.mockRejectedValueOnce(new Error('no such function'));
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('failed');
  expect(await createSettingsRepo(db).get<boolean>(SPOT_PENDING_KEY)).toBe(true);
  // 30 days on, the cleared spot is gone from the recompute
  await seed([spot('a', null)]);
  await expect(claimSpotBadge({ db, queryClient: qc, call })).resolves.toBe('claimed');
  expect(call).toHaveBeenCalledTimes(2);
  expect(await flag()).toBe(true);
  expect(await createSettingsRepo(db).get<boolean>(SPOT_PENDING_KEY)).toBeNull();
});
