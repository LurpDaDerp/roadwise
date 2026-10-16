package expo.modules.drivesense

// The navigation button (README §2): the only packages listInstalledApps lists and launchApp opens.
// Exactly the manifest's <queries> and modules/drive-sense/src/navPackages.ts (the tests hold them
// equal); any other package is skipped or refused, so the bridge never opens an app outside it.
internal object NavPackages {
  val ALLOWED: Set<String> = setOf(
    "com.google.android.apps.maps",
    "com.waze",
    "com.google.android.apps.navlite",
    "com.here.app.maps",
    "com.sygic.aura",
    "com.tomtom.gplay.navapp",
    "com.generalmagic.magicearth",
    "net.osmand.plus",
    "net.osmand",
    "app.organicmaps",
    "com.mapquest.android.ace",
    "ru.yandex.yandexnavi",
  )
}
