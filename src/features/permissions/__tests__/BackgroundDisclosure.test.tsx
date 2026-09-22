import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  AUTO_RECORD_INTENT_KEY,
  DISCLOSURE_AFFIRMED_KEY,
  MANUAL_BY_CHOICE_KEY,
  PROMPTS_KEY,
} from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import { DISCLOSURE_TEXT } from '@/features/drive/detectionCopy';
import {
  drive,
  fakeAdapter,
  fakeAppState,
  fakeHost,
  permissionsWorld,
  snap,
  type FakeAdapter,
  type Seed,
} from '@/features/permissions/__fixtures__/harness';
import { BackgroundDisclosure, type DisclosureReason } from '@/features/permissions/BackgroundDisclosure';
import { PENDING_DISCLOSURE_CONSENT_KEY } from '@/features/permissions/usePermissionHealth';
import { clearQueryClients } from '@/features/trips/__fixtures__/render';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

afterEach(clearQueryClients);

const requests = (a: FakeAdapter) => a.log.filter((c) => c !== 'snapshot');

async function renderDisclosure(
  adapter: FakeAdapter,
  opts: { reason?: DisclosureReason; seed?: Seed; enableAutoRecord?: boolean; consent?: jest.Mock } = {}
) {
  const w = await permissionsWorld(opts.seed ?? { trips: [drive(1)] });
  const fh = fakeHost();
  const appState = fakeAppState();
  const onResult = jest.fn();
  const recordConsent = opts.consent ?? jest.fn(async () => ({}));
  await w.render(
    <BackgroundDisclosure
      reason={opts.reason ?? 'repair'}
      enableAutoRecord={opts.enableAutoRecord}
      onResult={onResult}
      deps={{ adapter, appState, now: () => T0, recordConsent }}
    />,
    fh.host
  );
  return { ...w, host: fh.host, appState, onResult, recordConsent };
}

test('the disclosure is printed, and nothing is asked before Continue', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { settings } = await renderDisclosure(adapter);
  expect(await screen.findByText(DISCLOSURE_TEXT.heading)).toBeOnTheScreen();
  expect(screen.getByText(DISCLOSURE_TEXT.body)).toBeOnTheScreen();
  expect(await screen.findByTestId('disclosure-continue')).toBeOnTheScreen();
  expect(requests(adapter)).toEqual([]);
  expect(await settings.get(DISCLOSURE_AFFIRMED_KEY)).toBeNull();
});

test('Continue: affirmation stored, ONE Always request, consent recorded only on always', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { settings, onResult, recordConsent } = await renderDisclosure(adapter, {
    seed: { trips: [drive(1)], settings: { [MANUAL_BY_CHOICE_KEY]: true } },
  });
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('always'));
  expect(requests(adapter)).toEqual(['requestLocationAlways:firstDriveDone=true']);
  expect(await settings.get(DISCLOSURE_AFFIRMED_KEY)).toEqual({ version: 'pd-1', at: T0 });
  expect(recordConsent).toHaveBeenCalledWith('u1', { type: 'background_location', version: 'pd-1' });
  expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBeNull();
  // The driver tapped: the 14-day history is stamped so the app's own offers wait.
  expect(await settings.get(PROMPTS_KEY)).toEqual({ locationAlways: T0 });
});

test('a denial records no consent and marks manual by choice', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }), { always: 'foreground' });
  const { settings, onResult, recordConsent, host } = await renderDisclosure(adapter, {
    seed: { trips: [drive(1)], settings: { [AUTO_RECORD_INTENT_KEY]: true } },
  });
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('declined'));
  expect(recordConsent).not.toHaveBeenCalled();
  expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBe(true);
  expect(host.setAutoDetect).not.toHaveBeenCalled();
});

test('the driver’s auto-record intent turns auto-record on when Always arrives', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { host, onResult } = await renderDisclosure(adapter, {
    seed: { trips: [drive(1)], settings: { [AUTO_RECORD_INTENT_KEY]: true } },
  });
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('always'));
  expect(host.setAutoDetect).toHaveBeenCalledWith(true);
});

test('no intent: Always alone never turns auto-record on', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { host, onResult } = await renderDisclosure(adapter);
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('always'));
  expect(host.setAutoDetect).not.toHaveBeenCalled();
});

test('an auto-record entry (the offers, B2’s repair): Continue says the driver wants it on', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { host, settings } = await renderDisclosure(adapter, { enableAutoRecord: true });
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
  expect(await settings.get(AUTO_RECORD_INTENT_KEY)).toBe(true);
});

test('Not now asks nothing and marks manual by choice', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { settings, onResult, recordConsent } = await renderDisclosure(adapter);
  await press(await screen.findByTestId('disclosure-not-now'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('declined'));
  expect(requests(adapter)).toEqual([]);
  expect(recordConsent).not.toHaveBeenCalled();
  expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBe(true);
  expect(await settings.get(DISCLOSURE_AFFIRMED_KEY)).toBeNull();
});

test('when the OS can no longer ask: Open Settings, and the grant is picked up on the way back', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground', locationCanAskAgain: false }));
  const { appState, onResult, recordConsent } = await renderDisclosure(adapter);
  expect(await screen.findByText('Choose Always in Settings, then come back')).toBeOnTheScreen();
  const button = screen.getByTestId('disclosure-continue');
  expect(button).toHaveTextContent('Open Settings');
  await press(button);
  expect(requests(adapter)).toEqual(['openAppSettings']);
  expect(onResult).not.toHaveBeenCalled();
  // Back from Settings with Always chosen.
  adapter.current = snap({ platform: 'ios', location: 'always' });
  await act(async () => appState.foreground());
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('always'));
  expect(recordConsent).toHaveBeenCalledWith('u1', { type: 'background_location', version: 'pd-1' });
  expect(adapter.log.some((c) => c.startsWith('requestLocationAlways'))).toBe(false);
});

test('Android, when the OS can no longer ask: the Android wording', async () => {
  await renderDisclosure(fakeAdapter(snap({ location: 'foreground', locationCanAskAgain: false })));
  expect(await screen.findByText('Choose Allow all the time in Settings, then come back')).toBeOnTheScreen();
});

test('back from Settings without Always: nothing recorded, nothing assumed', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground', locationCanAskAgain: false }));
  const { appState, onResult, recordConsent, settings } = await renderDisclosure(adapter);
  await press(await screen.findByTestId('disclosure-continue'));
  await act(async () => appState.foreground());
  await waitFor(() => expect(adapter.log.filter((c) => c === 'snapshot').length).toBe(2));
  expect(onResult).not.toHaveBeenCalled();
  expect(recordConsent).not.toHaveBeenCalled();
  expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBeNull();
});

test('iOS before the first completed drive: nothing is offered or asked (design §5.3)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }));
  const { onResult, settings } = await renderDisclosure(adapter, { reason: 'onboarding', seed: { trips: [] } });
  expect(await screen.findByText('On iPhone, RoadWise asks for this after your first drive.')).toBeOnTheScreen();
  expect(screen.queryByTestId('disclosure-continue')).toBeNull();
  await press(screen.getByTestId('disclosure-back'));
  expect(onResult).toHaveBeenCalledWith('notAsked');
  expect(requests(adapter)).toEqual([]);
  expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBeNull();
});

test('Android before any drive (onboarding): offered, since §5.3’s wait is iOS only', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const { onResult } = await renderDisclosure(adapter, { reason: 'onboarding', seed: { trips: [] } });
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('always'));
  expect(requests(adapter)).toEqual(['requestLocationAlways:firstDriveDone=false']);
});

test('no While Using location yet: nothing asked', async () => {
  const adapter = fakeAdapter(snap({ location: 'denied', precise: null }));
  await renderDisclosure(adapter);
  expect(await screen.findByTestId('disclosure-not-yet')).toHaveTextContent(/Allow location while using the app first/);
  expect(screen.queryByTestId('disclosure-continue')).toBeNull();
});

test('offline: the grant still counts, and the consent is kept to send later', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  const consent = jest.fn(async () => {
    throw new Error('offline');
  });
  const { onResult, settings } = await renderDisclosure(adapter, { consent });
  await press(await screen.findByTestId('disclosure-continue'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith('always'));
  expect(await settings.get(PENDING_DISCLOSURE_CONSENT_KEY)).toBe('pd-1');
});

test('a read failure is an inline error with a retry', async () => {
  const adapter = fakeAdapter(snap({ location: 'foreground' }));
  adapter.failReads = true;
  await renderDisclosure(adapter);
  expect(await screen.findByTestId('disclosure-read-error')).toBeOnTheScreen();
  expect(screen.queryByTestId('disclosure-continue')).toBeNull();
  adapter.failReads = false;
  await press(screen.getByText('Try again'));
  expect(await screen.findByTestId('disclosure-continue')).toBeOnTheScreen();
});
