/** @jest-environment node */
// The Android car link (WP06: `detect/CarLink.kt`, `detect/CarLinkRecord.kt`, `CarConnectReceiver.kt`
// and their wiring into the drive detector), read as text as `native-android.test.ts` reads the
// rest of the Kotlin. The rules (the outputs listed, the drive's tally, pairing, "Not my car", the
// hidden Bluetooth address, the record and the state's shape, the car wake's gate) are proven by
// the JVM tests (`CarLinkRecordTest.kt`); this suite pins what can be checked statically: read-only
// audio, the outputs Android lists (A2DP and SCO; never LE audio or a hearing aid), Android Auto
// through CarConnection's contract, no polling, one thread, the detector's use of it (the link
// start, the tally, the car-link end, the wipe, the live `carLink` event) and the car's wake
// (ruling 2) with its receiver switched on only while the wakes run with a car paired.

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings (see native-android.test.ts)
const { existsSync, readFileSync } = require('node:fs') as {
  existsSync: (file: string) => boolean;
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const ANDROID = join(__dirname, '..', 'android');
const MAIN = join(ANDROID, 'src', 'main');
const KT_DIR = join(MAIN, 'java', 'expo', 'modules', 'drivesense');
const TEST_DIR = join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense');

const read = (file: string): string => readFileSync(file, 'utf8');
/** Kotlin source with line comments and block comments removed, so a rule cannot be met by a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const kt = (name: string): string => code(read(join(KT_DIR, `${name}.kt`)));
const det = (name: string): string => kt(`detect/${name}`);
/** A function's body, from its declaration to the first line closing at its own indent. */
const fn = (src: string, decl: string, indent = 0): string =>
  new RegExp(`${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n {${indent}}\\}`).exec(src)?.[0] ?? '';
const MANIFEST = () => read(join(MAIN, 'AndroidManifest.xml'));

describe('native-android: the car link reads, never changes, the audio', () => {
  const link = () => det('CarLink');

  it('lists only A2DP and SCO (HFP) Bluetooth outputs, never LE audio or a hearing aid, plus Android Auto', () => {
    const port = fn(link(), '  private fun portType(', 2);
    expect(port).toMatch(/AudioDeviceInfo\.TYPE_BLUETOOTH_A2DP -> "bluetoothA2DP"/);
    expect(port).toMatch(/AudioDeviceInfo\.TYPE_BLUETOOTH_SCO -> "bluetoothHFP"/);
    expect(port).toMatch(/else -> null/);
    expect(link()).not.toMatch(/TYPE_BLE_|TYPE_HEARING_AID/);
    expect(link()).toMatch(/getDevices\(AudioManager\.GET_DEVICES_OUTPUTS\)/);
    expect(link()).toMatch(/if \(projecting\) raw\.add\(CarOutput\(ANDROID_AUTO_UID, ANDROID_AUTO_NAME, "carAudio"\)\)/);
    expect(link()).toMatch(/const val ANDROID_AUTO_NAME = "Android Auto"/);
    expect(det('CarLinkRecord')).toMatch(/val TYPES = listOf\("bluetoothA2DP", "bluetoothHFP", "carAudio"\)/);
  });

  it('read-only: no routing, no SCO, no communication device, no mode, no scan or connection', () => {
    for (const call of ['setCommunicationDevice', 'startBluetoothSco', 'setBluetoothScoOn', 'setSpeakerphoneOn', 'setMode(', 'startDiscovery', 'bluetoothLeScanner', 'connectGatt', 'getProfileProxy']) {
      expect({ call, used: link().includes(call) }).toEqual({ call, used: false });
    }
  });

  it('event-driven on the detector’s thread: the device callback and the Android Auto receiver on its handler, no polling', () => {
    expect(link()).toMatch(/internal class CarLink\(context: Context, private val handler: Handler, private val onChange: \(\) -> Unit\)/);
    expect(fn(link(), '  fun start(', 2)).toMatch(/audio\?\.registerAudioDeviceCallback\(devices, handler\)/);
    // Android Auto (another app) sends its broadcast: exported, as androidx.car.app's CarConnection registers it.
    expect(fn(link(), '  fun start(', 2)).toMatch(/ContextCompat\.registerReceiver\(app, androidAuto, IntentFilter\(CAR_CONNECTION_UPDATED\), null, handler, ContextCompat\.RECEIVER_EXPORTED\)/);
    expect(link()).toMatch(/const val CAR_CONNECTION_UPDATED = "androidx\.car\.app\.connection\.action\.CAR_CONNECTION_UPDATED"/);
    expect(link()).toMatch(/authority\("androidx\.car\.app\.connection"\)/);
    expect(link()).toMatch(/private const val CONNECTION_TYPE_PROJECTION = 2/);
    for (const timer of ['postDelayed', 'Timer(', 'scheduleAtFixedRate', 'Thread.sleep']) expect({ timer, used: link().includes(timer) }).toEqual({ timer, used: false });
    // Made once per process by the detector, and started on its thread.
    const d = det('DriveDetector');
    expect(d).toMatch(/internal val carLink = CarLink\(app, handler\) \{ onCarLink\(\) \}/);
    expect(d.match(/carLink\.start\(\)/g)).toHaveLength(1);
    // Its record in its own preferences file, emptied by the wipe.
    expect(link()).toMatch(/private const val PREFS = "expo\.modules\.drivesense\.carLink"/);
    expect(fn(d, '  fun wipe(', 2)).toMatch(/carLink\.wipe\(\)/);
  });

  it('a hidden address (Android 14+ without Nearby devices) and a full one are one car; JVM-tested', () => {
    expect(fn(link(), '  fun refresh(', 2)).toMatch(/CarLinkRules\.reconcile\(read\(\), rec\)/);
    expect(det('CarLinkRecord')).toMatch(/private val HIDDEN = Regex\("\^XX:XX:XX:XX:\[0-9A-F\]\{2\}:\[0-9A-F\]\{2\}\$"\)/);
    expect(existsSync(join(TEST_DIR, 'detect', 'CarLinkRecordTest.kt'))).toBe(true);
    const t = read(join(TEST_DIR, 'detect', 'CarLinkRecordTest.kt'));
    for (const name of ['tally_mostOfTwoMinutesOrMore', 'pairing_connectedOrSeen_threeCarsEachOnce_leavesNotMine', 'notMine_newestTwentyEachOnce', 'hiddenAddresses_oneUidPerCar', 'state_hasTheContractsKeysAndIntegerTimes', 'wakeGate_aPairedCarConnectingSkipsTheRestButMeetsTheCap']) {
      expect({ name, tested: t.includes(`fun ${name}(`) }).toEqual({ name, tested: true });
    }
  });
});

describe('native-android: the detector uses the car link as iOS does', () => {
  const drive = () => det('DriveDetectorDrive');
  const watch = () => det('DriveDetectorWatch');

  it('the car link start beside the speed hold and slow traffic, its on-foot mark from the live reports', () => {
    const row = fn(watch(), 'internal fun DriveDetector.candidateRow(');
    expect(row).toMatch(/DetectPolicy\.linkStep\(linkState, d, linked = carLink\.linked, carPlay = DetectPolicy\.carPlayOn\(CarLinkRules\.ports\(carLink\.current\)\), carFresh = carFresh\(\)\)/);
    expect(row).toMatch(/if \(slow\.confirmed\) \{\s*confirm\(slowState\.runStartTs\)\s*\} else if \(link\.confirmed\) \{\s*confirm\(linkState\.runStartTs\)/);
    expect(fn(det('DriveDetectorSensing'), 'fun DriveDetector.onActivity(')).toMatch(/linkState = DetectPolicy\.linkReport\(linkState, report\)/);
    expect(fn(watch(), 'internal fun DriveDetector.clearWatch(')).toMatch(/linkState = LinkState\(\)/);
  });

  it('the tally: begun with each drive and each resume, counted on live rows only, kept at the end (none on "Not driving?")', () => {
    expect(fn(drive(), 'internal fun DriveDetector.beginDrive(')).toMatch(/carLink\.beginDrive\(\)/);
    expect(fn(drive(), 'private fun DriveDetector.onResumeSensing(')).toMatch(/carLink\.beginDrive\(\)/);
    expect(fn(drive(), 'internal fun DriveDetector.record(')).toMatch(/if \(evaluate\) carLink\.countRow\(\)/);
    const commit = fn(drive(), 'internal fun DriveDetector.commitEnd(');
    expect(commit).toMatch(/carLink\.endDrive\(driveId, endedAt, drove = endClock\.lastDroveTs != null\)/);
    expect(commit.indexOf('carLink.endDrive(')).toBeLessThan(commit.indexOf('finishSensing('));
    expect(fn(drive(), 'fun DriveDetector.notDriving(')).toMatch(/carLink\.endDrive\(driveId, now, drove = false\)/);
  });

  it('the car-link end: the safety stop and the linger read the link’s "gone since"', () => {
    expect(fn(drive(), 'internal fun DriveDetector.evaluateEnd(')).toMatch(/DetectPolicy\.endDue\(endClock, startedAt, now, walkSince, r\.waitUntil, carLink\.goneSince\)/);
    expect(fn(drive(), 'internal fun DriveDetector.automaticEndDue(')).toMatch(/DetectPolicy\.lingerAfterJsEnd\(endClock, startedAt, DriveDetector\.now\(\), walkSince, r\.waitUntil, carLink\.goneSince\)/);
  });

  it('JS hears every change live (never buffered)', () => {
    expect(fn(det('DriveDetectorSensing'), 'internal fun DriveDetector.onCarLink(')).toMatch(/DetectEventBus\.emitLive\("carLink", carLink\.json\(\)\)/);
  });
});

describe("native-android: a paired car's Bluetooth connecting is a wake (ruling 2)", () => {
  it('the receiver: ACL_CONNECTED only, its device’s address handed to the detector under goAsync', () => {
    const r = kt('CarConnectReceiver');
    expect(r).toMatch(/if \(intent\.action != BluetoothDevice\.ACTION_ACL_CONNECTED\) return/);
    expect(r).toMatch(/IntentCompat\.getParcelableExtra\(intent, BluetoothDevice\.EXTRA_DEVICE, BluetoothDevice::class\.java\)\?\.address/);
    expect(r).toMatch(/val pending = goAsync\(\)\s*try \{\s*DriveDetector\.get\(context\)\.onCarConnected\(address\) \{ pending\.finish\(\) \}/);
  });

  it('a paired car only, then the wake gate (no rest, the hourly cap) and no motion gate, as the geofence', () => {
    const w = det('DriveDetectorWatch');
    expect(fn(w, 'fun DriveDetector.onCarConnected(')).toMatch(/handler\.post \{\s*if \(carLink\.isPaired\(address\)\) onWake\(WakeReason\.CAR, done\) else done\(\)/);
    const wake = /internal fun DriveDetector\.onWake\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(wake).toMatch(/if \(reason == WakeReason\.CAR\) \{\s*beginCandidate\("wake:car", done = done\)\s*return\s*\}/);
    expect(wake.indexOf('beginCandidate("wake:car"')).toBeGreaterThan(wake.indexOf('DetectPolicy.wakeGate(ctx)'));
    expect(wake.indexOf('beginCandidate("wake:car"')).toBeLessThan(wake.indexOf('DetectPolicy.motionGate(m, now)'));
    expect(det('DetectTypes')).toMatch(/CAR\("car"\)/);
  });

  it('its receiver runs only while the wakes run with a car paired (DONT_KILL_APP), set again at each pairing', () => {
    const d = det('DriveDetector');
    expect(fn(d, '  internal fun syncCarWake(', 2)).toMatch(/wakes\.setCarWake\(r != null && allowed\(r\) && r\.state != "off" && carLink\.hasCars\(\)\)/);
    expect(fn(d, '  internal fun syncWakes(', 2)).toMatch(/syncCarWake\(\)/);
    for (const tap of ['pairCar', 'forgetCar']) expect(fn(d, `  fun ${tap}(`, 2)).toMatch(/syncCarWake\(\)/);
  });

  it('the manifest: Nearby devices (and Bluetooth below 12) declared, Android Auto’s provider visible, the receiver disabled until then', () => {
    const m = MANIFEST();
    expect(m).toMatch(/<uses-permission android:name="android\.permission\.BLUETOOTH_CONNECT" \/>/);
    expect(m).toMatch(/<uses-permission android:name="android\.permission\.BLUETOOTH" android:maxSdkVersion="30" \/>/);
    expect(m).not.toMatch(/BLUETOOTH_SCAN|BLUETOOTH_ADMIN/);
    expect(m).toMatch(/<queries>[\s\S]*<provider android:authorities="androidx\.car\.app\.connection" \/>[\s\S]*<\/queries>/);
    expect(m).toMatch(/<receiver\s+android:name="\.CarConnectReceiver"\s+android:exported="true"\s+android:enabled="false">/);
    // No car.app library: its contract is read directly (no LiveData, no Guava).
    expect(read(join(ANDROID, 'build.gradle'))).not.toMatch(/androidx\.car\.app/);
  });
});
