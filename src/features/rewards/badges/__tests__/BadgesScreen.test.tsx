import { BADGES, type BadgeId } from '@scoring';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { routerDouble } from '@/features/trips/__fixtures__/render';
import { BANNED_COPY } from '@/notifications/catalog';

import { BADGE_COPY, badgesCopy } from '../../copy/badges';
import { OFFLINE_LINE } from '../../copy/common';
import { fakeRewardsApi, renderedStrings, rewardsWorld, UID, type WorldSeed } from '../../hub/__fixtures__/harness';
import { badgeHref } from '../../hub/routes';
import { SEAL_THUMP_SCALE } from '../../ui/Seal';
import { badgeRow, iso, NOW, OTHER_UID, progressRow, snapshot } from '../../__fixtures__/rows';
import { formatEarnedDate } from '../BadgeSeal';
import { BadgesScreen } from '../BadgesScreen';
import { readSeenBadges, SEEN_BADGES_KEY } from '../seen';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));

afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  jest.clearAllMocks();
});

async function renderBadges(snap = snapshot(), seed: WorldSeed = {}) {
  const w = await rewardsWorld(seed);
  const server = fakeRewardsApi(snap);
  await w.render(<BadgesScreen deps={{ api: server.api }} tz="UTC" />);
  await screen.findByTestId('badges-grid');
  await settleInbox();
  return { ...w, ...server };
}

const allIds = BADGES.map((b) => b.id);
const earnedAt = iso(Date.parse('2026-09-21T15:00:00Z'));

describe('BadgesScreen', () => {
  it('none earned: the empty line, every locked seal with its criterion and progress', async () => {
    await renderBadges(
      snapshot({ badges: [], progress: progressRow({ safe_days: 3, phone_free_days: 0, smooth_days: 0, goals_achieved: 0, challenges_completed: 0 }) })
    );
    expect(screen.getByText('Your first badge comes with 7 safe days.')).toBeTruthy();
    expect(screen.getByTestId('badge-safe_days_30')).toHaveTextContent(/Reach 30 safe days · 3 so far/);
    expect(screen.getByTestId('badge-safe_days_7').props.accessibilityLabel).toBe(
      'Safe Start, Bronze badge, locked. Reach 7 safe days · 3 so far'
    );
    expect(screen.getAllByText('Locked', { includeHiddenElements: true }).length).toBeGreaterThanOrEqual(15);
  });

  it('some earned: each earned seal carries its date; the locked ones their progress', async () => {
    await renderBadges(
      snapshot({
        badges: [badgeRow('safe_days_7', { earned_at: earnedAt }), badgeRow('weekly_goals_1', { earned_at: earnedAt })],
        progress: progressRow({ safe_days: 12 }),
      })
    );
    expect(screen.getByTestId('badges-summary')).toHaveTextContent('2 of 15 earned');
    expect(screen.getByTestId('badge-safe_days_7')).toHaveTextContent(/Earned Sep 21/);
    expect(screen.getByTestId('badge-safe_days_7').props.accessibilityLabel).toBe(
      'Safe Start, Bronze badge, earned September 21'
    );
    expect(screen.getByTestId('badge-safe_days_30')).toHaveTextContent(/Reach 30 safe days · 12 so far/);
  });

  it('all earned: every seal dated, none locked', async () => {
    await renderBadges(snapshot({ badges: allIds.map((id) => badgeRow(id, { earned_at: earnedAt })) }), {
      referral: true,
    });
    expect(screen.getByTestId('badges-summary')).toHaveTextContent('16 of 16 earned');
    expect(screen.queryByText('Locked', { includeHiddenElements: true })).toBeNull();
    for (const id of allIds) expect(screen.getByTestId(`badge-${id}`)).toHaveTextContent(/Earned Sep 21/);
  });

  it('grouped by family, in display order, with a heading per family', async () => {
    await renderBadges(snapshot(), { referral: true });
    const headers = screen.getAllByRole('header').map((h) => h.props.children);
    expect(headers).toEqual(['Badges', 'Safe days', 'No phone use', 'Smooth driving', 'Weekly goals', 'Challenges', 'Friends']);
  });

  it('the referral badge is hidden while inviting is off, unless it was earned', async () => {
    await renderBadges(snapshot(), { referral: false });
    expect(screen.queryByTestId('badge-referrals_1')).toBeNull();
    await clearInboxClients();
    await renderBadges(snapshot({ badges: [badgeRow('referrals_1')] }), { referral: false });
    expect(screen.getByTestId('badge-referrals_1')).toBeTruthy();
  });

  it('a seal opens its badge', async () => {
    await renderBadges();
    fireEvent.press(screen.getByTestId('badge-smooth_days_7'));
    expect(mockRouter.push).toHaveBeenCalledWith(badgeHref('smooth_days_7'));
  });

  it('a badge seen for the first time thumps once; the next visit it is static', async () => {
    const snap = snapshot({ badges: [badgeRow('safe_days_7'), badgeRow('phone_free_days_10')] });
    const w = await renderBadges(snap, { settings: { [SEEN_BADGES_KEY]: { uid: UID, ids: ['safe_days_7'] } } });
    const scale = (id: string) => StyleSheet.flatten(screen.getByTestId(`seal-${id}`, { includeHiddenElements: true }).props.style).transform;
    expect(scale('phone_free_days_10')).toEqual([{ scale: SEAL_THUMP_SCALE }]);
    expect(scale('safe_days_7')).toBeUndefined();
    await waitFor(async () =>
      expect([...(await readSeenBadges(w.db, UID))].sort()).toEqual(['phone_free_days_10', 'safe_days_7'])
    );
    expect(await createSettingsRepo(w.db).get(SEEN_BADGES_KEY)).toEqual({ uid: UID, ids: ['phone_free_days_10', 'safe_days_7'] });
  });

  it('another account’s seen list does not silence this account’s first sight', async () => {
    await renderBadges(snapshot({ badges: [badgeRow('safe_days_7')] }), {
      settings: { [SEEN_BADGES_KEY]: { uid: OTHER_UID, ids: ['safe_days_7'] } },
    });
    expect(StyleSheet.flatten(screen.getByTestId('seal-safe_days_7', { includeHiddenElements: true }).props.style).transform).toEqual([
      { scale: SEAL_THUMP_SCALE },
    ]);
  });

  it('offline: the cached badges with the banner', async () => {
    setOnline(false);
    const w = await rewardsWorld({ cached: snapshot({ badges: [badgeRow('safe_days_7', { earned_at: earnedAt })] }) });
    const server = fakeRewardsApi();
    await w.render(<BadgesScreen deps={{ api: server.api }} tz="UTC" />);
    expect(await screen.findByText(OFFLINE_LINE)).toBeTruthy();
    expect(await screen.findByTestId('badge-safe_days_7')).toHaveTextContent(/Earned Sep 21/);
  });

  it('rendered text passes BANNED_COPY', async () => {
    await renderBadges(snapshot(), { referral: true });
    const text = renderedStrings(screen.getByTestId('badges-screen')).join('\n');
    for (const re of BANNED_COPY) expect(text).not.toMatch(re);
    expect(text).not.toMatch(/store|leaderboard|crew|coming soon|miles?\b|\btrips?\b/i);
  });
});

describe('badge copy', () => {
  it('names and criteria exist for every badge (exhaustive by type) and are clean', () => {
    for (const b of BADGES) {
      const words = BADGE_COPY[b.id as BadgeId];
      expect(words.name.length).toBeGreaterThan(0);
      const line = words.criterion(b.threshold);
      for (const re of BANNED_COPY) expect(`${words.name} ${line}`).not.toMatch(re);
      expect(line).not.toMatch(/miles?\b|\btrips?\b|distance/i);
    }
    expect(Object.keys(BADGE_COPY).sort()).toEqual([...allIds].sort());
  });

  it('criteria print the threshold they were given', () => {
    expect(BADGE_COPY.safe_days_30.criterion(30)).toBe('Reach 30 safe days');
    expect(BADGE_COPY.phone_free_days_10.criterion(10)).toBe('Reach 10 days with no phone use');
    expect(badgesCopy.lockedLine('Reach 30 safe days', 12)).toBe('Reach 30 safe days · 12 so far');
  });

  it('dates are in the phone’s zone, with the year only when it is not this one', () => {
    expect(formatEarnedDate('2026-09-21T02:00:00Z', 'America/Los_Angeles', NOW)).toEqual({
      printed: 'Sep 20',
      spoken: 'September 20',
    });
    expect(formatEarnedDate('2025-09-21T12:00:00Z', 'UTC', NOW).printed).toBe('Sep 21, 2025');
  });
});
