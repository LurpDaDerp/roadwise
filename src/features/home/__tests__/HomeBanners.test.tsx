import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { setHydrationStatus } from '@/data/hydrate/status';
import { setSharedNet, type NetAdapter } from '@/data/net/net';
import { HomeBanners, RestoreRetryProvider } from '@/features/home/HomeBanners';
import { ThemeProvider } from '@/ui/theme';

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

const renderBanners = (ui = <HomeBanners />) => render(<ThemeProvider>{ui}</ThemeProvider>);

afterEach(async () => {
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
  await renderBanners(
    <RestoreRetryProvider retry={retry}>
      <HomeBanners />
    </RestoreRetryProvider>
  );

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

test('the drive-in-progress banner comes first', async () => {
  const net = fakeNet(false);
  setSharedNet(net);
  await renderBanners(<HomeBanners inProgress={<Text testID="in-progress">Drive in progress</Text>} />);
  const banners = screen.getByTestId('home-banners');
  const ids = (banners.children as { props: { testID?: string } }[]).map((c) => c.props.testID);
  expect(ids.indexOf('in-progress')).toBe(0);
  expect(ids.indexOf('banner-offline')).toBeGreaterThan(0);
});
