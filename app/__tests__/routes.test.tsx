/**
 * The v3 navigation skeleton (plan §7): every route exists as one file, the removed v2 routes are
 * gone, and every settings href resolves to a route file.
 */
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { HOME_HREF, HOW_POINTS_WORK_HREF, TRIP_HISTORY_HREF } from '@/features/trips/routes';

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
  'auth/callback.tsx',
  '(onboarding)/[step].tsx',
  '(tabs)/_layout.tsx',
  '(tabs)/home.tsx',
  '(tabs)/leagues.tsx',
  '(tabs)/clan.tsx',
  '(tabs)/profile.tsx',
  'drive/_layout.tsx',
  'drive/index.tsx',
  '(app)/drives/index.tsx',
  '(app)/drives/[clientTripId].tsx',
  '(app)/stats.tsx',
  '(app)/how-points-work.tsx',
  '(app)/u/[username].tsx',
  '(app)/add/[username].tsx',
  '(app)/friends/index.tsx',
  '(app)/friends/add.tsx',
  '(app)/friends/scan.tsx',
  '(app)/clan/create.tsx',
  '(app)/clan/join.tsx',
  '(app)/clan/manage.tsx',
  '(app)/heatmap.tsx',
  '(app)/achievements.tsx',
  '(app)/settings/index.tsx',
  '(app)/settings/dms.tsx',
  '(app)/settings/dms-setup.tsx',
  '(app)/settings/privacy-zones.tsx',
  '(app)/settings/notifications.tsx',
  '(app)/settings/alerts.tsx',
  '(app)/settings/account.tsx',
  '(app)/settings/delete-account.tsx',
  '(app)/settings/blocked.tsx',
  '(app)/settings/permissions.tsx',
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

test('the drive hrefs name the v3 routes', () => {
  expect(HOME_HREF).toBe('/(tabs)/home');
  expect(TRIP_HISTORY_HREF).toBe('/(app)/drives');
  expect(HOW_POINTS_WORK_HREF).toBe('/(app)/how-points-work');
});
