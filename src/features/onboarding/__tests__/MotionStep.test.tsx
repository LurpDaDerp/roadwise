import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { PROMPTS_KEY } from '@/core/permissions';
import {
  fakeAdapter,
  fakeAppState,
  fakeHost,
  T0,
  appWorld,
  clearQueryClients,
  snap,
  type FakeAdapter,
} from '@/features/permissions/__fixtures__/harness';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { MotionStep } from '../steps/MotionStep';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

const copy = onboardingCopy.motion;

const ctx = (platform: 'ios' | 'android'): FlowContext => ({ platform, hasUsername: true });

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });
const requests = (a: FakeAdapter) => a.log.filter((c) => c !== 'snapshot');

afterEach(() => {
  clearQueryClients();
});

async function renderStep(platform: 'ios' | 'android', adapter: FakeAdapter) {
  const w = await appWorld();
  const onNext = jest.fn();
  await w.render(
    <MotionStep ctx={ctx(platform)} onNext={onNext} deps={{ adapter, appState: fakeAppState(), now: () => T0 }} />,
    fakeHost().host
  );
  return { ...w, onNext };
}

test.each(['ios', 'android'] as const)(
  '%s: one motion request through the drive-sense port on the grant, then on',
  async (platform) => {
    const adapter = fakeAdapter(snap({ platform, motion: 'undetermined' }), { motion: 'granted' });
    const { onNext, settings } = await renderStep(platform, adapter);
    expect(await screen.findByText(copy.title[platform])).toBeOnTheScreen();
    expect(requests(adapter)).toEqual([]);
    await press(screen.getByTestId('motion-allow'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestMotion']);
    expect(await settings.get(PROMPTS_KEY)).toEqual({ motion: T0 });
  }
);

test.each(['ios', 'android'] as const)('%s: under what motion access is for, the line on phone pickups: felt by motion, never the screen', async (platform) => {
  const adapter = fakeAdapter(snap({ platform, motion: 'undetermined' }));
  await renderStep(platform, adapter);
  expect(await screen.findByText(copy.body[platform])).toBeOnTheScreen();
  expect(screen.getByTestId('motion-phone')).toHaveTextContent('RoadWise spots pickups from motion alone. It never sees your screen, apps or messages.');
});

test('unavailable: the briefed line, no claim about when the phone will ask, and Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', motion: 'unavailable' }), { motion: 'unavailable' });
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText('Your phone didn\'t let RoadWise ask here. You can turn it on in Settings.')).toBeOnTheScreen();
  expect(copy.unavailable).not.toMatch(/later|next|when/i);
  expect(screen.getByTestId('motion-settings')).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('denied: said plainly, and still passable (D12)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'undetermined' }), { motion: 'denied' });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText(copy.denied.ios)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual(['requestMotion']);
});

test("can't check: said so, Continue moves on", async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: null }), { motion: null });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText(copy.cantCheck)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('already allowed: no request; Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'granted' }));
  const { onNext } = await renderStep('ios', adapter);
  expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

test('Android: Not now asks nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', motion: 'undetermined' }));
  const { onNext } = await renderStep('android', adapter);
  expect(await screen.findByTestId('motion-allow')).toHaveTextContent('Allow motion access');
  await press(screen.getByTestId('motion-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

test("iPhone: before the system alert, one button, Continue, which opens it; no Not now (Apple's rule)", async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'undetermined' }));
  await renderStep('ios', adapter);
  await screen.findByText(copy.body.ios);
  await waitFor(() => expect(screen.getByTestId('motion-allow')).toBeEnabled());
  expect(screen.getByTestId('motion-allow')).toHaveTextContent('Continue', { exact: true });
  expect(screen.queryByTestId('motion-not-now')).toBeNull();
  expect(screen.queryByTestId('motion-continue')).toBeNull();
  expect(requests(adapter)).toEqual([]);
});

test('iPhone: a request that fails (no alert came) says so, offers Continue again and Not now, which moves on (D12)', async () => {
  const say = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
  say.mockClear();
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'undetermined' }));
  adapter.requestMotion = jest.fn(async () => {
    adapter.log.push('requestMotion');
    throw new Error('no answer');
  });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText(copy.failed)).toBeOnTheScreen();
  // Read out as it appears: VoiceOver stays on the button.
  expect(say.mock.calls).toEqual([[copy.failed, { queue: true }]]);
  expect(screen.getByTestId('motion-allow')).toHaveTextContent('Continue', { exact: true });
  await press(screen.getByTestId('motion-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual(['requestMotion']);
});

test('iPhone: back from Settings after a refusal, the screen keeps Not now beside Continue', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', motion: 'undetermined' }), { motion: 'denied' });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('motion-allow'));
  expect(await screen.findByText(copy.denied.ios)).toBeOnTheScreen();
  await press(screen.getByTestId('motion-settings'));
  expect(await screen.findByTestId('motion-not-now')).toBeOnTheScreen();
  expect(screen.getByTestId('motion-allow')).toHaveTextContent('Continue', { exact: true });
  await press(screen.getByTestId('motion-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual(['requestMotion', 'openAppSettings']);
});
