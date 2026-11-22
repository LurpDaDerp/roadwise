/**
 * The v3 navigation skeleton (plan §7): every route exists as one file, the removed v2 routes are
 * gone, and every settings href resolves to a route file. Also, under the real expo-router, the two
 * ways a Start drive opens the driving screen never stack two of them.
 */
import { act, renderRouter } from 'expo-router/testing-library';
import { router, Stack, Tabs } from 'expo-router';
import { Text } from 'react-native';

import { DRIVE_HREF } from '@/features/drive/hudCopy';
import { SETTINGS_HREFS } from '@/features/settings/routes';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const fs = require('node:fs') as { existsSync: (file: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...parts: string[]) => string; resolve: (...parts: string[]) => string };
const APP = path.resolve(__dirname, '..');
const exists = (file: string) => fs.existsSync(path.join(APP, file));

const V3_ROUTES = [
  '_layout.tsx',
  'index.tsx',
  'update-required.tsx',
  '(auth)/sign-in.tsx',
  '(onboarding)/[step].tsx',
  '(tabs)/_layout.tsx',
  '(tabs)/home.tsx',
  '(tabs)/analytics.tsx',
  '(tabs)/leagues.tsx',
  '(tabs)/profile.tsx',
  'drive/_layout.tsx',
  'drive/index.tsx',
  '(app)/drives/index.tsx',
  '(app)/drives/[clientTripId].tsx',
  '(app)/how-scores-work.tsx',
  '(app)/u/[username].tsx',
  '(app)/add/[username].tsx',
  '(app)/friends/index.tsx',
  '(app)/friends/add.tsx',
  '(app)/friends/scan.tsx',
  '(app)/heatmap.tsx',
  '(app)/achievements.tsx',
  '(app)/settings/index.tsx',
  '(app)/settings/privacy-zones.tsx',
  '(app)/settings/places.tsx',
  '(app)/settings/emergency.tsx',
  '(app)/settings/car.tsx',
  '(app)/settings/dashcam.tsx',
  '(app)/settings/notifications.tsx',
  '(app)/settings/alerts.tsx',
  '(app)/settings/account.tsx',
  '(app)/settings/delete-account.tsx',
  '(app)/settings/blocked.tsx',
  '(app)/settings/permissions.tsx',
  '(app)/settings/permit.tsx',
  '(app)/settings/practice-drives.tsx',
  '(app)/wrapped/index.tsx',
  '(app)/wrapped/[month].tsx',
  '(app)/w/[id].tsx',
  'legal/[doc].tsx',
];

const REMOVED = [
  '(auth)/welcome.tsx',
  '(tabs)/drive.tsx',
  '(tabs)/insights.tsx',
  '(tabs)/family.tsx',
  '(tabs)/rewards.tsx',
  '(app)/inbox.tsx',
  '(app)/family',
  '(app)/insights',
  '(app)/rewards',
  '(app)/trips',
  '(app)/permissions',
  'drive/start.tsx',
  'drive/hud.tsx',
  'drive/pocket.tsx',
  'drive/end.tsx',
  '(app)/settings/dms.tsx',
  '(app)/settings/dms-setup.tsx',
  '(tabs)/clan.tsx',
  '(app)/clan',
  '(app)/stats.tsx',
  '(app)/how-points-work.tsx',
];

test.each(V3_ROUTES)('%s exists', (file) => expect(exists(file)).toBe(true));

test.each(REMOVED)('%s is gone', (file) => expect(exists(file)).toBe(false));

test('every settings href has its route file', () => {
  const toFile = (href: string) => {
    const p = href.replace(/^\//, '');
    return p.startsWith('settings') ? `(app)/${p === 'settings' ? 'settings/index' : p}.tsx` : `(app)/${p}.tsx`;
  };
  for (const href of Object.values(SETTINGS_HREFS)) expect([href, exists(toFile(String(href)))]).toEqual([href, true]);
});

/**
 * A Start drive swiped with the car already rolling: the drive's hold (`LockoutGate`) can open the
 * driving screen with `dismissTo` before `start()` resolves, and then Home opens it too
 * (`HomeScreen`). Home navigates, so the root stack keeps one driving screen whichever goes first.
 * The stack as the root layout has it: the tabs, and the drive group as a full-screen modal.
 */
describe('Start drive opens one driving screen', () => {
  const routes = {
    _layout: () => (
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="drive" options={{ gestureEnabled: false, presentation: 'fullScreenModal' }} />
      </Stack>
    ),
    '(tabs)/_layout': () => <Tabs screenOptions={{ headerShown: false }} />,
    '(tabs)/home': () => <Text>home</Text>,
    'drive/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
    'drive/index': () => <Text>driving</Text>,
  };
  type App = ReturnType<typeof renderRouter>;
  type Node = { name?: string; state?: { routes?: Node[] } };
  /** Driving screens mounted anywhere: each `drive` route counts the screens in its own stack (one before it has drawn one). */
  const count = (routes: readonly Node[] = []): number =>
    routes.reduce((n, r) => n + (r.name === 'drive' ? Math.max(1, r.state?.routes?.length ?? 0) : count(r.state?.routes)), 0);
  const drivingScreens = (app: App) => count(app.getRouterState()?.routes as readonly Node[] | undefined);
  const go = async (fn: () => void) => {
    await act(async () => fn());
  };

  test('the hold first, then Home: still one', async () => {
    const app = renderRouter(routes, { initialUrl: '/home' });
    await app;
    await go(() => router.dismissTo(DRIVE_HREF));
    await go(() => router.navigate(DRIVE_HREF));
    expect(app.getPathname()).toBe('/drive');
    expect(drivingScreens(app)).toBe(1);
  });

  test('Home first, then the hold: still one', async () => {
    const app = renderRouter(routes, { initialUrl: '/home' });
    await app;
    await go(() => router.navigate(DRIVE_HREF));
    expect(app.getPathname()).toBe('/drive');
    expect(drivingScreens(app)).toBe(1);
    // The hold skips this on the driving screen (LockoutGate's onDriveScreen); sent anyway, it adds none.
    await go(() => router.dismissTo(DRIVE_HREF));
    expect(app.getPathname()).toBe('/drive');
    expect(drivingScreens(app)).toBe(1);
  });

  test('control: a push after the hold would stack a second driving screen', async () => {
    const app = renderRouter(routes, { initialUrl: '/home' });
    await app;
    await go(() => router.dismissTo(DRIVE_HREF));
    await go(() => router.push(DRIVE_HREF));
    expect(drivingScreens(app)).toBe(2);
  });
});
