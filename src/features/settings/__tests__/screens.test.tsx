/**
 * The settings screens (lane C): the root's rows and where each goes, the profile edit, voice and
 * the test alert, export and delete, and help and legal. The data layer is the real one on sql.js;
 * the session, the drive state, the config and the rewards server are stand-ins.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { CONFIG_DEFAULTS, type AppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db/settings';
import { homeCopy } from '@/features/home/copy';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

import { resetVoicePrefForTests, VOICE_PREF_KEY, voicePrefEnabled } from '../alerts/voicePref';
import { settingsCopy as copy } from '../copy';
import { DeleteAccountScreen } from '../DeleteAccountScreen';
import { HelpScreen } from '../HelpScreen';
import { PrivacyScreen } from '../PrivacyScreen';
import { ProfileScreen } from '../ProfileScreen';
import { SETTINGS_HREFS } from '../routes';
import { SettingsScreen } from '../SettingsScreen';
import { AlertsScreen } from '../AlertsScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const mockSession = {
  session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } as { user: { id: string } } | null,
  profile: { display_name: 'Maya Chen', age_band: '18_plus' } as Record<string, unknown> | null,
  signOut: jest.fn(async (_opts?: { force?: boolean }) => ({ signedOut: true }) as { signedOut: boolean; unsentDeletes?: number | null }),
  refreshProfile: jest.fn(async () => {}),
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

const mockDrive = { status: 'idle' };
jest.mock('@/drive/useDrive', () => ({
  useDrive: (select: (s: { status: string }) => unknown) => select({ status: mockDrive.status }),
}));

let mockConfig: AppConfig = { ...CONFIG_DEFAULTS, fetchedAt: null };
jest.mock('@/data/config/appConfig', () => ({
  ...jest.requireActual('@/data/config/appConfig'),
  useAppConfig: () => ({ config: mockConfig, ready: true }),
}));

jest.mock('@/features/rewards/api', () => {
  const actual = jest.requireActual<typeof import('@/features/rewards/api')>('@/features/rewards/api');
  const rows = jest.requireActual<typeof import('@/features/rewards/__fixtures__/rows')>('@/features/rewards/__fixtures__/rows');
  return {
    ...actual,
    defaultRewardsApi: {
      ...actual.defaultRewardsApi,
      fetchSnapshot: jest.fn(async () => rows.snapshot({ progress: rows.progressRow({ xp: 2000, level: 2 }) })),
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDrive.status = 'idle';
  mockConfig = { ...CONFIG_DEFAULTS, fetchedAt: null };
  mockSession.session = { user: { id: '00000000-0000-4000-8000-00000000000a' } };
  mockSession.profile = { display_name: 'Maya Chen', age_band: '18_plus' };
  mockSession.signOut.mockImplementation(async () => ({ signedOut: true }));
  resetVoicePrefForTests();
});
afterEach(() => clearQueryClients());

async function render(ui: React.ReactElement) {
  const w = await world();
  await w.renderScreen(ui);
  return w;
}

describe('SettingsScreen (H2)', () => {
  test('every row names where it goes, and opens it', async () => {
    await render(<SettingsScreen />);
    expect(await screen.findByText('Class Steady')).toBeOnTheScreen();
    const rows: [string, string][] = [
      ['settings-profile-row', SETTINGS_HREFS.profile as string],
      ['settings-detection', '/permissions/auto-record'],
      ['settings-alerts', SETTINGS_HREFS.alerts as string],
      ['settings-notifications', '/settings/notifications'],
      ['settings-privacy', SETTINGS_HREFS.privacy as string],
      ['settings-help', SETTINGS_HREFS.help as string],
    ];
    for (const [id, href] of rows) {
      const row = screen.getByTestId(id);
      expect(row.props.accessibilityRole).toBe('button');
      expect(row.props.accessibilityHint).toBeTruthy();
      await fireEvent.press(row);
      expect(mockRouter.push).toHaveBeenLastCalledWith(href);
    }
    expect(screen.getByText('Maya Chen')).toBeOnTheScreen();
  });

  test('camera coaching is offered only with the beta on and an adult account', async () => {
    await render(<SettingsScreen />);
    expect(screen.queryByTestId('settings-camera')).toBeNull();
    clearQueryClients();
    mockConfig = { ...CONFIG_DEFAULTS, fetchedAt: 1, flags: { ...CONFIG_DEFAULTS.flags, camera_beta: true } };
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('settings-camera'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/settings/camera');
    clearQueryClients();
    mockSession.profile = { display_name: 'Sam', age_band: '13_17' };
    await render(<SettingsScreen />);
    expect(screen.queryByTestId('settings-camera')).toBeNull();
  });

  test('sign out: the existing flow, with its consequence stated before the press', async () => {
    await render(<SettingsScreen />);
    const button = screen.getByRole('button', { name: copy.root.signOut });
    expect(button.props.accessibilityHint).toBe(homeCopy.signOutWarning);
    expect(screen.getByText(homeCopy.signOutWarning)).toBeOnTheScreen();
    await fireEvent.press(button);
    expect(mockSession.signOut).toHaveBeenCalledWith();
  });

  test('no name yet: the card says New driver, and the portrait is a glyph', async () => {
    mockSession.profile = { display_name: '', age_band: '18_plus' };
    await render(<SettingsScreen />);
    expect(screen.getByText(homeCopy.card.noName)).toBeOnTheScreen();
  });
});

describe('ProfileScreen (H1)', () => {
  test('edits the first name through the one profile write path, then says so', async () => {
    const update = jest.fn(async () => ({}));
    await render(<ProfileScreen deps={{ update }} />);
    expect(await screen.findByTestId('profile-class')).toHaveTextContent('Class Steady');
    const save = screen.getByTestId('profile-save');
    expect(save).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText(copy.profile.nameLabel), '  Maya Chen  ');
    // the same name, only spaced: nothing to save
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText(copy.profile.nameLabel), 'Mae');
    await fireEvent.press(screen.getByTestId('profile-save'));
    await waitFor(() => expect(screen.getByTestId('profile-name-note')).toHaveTextContent(copy.profile.saved));
    expect(update).toHaveBeenCalledWith('00000000-0000-4000-8000-00000000000a', { display_name: 'Mae' });
    expect(mockSession.refreshProfile).toHaveBeenCalled();
  });

  test('an empty name is refused on the spot; a failed save says so', async () => {
    const update = jest.fn(async () => Promise.reject(new Error('offline')));
    await render(<ProfileScreen deps={{ update }} />);
    await fireEvent.changeText(screen.getByLabelText(copy.profile.nameLabel), '   ');
    await fireEvent.press(screen.getByTestId('profile-save'));
    await waitFor(() => expect(screen.getByTestId('profile-name-note')).toHaveTextContent(copy.profile.nameEmpty));
    expect(update).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText(copy.profile.nameLabel), 'Mae');
    await fireEvent.press(screen.getByTestId('profile-save'));
    expect(await screen.findByTestId('profile-save-error')).toBeOnTheScreen();
  });
});

describe('AlertsScreen (H4)', () => {
  test('voice prompts: on by default, turned off and kept on the phone, and the tones are said to stay', async () => {
    const w = await render(<AlertsScreen />);
    const toggle = screen.getByRole('switch', { name: copy.alerts.voice.title });
    expect(toggle.props.value).toBe(true);
    expect(screen.getByTestId('alerts-voice-hint')).toHaveTextContent(copy.alerts.voice.on);
    expect(screen.getByTestId('alerts-tones-stay')).toHaveTextContent(copy.alerts.tonesStay);
    await fireEvent(toggle, 'valueChange', false);
    await waitFor(() => expect(screen.getByTestId('alerts-voice-hint')).toHaveTextContent(copy.alerts.voice.off));
    expect(voicePrefEnabled()).toBe(false);
    expect(await createSettingsRepo(w.db).get(VOICE_PREF_KEY)).toBe(false);
  });

  test('a stored "off" is read when the screen opens', async () => {
    const w = await world();
    await createSettingsRepo(w.db).set(VOICE_PREF_KEY, false);
    await w.renderScreen(<AlertsScreen />);
    await waitFor(() => expect(screen.getByRole('switch', { name: copy.alerts.voice.title }).props.value).toBe(false));
  });

  test('the test alert plays on a tap, and says when it could not', async () => {
    const play = jest.fn(async () => 'failed' as const);
    await render(<AlertsScreen deps={{ play }} />);
    await fireEvent.press(screen.getByRole('button', { name: copy.alerts.test.label }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('alerts-test-failed')).toBeOnTheScreen();
  });

  test('never during a drive: the test is disabled and says why', async () => {
    mockDrive.status = 'recording';
    const play = jest.fn(async () => 'played' as const);
    await render(<AlertsScreen deps={{ play }} />);
    const button = screen.getByTestId('alerts-test');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('alerts-test-busy')).toHaveTextContent(copy.alerts.test.busy);
    await fireEvent.press(button);
    expect(play).not.toHaveBeenCalled();
  });
});

describe('PrivacyScreen (H7, H14)', () => {
  test('export: the data goes to the sheet', async () => {
    const exportData = jest.fn(async () => ({ ok: true as const, json: '{"a":1}' }));
    const share = jest.fn(async () => 'shared' as const);
    await render(<PrivacyScreen deps={{ exportData, share, platform: 'ios' }} />);
    expect(screen.queryByTestId('privacy-export-android')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: copy.privacy.export.action }));
    await waitFor(() => expect(share).toHaveBeenCalledWith('{"a":1}'));
  });

  test('Android says where the file goes, and says it was saved', async () => {
    const exportData = jest.fn(async () => ({ ok: true as const, json: '{}' }));
    const share = jest.fn(async () => 'saved' as const);
    await render(<PrivacyScreen deps={{ exportData, share, platform: 'android' }} />);
    expect(screen.getByTestId('privacy-export-android')).toHaveTextContent(copy.privacy.export.androidNote);
    await fireEvent.press(screen.getByRole('button', { name: copy.privacy.export.action }));
    expect(await screen.findByTestId('export-saved')).toBeOnTheScreen();
  });

  test.each([
    ['offline', 'export-offline'],
    ['too_many', 'export-too-many'],
    ['failed', 'export-failed'],
  ] as const)('export %s: said plainly, nothing shared', async (reason, id) => {
    const share = jest.fn();
    await render(<PrivacyScreen deps={{ exportData: async () => ({ ok: false, reason }), share }} />);
    await fireEvent.press(screen.getByRole('button', { name: copy.privacy.export.action }));
    expect(await screen.findByTestId(id)).toBeOnTheScreen();
    expect(share).not.toHaveBeenCalled();
  });

  test('delete account opens its own screen', async () => {
    await render(<PrivacyScreen />);
    await fireEvent.press(screen.getByRole('button', { name: copy.privacy.delete.action }));
    expect(mockRouter.push).toHaveBeenLastCalledWith(SETTINGS_HREFS.deleteAccount);
  });
});

describe('DeleteAccountScreen (H13)', () => {
  test('the consequences come first; the button waits for DELETE', async () => {
    const remove = jest.fn(async () => ({ ok: true as const }));
    const wipe = jest.fn(async () => {});
    await render(<DeleteAccountScreen deps={{ remove, wipe }} />);
    for (const line of copy.deleteAccount.consequences) expect(screen.getByText(line)).toBeOnTheScreen();
    expect(screen.getByTestId('delete-cannot-undo')).toHaveTextContent(copy.deleteAccount.cannotUndo);
    const button = screen.getByTestId('delete-confirm');
    expect(button).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText(copy.deleteAccount.typeLabel), 'delete');
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    expect(remove).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    await waitFor(() => expect(wipe).toHaveBeenCalled());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(mockSession.signOut).toHaveBeenCalledWith({ force: true });
  });

  test('a failure says nothing was deleted, and changes nothing on the phone', async () => {
    const remove = jest.fn(async () => ({ ok: false as const, reason: 'failed' as const }));
    const wipe = jest.fn(async () => {});
    await render(<DeleteAccountScreen deps={{ remove, wipe }} />);
    await fireEvent.changeText(screen.getByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    expect(await screen.findByTestId('delete-failed')).toBeOnTheScreen();
    expect(screen.getByText(copy.deleteAccount.failed)).toBeOnTheScreen();
    expect(mockSession.signOut).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
  });

  test('a session that proves no account: signed out, and told so without a claim', async () => {
    const remove = jest.fn(async () => ({ ok: false as const, reason: 'session_gone' as const }));
    const wipe = jest.fn(async () => {});
    await render(<DeleteAccountScreen deps={{ remove, wipe }} />);
    await fireEvent.changeText(screen.getByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    expect(await screen.findByTestId('delete-session-gone')).toBeOnTheScreen();
    expect(mockSession.signOut).toHaveBeenCalledWith({ force: true });
    expect(wipe).not.toHaveBeenCalled();
  });

  test('never during a drive', async () => {
    mockDrive.status = 'recording';
    const remove = jest.fn(async () => ({ ok: true as const }));
    await render(<DeleteAccountScreen deps={{ remove, wipe: async () => {} }} />);
    await fireEvent.changeText(screen.getByLabelText(copy.deleteAccount.typeLabel), 'DELETE');
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
    expect(screen.getByText(copy.deleteAccount.busy)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    expect(remove).not.toHaveBeenCalled();
  });

  test('export first is one tap away', async () => {
    const exportData = jest.fn(async () => ({ ok: true as const, json: '{}' }));
    const share = jest.fn(async () => 'shared' as const);
    await render(<DeleteAccountScreen deps={{ exportData, share, remove: jest.fn(), wipe: jest.fn() }} />);
    await fireEvent.press(screen.getByRole('button', { name: copy.deleteAccount.exportAction }));
    await waitFor(() => expect(share).toHaveBeenCalled());
  });
});

describe('HelpScreen (H11, H12)', () => {
  test('the FAQ, the scoring explainer, and the safety disclaimer word for word', async () => {
    await render(<HelpScreen />);
    for (const item of copy.help.faq) expect(screen.getByText(item.q)).toBeOnTheScreen();
    expect(screen.getByText('RoadWise is a coaching aid and may miss or misreport events.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: copy.help.scoring }));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/insights/how-scoring-works');
  });

  test('no published documents: no dead links, and it says they will come', async () => {
    await render(<HelpScreen />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('help-no-docs')).toHaveTextContent(copy.help.noDocuments);
  });

  test('published documents open in the browser', async () => {
    mockConfig = {
      ...CONFIG_DEFAULTS,
      fetchedAt: 1,
      onboarding: { tos_version: '1', privacy_version: '1' },
      legal_urls: { terms: 'https://roadwise.example/terms', privacy: 'https://roadwise.example/privacy' },
    };
    const open = jest.fn(async () => undefined);
    await render(<HelpScreen open={open} />);
    await fireEvent.press(screen.getByRole('link', { name: 'Privacy Policy' }));
    expect(open).toHaveBeenCalledWith('https://roadwise.example/privacy');
  });
});
