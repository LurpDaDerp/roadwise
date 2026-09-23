import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { tripRow } from '@/data/queries/__fixtures__/rows';
import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { renderedStrings } from '@/features/rewards/__fixtures__/goalChallengesWorld';
import { progressRow, snapshot } from '@/features/rewards/__fixtures__/rows';
import { BANNED_COPY } from '@/notifications/catalog';

import { shareCopy as copy } from '../copy';
import { ShareComposerScreen } from '../ShareComposerScreen';
import { composerDeps, fakeRewardsApi, fakeReferralApi, shareWorld } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockFontScale = jest.fn(() => 1);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: mockFontScale() }),
}));

afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  mockFontScale.mockReturnValue(1);
  jest.clearAllMocks();
});

const FINAL = tripRow({
  client_trip_id: 'trip-9',
  status: 'final',
  sync_state: 'synced',
  score: 92,
  started_at: Date.parse('2026-09-21T23:47:00Z'),
  tz: 'America/Los_Angeles',
  start_label: 'Near Home',
  end_label: 'Near Lincoln HS',
});

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
  await settleInbox();
};

async function open(params: Record<string, unknown>, world: Parameters<typeof shareWorld>[0] = {}, over = {}) {
  const w = await shareWorld(world);
  const { deps, sheet } = composerDeps(over);
  await w.render(<ShareComposerScreen params={params} deps={deps} />);
  await screen.findByTestId('share-screen');
  await waitFor(() => expect(screen.queryByTestId('share-loading')).toBeNull());
  await settleInbox();
  return { ...w, deps, sheet };
}

function assertPrivacy() {
  const strings = renderedStrings(screen.toJSON());
  expect(strings.length).toBeGreaterThan(0);
  for (const s of strings) {
    for (const re of BANNED_COPY) expect(s).not.toMatch(re);
    expect(s).not.toMatch(/licen[cs]e|\bID\b|DOB|date of birth|<<|MRZ/i);
    expect(s).not.toMatch(/\d{1,2}:\d{2}/);
    expect(s).not.toMatch(/Near Home|Lincoln/);
  }
}

describe('ShareComposerScreen (F9)', () => {
  test.each([[{}], [{ kind: 'selfie' }], [{ kind: 'trip' }], [{ kind: 'badge' }], [{ kind: ['trip', 'x'] }]])(
    'nothing to share (%j): one line and one action to Rewards',
    async (params) => {
      await open(params);
      expect(screen.getByText('Nothing to share yet.')).toBeTruthy();
      await press(screen.getByRole('button', { name: 'Go to Rewards' }));
      expect(mockRouter.replace).toHaveBeenCalledWith('/rewards');
    }
  );

  test('a confirmed drive: the preview, the privacy line, everything off by default, and Share sends the caption', async () => {
    const { sheet } = await open({ kind: 'trip', clientTripId: 'trip-9' }, { trips: [FINAL] });
    const preview = screen.getByTestId('share-preview');
    expect(preview.props.accessibilityLabel).toBe('RoadWise\nDrive score: 92, Excellent\nSep 21');
    expect(screen.getByText('No map, place or time is ever shown.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Show distance' }).props.accessibilityState).toMatchObject({ checked: false });
    // The referral flag is off by default: no code toggle at all.
    expect(screen.queryByRole('switch', { name: 'Add my invite code' })).toBeNull();
    await press(screen.getByRole('button', { name: 'Share' }));
    expect(sheet).toHaveBeenCalledWith({ message: 'RoadWise\nDrive score: 92, Excellent\nSep 21' });
    assertPrivacy();
  });

  test('distance appears only once turned on', async () => {
    const { sheet } = await open({ kind: 'trip', clientTripId: 'trip-9' }, { trips: [FINAL] });
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Show distance' }), 'valueChange', true);
    });
    expect(screen.getByTestId('share-preview').props.accessibilityLabel).toContain('10.0 mi');
    await press(screen.getByRole('button', { name: 'Share' }));
    expect(sheet.mock.calls[0]?.[0].message).toContain('10.0 mi');
  });

  test('a drive not yet confirmed: said so, and nothing to share', async () => {
    await open({ kind: 'trip', clientTripId: 'trip-9' }, { trips: [{ ...FINAL, status: 'provisional' }] });
    expect(screen.getByText('You can share a drive once RoadWise has its final score.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  test('the invite code: offered only while invites are on, off by default, fetched only when turned on', async () => {
    const referral = fakeReferralApi();
    const { sheet } = await open(
      { kind: 'streak' },
      { referral: true },
      { api: referral, rewardsApi: fakeRewardsApi(snapshot({ progress: progressRow({ streak_days: 6, best_streak: 9 }) })) }
    );
    const toggle = screen.getByRole('switch', { name: 'Add my invite code' });
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false });
    expect(referral.getMyReferralCode).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });
    await settleInbox();
    expect(referral.getMyReferralCode).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('share-preview').props.accessibilityLabel).toContain('Join me on RoadWise with my code ABCD2345.')
    );
    await press(screen.getByRole('button', { name: 'Share' }));
    expect(sheet.mock.calls[0]?.[0].message).toContain('ABCD2345');
    // No distance toggle on a streak card.
    expect(screen.queryByRole('switch', { name: 'Show distance' })).toBeNull();
  });

  test("a code that can't be loaded is said, and the card goes without it", async () => {
    await open({ kind: 'streak' }, { referral: true }, { api: fakeReferralApi({ fail: true }) });
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Add my invite code' }), 'valueChange', true);
    });
    await settleInbox();
    expect(await screen.findByText(copy.toggles.codeError)).toBeTruthy();
    expect(screen.getByTestId('share-preview').props.accessibilityLabel).not.toContain('code');
  });

  test.each([
    ['streak', {}, 'Safe-day streak'],
    ['level', {}, 'Class'],
    ['badge', { badgeId: 'safe_days_7' }, 'Badge'],
  ] as const)('%s card from the rewards snapshot', async (kind, extra, heading) => {
    await open({ kind, ...extra }, {}, {
      rewardsApi: fakeRewardsApi(
        snapshot({
          progress: progressRow({ streak_days: 3, best_streak: 3, safe_days: 12, xp: 1600 }),
          badges: [{ user_id: '00000000-0000-4000-8000-00000000000a', badge_id: 'safe_days_7', earned_at: '2026-09-20T12:00:00Z', created_at: '2026-09-20T12:00:00Z' }],
        })
      ),
    });
    expect(screen.getByTestId('share-preview').props.accessibilityLabel).toContain(heading);
    assertPrivacy();
  });

  test('a badge not earned: said so', async () => {
    await open({ kind: 'badge', badgeId: 'safe_days_100' });
    expect(screen.getByText("You can share a badge once you've earned it.")).toBeTruthy();
  });

  test('no streak yet: the first-safe-day line', async () => {
    await open({ kind: 'streak' }, {}, { rewardsApi: fakeRewardsApi(snapshot({ progress: progressRow({ streak_days: 0 }) })) });
    expect(screen.getByText("Share your first safe day once it's confirmed.")).toBeTruthy();
  });

  test('offline: the saved snapshot still makes a card, marked, and it shares', async () => {
    setOnline(false);
    const { sheet } = await open(
      { kind: 'streak' },
      { cachedRewards: snapshot({ progress: progressRow({ streak_days: 4, best_streak: 4 }) }) }
    );
    expect(screen.getByText(copy.offline)).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Share' }));
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  test('a failed share: an inline retry that tries again', async () => {
    const w = await shareWorld({ trips: [FINAL] });
    const sheet = jest.fn(async () => {
      throw new Error('no sheet');
    });
    const { deps } = composerDeps({ share: { platform: 'android', share: sheet } });
    await w.render(<ShareComposerScreen params={{ kind: 'trip', clientTripId: 'trip-9' }} deps={deps} />);
    await screen.findByTestId('share-preview');
    await press(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByText("Couldn't share. Try again.")).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(sheet).toHaveBeenCalledTimes(2);
  });

  test('the card art: no ID wording or strip in any SVG text node', async () => {
    await open({ kind: 'badge', badgeId: 'safe_days_7' }, { referral: true }, {
      rewardsApi: fakeRewardsApi(
        snapshot({
          badges: [{ user_id: '00000000-0000-4000-8000-00000000000a', badge_id: 'safe_days_7', earned_at: '2026-09-20T12:00:00Z', created_at: '2026-09-20T12:00:00Z' }],
        })
      ),
    });
    // Every string the SVG draws, from the rendered tree (not the model).
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('Safe Start');
    expect(tree).toContain('Earned Sep');
    expect(tree).not.toMatch(/licen[cs]e|\bID\b|DOB|date of birth|<<|MRZ/i);
  });

  test('Android: "Shares as text on this phone." under Share and in its hint (T13 r1 m2)', async () => {
    await open({ kind: 'trip', clientTripId: 'trip-9' }, { trips: [FINAL] });
    expect(screen.getByTestId('share-text-only').props.children).toBe('Shares as text on this phone.');
    expect(screen.getByRole('button', { name: 'Share' }).props.accessibilityHint).toContain('Shares as text on this phone.');
  });

  test('iOS: the image goes, so no text-only note', async () => {
    const w = await shareWorld({ trips: [FINAL] });
    const { deps } = composerDeps({}, 'ios');
    await w.render(<ShareComposerScreen params={{ kind: 'trip', clientTripId: 'trip-9' }} deps={deps} />);
    await screen.findByTestId('share-preview');
    expect(screen.queryByTestId('share-text-only')).toBeNull();
    expect(screen.getByRole('button', { name: 'Share' }).props.accessibilityHint).not.toContain('text');
  });

  test('Share waits while a turned-on code is still loading (T13 r1 n2)', async () => {
    let release: (code: string) => void = () => undefined;
    const referral = fakeReferralApi();
    (referral.getMyReferralCode as jest.Mock).mockImplementation(() => new Promise<string>((r) => (release = r)));
    const { sheet } = await open({ kind: 'streak' }, { referral: true }, { api: referral });
    await act(async () => {
      fireEvent(screen.getByRole('switch', { name: 'Add my invite code' }), 'valueChange', true);
    });
    const button = screen.getByRole('button', { name: 'Share' });
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    await press(button);
    expect(sheet).not.toHaveBeenCalled();
    await act(async () => release('ABCD2345'));
    await settleInbox();
    expect(screen.getByRole('button', { name: 'Share' }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  test('200 % text: the chrome still renders every control', async () => {
    mockFontScale.mockReturnValue(2);
    await open({ kind: 'trip', clientTripId: 'trip-9' }, { trips: [FINAL] });
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Show distance' })).toBeTruthy();
  });
});
