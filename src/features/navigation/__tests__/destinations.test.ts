/** @jest-environment node */
// Directions to a point (round 14, feature 3): which apps take a destination on which platform, the
// exact URLs, the point's format, walking with its fallback, and the openers that use them.
import { openDirections, openWalkingDirections, type NavAppsPort } from '@/features/navigation/apps';
import { NAV_APPS, navAppById, type NavAppId } from '@/features/navigation/catalog';
import { destinationUrl, drivingUrl, pointParam, takesDestination, WALKING_FALLBACK, walkingUrl, type NavPlatform } from '@/features/navigation/destinations';

const HOME = { lat: 47.6062104, lng: -122.3320708 };
const PLATFORMS: NavPlatform[] = ['ios', 'android'];

describe('the point', () => {
  test('latitude,longitude to 6 decimals, rounded, signs kept', () => {
    expect(pointParam(HOME)).toBe('47.606210,-122.332071');
    expect(pointParam({ lat: -33.8688, lng: 151.2093 })).toBe('-33.868800,151.209300');
    expect(pointParam({ lat: 1, lng: 2 })).toBe('1.000000,2.000000');
    expect(pointParam({ lat: 12.3456785, lng: 0.0000004 })).toMatch(/^12\.34567[89],0\.000000$/);
  });

  test('the poles and the date line are real points', () => {
    expect(pointParam({ lat: 90, lng: 180 })).toBe('90.000000,180.000000');
    expect(pointParam({ lat: -90, lng: -180 })).toBe('-90.000000,-180.000000');
  });

  test('zero never reads as "-0"', () => {
    expect(pointParam({ lat: -0, lng: -0 })).toBe('0.000000,0.000000');
    expect(pointParam({ lat: -0.0000001, lng: -0.0000004 })).toBe('0.000000,0.000000');
    expect(pointParam({ lat: -0.0000006, lng: 0 })).toBe('-0.000001,0.000000');
  });

  test('anything that is not a real point gives no URL at all', () => {
    const bad = [
      { lat: Number.NaN, lng: 0 },
      { lat: 0, lng: Number.POSITIVE_INFINITY },
      { lat: 90.000001, lng: 0 },
      { lat: -91, lng: 0 },
      { lat: 0, lng: 180.5 },
      { lat: 0, lng: -181 },
      { lat: '47.6', lng: '-122.3' } as unknown as { lat: number; lng: number },
      { lat: null, lng: undefined } as unknown as { lat: number; lng: number },
    ];
    for (const p of bad) {
      expect(pointParam(p)).toBeNull();
      for (const platform of PLATFORMS) {
        for (const a of NAV_APPS) {
          expect(drivingUrl(a.id, platform, p)).toBeNull();
          expect(walkingUrl(a.id, platform, p)).toBeNull();
        }
        expect(walkingUrl(null, platform, p)).toBeNull();
      }
    }
  });
});

describe('which apps take a destination', () => {
  test('iPhone: Apple Maps, Google Maps and Waze; Android: Google Maps and Waze; no other app', () => {
    const takers = (platform: NavPlatform) => NAV_APPS.filter((a) => takesDestination(a.id, platform)).map((a) => a.id);
    expect(takers('ios')).toEqual(['apple_maps', 'google_maps', 'waze']);
    expect(takers('android')).toEqual(['google_maps', 'waze']);
    expect(takesDestination(null, 'ios')).toBe(false);
    expect(takesDestination(undefined, 'android')).toBe(false);
  });

  test('an id this build does not know, or one that names an object property, takes nothing', () => {
    for (const id of ['citymapper', 'toString', 'constructor', '__proto__', 'hasOwnProperty', '']) {
      for (const platform of PLATFORMS) {
        expect(takesDestination(id as NavAppId, platform)).toBe(false);
        expect(drivingUrl(id as NavAppId, platform, HOME)).toBeNull();
        // walking still falls back to the platform's maps
        expect(walkingUrl(id as NavAppId, platform, HOME)).toBe(walkingUrl(WALKING_FALLBACK[platform], platform, HOME));
      }
    }
  });

  test('an iPhone URL uses the app’s own declared scheme (so it is the app that opens)', () => {
    for (const a of NAV_APPS) {
      for (const mode of ['driving', 'walking'] as const) {
        const url = destinationUrl(a.id, 'ios', HOME, mode);
        if (url !== null) expect(url.startsWith(`${navAppById(a.id)!.iosScheme}://`)).toBe(true);
      }
    }
  });

  test('an app takes a destination only where it has an app at all', () => {
    for (const a of NAV_APPS) {
      if (a.iosScheme === null) expect(takesDestination(a.id, 'ios')).toBe(false);
      if (a.androidPackages.length === 0) expect(takesDestination(a.id, 'android')).toBe(false);
    }
  });
});

describe('driving directions', () => {
  test('Apple Maps (iPhone)', () => {
    expect(drivingUrl('apple_maps', 'ios', HOME)).toBe('maps://?daddr=47.606210,-122.332071&dirflg=d');
    expect(drivingUrl('apple_maps', 'android', HOME)).toBeNull();
  });

  test('Google Maps: its iPhone scheme, and google.navigation on Android', () => {
    expect(drivingUrl('google_maps', 'ios', HOME)).toBe('comgooglemaps://?daddr=47.606210,-122.332071&directionsmode=driving');
    expect(drivingUrl('google_maps', 'android', HOME)).toBe('google.navigation:q=47.606210,-122.332071&mode=d');
  });

  test('Waze, the same on both', () => {
    expect(drivingUrl('waze', 'ios', HOME)).toBe('waze://?ll=47.606210,-122.332071&navigate=yes');
    expect(drivingUrl('waze', 'android', HOME)).toBe('waze://?ll=47.606210,-122.332071&navigate=yes');
  });

  test('the other apps have none', () => {
    for (const id of ['google_maps_go_nav', 'here', 'sygic', 'tomtom', 'magic_earth', 'osmand', 'organic_maps', 'mapquest', 'yandex_navi'] as const) {
      for (const platform of PLATFORMS) expect(drivingUrl(id, platform, HOME)).toBeNull();
    }
  });

  test('every URL holds nothing but the point (no address, no spaces)', () => {
    for (const platform of PLATFORMS) {
      for (const a of NAV_APPS) {
        const url = drivingUrl(a.id, platform, HOME);
        if (url !== null) {
          expect(url).not.toMatch(/\s/);
          expect(url).toContain('47.606210,-122.332071');
        }
      }
    }
  });
});

describe('walking directions', () => {
  test('in the app when it walks', () => {
    expect(walkingUrl('apple_maps', 'ios', HOME)).toBe('maps://?daddr=47.606210,-122.332071&dirflg=w');
    expect(walkingUrl('google_maps', 'ios', HOME)).toBe('comgooglemaps://?daddr=47.606210,-122.332071&directionsmode=walking');
    expect(walkingUrl('google_maps', 'android', HOME)).toBe('google.navigation:q=47.606210,-122.332071&mode=w');
  });

  test('Waze only drives: walking falls back to Apple Maps on iPhone, Google Maps on Android', () => {
    expect(WALKING_FALLBACK).toEqual({ ios: 'apple_maps', android: 'google_maps' });
    expect(destinationUrl('waze', 'ios', HOME, 'walking')).toBeNull();
    expect(walkingUrl('waze', 'ios', HOME)).toBe('maps://?daddr=47.606210,-122.332071&dirflg=w');
    expect(walkingUrl('waze', 'android', HOME)).toBe('google.navigation:q=47.606210,-122.332071&mode=w');
  });

  test('no app saved, an app with no destination, or Apple Maps on Android: the same fallback', () => {
    for (const id of [null, undefined, 'here', 'osmand', 'google_maps_go_nav', 'apple_maps'] as const) {
      expect(walkingUrl(id, 'android', HOME)).toBe('google.navigation:q=47.606210,-122.332071&mode=w');
    }
    for (const id of [null, undefined, 'here', 'osmand', 'yandex_navi'] as const) {
      expect(walkingUrl(id, 'ios', HOME)).toBe('maps://?daddr=47.606210,-122.332071&dirflg=w');
    }
  });

  test('never a driving URL', () => {
    for (const platform of PLATFORMS) {
      for (const a of [...NAV_APPS.map((x) => x.id), null]) {
        const url = walkingUrl(a, platform, HOME)!;
        expect(url).toMatch(/dirflg=w$|directionsmode=walking$|mode=w$/);
        expect(url).not.toContain('navigate=yes');
      }
    }
  });
});

describe('opening them', () => {
  function port(platform: NavPlatform, fails: (url: string) => boolean = () => false): NavAppsPort & { opened: string[] } {
    const opened: string[] = [];
    return {
      platform,
      canOpenURL: async () => true,
      openURL: async (url) => {
        opened.push(url);
        if (fails(url)) throw new Error('no app');
        return true;
      },
      listInstalledApps: async () => [],
      launchApp: async () => true,
      opened,
    };
  }

  test('openDirections: the URL through the phone, on Android too (never the package launcher); false when it does not open', async () => {
    const p = port('android', (u) => u.startsWith('waze'));
    const launch = jest.spyOn(p, 'launchApp');
    expect(await openDirections('google.navigation:q=1.000000,2.000000&mode=d', p)).toBe(true);
    expect(await openDirections('waze://?ll=1.000000,2.000000&navigate=yes', p)).toBe(false);
    expect(p.opened).toEqual(['google.navigation:q=1.000000,2.000000&mode=d', 'waze://?ll=1.000000,2.000000&navigate=yes']);
    expect(launch).not.toHaveBeenCalled();
  });

  test('openWalkingDirections: the saved app when it walks', async () => {
    const p = port('ios');
    expect(await openWalkingDirections('google_maps', HOME, p)).toBe(true);
    expect(p.opened).toEqual(['comgooglemaps://?daddr=47.606210,-122.332071&directionsmode=walking']);
  });

  test('openWalkingDirections: the platform maps when the saved app does not open, or does not walk', async () => {
    const p = port('ios', (u) => u.startsWith('comgooglemaps'));
    expect(await openWalkingDirections('google_maps', HOME, p)).toBe(true);
    expect(p.opened).toEqual(['comgooglemaps://?daddr=47.606210,-122.332071&directionsmode=walking', 'maps://?daddr=47.606210,-122.332071&dirflg=w']);
    const a = port('android');
    expect(await openWalkingDirections('waze', HOME, a)).toBe(true);
    expect(a.opened).toEqual(['google.navigation:q=47.606210,-122.332071&mode=w']);
  });

  test('openWalkingDirections: false when nothing opens, trying the fallback only once; nothing at all for a bad point', async () => {
    const p = port('android', () => true);
    expect(await openWalkingDirections('google_maps', HOME, p)).toBe(false);
    expect(p.opened).toEqual(['google.navigation:q=47.606210,-122.332071&mode=w']);
    expect(await openWalkingDirections(null, { lat: Number.NaN, lng: 0 }, p)).toBe(false);
    expect(p.opened).toHaveLength(1);
  });
});
