import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';

import { setHydrationStatus } from '@/data/hydrate/status';
import { setSharedNet, type NetAdapter } from '@/data/net/net';
import { HomeBanners, RestoreRetryProvider } from '@/features/home/HomeBanners';
import {
  drive,
  fakeAdapter,
  fakeAppState,
  fakeHost,
  noRefresh,
  permissionsWorld,
  snap,
  type FakeAdapter,
} from '@/features/permissions/__fixtures__/harness';
import { clearQueryClients, routerDouble } from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } }),
}));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));

function fakeNet(online: boolean): NetAdapter & { go(online: boolean): void } {
  let isOnline = online;
  const listeners = new Set<() => void>();
  return {
    isOnline: () => isOnline,
    isWifi: () => false,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    go(next: boolean) {
      isOnline = next;
      for (const l of listeners) l();
    },
  } as unknown as NetAdapter & { go(online: boolean): void };
}

/**
 * Home's banners inside the app's providers, with a phone whose permissions are healthy unless a
 * test says otherwise (Task 19 added the permission banner, which reads the phone).
 */
async function renderBanners(
  ui: (deps: { adapter: FakeAdapter }) => ReactElement = (deps) => <HomeBanners permissionDeps={withSeams(deps.adapter)} />,
  adapter: FakeAdapter = fakeAdapter(snap())
) {
  const w = await permissionsWorld({ trips: [drive(1)] });
  await w.render(ui({ adapter }), fakeHost({ intent: true }).host);
  await waitFor(() => expect(adapter.log).toContain('snapshot'));
  await act(async () => {});
  return adapter;
}

const withSeams = (adapter: FakeAdapter) => ({ adapter, appState: fakeAppState(), appConfig: { refresher: noRefresh } });

afterEach(async () => {
  clearQueryClients();
  await act(async () => {
    setSharedNet(null);
    setHydrationStatus({ state: 'idle' });
  });
});

test('online, nothing restoring, no drive: no banner at all', async () => {
  await renderBanners();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('offline says so, and what happens to drives meanwhile; back online it goes', async () => {
  const net = fakeNet(false);
  setSharedNet(net);
  await renderBanners();
  expect(
    screen.getByText("You're offline. Drives are saved on this phone and upload when you're back online.")
  ).toBeOnTheScreen();

  await act(async () => net.go(true));
  expect(screen.queryByTestId('banner-offline')).toBeNull();
});

test('an unread network state is not evidence of being offline', async () => {
  await renderBanners();
  expect(screen.queryByTestId('banner-offline')).toBeNull();
});

test('a restore in progress says how far it has got', async () => {
  setHydrationStatus({ state: 'restoring', restored: 0 });
  await renderBanners();
  expect(screen.getByText('Restoring your drives from the server.')).toBeOnTheScreen();

  await act(async () => setHydrationStatus({ state: 'restoring', restored: 12 }));
  expect(screen.getByText('Restoring your drives from the server: 12 drives so far.')).toBeOnTheScreen();
});

test('a restore cut short offers Retry, which runs the restore now', async () => {
  setHydrationStatus({ state: 'failed', at: 1 });
  let finish: () => void = () => {};
  const retry = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = () => resolve(true);
      })
  );
  await renderBanners(({ adapter }) => (
    <RestoreRetryProvider retry={retry}>
      <HomeBanners permissionDeps={withSeams(adapter)} />
    </RestoreRetryProvider>
  ));

  expect(
    screen.getByText("Couldn't finish restoring your drives. Your score may be missing until it does.")
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledTimes(1);
  // One run at a time: the button is gone until this one answers.
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

  await act(async () => {
    finish();
  });
  expect(screen.getByRole('button', { name: 'Retry' })).toBeOnTheScreen();
});

test('without a way to retry, the failed banner still says what happened and offers nothing false', async () => {
  setHydrationStatus({ state: 'failed', at: 1 });
  await renderBanners();
  expect(screen.getByTestId('banner-restore-failed')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('the drive-in-progress banner comes first, then permission health, then offline', async () => {
  const net = fakeNet(false);
  setSharedNet(net);
  await renderBanners(
    ({ adapter }) => (
      <HomeBanners
        inProgress={<Text testID="in-progress">Drive in progress</Text>}
        permissionDeps={withSeams(adapter)}
      />
    ),
    fakeAdapter(snap({ location: 'denied', precise: null }))
  );
  // The rendered tree, depth first: the order a screen reader meets them.
  const seen: string[] = [];
  type Node = { props?: { testID?: string }; children?: (Node | string)[] | null };
  const walk = (n: Node | Node[] | string | null): void => {
    if (n === null || typeof n === 'string') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.props?.testID) seen.push(n.props.testID);
    (n.children ?? []).forEach(walk);
  };
  walk(screen.toJSON() as Node | Node[] | null);
  const wanted = ['in-progress', 'banner-permission-health', 'banner-offline'];
  expect(seen.filter((id) => wanted.includes(id))).toEqual(wanted);
});

describe('permission health (Task 9, retired interim shells: Task 19)', () => {
  test('a healthy phone: no permission banner', async () => {
    await renderBanners();
    expect(screen.queryByTestId('banner-permission-health')).toBeNull();
  });

  test('location off: Home carries the one "tap to fix" banner, which opens B2', async () => {
    await renderBanners(undefined, fakeAdapter(snap({ location: 'denied', precise: null })));
    const banner = await screen.findByRole('button', { name: 'Drive recording is off — tap to fix' });
    fireEvent.press(banner);
    expect(mockRouter.push).toHaveBeenCalledWith('/permissions');
    expect(screen.getAllByTestId('banner-permission-health')).toHaveLength(1);
  });

  test('a phone that cannot be read raises no banner (nothing is made up)', async () => {
    const adapter = fakeAdapter(snap({ location: 'denied' }));
    adapter.failReads = true;
    await renderBanners(undefined, adapter);
    expect(screen.queryByTestId('banner-permission-health')).toBeNull();
  });
});
