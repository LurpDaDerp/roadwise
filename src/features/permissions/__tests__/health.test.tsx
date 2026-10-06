/**
 * v3 permission health: While Using location, precise, motion and notifications; never Always.
 * And the screen: each Fix is one OS call on the tap, then the phone is read again.
 */
import { screen, waitFor } from '@testing-library/react-native';

import { appWorld, clearQueryClients, fakeAdapter, fakeAppState, snap, T0, tap } from '../__fixtures__/harness';
import { healthRows, overall } from '../health';
import { PermissionsScreen } from '../PermissionsScreen';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'u1' } } }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), canGoBack: () => true }) }));

afterEach(() => clearQueryClients());

describe('healthRows', () => {
  it('all on: every row ok, While Using is enough', () => {
    const rows = healthRows(snap({ location: 'foreground' }));
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['location', 'ok'],
      ['precise', 'ok'],
      ['motion', 'ok'],
      ['notifications', 'ok'],
    ]);
    expect(overall(rows)).toBe('ok');
  });

  it('location not asked yet: one request; denied for good: Settings; either way drives are blocked', () => {
    const ask = healthRows(snap({ location: 'undetermined', precise: null }));
    expect(ask[0]).toEqual({ id: 'location', status: 'attention', fix: 'requestLocation' });
    expect(ask.some((r) => r.id === 'precise')).toBe(false);
    expect(overall(ask)).toBe('broken');
    const denied = healthRows(snap({ location: 'denied', precise: null, locationCanAskAgain: false }));
    expect(denied[0]).toEqual({ id: 'location', status: 'off', fix: 'openSettings' });
  });

  it('approximate location, motion off and notifications off each say how to fix', () => {
    const rows = healthRows(
      snap({ precise: false, motion: 'denied', notifications: 'denied', notificationsCanAskAgain: false })
    );
    expect(rows.find((r) => r.id === 'precise')).toEqual({ id: 'precise', status: 'attention', fix: 'openSettings' });
    expect(rows.find((r) => r.id === 'motion')).toEqual({ id: 'motion', status: 'off', fix: 'openSettings' });
    expect(rows.find((r) => r.id === 'notifications')).toEqual({ id: 'notifications', status: 'off', fix: 'openSettings' });
    expect(overall(rows)).toBe('attention');
  });

  it('a phone without motion sensing has no motion row', () => {
    expect(healthRows(snap({ motion: 'unavailable' })).some((r) => r.id === 'motion')).toBe(false);
    expect(healthRows(snap({ motion: null })).some((r) => r.id === 'motion')).toBe(false);
  });
});

describe('PermissionsScreen', () => {
  it('a Fix asks the OS once (While Using, never Always) and reads the phone again', async () => {
    const adapter = fakeAdapter(snap({ location: 'undetermined', precise: null }));
    const w = await appWorld();
    await w.render(<PermissionsScreen deps={{ adapter, appState: fakeAppState(), now: () => T0 }} />);
    await tap('permission-location-fix');
    await waitFor(() => expect(screen.getByTestId('permission-location-status')).toHaveTextContent('On'));
    expect(adapter.log.filter((c) => c !== 'snapshot')).toEqual(['requestLocationForeground']);
    expect(adapter.log).not.toContain('requestLocationAlways');
  });

  it('a row turned off for good opens Settings', async () => {
    const adapter = fakeAdapter(snap({ motion: 'denied' }));
    const w = await appWorld();
    await w.render(<PermissionsScreen deps={{ adapter, appState: fakeAppState(), now: () => T0 }} />);
    await tap('permission-motion-fix');
    await waitFor(() => expect(adapter.log).toContain('openAppSettings'));
  });

  it('an unreadable phone says so with a retry', async () => {
    const adapter = fakeAdapter(snap());
    adapter.failReads = true;
    const w = await appWorld();
    await w.render(<PermissionsScreen deps={{ adapter, appState: fakeAppState() }} />);
    expect(await screen.findByTestId('permissions-read-error')).toBeOnTheScreen();
  });
});
