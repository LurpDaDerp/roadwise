/**
 * What a manual drive needs before it starts (C1), through Task 8's adapter: no Expo permission
 * call is made from here. Start drive is the driver's own tap (Task 19 r1 ruling), so it asks at
 * once — never throttled — and stamps the 14-day history so the app's own offers wait. M3's rules
 * are kept: location is asked once when undetermined and never re-prompted once denied; motion is
 * asked once and never blocks.
 */
import { PROMPTS_KEY, PROMPT_INTERVAL_MS, type Grant, type LocationAccess, type PermissionSnapshot } from '@/core/permissions';
import {
  ensureDrivePermissions,
  openAppSettings,
  readLocationPermission,
  type PermissionDeps,
} from '@/features/drive/permissions';

const NOW = 1_790_000_000_000;

function memorySettings(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: jest.fn(async <T,>(key: string) => (store.has(key) ? (store.get(key) as T) : null)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    store,
  };
}

function snapshot(location: LocationAccess, motion: Grant | null, over: { precise?: boolean | null; services?: boolean | null } = {}): PermissionSnapshot {
  const granted = location === 'foreground' || location === 'always';
  return {
    platform: 'ios',
    location,
    precise: granted ? (over.precise === undefined ? true : over.precise) : null,
    locationCanAskAgain: true,
    locationServices: over.services === undefined ? true : over.services,
    motion,
    notifications: 'granted',
    notificationsCanAskAgain: true,
    batteryOptimization: 'unknown',
    lowPowerMode: false,
    backgroundRefresh: 'available',
    canAskAlways: true,
    liveActivities: true,
    checkedAt: NOW,
  };
}

function deps(opts: {
  location: LocationAccess;
  afterRequest?: LocationAccess;
  motion?: Grant | null;
  motionAnswer?: Grant | null;
  prompts?: Record<string, number>;
  precise?: boolean | null;
  services?: boolean | null;
}) {
  let location = opts.location;
  let motion: Grant | null = opts.motion === undefined ? 'granted' : opts.motion;
  const calls: string[] = [];
  const settings = memorySettings(opts.prompts ? { [PROMPTS_KEY]: opts.prompts } : {});
  const adapter = {
    snapshot: jest.fn(async () => {
      calls.push('snapshot');
      return snapshot(location, motion, { precise: opts.precise, services: opts.services });
    }),
    requestLocationForeground: jest.fn(async () => {
      calls.push('location:request');
      location = opts.afterRequest ?? 'denied';
      return location;
    }),
    requestMotion: jest.fn(async () => {
      calls.push('motion:request');
      motion = opts.motionAnswer === undefined ? 'granted' : opts.motionAnswer;
      return motion;
    }),
    openAppSettings: jest.fn(async () => {
      calls.push('openSettings');
    }),
  };
  const d: PermissionDeps = { adapter, settings: settings as unknown as PermissionDeps['settings'], now: () => NOW };
  return { d, calls, adapter, settings };
}

describe('ensureDrivePermissions', () => {
  test('already granted: no prompt of any kind', async () => {
    const { d, calls } = deps({ location: 'foreground', motion: 'granted' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'granted' });
    expect(calls).toEqual(['snapshot']);
  });

  test('Always counts as granted for a manual drive', async () => {
    const { d } = deps({ location: 'always', motion: 'granted' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'granted' });
  });

  test('undetermined location is asked once through the adapter; granted then goes on to motion', async () => {
    const { d, calls, settings } = deps({ location: 'undetermined', afterRequest: 'foreground', motion: 'undetermined' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'granted' });
    expect(calls).toEqual(['snapshot', 'location:request', 'snapshot', 'motion:request']);
    // Both prompts are stamped, so the app's own later offers wait out the window.
    expect(settings.store.get(PROMPTS_KEY)).toEqual({ location: NOW, motion: NOW });
  });

  test('the driver’s tap is never throttled: a location prompt made 3 days ago is made again, and stamped', async () => {
    const { d, calls, settings } = deps({
      location: 'undetermined',
      afterRequest: 'foreground',
      prompts: { location: NOW - 3 * 86_400_000 },
    });
    expect(3 * 86_400_000).toBeLessThan(PROMPT_INTERVAL_MS);
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'granted' });
    expect(calls).toContain('location:request');
    expect(settings.store.get(PROMPTS_KEY)).toMatchObject({ location: NOW });
  });

  test('motion too: asked at once inside the window, and stamped', async () => {
    const { d, calls, settings } = deps({
      location: 'foreground',
      motion: 'undetermined',
      prompts: { motion: NOW - 86_400_000 },
    });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'granted' });
    expect(calls).toContain('motion:request');
    expect(settings.store.get(PROMPTS_KEY)).toMatchObject({ motion: NOW });
  });

  test('a stamp that cannot be written never blocks the drive', async () => {
    const { d, settings } = deps({ location: 'undetermined', afterRequest: 'foreground' });
    settings.set.mockRejectedValue(new Error('disk'));
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'granted' });
  });

  test('denied location is never re-prompted and motion is not asked', async () => {
    const { d, adapter, calls } = deps({ location: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'denied', precise: null, services: true, motion: 'undetermined' });
    expect(adapter.requestLocationForeground).not.toHaveBeenCalled();
    expect(calls).toEqual(['snapshot']);
  });

  test('a refusal at the prompt is reported as denied; a second call does not prompt again', async () => {
    const { d, adapter } = deps({ location: 'undetermined', afterRequest: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'denied' });
    expect(adapter.requestLocationForeground).toHaveBeenCalledTimes(1);
  });

  test('denied motion does not block and is never re-prompted', async () => {
    const { d, calls } = deps({ location: 'foreground', motion: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'denied' });
    expect(calls).not.toContain('motion:request');
  });

  test('motion that cannot be checked (no drive-sense) counts as unavailable, not as a blocker', async () => {
    const { d } = deps({ location: 'foreground', motion: null });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'unavailable' });
  });

  test('a phone that cannot be read counts as denied: the explainer offers Settings, never a loop', async () => {
    const { d, adapter } = deps({ location: 'undetermined' });
    adapter.snapshot.mockRejectedValueOnce(new Error('bridge'));
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'denied', precise: null, services: null, motion: 'undetermined' });
    expect(adapter.requestLocationForeground).not.toHaveBeenCalled();
  });

  test('the Start Drive tap (askMotion false): undetermined motion is read and never requested; undetermined location is still asked once', async () => {
    const { d, calls, adapter, settings } = deps({ location: 'undetermined', afterRequest: 'foreground', motion: 'undetermined' });
    await expect(ensureDrivePermissions(d, { askMotion: false })).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'undetermined' });
    expect(adapter.requestMotion).not.toHaveBeenCalled();
    expect(adapter.requestLocationForeground).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['snapshot', 'location:request', 'snapshot']);
    expect(settings.store.get(PROMPTS_KEY)).toEqual({ location: NOW });
  });

  test('askMotion false with motion already answered leaves it as read', async () => {
    const granted = deps({ location: 'foreground', motion: 'granted' });
    await expect(ensureDrivePermissions(granted.d, { askMotion: false })).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'granted' });
    const denied = deps({ location: 'foreground', motion: 'denied' });
    await expect(ensureDrivePermissions(denied.d, { askMotion: false })).resolves.toEqual({ location: 'granted', precise: true, services: true, motion: 'denied' });
    expect(denied.calls).toEqual(['snapshot']);
  });

  test('Precise Location and the Location Services switch are read, never asked', async () => {
    const approx = deps({ location: 'foreground', precise: false });
    await expect(ensureDrivePermissions(approx.d, { askMotion: false })).resolves.toEqual({ location: 'granted', precise: false, services: true, motion: 'granted' });
    expect(approx.calls).toEqual(['snapshot']);
    const off = deps({ location: 'foreground', services: false });
    await expect(ensureDrivePermissions(off.d, { askMotion: false })).resolves.toMatchObject({ location: 'granted', services: false });
    const unknown = deps({ location: 'foreground', precise: null, services: null });
    await expect(ensureDrivePermissions(unknown.d, { askMotion: false })).resolves.toMatchObject({ precise: null, services: null });
  });

  test('a location granted at the tap reads Precise Location again (the answer has no accuracy); a failed re-read is unknown', async () => {
    const approx = deps({ location: 'undetermined', afterRequest: 'foreground', precise: false });
    await expect(ensureDrivePermissions(approx.d, { askMotion: false })).resolves.toMatchObject({ location: 'granted', precise: false });
    expect(approx.calls).toEqual(['snapshot', 'location:request', 'snapshot']);
    const failed = deps({ location: 'undetermined', afterRequest: 'foreground', precise: false });
    failed.adapter.snapshot.mockImplementationOnce(async () => snapshot('undetermined', 'granted')).mockRejectedValueOnce(new Error('bridge'));
    await expect(ensureDrivePermissions(failed.d, { askMotion: false })).resolves.toMatchObject({ location: 'granted', precise: null, services: true });
  });

  test('a request that throws is not recorded as a prompt and reads as denied', async () => {
    const { d, adapter, settings } = deps({ location: 'undetermined' });
    adapter.requestLocationForeground.mockRejectedValueOnce(new Error('E_LOCATION'));
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'denied' });
    expect(settings.store.get(PROMPTS_KEY)).toBeUndefined();
  });
});

describe('readLocationPermission', () => {
  test('reads without prompting (the return-from-Settings check)', async () => {
    const { d, adapter } = deps({ location: 'undetermined' });
    await expect(readLocationPermission(d)).resolves.toBe('undetermined');
    expect(adapter.requestLocationForeground).not.toHaveBeenCalled();
  });

  test.each([
    ['always', 'granted'],
    ['foreground', 'granted'],
    ['denied', 'denied'],
    ['undetermined', 'undetermined'],
  ] as const)('%s reads as %s', async (access, expected) => {
    const { d } = deps({ location: access });
    await expect(readLocationPermission(d)).resolves.toBe(expected);
  });
});

test('Open Settings goes through the adapter', async () => {
  const { d, adapter } = deps({ location: 'denied' });
  await openAppSettings(d);
  expect(adapter.openAppSettings).toHaveBeenCalledTimes(1);
});
