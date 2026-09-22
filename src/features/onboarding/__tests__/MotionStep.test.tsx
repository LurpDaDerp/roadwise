import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { PROMPTS_KEY } from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  fakeAdapter,
  fakeAppState,
  fakeHost,
  permissionsWorld,
  snap,
  type FakeAdapter,
} from '@/features/permissions/__fixtures__/harness';
import { clearQueryClients } from '@/features/trips/__fixtures__/render';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { PERMISSION_CONSENT_VERSION } from '../state';
import { MotionStep } from '../steps/MotionStep';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
const mockRecordConsent = jest.fn(async (_uid: string, _c: { type: string; version: string }) => ({}));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({
  recordConsent: (uid: string, c: { type: string; version: string }) => mockRecordConsent(uid, c),
}));

const copy = onboardingCopy.motion;

const ctx = (platform: 'ios' | 'android'): FlowContext => ({
  platform,
  ageBand: '18_plus',
  drivingStage: 'new',
  termsCurrent: true,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
});

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });
const requests = (a: FakeAdapter) => a.log.filter((c) => c !== 'snapshot');

afterEach(() => {
  clearQueryClients();
  mockRecordConsent.mockClear();
});

async function renderStep(platform: 'ios' | 'android', adapter: FakeAdapter) {
  const w = await permissionsWorld();
  const onNext = jest.fn();
  await w.render(
    <MotionStep ctx={ctx(platform)} onNext={onNext} deps={{ adapter, appState: fakeAppState(), now: () => T0 }} />,
    fakeHost().host
  );
  return { ...w, onNext };
}

test.each(['ios', 'android'] as const)(
  '%s: one motion request through the drive-sense port, consent on the grant, then on',
  async (platform) => {
    const adapter = fakeAdapter(snap({ platform, motion: 'undetermined' }), { motion: 'granted' });
    const { onNext, settings } = await renderStep(platform, adapter);
    expect(await screen.findByText(copy.title[platform])).toBeOnTheScreen();
    expect(requests(adapter)).toEqual([]);
    await press(screen.getByTestId('motion-allow'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestMotion']);
    expect(mockRecordConsent).toHaveBeenCalledWith('u1', { type: 'motion', version: PERMISSION_CONSENT_VERSION });
    expect(await settings.get(PROMPTS_KEY)).toEqual({ motion: T0 });
  }
);

test('unavailable: the briefed line, no claim about when the phone will ask, and Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', motion: 'unavailable' }), { motion: 'unavailable' });
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText("Your phone didn't let us ask here. You can turn it on in Settings.")).toBeOnTheScreen();
  expect(copy.unavailable).not.toMatch(/later|next|when/i);
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(screen.getByTestId('motion-settings')).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('denied: no consent, said plainly, and still passable (D12)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'undetermined' }), { motion: 'denied' });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText(copy.denied)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(requests(adapter)).toEqual(['requestMotion']);
});

test("can't check: said so, no consent, Continue moves on", async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: null }), { motion: null });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText(copy.cantCheck)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(mockRecordConsent).not.toHaveBeenCalled();
});

test('already allowed: no request; Continue records the consent', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'granted' }));
  const { onNext } = await renderStep('ios', adapter);
  expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
  expect(mockRecordConsent).toHaveBeenCalledTimes(1);
});

test('Not now asks nothing and records nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', motion: 'undetermined' }));
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('motion-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
  expect(mockRecordConsent).not.toHaveBeenCalled();
});
