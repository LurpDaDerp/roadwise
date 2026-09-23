import { fireEvent, screen } from '@testing-library/react-native';

import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { routerDouble } from '@/features/trips/__fixtures__/render';

import { badgesCopy } from '../../copy/badges';
import { fakeRewardsApi, rewardsWorld } from '../../hub/__fixtures__/harness';
import { shareBadgeHref } from '../../hub/routes';
import { badgeRow, iso, progressRow, snapshot } from '../../__fixtures__/rows';
import { BadgeDetailScreen } from '../BadgeDetailScreen';

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

async function renderDetail(badgeId: string, snap = snapshot()) {
  const w = await rewardsWorld();
  const server = fakeRewardsApi(snap);
  await w.render(<BadgeDetailScreen badgeId={badgeId} deps={{ api: server.api }} tz="UTC" />);
  await screen.findByTestId(/^badge-(detail|unknown)$/);
  await settleInbox();
  return server;
}

describe('BadgeDetailScreen', () => {
  it('earned: criterion, the date, and Share → the composer for this badge', async () => {
    await renderDetail('safe_days_7', snapshot({ badges: [badgeRow('safe_days_7', { earned_at: iso(Date.parse('2026-09-21T15:00:00Z')) })] }));
    expect(screen.getByText('Safe Start')).toBeTruthy();
    expect(screen.getByTestId('badge-criterion')).toHaveTextContent('Reach 7 safe days');
    expect(screen.getByTestId('badge-earned')).toHaveTextContent('Earned Sep 21');
    expect(screen.getByTestId('badge-seal').props.accessibilityLabel).toBe('Safe Start, Bronze badge, earned September 21');
    fireEvent.press(screen.getByTestId('badge-share'));
    expect(mockRouter.push).toHaveBeenCalledWith(shareBadgeHref('safe_days_7'));
    expect(shareBadgeHref('safe_days_7')).toBe('/rewards/share?kind=badge&badgeId=safe_days_7');
  });

  it('locked: criterion and progress from the counters, and no Share', async () => {
    await renderDetail('safe_days_30', snapshot({ progress: progressRow({ safe_days: 12 }) }));
    expect(screen.getByTestId('badge-criterion')).toHaveTextContent('Reach 30 safe days');
    expect(screen.getByTestId('badge-progress')).toHaveTextContent('12 of 30 safe days');
    expect(screen.getByTestId('badge-seal').props.accessibilityLabel).toBe('Safe Regular, Silver badge, locked');
    expect(screen.getByText(badgesCopy.locked)).toBeTruthy();
    expect(screen.queryByTestId('badge-share')).toBeNull();
    expect(screen.queryByText(badgesCopy.share)).toBeNull();
  });

  it('an id this build does not know says so, with no Share', async () => {
    await renderDetail('night_owl_5');
    expect(screen.getByText(badgesCopy.unknown)).toBeTruthy();
    expect(screen.queryByTestId('badge-share')).toBeNull();
  });
});
