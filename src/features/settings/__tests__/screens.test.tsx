/**
 * The settings screens: the root (the forgot-to-start reminder, units, state), alerts (voice off by default,
 * style, test), account (export, delete, sign out) and delete account. Device settings are an
 * in-memory table; the server, session and drive state are stand-ins.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { createFakeDriveSense } from '@drive-sense';

import { answerRpc, appWorld, clearQueryClients, fakeAdapter, fakeAppState, snap, tap } from '@/features/permissions/__fixtures__/harness';
import { reminderCopy } from '@/features/reminder';

import { alertStyleCopy } from '../alerts/copy';
import { ALERT_STYLE_PREF_KEY, alertStylePref, resetAlertStylePrefForTests } from '../alerts/stylePref';
import { resetVoicePrefForTests, VOICE_PREF_KEY, voicePrefEnabled } from '../alerts/voicePref';
import { AccountScreen } from '../AccountScreen';
import { AlertsScreen } from '../AlertsScreen';
import { settingsCopy as copy } from '../copy';
import { DeleteAccountScreen } from '../DeleteAccountScreen';
import { UNITS_KEY } from '../localPrefs';
import { SETTINGS_HREFS } from '../routes';
import { SettingsScreen } from '../SettingsScreen';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession = {
  session: { user: { id: 'me' } },
  profile: null,
  signOut: jest.fn(async (_opts?: { force?: boolean }) => ({ signedOut: true }) as { signedOut: boolean; unsentDeletes?: number | null }),
  refreshProfile: jest.fn(async () => {}),
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
const mockRouter = { push: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
const mockDrive = { status: 'idle' };
jest.mock('@/drive/useDrive', () => ({
  useDrive: (select: (s: { status: string }) => unknown) => select({ status: mockDrive.status }),
}));
jest.mock('@/drive/policy', () => ({ isBusyStatus: (s: string) => s === 'recording' || s === 'finalizing' }));
jest.mock('../deviceWipe', () => ({ wipeThisPhone: jest.fn(async () => {}) }));

const SUMMARY = {
  profile: {
    user_id: 'me',
    username: 'swift_fox',
    units: 'mi',
    state: null,
    heatmap_visibility: 'only_me',
    league_eligible: true,
    onboarded_at: '2026-10-01T00:00:00Z',
  },
  progress: {},
  league: {},
  not_driving_left: 2,
  challenges: [],
  achievements: [],
};

beforeEach(() => {
  mockRpc.mockReset();
  answerRpc(mockRpc, { get_my_summary: SUMMARY });
  mockRouter.push.mockClear();
  mockSession.signOut.mockClear();
  mockSession.signOut.mockImplementation(async () => ({ signedOut: true }));
  mockDrive.status = 'idle';
  resetVoicePrefForTests();
  resetAlertStylePrefForTests();
});
afterEach(() => clearQueryClients());

describe('Settings', () => {
  describe('the forgot-to-start reminder', () => {
    const world = (platform: 'ios' | 'android', adapter = fakeAdapter(snap({ platform }))) => {
      const native = createFakeDriveSense({ platform });
      const appState = fakeAppState();
      return { native, adapter, appState, deps: { reminder: { native, adapter, platform, appState } } };
    };

    it('is off by default; turning it on asks for what it needs (iOS: Always) and shows what is still missing', async () => {
      const r = world('ios', fakeAdapter(snap({ platform: 'ios', location: 'foreground' }), { always: 'whenInUse' }));
      const w = await appWorld();
      await w.render(<SettingsScreen deps={r.deps} />);
      const toggle = await screen.findByTestId('settings-reminder');
      expect(toggle.props.value).toBe(false);
      expect(screen.getByText(reminderCopy.lines.off, { includeHiddenElements: true })).toBeOnTheScreen();
      r.native.setTripReminderEnv({ missing: ['locationAlways'] });
      await act(async () => {
        fireEvent(toggle, 'valueChange', true);
      });
      await waitFor(() => expect(screen.getByTestId('settings-reminder').props.value).toBe(true));
      expect(r.adapter.log).toContain('requestAlwaysForReminder');
      expect(screen.getByText(reminderCopy.lines.needsAlways, { includeHiddenElements: true })).toBeOnTheScreen();
      await tap('settings-reminder-openSettings');
      expect(r.adapter.log).toContain('openAppSettings');
      // The reminder never starts a drive.
      expect(r.native.calls.filter((c) => c.startsWith('startCapture'))).toEqual([]);
    });

    it('Android, on: the honest line; turning it off forgets it', async () => {
      const r = world('android');
      await r.native.setTripReminder(true);
      const w = await appWorld();
      await w.render(<SettingsScreen deps={r.deps} />);
      expect(await screen.findByText(reminderCopy.lines.onAndroid, { includeHiddenElements: true })).toBeOnTheScreen();
      await act(async () => {
        fireEvent(screen.getByTestId('settings-reminder'), 'valueChange', false);
      });
      await waitFor(() => expect(r.native.tripReminderOn).toBe(false));
      expect(r.adapter.log).toEqual([]);
    });

    it('is read again when RoadWise comes back to the front', async () => {
      const r = world('android');
      const w = await appWorld();
      await w.render(<SettingsScreen deps={r.deps} />);
      await screen.findByTestId('settings-reminder');
      r.native.setTripReminderEnv({ available: false });
      await act(async () => {
        r.appState.foreground();
      });
      expect(await screen.findByText(reminderCopy.lines.unavailable, { includeHiddenElements: true })).toBeOnTheScreen();
      expect(screen.getByTestId('settings-reminder').props.disabled).toBe(true);
    });

    it('on a phone that can no longer run it, a reminder still on can be turned off', async () => {
      const r = world('android');
      await r.native.setTripReminder(true);
      r.native.setTripReminderEnv({ available: false });
      const w = await appWorld();
      await w.render(<SettingsScreen deps={r.deps} />);
      expect(await screen.findByText(reminderCopy.lines.unavailable, { includeHiddenElements: true })).toBeOnTheScreen();
      const toggle = screen.getByTestId('settings-reminder');
      expect(toggle.props.value).toBe(true);
      expect(toggle.props.disabled).toBe(false);
      await act(async () => {
        fireEvent(toggle, 'valueChange', false);
      });
      await waitFor(() => expect(r.native.tripReminderOn).toBe(false));
      expect(screen.getByTestId('settings-reminder').props.disabled).toBe(true);
    });

    it('is not shown where the native module is missing', async () => {
      const w = await appWorld();
      await w.render(<SettingsScreen />);
      await screen.findByTestId('settings-alerts');
      await act(async () => {});
      expect(screen.queryByTestId('settings-reminder')).toBeNull();
    });
  });

  it('units save to the server and to the phone’s mirror', async () => {
    let units = 'mi';
    answerRpc(mockRpc, {
      get_my_summary: () => ({ ...SUMMARY, profile: { ...SUMMARY.profile, units } }),
      update_profile: (args) => {
        units = String(args?.p_units ?? units);
        return null;
      },
    });
    const w = await appWorld();
    await w.render(<SettingsScreen />);
    await screen.findByTestId('settings-units');
    await act(async () => {
      fireEvent.press(screen.getByRole('tab', { name: 'Kilometers' }));
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('update_profile', { p_units: 'km' }));
    await waitFor(async () => expect(await w.settings.get(UNITS_KEY)).toBe('km'));
  });

  it('a failed units change leaves the phone’s mirror alone', async () => {
    answerRpc(mockRpc, { get_my_summary: SUMMARY, update_profile: new Error('offline') });
    const w = await appWorld({ settings: { [UNITS_KEY]: 'mi' } });
    await w.render(<SettingsScreen />);
    await screen.findByTestId('settings-units');
    await act(async () => {
      fireEvent.press(screen.getByRole('tab', { name: 'Kilometers' }));
    });
    expect(await screen.findByTestId('settings-save-error')).toBeOnTheScreen();
    expect(await w.settings.get(UNITS_KEY)).toBe('mi');
  });

  it('the mirror follows units changed on another device', async () => {
    answerRpc(mockRpc, { get_my_summary: { ...SUMMARY, profile: { ...SUMMARY.profile, units: 'km' } } });
    const w = await appWorld({ settings: { [UNITS_KEY]: 'mi' } });
    await w.render(<SettingsScreen />);
    await waitFor(async () => expect(await w.settings.get(UNITS_KEY)).toBe('km'));
  });

  it('the state goes through update_profile, and there is no license setting', async () => {
    const w = await appWorld();
    await w.render(<SettingsScreen />);
    await screen.findByTestId('settings-state');
    expect(screen.queryByTestId('settings-license')).toBeNull();
    await tap('settings-state');
    await act(async () => {
      fireEvent.press(await screen.findByRole('radio', { name: 'Ohio' }));
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('update_profile', { p_state: 'OH' }));
  });

  it('heat map visibility offers Only me and Friends; a saved clan setting shows as Only me', async () => {
    answerRpc(mockRpc, {
      get_my_summary: { ...SUMMARY, profile: { ...SUMMARY.profile, heatmap_visibility: 'clan' } },
      update_profile: {},
    });
    const w = await appWorld();
    await w.render(<SettingsScreen />);
    const control = within(await screen.findByTestId('settings-heatmap-visibility'));
    await waitFor(() => expect(control.getByRole('tab', { name: 'Only me' })).toBeSelected());
    expect(control.getByRole('tab', { name: 'Friends' })).not.toBeSelected();
    expect(control.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual(['Only me', 'Friends']);
    expect(screen.queryByText('Clan')).toBeNull();
    await act(async () => {
      fireEvent.press(control.getByRole('tab', { name: 'Friends' }));
    });
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('update_profile', { p_heatmap_visibility: 'friends' }));
  });

  it('Driving › DashPal opens the DashPal screen and says "Set up your dashcam" until one is paired', async () => {
    const w = await appWorld();
    await w.render(<SettingsScreen />);
    expect(await screen.findByText('Set up your dashcam')).toBeOnTheScreen();
    await tap('settings-dashcam');
    expect(mockRouter.push).toHaveBeenLastCalledWith(SETTINGS_HREFS.dashcam);
  });

  it('opens alerts, zones and notifications, and has no driver monitoring entry', async () => {
    const w = await appWorld();
    await w.render(<SettingsScreen />);
    expect(screen.queryByTestId('settings-dms')).toBeNull();
    await tap('settings-alerts');
    await tap('settings-zones');
    await tap('settings-notifications');
    expect(mockRouter.push.mock.calls.map((c) => c[0])).toEqual([
      SETTINGS_HREFS.alerts,
      SETTINGS_HREFS.privacyZones,
      SETTINGS_HREFS.notifications,
    ]);
  });
});

describe('Alerts', () => {
  it('voice alerts are off by default; turning them on is kept on the phone', async () => {
    const w = await appWorld();
    await w.render(<AlertsScreen />);
    const toggle = await screen.findByTestId('alerts-voice');
    expect(toggle.props.value).toBe(false);
    expect(screen.getByTestId('alerts-tones-stay')).toHaveTextContent(copy.alerts.tonesStay);
    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });
    await waitFor(() => expect(voicePrefEnabled()).toBe(true));
    expect(await w.settings.get(VOICE_PREF_KEY)).toBe(true);
  });

  it('alert style: sound and vibration by default; a choice is kept on the phone', async () => {
    const w = await appWorld();
    await w.render(<AlertsScreen />);
    const checked = (name: string) => screen.getByRole('radio', { name }).props.accessibilityState.checked as boolean;
    await screen.findByTestId('alerts-style-both');
    expect(checked(alertStyleCopy.options.both)).toBe(true);
    await tap('alerts-style-vibration');
    await waitFor(() => expect(checked(alertStyleCopy.options.vibration)).toBe(true));
    expect(alertStylePref()).toBe('vibration');
    expect(await w.settings.get(ALERT_STYLE_PREF_KEY)).toBe('vibration');
  });

  it('never tests during a drive', async () => {
    mockDrive.status = 'recording';
    const play = jest.fn(async () => 'played' as const);
    const w = await appWorld();
    await w.render(<AlertsScreen deps={{ play }} />);
    expect(await screen.findByTestId('alerts-test')).toBeDisabled();
    expect(screen.getByTestId('alerts-test-busy')).toHaveTextContent(copy.alerts.test.busy);
  });
});

describe('Account', () => {
  it('export goes to the sheet; delete opens its own screen; sign out signs out', async () => {
    const exportData = jest.fn(async () => ({ ok: true as const, json: '{"a":1}' }));
    const share = jest.fn(async () => 'shared' as const);
    const w = await appWorld();
    await w.render(<AccountScreen deps={{ exportData, share, platform: 'ios' }} />);
    expect(await screen.findByText(copy.account.signedInAs('swift_fox'))).toBeOnTheScreen();
    await tap('account-export');
    await waitFor(() => expect(share).toHaveBeenCalledWith('{"a":1}'));
    await tap('account-delete');
    expect(mockRouter.push).toHaveBeenLastCalledWith(SETTINGS_HREFS.deleteAccount);
    await tap('account-sign-out');
    await waitFor(() => expect(mockSession.signOut).toHaveBeenCalled());
  });

  it.each([
    ['offline', 'export-offline'],
    ['too_many', 'export-too-many'],
    ['failed', 'export-failed'],
  ] as const)('export %s is said plainly, nothing shared', async (reason, id) => {
    const share = jest.fn();
    const w = await appWorld();
    await w.render(<AccountScreen deps={{ exportData: async () => ({ ok: false, reason }), share }} />);
    await tap('account-export');
    expect(await screen.findByTestId(id)).toBeOnTheScreen();
    expect(share).not.toHaveBeenCalled();
  });
});

describe('Delete account', () => {
  it('lists what goes, then waits for DELETE', async () => {
    const remove = jest.fn(async () => ({ ok: true as const }));
    const wipe = jest.fn(async () => {});
    const w = await appWorld();
    await w.render(<DeleteAccountScreen deps={{ remove, wipe }} />);
    for (const line of copy.deleteAccount.consequences) expect(await screen.findByText(line)).toBeOnTheScreen();
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    });
    await tap('delete-confirm');
    await waitFor(() => expect(wipe).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mockSession.signOut).toHaveBeenCalledWith({ force: true });
  });

  it("a failure says nothing was deleted and changes nothing", async () => {
    const remove = jest.fn(async () => ({ ok: false as const, reason: 'failed' as const }));
    const wipe = jest.fn(async () => {});
    const w = await appWorld();
    await w.render(<DeleteAccountScreen deps={{ remove, wipe }} />);
    await act(async () => {
      fireEvent.changeText(await screen.findByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    });
    await tap('delete-confirm');
    expect(await screen.findByTestId('delete-failed')).toBeOnTheScreen();
    expect(mockSession.signOut).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
  });

  it('never during a drive', async () => {
    mockDrive.status = 'recording';
    const remove = jest.fn(async () => ({ ok: true as const }));
    const w = await appWorld();
    await w.render(<DeleteAccountScreen deps={{ remove, wipe: async () => {} }} />);
    await act(async () => {
      fireEvent.changeText(await screen.findByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    });
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
    expect(screen.getByText(copy.deleteAccount.busy)).toBeOnTheScreen();
  });
});
