/**
 * Android only: the Bluetooth permissions DashPal discovery needs, declared in the app's manifest.
 *
 * react-native-ble-manager lists them in its own `src/main/AndroidManifest.xml`, but on AGP 7.3 and
 * later its build.gradle points the library at `src/main/AndroidManifestNew.xml`, which the package
 * doesn't ship, so the library adds none of them to the build. Its config plugin is left out
 * (app.config.ts), so they are declared here:
 * - BLUETOOTH_SCAN (Android 12+) with `neverForLocation`: a DashPal scan never derives location, and
 *   Android hands back nothing for a permission the manifest doesn't declare (no dialog, denied).
 * - BLUETOOTH_ADMIN (Android 11 and lower, maxSdkVersion 30): BluetoothLeScanner.startScan needs it there.
 * BLUETOOTH (maxSdkVersion 30) and BLUETOOTH_CONNECT come from the drive-sense module's manifest (the car link).
 */
const { withAndroidManifest } = require('expo/config-plugins');

const PERMISSIONS = [
  {
    'android:name': 'android.permission.BLUETOOTH_SCAN',
    'android:usesPermissionFlags': 'neverForLocation',
    'tools:targetApi': 's',
  },
  { 'android:name': 'android.permission.BLUETOOTH_ADMIN', 'android:maxSdkVersion': '30' },
];

function addBluetoothScan(manifest) {
  manifest.manifest.$ = { ...manifest.manifest.$, 'xmlns:tools': 'http://schemas.android.com/tools' };
  const listed = manifest.manifest['uses-permission'] ?? [];
  for (const attrs of PERMISSIONS) {
    const at = listed.findIndex((p) => p.$?.['android:name'] === attrs['android:name']);
    if (at === -1) listed.push({ $: { ...attrs } });
    else listed[at] = { $: { ...attrs } };
  }
  manifest.manifest['uses-permission'] = listed;
  return manifest;
}

const withAndroidBluetoothScan = (config) =>
  withAndroidManifest(config, (c) => {
    addBluetoothScan(c.modResults);
    return c;
  });

module.exports = withAndroidBluetoothScan;
module.exports.addBluetoothScan = addBluetoothScan;
module.exports.PERMISSIONS = PERMISSIONS;
