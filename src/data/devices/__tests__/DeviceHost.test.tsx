import { act, render, renderHook, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { PermissionSnapshot } from '@/core/permissions';
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { createSettingsRepo, type Db } from '@/data/db';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { DataProvider } from '@/data/queries/context';
import { SETTINGS_RETURN_ACK_KEY } from '@/features/permissions/usePermissionHealth';

import { createFakeSupabase, type FakeSupabase } from '../__fixtures__/fakeSupabase';
import { DeviceHost, type DeviceHostDeps } from '../DeviceHost';
import { useDriveStateReported } from '../driveStateStore';
import { requestDeviceSync } from '../events';
import { INSTALL_ID_KEY } from '../installId';
import { PUSH_REGISTRATION_KEY, type PushPort } from '../pushToken';

type MockSession = {
  status: 'loading' | 'signedOut' | 'signedIn';
  session: { user: { id: string } } | null;
  profile: { age_band: string | null; flags: unknown } | null;
};
let mockSession: MockSession;
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn() }));

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const TOKEN = 'ExponentPushToken[abcdefgh12345678]';

const snapshot = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
  platform: 'ios',
  location: 'always',
  precise: true,
  locationCanAskAgain: false,
  motion: 'granted',
  notifications: 'granted',
  notificationsCanAskAgain: false,
  batteryOptimization: 'exempt',
  lowPowerMode: false,
  checkedAt: T0,
  ...over,
});

let db: Db;
let fake: FakeSupabase;
let appStateListeners: Set<(s: string) => void>;
let appState: { currentState: string; addEventListener: jest.Mock };
let snap: PermissionSnapshot;
let permitted: boolean;
let tokenListeners: Set<() => void>;
let push: PushPort;

function deps(): Partial<DeviceHostDeps> {
  return {
    supabase: fake.client,
    adapter: { snapshot: async () => snap },
    push,
    appState,
    deviceInfo: () => ({ platform: 'ios', model: 'iPhone 15', osVersion: '19.0', appVersion: '2.0.0' }),
    projectId: 'project',
    newId: () => 'install-0000-0001',
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <DataProvider db={db} now={() => T0}>
      {children}
    </DataProvider>
  );
}

const ops = () => fake.calls.map((c) => `${c.target}:${c.op}`);

beforeEach(async () => {
  db = await createTestDb();
  await createSettingsRepo(db).set(LAST_USER_KEY, 'user-a');
  fake = createFakeSupabase('user-a');
  appStateListeners = new Set();
  appState = {
    currentState: 'active',
    addEventListener: jest.fn((_t: 'change', l: (s: string) => void) => {
      appStateListeners.add(l);
      return { remove: () => appStateListeners.delete(l) };
    }),
  };
  snap = snapshot();
  permitted = true;
  tokenListeners = new Set();
  push = {
    isDevice: () => true,
    permitted: async () => permitted,
    getExpoPushToken: async () => TOKEN,
    addPushTokenListener: (fn) => {
      tokenListeners.add(fn);
      return { remove: () => tokenListeners.delete(fn) };
    },
  };
  mockSession = {
    status: 'signedIn',
    session: { user: { id: 'user-a' } },
    profile: { age_band: 'adult', flags: { onboarded: true } },
  };
});

const setAppState = (s: string) =>
  act(() => {
    appState.currentState = s;
    for (const l of appStateListeners) l(s);
  });

describe('DeviceHost', () => {
  it('signed in and onboarded: upsert, permission report, token, then onForeground', async () => {
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalledWith('user-a'));
    expect(ops()).toEqual(['devices:upsert', 'devices:update', 'register_push_token:rpc']);
    expect(fake.to('register_push_token')[0]?.values).toEqual({ p_device_id: 'install-0000-0001', p_token: TOKEN });
  });

  it('every launch re-registers the token, even when the last registration is fresh (T2 M-3)', async () => {
    const s = createSettingsRepo(db);
    await s.set(INSTALL_ID_KEY, 'install-0000-0001');
    await s.set(PUSH_REGISTRATION_KEY, { token: TOKEN, userId: 'user-a', deviceId: 'install-0000-0001', at: T0 - 1_000 });
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    expect(fake.to('register_push_token')).toHaveLength(1);
  });

  it('a later foreground is throttled: no upsert, no unchanged report, no token fetch', async () => {
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalledTimes(1));
    await setAppState('background');
    await setAppState('active');
    await waitFor(() => expect(onForeground).toHaveBeenCalledTimes(2));
    expect(fake.calls).toHaveLength(3);
  });

  it('a permission changed while away is reported on the next foreground', async () => {
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalledTimes(1));
    snap = snapshot({ location: 'foreground' });
    await setAppState('background');
    await setAppState('active');
    await waitFor(() => expect(onForeground).toHaveBeenCalledTimes(2));
    const reports = fake.to('devices').filter((c) => c.op === 'update');
    expect(reports).toHaveLength(2);
    expect(reports[1]?.values).toMatchObject({ permissions: { location: 'foreground', reportedFrom: 'foreground' } });
  });

  it('a Settings trip from B2: the next report carries ack, and an unchanged return ends the trip', async () => {
    const s = createSettingsRepo(db);
    await s.set(SETTINGS_RETURN_ACK_KEY, T0 - 1_000);
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalledTimes(1));
    expect(fake.to('devices')[1]?.values).toMatchObject({ permissions: { ack: true } });
    expect(await s.get(SETTINGS_RETURN_ACK_KEY)).toBeNull();

    await s.set(SETTINGS_RETURN_ACK_KEY, T0 - 1_000);
    await setAppState('background');
    await setAppState('active');
    await waitFor(() => expect(onForeground).toHaveBeenCalledTimes(2));
    expect(await s.get(SETTINGS_RETURN_ACK_KEY)).toBeNull();
  });

  it('mounted in a background launch: nothing runs until the app comes forward', async () => {
    appState.currentState = 'background';
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fake.calls).toHaveLength(0);
    await setAppState('active');
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    expect(fake.to('register_push_token')).toHaveLength(1);
  });

  it.each<[string, () => void]>([
    ['signed out', () => (mockSession = { status: 'signedOut', session: null, profile: null })],
    ['under 13', () => (mockSession.profile = { age_band: 'u13', flags: { onboarded: true } })],
    ['no profile yet', () => (mockSession.profile = null)],
  ])('%s: nothing runs', async (_name, arrange) => {
    arrange();
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fake.calls).toHaveLength(0);
    expect(onForeground).not.toHaveBeenCalled();
  });

  describe('the push token before onboarding finishes (security M-1)', () => {
    const settle = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

    it('not onboarded yet: the device row and the token only, no report and no onForeground', async () => {
      mockSession.profile = { age_band: 'adult', flags: {} };
      const onForeground = jest.fn();
      await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
      await waitFor(() => expect(fake.to('register_push_token')).toHaveLength(1));
      await settle();
      expect(ops()).toEqual(['devices:upsert', 'register_push_token:rpc']);
      expect(fake.to('devices')[0]?.values).not.toHaveProperty('permissions');
      expect(onForeground).not.toHaveBeenCalled();
    });

    it('a handover: the new owner takes the token before onboarding, once the rebuild has settled the owner', async () => {
      // B signed in on A's phone; the owner watch marked the handover, the rebuild has not run yet
      mockSession = { status: 'signedIn', session: { user: { id: 'user-b' } }, profile: { age_band: 'adult', flags: {} } };
      fake.sessionUid = 'user-b';
      await createSettingsRepo(db).set(PENDING_OWNER_KEY, 'user-b');
      await render(<DeviceHost deps={deps()} />, { wrapper: Wrapper });
      await settle();
      expect(fake.calls).toHaveLength(0);

      // the rebuild wiped A's settings and recorded B as the owner
      await db.execute('DELETE FROM settings');
      await createSettingsRepo(db).set(LAST_USER_KEY, 'user-b');
      await setAppState('background');
      await setAppState('active');
      await waitFor(() => expect(fake.to('register_push_token')).toHaveLength(1));
      expect(fake.to('devices')[0]?.values).toMatchObject({ user_id: 'user-b' });
      expect(fake.to('register_push_token')[0]?.values).toEqual({ p_device_id: 'install-0000-0001', p_token: TOKEN });
    });

    it('finishing onboarding adds the rest without registering the token a second time', async () => {
      mockSession.profile = { age_band: 'adult', flags: {} };
      const onForeground = jest.fn();
      const view = await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
      await waitFor(() => expect(fake.to('register_push_token')).toHaveLength(1));
      mockSession = { ...mockSession, profile: { age_band: 'adult', flags: { onboarded: true } } };
      await view.rerender(<DeviceHost deps={deps()} onForeground={onForeground} />);
      await waitFor(() => expect(onForeground).toHaveBeenCalledWith('user-a'));
      expect(fake.to('register_push_token')).toHaveLength(1);
      expect(fake.to('devices').filter((c) => c.op === 'update')).toHaveLength(1);
    });

    it('under 13: never registered, onboarded or not', async () => {
      mockSession.profile = { age_band: 'u13', flags: {} };
      await render(<DeviceHost deps={deps()} />, { wrapper: Wrapper });
      await settle();
      expect(fake.calls).toHaveLength(0);
    });
  });

  it('enabled={false}: nothing runs', async () => {
    await render(<DeviceHost enabled={false} deps={deps()} />, { wrapper: Wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['another owner', LAST_USER_KEY, 'user-b'],
    ['a pending handover', PENDING_OWNER_KEY, 'user-b'],
  ])('%s: the owner fence holds everything back', async (_n, key, value) => {
    await createSettingsRepo(db).set(key, value);
    await render(<DeviceHost deps={deps()} />, { wrapper: Wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('requestDeviceSync registers the token once permission arrives', async () => {
    permitted = false;
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    expect(fake.to('register_push_token')).toHaveLength(0);
    permitted = true;
    await act(() => requestDeviceSync());
    await waitFor(() => expect(fake.to('register_push_token')).toHaveLength(1));
  });

  it('a new token from the OS is registered', async () => {
    const onForeground = jest.fn();
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    await waitFor(() => expect(tokenListeners.size).toBe(1));
    await act(() => tokenListeners.forEach((l) => l()));
    await waitFor(() => expect(fake.to('register_push_token')).toHaveLength(2));
  });

  it('reports no drive state and never claims to (the runtime reports it: ruling T10 (4))', async () => {
    const onForeground = jest.fn();
    const reported = await renderHook(() => useDriveStateReported());
    await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    await reported.rerender({});
    expect(reported.result.current).toBe(false);
    expect(fake.calls.some((c) => c.values && typeof c.values === 'object' && 'drive_state' in c.values)).toBe(false);
  });

  it('a snapshot that fails is reported as an error and the rest still runs', async () => {
    const onError = jest.fn();
    const onForeground = jest.fn();
    const d = { ...deps(), adapter: { snapshot: async () => Promise.reject(new Error('read failed')) } };
    await render(<DeviceHost deps={d} onError={onError} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    expect(ops()).toEqual(['devices:upsert', 'register_push_token:rpc']);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'devices permissions snapshot');
  });

  it('signing out stops the listeners', async () => {
    const onForeground = jest.fn();
    const view = await render(<DeviceHost deps={deps()} onForeground={onForeground} />, { wrapper: Wrapper });
    await waitFor(() => expect(onForeground).toHaveBeenCalled());
    await waitFor(() => expect(tokenListeners.size).toBe(1));
    mockSession = { status: 'signedOut', session: null, profile: null };
    await view.rerender(<DeviceHost deps={deps()} onForeground={onForeground} />);
    await waitFor(() => expect(appStateListeners.size).toBe(0));
    expect(tokenListeners.size).toBe(0);
  });
});
