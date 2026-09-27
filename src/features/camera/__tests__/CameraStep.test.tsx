import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import type { FlowContext } from '@/features/onboarding/flow';
import { fakeHost, permissionsWorld } from '@/features/permissions/__fixtures__/harness';
import { clearQueryClients } from '@/features/trips/__fixtures__/render';

import { CameraStep } from '../CameraStep';
import { cameraConsent, cameraCopy } from '../copy';
import { CAMERA_CONSENT_VERSION, CAMERA_OPT_IN_KEY, readCameraOptIn } from '../optIn';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));

const ctx = (ageBand: FlowContext['ageBand']): FlowContext =>
  ({
    platform: 'ios',
    ageBand,
    drivingStage: 'new',
    termsCurrent: true,
    termsPublished: false,
    minorConsentMode: 'guardian_link_optional',
    features: { autoDetect: true, guardianInvites: false, cameraBeta: true },
  }) as FlowContext;

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

afterEach(() => clearQueryClients());

async function renderStep(ageBand: FlowContext['ageBand'], flag: boolean, record = jest.fn(async () => ({}))) {
  const w = await permissionsWorld();
  const onNext = jest.fn();
  await w.render(
    <CameraStep ctx={ctx(ageBand)} onNext={onNext} deps={{ readCameraBeta: async () => flag, recordConsent: record }} />,
    fakeHost().host
  );
  return { ...w, onNext, record };
}

test('an adult with the flag: the consent text; Turn on records the versioned camera consent, stores it, moves on', async () => {
  const { onNext, record, settings } = await renderStep('18_plus', true);
  expect(await screen.findByText(cameraConsent.lead)).toBeOnTheScreen();
  for (const point of cameraConsent.points) expect(screen.getByText(point)).toBeOnTheScreen();
  await press(screen.getByTestId('camera-turn-on'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(record).toHaveBeenCalledWith('u1', { type: 'camera', version: CAMERA_CONSENT_VERSION });
  await expect(readCameraOptIn(settings, 'u1')).resolves.toBe(true);
});

test('off by default: Not now records nothing and moves on', async () => {
  const { onNext, record, settings } = await renderStep('18_plus', true);
  await press(await screen.findByTestId('camera-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
  await expect(settings.get(CAMERA_OPT_IN_KEY)).resolves.toBeNull();
});

test('a consent the server did not take leaves it off, says so, and stays on the step', async () => {
  const { onNext, settings } = await renderStep('18_plus', true, jest.fn(async () => Promise.reject(new Error('offline'))));
  await press(await screen.findByTestId('camera-turn-on'));
  expect(await screen.findByText(cameraCopy.step.failed)).toBeOnTheScreen();
  expect(onNext).not.toHaveBeenCalled();
  await expect(readCameraOptIn(settings, 'u1')).resolves.toBe(false);
});

test.each([
  ['13_17', true, cameraCopy.step.notAvailableAge],
  ['unknown', true, cameraCopy.step.notAvailableAge],
  ['18_plus', false, cameraCopy.step.notAvailableFlag],
] as const)('age band %s, flag %s: not available, no consent shown, Continue only', async (band, flag, text) => {
  const { onNext, record } = await renderStep(band, flag);
  expect(await screen.findByText(text)).toBeOnTheScreen();
  expect(screen.queryByTestId('camera-consent')).toBeNull();
  expect(screen.queryByTestId('camera-turn-on')).toBeNull();
  await press(screen.getByTestId('camera-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
});
