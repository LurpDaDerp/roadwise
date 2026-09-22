import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { AUTO_RECORD_INTENT_KEY, MANUAL_BY_CHOICE_KEY } from '@/core/permissions';
import { CONFIG_DEFAULTS } from '@/data/config/appConfig';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  drive,
  fakeAdapter,
  fakeAppState,
  fakeHost,
  noRefresh,
  permissionsWorld,
  snap,
  type FakeAdapter,
  type Seed,
} from '@/features/permissions/__fixtures__/harness';
import { SETTINGS_RETURN_ACK_KEY } from '@/features/permissions/usePermissionHealth';
import { clearQueryClients } from '@/features/trips/__fixtures__/render';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { AutoDetectStep } from '../steps/AutoDetectStep';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

const copy = onboardingCopy.autoRecord;

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

afterEach(() => clearQueryClients());

async function renderStep(
  platform: 'ios' | 'android',
  adapter: FakeAdapter,
  opts: { seed?: Seed; intent?: boolean; status?: 'off' | 'armed'; manufacturer?: string | null } = {}
) {
  const w = await permissionsWorld(opts.seed ?? {});
  const fh = fakeHost({ intent: opts.intent, status: opts.status });
  const onNext = jest.fn();
  const appState = fakeAppState();
  await w.render(
    <AutoDetectStep
      ctx={ctx(platform)}
      onNext={onNext}
      deps={{
        adapter,
        appState,
        now: () => T0,
        manufacturer: opts.manufacturer ?? null,
        appConfig: { refresher: noRefresh },
      }}
    />,
    fh.host
  );
  const keys = async () =>
    (await w.db.execute('SELECT key FROM settings')).rows.map((r) => (r as { key: string }).key);
  return { ...w, onNext, host: fh.host, appState, keys };
}

const autoDetectKeys = (keys: string[]) => keys.filter((k) => /auto.?detect|auto.?record/i.test(k));

describe('Android with Always and motion', () => {
  test('Turn on goes through the drive host, writes no auto-detect setting of its own, and moves on', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android' }));
    const { onNext, host, settings, keys } = await renderStep('android', adapter, {
      seed: { settings: { [MANUAL_BY_CHOICE_KEY]: true } },
    });
    expect(await screen.findByText(copy.toggleOff)).toBeOnTheScreen();
    await press(screen.getByTestId('auto-record-turn-on'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(host.setAutoDetect).toHaveBeenCalledWith(true);
    expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBeNull();
    expect(autoDetectKeys(await keys())).toEqual([]);
  });

  test('the toggle says plainly that it turns on automatic recording, and reads the host choice, not the status', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android' }));
    const { host } = await renderStep('android', adapter, { intent: true, status: 'off' });
    const toggle = await screen.findByTestId('auto-record-toggle');
    expect(toggle.props.value).toBe(true);
    expect(screen.getByText(copy.toggleOn)).toBeOnTheScreen();
    expect(copy.toggleOn).toMatch(/recording your drives automatically/);
    // Already on: Continue, no Skip.
    expect(screen.getByTestId('auto-record-continue')).toBeOnTheScreen();
    expect(screen.queryByTestId('auto-record-skip')).toBeNull();
    await act(async () => {
      fireEvent(toggle, 'valueChange', false);
    });
    expect(host.setAutoDetect).toHaveBeenCalledWith(false);
    expect(await screen.findByTestId('auto-record-skip')).toBeOnTheScreen();
  });

  test('Skip marks manual by choice and turns nothing on', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android' }));
    const { onNext, host, settings } = await renderStep('android', adapter, {
      seed: { settings: { [AUTO_RECORD_INTENT_KEY]: true } },
    });
    await press(await screen.findByTestId('auto-record-skip'));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBe(true);
    expect(await settings.get(AUTO_RECORD_INTENT_KEY)).toBeNull();
    expect(host.setAutoDetect).not.toHaveBeenCalled();
  });

  test('battery: the maker guide, the button to battery settings and the status the phone can read', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', batteryOptimization: 'optimized' }));
    const { settings } = await renderStep('android', adapter, { manufacturer: 'samsung' });
    expect(await screen.findByText(CONFIG_DEFAULTS.oem_battery_guides.samsung!.title)).toBeOnTheScreen();
    expect(screen.getByText(copy.battery.optimized)).toBeOnTheScreen();
    await press(screen.getByTestId('auto-record-battery'));
    expect(adapter.log).toContain('openBatterySettings');
    expect(await settings.get(SETTINGS_RETURN_ACK_KEY)).toBe(T0);
  });

  test('battery that cannot be read: guide and button, no status line', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', batteryOptimization: 'unknown' }));
    await renderStep('android', adapter);
    expect(await screen.findByText(CONFIG_DEFAULTS.oem_battery_guides.default.title)).toBeOnTheScreen();
    expect(screen.getByTestId('auto-record-battery')).toBeOnTheScreen();
    expect(screen.queryByText(copy.battery.optimized)).toBeNull();
    expect(screen.queryByText(copy.battery.exempt)).toBeNull();
  });
});

test('Android without Always: the toggle is disabled and says why; Continue moves on and writes nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'foreground' }));
  const { onNext, host, keys } = await renderStep('android', adapter);
  const toggle = await screen.findByTestId('auto-record-toggle');
  expect(toggle.props.disabled).toBe(true);
  expect(screen.getByText(copy.needs.always.android)).toBeOnTheScreen();
  await press(screen.getByTestId('auto-record-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(host.setAutoDetect).not.toHaveBeenCalled();
  expect(autoDetectKeys(await keys())).toEqual([]);
});

test('Android without motion: disabled, and says motion is what it needs', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', motion: 'denied' }));
  await renderStep('android', adapter);
  expect(await screen.findByText(copy.needs.motion)).toBeOnTheScreen();
  expect(screen.getByTestId('auto-record-toggle').props.disabled).toBe(true);
});

describe('iOS', () => {
  test('before the first drive: Turn on stores the intent only, and says when it turns on', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground', batteryOptimization: 'exempt' }));
    const { onNext, host, settings } = await renderStep('ios', adapter);
    expect(await screen.findByText(copy.iosAfterFirstDrive)).toBeOnTheScreen();
    expect(copy.iosAfterFirstDrive).toBe('Turns on after your first drive, once you allow it.');
    await press(screen.getByTestId('auto-record-turn-on'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(await settings.get(AUTO_RECORD_INTENT_KEY)).toBe(true);
    expect(host.setAutoDetect).not.toHaveBeenCalled();
    expect(adapter.log.filter((c) => c !== 'snapshot')).toEqual([]);
    // No battery section on iPhone.
    expect(screen.queryByTestId('auto-record-battery')).toBeNull();
  });

  test('after the first drive with Always and motion: through the host', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios' }));
    const { host } = await renderStep('ios', adapter, { seed: { trips: [drive(1)] } });
    await press(await screen.findByTestId('auto-record-turn-on'));
    await waitFor(() => expect(host.setAutoDetect).toHaveBeenCalledWith(true));
  });

  test('after the first drive without Always: disabled, with the iPhone wording', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }));
    await renderStep('ios', adapter, { seed: { trips: [drive(1)] } });
    expect(await screen.findByText(copy.needs.always.ios)).toBeOnTheScreen();
  });
});

test('a read failure: said, with a retry, and Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android' }));
  adapter.failReads = true;
  const { onNext } = await renderStep('android', adapter);
  expect(await screen.findByTestId('auto-record-read-error')).toBeOnTheScreen();
  await press(screen.getByTestId('auto-record-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});
