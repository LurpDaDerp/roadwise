/** @jest-environment node */
// The navigation apps (design §7.1-§7.3): the catalogue's invariants, the iOS and Android lists it
// must equal, finding and opening an app on each platform, and the saved choice.
import { NAV_APP_PACKAGES } from '@drive-sense';
import type { ExpoConfig, ConfigContext } from 'expo/config';

import appConfig from '../../../../app.config';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { findInstalledNavApp, listInstalledNavApps, openNavApp, type NavAppsPort } from '@/features/navigation/apps';
import { NAV_ANDROID_PACKAGES, NAV_APPS, NAV_IOS_SCHEMES, navAppById } from '@/features/navigation/catalog';
import { clearNavApp, NAV_APP_KEY, readNavApp, writeNavApp } from '@/features/navigation/prefs';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings
const { readFileSync } = require('node:fs') as { readFileSync: (file: string, encoding: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function port(over: Partial<NavAppsPort> = {}): NavAppsPort & { opened: string[]; launched: string[] } {
  const opened: string[] = [];
  const launched: string[] = [];
  return {
    platform: 'ios',
    canOpenURL: async () => false,
    openURL: async (url) => {
      opened.push(url);
    },
    listInstalledApps: async () => [],
    launchApp: async (p) => {
      launched.push(p);
      return true;
    },
    ...over,
    opened,
    launched,
  };
}

describe('the catalogue', () => {
  test('ids unique; each app on at least one platform; schemes bare; packages well formed; under the 50-scheme limit', () => {
    expect(new Set(NAV_APPS.map((a) => a.id)).size).toBe(NAV_APPS.length);
    for (const a of NAV_APPS) {
      expect(a.iosScheme !== null || a.androidPackages.length > 0).toBe(true);
      if (a.iosScheme !== null) expect(a.iosScheme).toMatch(/^[a-z][a-z0-9.+-]*$/);
      for (const p of a.androidPackages) expect(p).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i);
    }
    expect(NAV_IOS_SCHEMES.length).toBeLessThanOrEqual(50);
    expect(new Set(NAV_ANDROID_PACKAGES).size).toBe(NAV_ANDROID_PACKAGES.length);
    // navigation apps only: no transit app
    expect(NAV_APPS.map((a) => a.label)).not.toContain('Citymapper');
    expect(NAV_APPS.map((a) => a.label)).toEqual([
      'Apple Maps', 'Google Maps', 'Waze', 'Navigation for Google Maps Go', 'HERE WeGo', 'Sygic', 'TomTom GO', 'Magic Earth', 'OsmAnd', 'Organic Maps', 'MapQuest', 'Yandex Navigator',
    ]);
    for (const a of NAV_APPS) expect(a.short.length).toBeLessThanOrEqual(12);
    expect(navAppById('waze')?.label).toBe('Waze');
    expect(navAppById('citymapper')).toBeNull();
  });

  test('iOS: app.config.ts declares exactly the catalogue schemes, in order', () => {
    const config = appConfig({ config: {}, projectRoot: '/work/roadwise' } as unknown as ConfigContext) as ExpoConfig;
    expect(config.ios?.infoPlist?.LSApplicationQueriesSchemes).toEqual([...NAV_IOS_SCHEMES]);
  });

  test("Android: the drive-sense manifest's <queries> names exactly the catalogue packages, in order", () => {
    const manifest = readFileSync(join(__dirname, '..', '..', '..', '..', 'modules', 'drive-sense', 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    const queries = /<queries>([\s\S]*?)<\/queries>/.exec(manifest)?.[1] ?? '';
    expect([...queries.matchAll(/<package android:name="([^"]+)" \/>/g)].map((m) => m[1])).toEqual([...NAV_ANDROID_PACKAGES]);
  });

  test('Android: the bridge accepts exactly the catalogue packages, in order (any other is refused)', () => {
    expect([...NAV_APP_PACKAGES]).toEqual([...NAV_ANDROID_PACKAGES]);
  });
});

describe('iPhone: by URL scheme', () => {
  test('the installed ones in catalogue order; a rejection is "not installed"; opened as bare scheme://', async () => {
    const p = port({
      canOpenURL: async (url) => {
        if (url === 'tomtomgo://') throw new Error('not declared');
        return url === 'waze://' || url === 'comgooglemaps://';
      },
    });
    const apps = await listInstalledNavApps(p);
    expect(apps).toEqual([
      { id: 'google_maps', label: 'Google Maps', target: 'comgooglemaps://' },
      { id: 'waze', label: 'Waze', target: 'waze://' },
    ]);
    expect(await openNavApp(apps[1]!, p)).toBe(true);
    expect(p.opened).toEqual(['waze://']);
    expect(await openNavApp(apps[1]!, port({ openURL: async () => Promise.reject(new Error('no')) }))).toBe(false);
    expect(await findInstalledNavApp('waze', p)).toEqual({ id: 'waze', label: 'Waze', target: 'waze://' });
    expect(await findInstalledNavApp('here', p)).toBeNull();
  });

  test('an Android-only entry is never asked on iPhone', async () => {
    const asked: string[] = [];
    await listInstalledNavApps(port({ canOpenURL: async (u) => (asked.push(u), false) }));
    expect(asked).toEqual(NAV_IOS_SCHEMES.map((s) => `${s}://`));
  });
});

describe('Android: by package', () => {
  test('one native call with every catalogue package; the first installed package of an app wins, with its own label', async () => {
    const asked: (readonly string[])[] = [];
    const p = port({
      platform: 'android',
      listInstalledApps: async (pkgs) => {
        asked.push(pkgs);
        return [
          { package: 'net.osmand', label: 'OsmAnd~' },
          { package: 'net.osmand.plus', label: 'OsmAnd+' },
          { package: 'com.waze', label: '  ' },
        ];
      },
    });
    const apps = await listInstalledNavApps(p);
    expect(asked).toEqual([NAV_ANDROID_PACKAGES]);
    expect(apps).toEqual([
      { id: 'waze', label: 'Waze', target: 'com.waze' },
      { id: 'osmand', label: 'OsmAnd+', target: 'net.osmand.plus' },
    ]);
    expect(await openNavApp(apps[0]!, p)).toBe(true);
    expect(p.launched).toEqual(['com.waze']);
    expect(await openNavApp(apps[0]!, port({ platform: 'android', launchApp: async () => false }))).toBe(false);
    expect(await openNavApp(apps[0]!, port({ platform: 'android', launchApp: async () => Promise.reject(new Error('x')) }))).toBe(false);
  });

  test('a failed native list is no apps', async () => {
    expect(await listInstalledNavApps(port({ platform: 'android', listInstalledApps: async () => Promise.reject(new Error('x')) }))).toEqual([]);
  });
});

describe('the saved choice', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createSqlJsDb();
    await migrate(db);
  });

  test('saved, read back, cleared; an id this build does not know reads as unset', async () => {
    expect(await readNavApp(db)).toBeNull();
    await writeNavApp(db, 'waze');
    expect(await readNavApp(db)).toBe('waze');
    await clearNavApp(db);
    expect(await readNavApp(db)).toBeNull();
    await createSettingsRepo(db).set(NAV_APP_KEY, 'citymapper');
    expect(await readNavApp(db)).toBeNull();
    await createSettingsRepo(db).set(NAV_APP_KEY, { id: 'waze' });
    expect(await readNavApp(db)).toBeNull();
  });
});
