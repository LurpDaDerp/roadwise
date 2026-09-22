import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { CONFIG_DEFAULTS, type AppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createQueryClient } from '@/data/queries/client';
import { DataProvider } from '@/data/queries/context';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { DISCLAIMER_VERSION } from '@/features/auth/legal';

import {
  buildFlowContext,
  CONSENTS_CACHE_KEY,
  readCachedConsents,
  useFlowContext,
  writeCachedConsents,
} from '../context';
import { markBlockPurged, readBlockPurged } from '../api';

const USER = 'user-1';
const mockConfig: { config: AppConfig; ready: boolean } = {
  config: { ...CONFIG_DEFAULTS, fetchedAt: 1 },
  ready: true,
};
const mockSession: {
  session: { user: { id: string } } | null;
  profile: Record<string, unknown> | null;
} = { session: { user: { id: USER } }, profile: null };
const mockFetchConsents = jest.fn(async (_id: string) => [] as { type: string; version: string }[]);

jest.mock('@/data/config/appConfig', () => ({
  ...jest.requireActual('@/data/config/appConfig'),
  useAppConfig: () => mockConfig,
}));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  fetchOwnConsents: (id: string) => mockFetchConsents(id),
}));

const PUBLISHED: AppConfig = {
  ...CONFIG_DEFAULTS,
  fetchedAt: 1,
  onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
  legal_urls: { terms: 'https://x.example/t', privacy: 'https://x.example/p' },
};
const ACKED = { disclaimerAcknowledged: DISCLAIMER_VERSION };
const HELD = [
  { type: 'tos', version: 't-2' },
  { type: 'privacy', version: 'p-3' },
];

let db: Db;
let client: ReturnType<typeof createQueryClient>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <DataProvider db={db}>{children}</DataProvider>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  db = await createTestDb();
  client = createQueryClient();
  mockConfig.config = { ...CONFIG_DEFAULTS, fetchedAt: 1 };
  mockConfig.ready = true;
  mockSession.session = { user: { id: USER } };
  mockSession.profile = { id: USER, age_band: '18_plus', driving_stage: 'new', flags: {} };
  mockFetchConsents.mockReset().mockResolvedValue([]);
});

afterEach(() => client.clear());

describe('buildFlowContext', () => {
  const base = {
    platform: 'ios' as const,
    profile: { age_band: '13_17', driving_stage: 'permit', flags: ACKED },
    config: CONFIG_DEFAULTS,
    consents: [],
  };

  it('unpublished: the disclaimer acknowledgement alone makes the terms current (T11 carry)', () => {
    const c = buildFlowContext(base);
    expect(c).toMatchObject({ termsCurrent: true, termsPublished: false });
    expect(buildFlowContext({ ...base, profile: { ...base.profile, flags: {} } }).termsCurrent).toBe(false);
    expect(
      buildFlowContext({
        ...base,
        profile: { ...base.profile, flags: { disclaimerAcknowledged: '2000-01-01' } },
      }).termsCurrent
    ).toBe(false);
  });

  it('published: both consents at the current versions as well', () => {
    expect(buildFlowContext({ ...base, config: PUBLISHED }).termsCurrent).toBe(false);
    expect(buildFlowContext({ ...base, config: PUBLISHED, consents: HELD })).toMatchObject({
      termsCurrent: true,
      termsPublished: true,
    });
  });

  it('band, stage, consent mode and flags come through', () => {
    const c = buildFlowContext({
      ...base,
      config: {
        ...CONFIG_DEFAULTS,
        minor_consent_mode: 'guardian_consent_required',
        flags: { ...CONFIG_DEFAULTS.flags, guardian_invites: true, auto_detect: false },
      },
    });
    expect(c).toEqual({
      platform: 'ios',
      ageBand: '13_17',
      drivingStage: 'permit',
      termsCurrent: true,
      termsPublished: false,
      minorConsentMode: 'guardian_consent_required',
      features: { autoDetect: false, guardianInvites: true },
    });
  });

  it('unknown values read as unknown', () => {
    const c = buildFlowContext({ ...base, profile: { age_band: 'x', driving_stage: null, flags: null } });
    expect(c).toMatchObject({ ageBand: 'unknown', drivingStage: 'unknown', termsCurrent: false });
  });
});

describe('the consents cache', () => {
  it("round-trips, and never serves another account's", async () => {
    const settings = createSettingsRepo(db);
    await writeCachedConsents(settings, USER, HELD);
    expect(await readCachedConsents(settings, USER)).toEqual(HELD);
    expect(await readCachedConsents(settings, 'someone-else')).toBeNull();
    await settings.set(CONSENTS_CACHE_KEY, 'garbage');
    expect(await readCachedConsents(settings, USER)).toBeNull();
  });
});

describe('useFlowContext', () => {
  it('is null while there is no profile, and while the config cache is unread', async () => {
    mockSession.profile = null;
    const { result, rerender } = await renderHook(() => useFlowContext(), { wrapper });
    expect(result.current).toBeNull();
    mockSession.profile = { id: USER, age_band: '18_plus', driving_stage: 'new', flags: {} };
    mockConfig.ready = false;
    await rerender({});
    expect(result.current).toBeNull();
    mockConfig.ready = true;
    await rerender({});
    expect(result.current).toMatchObject({ ageBand: '18_plus', drivingStage: 'new' });
  });

  it('unpublished: never asks the server for consents', async () => {
    mockSession.profile = { id: USER, age_band: '18_plus', driving_stage: 'new', flags: ACKED };
    const { result } = await renderHook(() => useFlowContext(), { wrapper });
    expect(result.current).toMatchObject({ termsCurrent: true, termsPublished: false });
    await act(async () => {});
    expect(mockFetchConsents).not.toHaveBeenCalled();
  });

  it('published, offline cold start: the cached consents decide, without waiting on the network', async () => {
    mockConfig.config = PUBLISHED;
    mockSession.profile = { id: USER, age_band: '18_plus', driving_stage: 'new', flags: ACKED };
    await writeCachedConsents(createSettingsRepo(db), USER, HELD);
    // A request that never answers: a phone in a tunnel.
    mockFetchConsents.mockReturnValue(new Promise(() => {}));
    const { result } = await renderHook(() => useFlowContext(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toMatchObject({ termsCurrent: true, termsPublished: true });
  });

  it('published, with no cache and no network: Terms are owed (asked again, never assumed)', async () => {
    mockConfig.config = PUBLISHED;
    mockSession.profile = { id: USER, age_band: '18_plus', driving_stage: 'new', flags: ACKED };
    mockFetchConsents.mockRejectedValue(new Error('offline'));
    const { result } = await renderHook(() => useFlowContext(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.termsCurrent).toBe(false);
  });

  it("published: the server's answer replaces the cache, and is cached for next time", async () => {
    mockConfig.config = PUBLISHED;
    mockSession.profile = { id: USER, age_band: '18_plus', driving_stage: 'new', flags: ACKED };
    mockFetchConsents.mockResolvedValue(HELD);
    const { result } = await renderHook(() => useFlowContext(), { wrapper });
    await waitFor(() => expect(result.current?.termsCurrent).toBe(true));
    expect(await readCachedConsents(createSettingsRepo(db), USER)).toEqual(HELD);
  });
});

describe('the block removal stamp (T12 r1 n1)', () => {
  it('release then re-block: the stamp goes on release, so the full removal runs again', async () => {
    // Blocked, and the removal finished.
    await markBlockPurged(db, USER);
    mockSession.profile = { id: USER, age_band: 'u13', driving_stage: 'unknown', flags: {} };
    const { rerender } = await renderHook(() => useFlowContext(), { wrapper });
    await act(async () => {});
    expect(await readBlockPurged(db, USER)).toBe(true);

    // Released at 13 (or corrected by support): the account is seen as 13_17.
    mockSession.profile = { id: USER, age_band: '13_17', driving_stage: 'unknown', flags: {} };
    await rerender({});
    await waitFor(async () => expect(await readBlockPurged(db, USER)).toBe(false));

    // Blocked again: nothing stamped, so the block screen runs the whole removal.
    mockSession.profile = { id: USER, age_band: 'u13', driving_stage: 'unknown', flags: {} };
    await rerender({});
    await act(async () => {});
    expect(await readBlockPurged(db, USER)).toBe(false);
  });

  it('an unknown band leaves the stamp alone', async () => {
    await markBlockPurged(db, USER);
    mockSession.profile = { id: USER, age_band: 'unknown', driving_stage: 'unknown', flags: {} };
    await renderHook(() => useFlowContext(), { wrapper });
    await act(async () => {});
    expect(await readBlockPurged(db, USER)).toBe(true);
  });
});
