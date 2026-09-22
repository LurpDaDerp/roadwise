import { act, waitFor } from '@testing-library/react-native';
import { useState } from 'react';

import { ALWAYS_OFFER_KEY, MANUAL_BY_CHOICE_KEY, PROMPT_INTERVAL_MS, PROMPTS_KEY } from '@/core/permissions';
import type { PermissionPlatform } from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  drive,
  fakeAdapter,
  fakeHost,
  noRefresh,
  permissionsWorld,
  snap,
  type FakeAdapter,
  type Seed,
} from '@/features/permissions/__fixtures__/harness';
import { offerHref, PermissionPromptsHost } from '@/features/permissions/PermissionPromptsHost';
import { clearQueryClients, routerDouble } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useSegments: () => ['(tabs)', 'home'] }));
const mockSession = {
  session: { user: { id: 'u1' } },
  profile: { driving_stage: 'new' } as { driving_stage: string } | null,
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

afterEach(() => {
  clearQueryClients();
  mockSession.profile = { driving_stage: 'new' };
  jest.clearAllMocks();
});

const TABS = ['(tabs)', 'home'];

async function renderHost(
  opts: {
    platform?: PermissionPlatform;
    adapter?: FakeAdapter;
    seed?: Seed;
    segments?: string[];
    busy?: boolean;
  } = {}
) {
  const platform = opts.platform ?? 'ios';
  const adapter = opts.adapter ?? fakeAdapter(snap({ platform, location: 'foreground' }));
  const w = await permissionsWorld(opts.seed ?? { trips: [drive(1)] });
  const fh = fakeHost({ busy: opts.busy });
  const route: { go: (segments: string[]) => void } = { go: () => {} };
  function Routed() {
    const [segments, setSegments] = useState(opts.segments ?? TABS);
    route.go = setSegments;
    return (
      <PermissionPromptsHost
        isBusy={fh.host.isBusy}
        segments={segments}
        deps={{ adapter, platform, now: () => T0, appConfig: { refresher: noRefresh } }}
      />
    );
  }
  const r = await w.render(<Routed />, fh.host);
  // Let the host look (settings reads, and the phone if an offer could be due).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { ...w, ...r, ...fh, adapter, route };
}

test('iOS: offered once after the first completed drive, through the disclosure, and recorded', async () => {
  const { settings } = await renderHost();
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(offerHref('first-drive')));
  expect(await settings.get(ALWAYS_OFFER_KEY)).toEqual({ 'first-drive': T0 });
  // An app-started prompt: stamped in the 14-day history (offerPrompt).
  expect(await settings.get(PROMPTS_KEY)).toEqual({ locationAlways: T0 });
});

test('the offer never asks the OS itself', async () => {
  const { adapter } = await renderHost();
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
  expect(adapter.log.filter((c) => c !== 'snapshot')).toEqual([]);
});

test('iOS: not before the first drive, and nothing native is read', async () => {
  const { adapter } = await renderHost({ seed: { trips: [] } });
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(adapter.log).toEqual([]);
});

test('iOS: the first offer is not repeated on the second drive', async () => {
  const { adapter } = await renderHost({
    seed: { trips: [drive(1), drive(2)], settings: { [ALWAYS_OFFER_KEY]: { 'first-drive': T0 - 1 } } },
  });
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(adapter.log).toEqual([]);
});

test('both platforms: once more after the third drive, when the 14-day window allows', async () => {
  const past = T0 - PROMPT_INTERVAL_MS;
  const { settings } = await renderHost({
    platform: 'android',
    seed: { trips: [drive(1), drive(2), drive(3)], settings: { [PROMPTS_KEY]: { locationAlways: past } } },
  });
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(offerHref('third-drive')));
  expect(await settings.get(ALWAYS_OFFER_KEY)).toEqual({ 'third-drive': T0 });
});

test('not inside the 14-day window', async () => {
  await renderHost({
    platform: 'android',
    seed: { trips: [drive(1), drive(2), drive(3)], settings: { [PROMPTS_KEY]: { locationAlways: T0 - 1000 } } },
  });
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('Android: no first-drive offer (A6 asked during onboarding)', async () => {
  const { adapter } = await renderHost({ platform: 'android' });
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(adapter.log).toEqual([]);
});

test('after both offers, only B2; and the host stops reading (review m5)', async () => {
  const r = await renderHost({
    seed: {
      trips: [drive(1), drive(2), drive(3), drive(4)],
      settings: { [ALWAYS_OFFER_KEY]: { 'first-drive': 1, 'third-drive': 2 } },
    },
  });
  expect(mockRouter.push).not.toHaveBeenCalled();
  const execute = jest.spyOn(r.db, 'execute');
  await act(async () => r.publish({ status: 'armed' }));
  await act(async () => r.publish({ status: 'off' }));
  expect(execute).not.toHaveBeenCalled();
  expect(r.adapter.log).toEqual([]);
});

test('never for a driver who chose manual', async () => {
  await renderHost({ seed: { trips: [drive(1)], settings: { [MANUAL_BY_CHOICE_KEY]: true } } });
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('never when Always is already granted', async () => {
  await renderHost({ adapter: fakeAdapter(snap({ platform: 'ios', location: 'always' })) });
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('never for a non-driver', async () => {
  mockSession.profile = { driving_stage: 'non_driver' };
  await renderHost();
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('never while auto-record is withdrawn by the server', async () => {
  await renderHost({ seed: { trips: [drive(1)], autoDetect: false } });
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('never outside (tabs); offered once the driver is back there', async () => {
  const r = await renderHost({ segments: ['(app)', 'trips', 'trip-1'] });
  expect(mockRouter.push).not.toHaveBeenCalled();
  await act(async () => r.route.go(TABS));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(offerHref('first-drive')));
});

test('never while the drive host is busy; offered once it is idle again', async () => {
  const r = await renderHost({ busy: true });
  expect(mockRouter.push).not.toHaveBeenCalled();
  r.setBusy(false);
  await act(async () => r.publish({ status: 'armed' }));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(offerHref('first-drive')));
});

test('a phone that cannot be read is offered nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }));
  adapter.failReads = true;
  const { settings } = await renderHost({ adapter });
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(await settings.get(ALWAYS_OFFER_KEY)).toBeNull();
});
