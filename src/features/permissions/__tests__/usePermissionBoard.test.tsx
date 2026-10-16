/**
 * The board hook: when it reads the phone (never on a timer), the Bluetooth read gated on a pairing,
 * the no-effect mark and its pruning, hide / show, and the DashPal link watch.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { TripReminderStatus } from '@drive-sense';

import { HOME_HIDDEN_KEY } from '@/core/permissions';
import { PAIRED_KEY } from '@/dashcam/keys';
import { setActiveDashcam } from '@/dashcam/registry';
import type { DashcamRuntime, DashcamState } from '@/dashcam/runtime';
import { DataProvider } from '@/data/queries/context';

import { appWorld, clearQueryClients, fakeAdapter, fakeAppState, snap, type AppWorld } from '../__fixtures__/harness';
import * as homePrefs from '../homePrefs';
import type { HomePrefs } from '../homePrefs';
import { usePermissionBoard, watchDashcamPermissions, type PermissionBoardDeps } from '../usePermissionBoard';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'u1' } } }) }));

afterEach(() => {
  clearQueryClients();
  setActiveDashcam(null);
});

const PAIRED = { dashcamId: 'a1b2c3d4e5f6', peripheralId: 'AA:BB', name: 'DashPal-E5F6', pairedAt: 1, secure: true as const };

function mount(w: AppWorld, deps: PermissionBoardDeps) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={w.client}>
      <DataProvider db={w.db}>{children}</DataProvider>
    </QueryClientProvider>
  );
  return renderHook(() => usePermissionBoard(deps), { wrapper });
}

function setup(over: Partial<PermissionBoardDeps> = {}, initial = snap({ platform: 'android', motion: 'denied' }), answers: Parameters<typeof fakeAdapter>[1] = {}) {
  const adapter = fakeAdapter(initial, answers);
  const appState = fakeAppState();
  let dashcamChange: (() => void) | null = null;
  const reminder = jest.fn(async (): Promise<TripReminderStatus> => ({ enabled: false, state: 'off', missing: [] }));
  const deps: PermissionBoardDeps = {
    adapter,
    appState,
    reminder,
    androidApi: 34,
    watchDashcam: (fn) => {
      dashcamChange = fn;
      return () => {
        dashcamChange = null;
      };
    },
    ensureChannels: async () => {},
    requestDeviceSync: () => {},
    ...over,
  };
  const reads = () => adapter.log.filter((c) => c === 'snapshot').length;
  return { adapter, appState, deps, reads, reminder, fireDashcam: () => dashcamChange?.() };
}

test('one read of the phone: snapshot, camera and reminder; no Bluetooth read without a pairing', async () => {
  const w = await appWorld();
  const s = setup();
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.read).toMatchObject({ paired: false, bluetooth: null, androidApi: 34, camera: { access: 'undetermined' }, reminder: { enabled: false } });
  expect(s.adapter.log).not.toContain('bluetoothPermission');
  expect(s.adapter.log).not.toContain('bluetooth');
  expect(s.reads()).toBe(1);
});

test('with a pairing stored, the Bluetooth permission is read (never the radio)', async () => {
  const w = await appWorld({ settings: { [PAIRED_KEY]: PAIRED } });
  const s = setup();
  s.adapter.btPermission = 'undetermined';
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.read).toMatchObject({ paired: true, bluetooth: 'undetermined' });
  expect(s.adapter.log).toContain('bluetoothPermission');
  expect(s.adapter.log).not.toContain('bluetooth');
});

test('reads again on every return to the front, on a DashPal link change and on a shared refresh; a focus within 2 s reuses the read', async () => {
  const w = await appWorld();
  const s = setup();
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  await act(async () => {
    await result.current.refresh('focus');
  });
  expect(s.reads()).toBe(1);
  await act(async () => {
    s.appState.foreground();
  });
  await waitFor(() => expect(s.reads()).toBe(2));
  await act(async () => {
    s.fireDashcam();
  });
  await waitFor(() => expect(s.reads()).toBe(3));
  await act(async () => {
    await result.current.refresh('shared');
  });
  expect(s.reads()).toBe(4);
});

test('an unreadable phone is an error, not a card', async () => {
  const w = await appWorld();
  const s = setup();
  s.adapter.failReads = true;
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(result.current.read).toBeNull();
});

test('a board read that lands before the stored prefs stays loading, so a hidden row never shows and no tap runs on empty marks', async () => {
  const w = await appWorld();
  const s = setup();
  let land: (p: HomePrefs) => void = () => {};
  const spy = jest.spyOn(homePrefs, 'readHomePrefs').mockImplementationOnce(
    () =>
      new Promise<HomePrefs>((resolve) => {
        land = resolve;
      })
  );
  try {
    const { result } = await mount(w, s.deps);
    await waitFor(() => expect(s.reads()).toBe(1));
    // Let the board read settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.status).toBe('loading');
    await act(async () => {
      expect(await result.current.fix('motion')).toBeNull();
    });
    expect(s.adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual([]);
    await act(async () => {
      land({ hidden: ['motion'], toSettings: { motion: 'denied:true' } });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.prefs).toEqual({ hidden: ['motion'], toSettings: { motion: 'denied:true' } });
  } finally {
    spy.mockRestore();
  }
});

test('a reminder or camera read that fails nulls only its field', async () => {
  const w = await appWorld();
  const s = setup({ reminder: () => Promise.reject(new Error('no module')) });
  (s.adapter.camera as jest.Mock).mockRejectedValue(new Error('no camera module'));
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(result.current.read).toMatchObject({ reminder: null, camera: null });
});

test('a request with no effect makes the next tap open Settings; once the permission is on, the mark is dropped', async () => {
  const w = await appWorld();
  const s = setup({}, snap({ platform: 'android', motion: 'denied' }), { motion: 'denied' });
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  await act(async () => {
    expect(await result.current.fix('motion')).toMatchObject({ kind: 'requested', noEffect: true });
  });
  await waitFor(() => expect(result.current.prefs.toSettings).toEqual({ motion: 'denied:true' }));
  await act(async () => {
    expect(await result.current.fix('motion')).toEqual({ kind: 'opened' });
  });
  expect(s.adapter.log.filter((c) => c !== 'snapshot' && c !== 'camera')).toEqual(['requestMotion', 'openAppSettings']);
  s.adapter.current = { ...s.adapter.current, motion: 'granted' };
  await act(async () => {
    s.appState.foreground();
  });
  await waitFor(() => expect(result.current.prefs.toSettings).toEqual({}));
  expect(await w.settings.get('permissions.homeToSettings')).toEqual({});
});

test('a fix on a row that is not missing does nothing', async () => {
  const w = await appWorld();
  const s = setup({}, snap({ platform: 'android' }));
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  await act(async () => {
    expect(await result.current.fix('motion')).toBeNull();
  });
  expect(s.adapter.log.filter((c) => c.startsWith('request') || c.startsWith('open'))).toEqual([]);
});

test('hide and show update the prefs at once, without reading the phone', async () => {
  const w = await appWorld();
  const s = setup();
  const { result } = await mount(w, s.deps);
  await waitFor(() => expect(result.current.status).toBe('ready'));
  const before = s.reads();
  await act(async () => {
    await result.current.hide('motion');
  });
  // The query cache tells its observers on the next tick.
  await waitFor(() => expect(result.current.prefs.hidden).toEqual(['motion']));
  expect(await w.settings.get(HOME_HIDDEN_KEY)).toEqual(['motion']);
  await act(async () => {
    await result.current.show('motion');
  });
  await waitFor(() => expect(result.current.prefs.hidden).toEqual([]));
  expect(s.reads()).toBe(before);
});

describe('watchDashcamPermissions', () => {
  function runtime(initial: { lifecycle: string; paired: object | null }) {
    let st = initial;
    const fns = new Set<(s: DashcamState) => void>();
    const rt = {
      state: () => ({ link: { lifecycle: st.lifecycle, paired: st.paired } }) as unknown as DashcamState,
      subscribe: (fn: (s: DashcamState) => void) => {
        fns.add(fn);
        return () => fns.delete(fn);
      },
      set(next: { lifecycle: string; paired: object | null }) {
        st = next;
        for (const fn of [...fns]) fn(rt.state());
      },
      listeners: () => fns.size,
    };
    return rt;
  }

  it('fires when the link enters or leaves unauthorized or the pairing changes, not on other changes', () => {
    const rt = runtime({ lifecycle: 'idle', paired: PAIRED });
    setActiveDashcam(rt as unknown as DashcamRuntime);
    const onChange = jest.fn();
    const off = watchDashcamPermissions(onChange);
    rt.set({ lifecycle: 'connecting', paired: PAIRED });
    rt.set({ lifecycle: 'connected', paired: PAIRED });
    expect(onChange).not.toHaveBeenCalled();
    rt.set({ lifecycle: 'unauthorized', paired: PAIRED });
    expect(onChange).toHaveBeenCalledTimes(1);
    rt.set({ lifecycle: 'unauthorized', paired: PAIRED });
    expect(onChange).toHaveBeenCalledTimes(1);
    rt.set({ lifecycle: 'idle', paired: PAIRED });
    expect(onChange).toHaveBeenCalledTimes(2);
    rt.set({ lifecycle: 'unpaired', paired: null });
    expect(onChange).toHaveBeenCalledTimes(3);
    off();
    expect(rt.listeners()).toBe(0);
    rt.set({ lifecycle: 'idle', paired: PAIRED });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('follows the runtime across a handover', () => {
    const onChange = jest.fn();
    const off = watchDashcamPermissions(onChange);
    const rt = runtime({ lifecycle: 'unauthorized', paired: PAIRED });
    setActiveDashcam(rt as unknown as DashcamRuntime);
    expect(onChange).toHaveBeenCalledTimes(1);
    rt.set({ lifecycle: 'idle', paired: PAIRED });
    expect(onChange).toHaveBeenCalledTimes(2);
    off();
  });
});
