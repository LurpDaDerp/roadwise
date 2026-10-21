/**
 * A tap's fix: exactly the OS call of each permission, the 14-day stamp, the Android notification
 * channels and token sync, the Settings page of each target, and the no-effect rule.
 */
import { HOME_TO_SETTINGS_KEY, PROMPTS_KEY, type PermissionSnapshot } from '@/core/permissions';

import { fakeAdapter, snap, T0, type FakeAdapter } from '../__fixtures__/harness';
import { runFix, type FixDeps } from '../actions';
import { fixFor } from '../board';
import { readHomePrefs } from '../homePrefs';
import { permissionDef, type MissingState, type PermissionBoardRead, type PermissionId } from '../registry';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

function store() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string): Promise<T | null> {
      return (data.has(key) ? data.get(key) : null) as T | null;
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function world(initial: PermissionSnapshot, opts: { paired?: boolean } = {}, answers: Parameters<typeof fakeAdapter>[1] = {}) {
  const adapter: FakeAdapter = fakeAdapter(initial, answers);
  const settings = store();
  const boardOf = (): PermissionBoardRead => ({
    snapshot: adapter.current,
    androidApi: adapter.current.platform === 'android' ? 34 : null,
    paired: opts.paired ?? false,
    bluetooth: opts.paired ? adapter.btPermission : null,
    camera: adapter.cam,
  });
  const ensureChannels = jest.fn(async () => {
    adapter.log.push('ensureChannels');
  });
  const requestDeviceSync = jest.fn(() => {
    adapter.log.push('requestDeviceSync');
  });
  const deps: FixDeps = { adapter, settings, now: () => T0, reread: async () => boardOf(), ensureChannels, requestDeviceSync };
  const run = async (id: PermissionId) => {
    const state = permissionDef(id).state(boardOf());
    if (state.kind !== 'missing') throw new Error(`${id} is not missing`);
    const fix = fixFor(id, state, await readHomePrefs(settings));
    return runFix(id, state, fix!, deps);
  };
  const calls = () => adapter.log.filter((c) => c !== 'snapshot');
  return { adapter, settings, deps, run, calls, boardOf };
}

describe('requests: one OS call each, stamped', () => {
  it('location (not asked yet) asks While Using and stamps location', async () => {
    const w = world(snap({ location: 'undetermined', precise: null }));
    expect(await w.run('location')).toMatchObject({ kind: 'requested', noEffect: false });
    expect(w.calls()).toEqual(['requestLocationForeground']);
    expect(w.settings.data.get(PROMPTS_KEY)).toEqual({ location: T0 });
  });

  it('precise on Android 12+ asks location again (the change-to-precise dialog)', async () => {
    const w = world(snap({ platform: 'android', precise: false }));
    await w.run('precise');
    expect(w.calls()).toEqual(['requestLocationForeground']);
    expect(w.settings.data.get(PROMPTS_KEY)).toEqual({ location: T0 });
  });

  it('motion asks through drive-sense and stamps motion', async () => {
    const w = world(snap({ motion: 'undetermined' }));
    await w.run('motion');
    expect(w.calls()).toEqual(['requestMotion']);
    expect(w.settings.data.get(PROMPTS_KEY)).toEqual({ motion: T0 });
  });

  it('notifications on Android make the channels first, and sync the token only on a grant', async () => {
    const w = world(snap({ platform: 'android', notifications: 'undetermined' }));
    await w.run('notifications');
    expect(w.calls()).toEqual(['ensureChannels', 'requestNotifications', 'requestDeviceSync']);
    expect(w.settings.data.get(PROMPTS_KEY)).toEqual({ notifications: T0 });

    const refused = world(snap({ platform: 'ios', notifications: 'undetermined' }));
    refused.deps.ensureChannels = undefined;
    (refused.adapter.requestNotifications as jest.Mock).mockImplementation(async () => {
      refused.adapter.log.push('requestNotifications');
      refused.adapter.current = { ...refused.adapter.current, notifications: 'denied', notificationsCanAskAgain: false };
      return 'denied';
    });
    await refused.run('notifications');
    expect(refused.calls()).toEqual(['requestNotifications']);
  });

  it("notifications on iOS: no channels (the deps the hook passes on iOS have none)", async () => {
    const w = world(snap({ platform: 'ios', notifications: 'undetermined' }));
    w.deps.ensureChannels = undefined;
    await w.run('notifications');
    expect(w.calls()).toEqual(['requestNotifications', 'requestDeviceSync']);
  });

  it("Location Services off on Android: first the Play-services dialog; still off → the next tap opens the Location page; on later prunes it", async () => {
    const w = world(snap({ platform: 'android', locationServices: false }));
    expect(await w.run('location')).toMatchObject({ kind: 'requested', noEffect: true });
    expect(w.calls()).toEqual(['requestLocationServices']);
    expect(w.settings.data.get(HOME_TO_SETTINGS_KEY)).toEqual({ location: 'servicesOff:true' });
    expect(w.settings.data.get(PROMPTS_KEY)).toBeUndefined();
    expect(await w.run('location')).toEqual({ kind: 'opened' });
    expect(w.calls()).toEqual(['requestLocationServices', 'openLocationServicesSettings']);
  });

  it('Location Services turned on by the dialog: an effect, nothing stored', async () => {
    const w = world(snap({ platform: 'android', locationServices: false }), {}, { servicesOnRequest: true });
    expect(await w.run('location')).toMatchObject({ kind: 'requested', noEffect: false });
    expect(w.settings.data.get(HOME_TO_SETTINGS_KEY)).toBeUndefined();
  });
});

describe('the no-effect rule', () => {
  it('Android motion silently refused: the next tap opens Settings', async () => {
    const w = world(snap({ platform: 'android', motion: 'denied' }), {}, { motion: 'denied' });
    expect(await w.run('motion')).toMatchObject({ noEffect: true });
    expect(w.settings.data.get(HOME_TO_SETTINGS_KEY)).toEqual({ motion: 'denied:true' });
    expect(await w.run('motion')).toEqual({ kind: 'opened' });
    expect(w.calls()).toEqual(['requestMotion', 'openAppSettings']);
  });

  it('Android notifications switched off with the permission kept (denied, can ask again): the request changes nothing → Settings next', async () => {
    const w = world(snap({ platform: 'android', notifications: 'denied', notificationsCanAskAgain: true }));
    (w.adapter.requestNotifications as jest.Mock).mockImplementation(async () => {
      w.adapter.log.push('requestNotifications');
      return 'denied';
    });
    expect(await w.run('notifications')).toMatchObject({ noEffect: true });
    expect(w.settings.data.get(HOME_TO_SETTINGS_KEY)).toEqual({ notifications: 'denied:true' });
    await w.run('notifications');
    expect(w.calls()).toEqual(['ensureChannels', 'requestNotifications', 'openAppSettings']);
  });

  it('an iOS not-asked → denied answer is an effect: the fix comes from the new state, nothing stored', async () => {
    const w = world(snap({ platform: 'ios', location: 'undetermined', precise: null }), {}, { foreground: 'denied' });
    w.adapter.current = { ...w.adapter.current };
    (w.adapter.requestLocationForeground as jest.Mock).mockImplementation(async () => {
      w.adapter.log.push('requestLocationForeground');
      w.adapter.current = { ...w.adapter.current, location: 'denied', locationCanAskAgain: false };
      return 'denied';
    });
    expect(await w.run('location')).toMatchObject({ noEffect: false });
    expect(w.settings.data.get(HOME_TO_SETTINGS_KEY)).toBeUndefined();
    await w.run('location');
    expect(w.calls()).toEqual(['requestLocationForeground', 'openAppSettings']);
  });

  it('a read after the request that fails stores nothing', async () => {
    const w = world(snap({ platform: 'android', motion: 'denied' }), {}, { motion: 'denied' });
    w.deps.reread = async () => null;
    expect(await w.run('motion')).toEqual({ kind: 'requested', read: null, noEffect: false });
    expect(w.settings.data.get(HOME_TO_SETTINGS_KEY)).toBeUndefined();
  });

  it('a request that throws rejects and persists nothing', async () => {
    const w = world(snap({ motion: 'undetermined' }));
    (w.adapter.requestMotion as jest.Mock).mockRejectedValue(new Error('bridge'));
    await expect(w.run('motion')).rejects.toThrow('bridge');
    expect(w.settings.data.size).toBe(0);
  });
});

describe('Settings targets', () => {
  it("Location Always kept at While Using and Background App Refresh off open the app's page", async () => {
    const i = world(snap({ platform: 'ios', location: 'foreground', canAskAlways: false, backgroundRefresh: 'denied' }));
    expect(await i.run('locationAlways')).toEqual({ kind: 'opened' });
    expect(await i.run('backgroundRefresh')).toEqual({ kind: 'opened' });
    expect(i.calls()).toEqual(['openAppSettings', 'openAppSettings']);
  });

  it('Location Always asks once while iOS still can, stamped as a location prompt', async () => {
    const w = world(snap({ platform: 'ios', location: 'foreground', canAskAlways: true }));
    const out = await w.run('locationAlways');
    expect(out).toMatchObject({ kind: 'requested', noEffect: false });
    expect(w.calls()).toEqual(['requestLocationAlways']);
    expect(w.settings.data.get(PROMPTS_KEY)).toEqual({ location: T0 });
    expect(permissionDef('locationAlways').state(w.boardOf())).toEqual({ kind: 'granted' });
  });

  it('Location Always declined: the next tap opens Settings', async () => {
    const w = world(snap({ platform: 'ios', location: 'foreground', canAskAlways: true }), {}, { always: 'whenInUse' });
    await w.run('locationAlways');
    await w.run('locationAlways');
    expect(w.calls()).toEqual(['requestLocationAlways', 'openAppSettings']);
  });

  it("iOS Location Services off opens the app's page (iOS has no direct way to its Location Services)", async () => {
    const w = world(snap({ platform: 'ios', locationServices: false, location: 'denied' }));
    await w.run('location');
    expect(w.calls()).toEqual(['openAppSettings']);
  });

  it('Bluetooth and the camera never call a request method', async () => {
    const w = world(snap({ platform: 'android' }), { paired: true });
    w.adapter.btPermission = 'undetermined';
    w.adapter.cam = { access: 'denied', canAskAgain: true };
    for (const id of ['bluetooth', 'camera'] as const) await w.run(id);
    expect(w.calls().filter((c) => c.startsWith('request'))).toEqual([]);
    expect(w.calls()).toEqual(['openAppSettings', 'openAppSettings']);
  });

  it('a request fix on a row that cannot ask still only opens Settings', async () => {
    const w = world(snap({ platform: 'ios' }), { paired: true });
    w.adapter.btPermission = 'denied';
    const state = permissionDef('bluetooth').state(w.boardOf()) as MissingState;
    expect(await runFix('bluetooth', state, 'request', w.deps)).toEqual({ kind: 'opened' });
    expect(w.calls()).toEqual(['openAppSettings']);
  });

  it('Settings › Permissions stamps the "back from Settings" mark first; Home does not', async () => {
    const w = world(snap({ platform: 'ios', motion: 'denied' }));
    await w.run('motion');
    expect(w.settings.data.has('permissions.settingsReturnAck')).toBe(false);
    w.deps.markReturn = true;
    await w.run('motion');
    expect(w.settings.data.get('permissions.settingsReturnAck')).toBe(T0);
  });

  it('a Settings call that throws rejects', async () => {
    const w = world(snap({ platform: 'ios', motion: 'denied' }));
    (w.adapter.openAppSettings as jest.Mock).mockRejectedValue(new Error('no'));
    await expect(w.run('motion')).rejects.toThrow('no');
  });
});
