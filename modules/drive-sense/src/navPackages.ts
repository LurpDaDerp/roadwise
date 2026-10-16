// The Android packages `listInstalledApps` and `launchApp` accept: exactly the navigation apps of
// src/features/navigation/catalog.ts, in its order, and the manifest's `<queries>` (the tests hold
// all three, and the Kotlin `NavPackages.ALLOWED`, equal). Any other package is refused before the
// bridge, and again natively, so the bridge never opens an app outside this list.
export const NAV_APP_PACKAGES: readonly string[] = Object.freeze([
  'com.google.android.apps.maps',
  'com.waze',
  'com.google.android.apps.navlite',
  'com.here.app.maps',
  'com.sygic.aura',
  'com.tomtom.gplay.navapp',
  'com.generalmagic.magicearth',
  'net.osmand.plus',
  'net.osmand',
  'app.organicmaps',
  'com.mapquest.android.ace',
  'ru.yandex.yandexnavi',
]);

const ALLOWED: ReadonlySet<string> = new Set(NAV_APP_PACKAGES);

/** A package the navigation button may list or open. */
export const isNavAppPackage = (v: unknown): v is string => typeof v === 'string' && ALLOWED.has(v);
