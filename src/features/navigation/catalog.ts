// The navigation apps the navigation button can open (product spec v3 "Driving screen ·
// Navigation"), in display order. iOS finds one by its URL scheme (each listed in app.config.ts
// `LSApplicationQueriesSchemes`), Android by its package (each listed in the drive-sense manifest's
// `<queries>`); the tests hold both lists equal to this one. A wrong scheme or package fails safe:
// that app just never appears. Pure data; imports nothing.

export type NavAppId =
  | 'apple_maps'
  | 'google_maps'
  | 'waze'
  | 'google_maps_go_nav'
  | 'here'
  | 'sygic'
  | 'tomtom'
  | 'magic_earth'
  | 'osmand'
  | 'organic_maps'
  | 'mapquest'
  | 'yandex_navi';

export interface NavAppEntry {
  id: NavAppId;
  label: string;
  /** The navigation button's caption: at most 12 characters. */
  short: string;
  /** The URL scheme the iPhone app answers (opened as `scheme://`), or null when it has no iPhone app. */
  iosScheme: string | null;
  /** Android packages, the first installed one wins; empty when it has no Android app. */
  androidPackages: readonly string[];
}

export const NAV_APPS: readonly NavAppEntry[] = [
  { id: 'apple_maps', label: 'Apple Maps', short: 'Apple Maps', iosScheme: 'maps', androidPackages: [] },
  { id: 'google_maps', label: 'Google Maps', short: 'Google Maps', iosScheme: 'comgooglemaps', androidPackages: ['com.google.android.apps.maps'] },
  { id: 'waze', label: 'Waze', short: 'Waze', iosScheme: 'waze', androidPackages: ['com.waze'] },
  { id: 'google_maps_go_nav', label: 'Navigation for Google Maps Go', short: 'Maps Go', iosScheme: null, androidPackages: ['com.google.android.apps.navlite'] },
  { id: 'here', label: 'HERE WeGo', short: 'HERE WeGo', iosScheme: 'here-route', androidPackages: ['com.here.app.maps'] },
  { id: 'sygic', label: 'Sygic', short: 'Sygic', iosScheme: 'com.sygic.aura', androidPackages: ['com.sygic.aura'] },
  { id: 'tomtom', label: 'TomTom GO', short: 'TomTom GO', iosScheme: 'tomtomgo', androidPackages: ['com.tomtom.gplay.navapp'] },
  { id: 'magic_earth', label: 'Magic Earth', short: 'Magic Earth', iosScheme: 'magicearth', androidPackages: ['com.generalmagic.magicearth'] },
  { id: 'osmand', label: 'OsmAnd', short: 'OsmAnd', iosScheme: 'osmandmaps', androidPackages: ['net.osmand.plus', 'net.osmand'] },
  { id: 'organic_maps', label: 'Organic Maps', short: 'Organic Maps', iosScheme: 'om', androidPackages: ['app.organicmaps'] },
  { id: 'mapquest', label: 'MapQuest', short: 'MapQuest', iosScheme: 'mapquest', androidPackages: ['com.mapquest.android.ace'] },
  { id: 'yandex_navi', label: 'Yandex Navigator', short: 'Yandex', iosScheme: 'yandexnavi', androidPackages: ['ru.yandex.yandexnavi'] },
];

/** Every iOS scheme, in order (app.config.ts lists exactly these). */
export const NAV_IOS_SCHEMES: readonly string[] = NAV_APPS.flatMap((a) => (a.iosScheme === null ? [] : [a.iosScheme]));

/** Every Android package, in order (the drive-sense manifest's `<queries>` lists exactly these). */
export const NAV_ANDROID_PACKAGES: readonly string[] = NAV_APPS.flatMap((a) => a.androidPackages);

export const navAppById = (id: unknown): NavAppEntry | null => NAV_APPS.find((a) => a.id === id) ?? null;
