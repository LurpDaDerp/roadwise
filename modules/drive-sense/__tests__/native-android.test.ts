/** @jest-environment node */
// The Android half of drive-sense cannot be compiled or run in Jest, so this suite holds the Kotlin
// sources and the module manifest to the binding contract by reading them as text (README §1, §2,
// §6, §7). Each check names the contract rule it guards; a failure here means the Android build
// would ship something the JS side, the watchdog ruling (rev1: C2), the battery rules (design
// §3.5: no GPS while idle) or the Android rulings (.agent/android/decisions.md) do not allow. The
// drive detector's runtime (its wakes, watch, rest and permissions) is held here too; its policy
// port is in native-android-detect.test.ts and its drive runtime in native-android-drive-detect.test.ts.
import * as CONSTANTS from '../src/extract/constants';
import { NAV_APP_PACKAGES } from '../src/navPackages';
import { FIRST_WINDOW_MS, MAX_ROW_GAP_MS, TIMEBASE_MAX_SKEW_MS } from '../src/extract/timebase';
import { EVENT_BUFFER_MAX } from '../src/fake';
import { DRIVE_SENSE_ERROR_CODES, DRIVE_SENSE_EVENTS, DRIVE_SENSE_METHODS, DRIVE_SENSE_SYNC_METHODS } from '../src/types';
import { DRIVE_DETECT_ERROR_CODES } from '../src/detect/types';
import { DANGER_ORDER } from '../../../src/features/weather/danger';
import { ANDROID_GEOCODE_METHODS } from '../src/geocode';
import { ANDROID_SHARE_METHODS } from '../src/share';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The root
// tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the local
// shapes rather than an `import` from 'node:fs'.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { existsSync, readdirSync, readFileSync } = require('node:fs') as {
  existsSync: (file: string) => boolean;
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const ANDROID = join(__dirname, '..', 'android');
const MAIN = join(ANDROID, 'src', 'main');
const KT_DIR = join(MAIN, 'java', 'expo', 'modules', 'drivesense');
const KT_DIR_DETECT = join(KT_DIR, 'detect');

const read = (file: string): string => readFileSync(file, 'utf8');
const kt = (name: string): string => read(join(KT_DIR, `${name}.kt`));
const allKotlin = (): string =>
  readdirSync(KT_DIR)
    .filter((f) => f.endsWith('.kt'))
    .map((f) => read(join(KT_DIR, f)))
    .join('\n');
/** Kotlin source with line comments and block comments removed, so a rule cannot be met by a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MODULE = () => code(kt('DriveSenseModule'));
const MANIFEST = () => read(join(MAIN, 'AndroidManifest.xml'));

describe('native-android: files the contract names exist, and no trip-detection file does', () => {
  const files = [
    'DriveSenseModule',
    'CaptureService',
    'Watchdog',
    'ActivityTransitionReceiver',
    'DriveSenseHeadlessService',
    'LocationSource',
    'SensorSource',
    'GravityFilter',
    'FeatureExtractor',
    'Alignment',
    'PhoneStateReceiver',
    'AppVisibility',
    'DriveSensePackage',
    'NotificationFactory',
    'ExitInfoReader',
    'EventBus',
    'GeofenceReceiver',
    'DetectBootReceiver',
    'WatchNotification',
    'DashpalLinkService',
    'AlertWakeLock',
    'AudioOutput',
    'PedometerSource',
    'HeadingSource',
    'PhoneHeadingModule',
  ];
  it.each(files)('%s.kt', (name) => {
    expect(existsSync(join(KT_DIR, `${name}.kt`))).toBe(true);
  });
  it('the notification icon drawable', () => {
    expect(existsSync(join(MAIN, 'res', 'drawable', 'ic_drive_notification.xml'))).toBe(true);
  });
  // The retired forgot-to-start reminder (ruling 13) and older designs.
  it.each([
    'BootReceiver',
    'ForgotToStartReminder',
    'TransitionStore',
    'ReminderActionReceiver',
    'TripReminder',
    'TripReminderPolicy',
    'TripReminderState',
    'TripReminderNotifier',
    'ReminderBootReceiver',
    'TripReminderSelfTest',
  ])('no %s.kt', (name) => {
    expect(existsSync(join(KT_DIR, `${name}.kt`))).toBe(false);
  });
});

describe('native-android: the bridge surface (README §1)', () => {
  it('declares exactly DRIVE_SENSE_EVENTS, byte-identical and in order', () => {
    const m = /Events\(([^)]*)\)/.exec(MODULE());
    expect(m).not.toBeNull();
    const names = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(names).toEqual([...DRIVE_SENSE_EVENTS]);
    expect(m![0]).toBe(`Events(${DRIVE_SENSE_EVENTS.map((e) => `"${e}"`).join(', ')})`);
  });

  it.each([...DRIVE_SENSE_METHODS])('AsyncFunction("%s") is declared', (name) => {
    expect(MODULE()).toContain(`AsyncFunction("${name}")`);
  });

  it('declares no AsyncFunction outside DRIVE_SENSE_METHODS and the Android-only share and geocoder ones, and none twice', () => {
    const declared = [...MODULE().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_SENSE_METHODS, ...ANDROID_SHARE_METHODS, ...ANDROID_GEOCODE_METHODS].sort());
  });

  it.each([...DRIVE_SENSE_SYNC_METHODS])('Function("%s") is declared (sync, never an AsyncFunction)', (name) => {
    expect(MODULE()).toMatch(new RegExp(`(?<!Async)Function\\("${name}"\\)`));
    expect(MODULE()).not.toContain(`AsyncFunction("${name}")`);
  });

  it('declares no sync Function outside DRIVE_SENSE_SYNC_METHODS, and none twice', () => {
    const declared = [...MODULE().matchAll(/(?<!Async)Function\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_SENSE_SYNC_METHODS].sort());
  });

  it('registers the module under the name the JS wrapper requires', () => {
    expect(MODULE()).toMatch(/Name\("DriveSense"\)/);
  });

  it('observes every event (buffer flush) and the row listener (watchdog liveness)', () => {
    const src = MODULE();
    expect(src).toMatch(/OnStartObserving\(/);
    expect(src).toMatch(/OnStopObserving\(/);
  });

  it('rejects only with the contract error codes (DriveDetect with its own: E_BUSY)', () => {
    for (const m of code(kt('DriveDetectModule')).matchAll(/"(E_[A-Z_]+)"/g)) expect(DRIVE_DETECT_ERROR_CODES as readonly string[]).toContain(m[1]);
    const used = new Set([...code(allKotlin().replace(kt('DriveDetectModule'), '')).matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]!));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(DRIVE_SENSE_ERROR_CODES as readonly string[]).toContain(c);
    // The codes Android can raise (README §2 "Errors"); the excludeFromBackup codes are iOS-only.
    for (const c of ['E_PERMISSION', 'E_FGS_REFUSED', 'E_INVALID_INPUT']) {
      expect(DRIVE_SENSE_ERROR_CODES as readonly string[]).toContain(c);
      expect(used).toContain(c);
    }
  });

  it('isIgnoringBatteryOptimizations reads PowerManager for this package', () => {
    expect(code(allKotlin())).toMatch(/isIgnoringBatteryOptimizations\(\s*[\w.]*packageName\s*\)/);
  });
});

describe('native-android: manifest (While Using for the Start card, "Allow all the time" for automatic drives)', () => {
  it.each([
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    'android.permission.ACTIVITY_RECOGNITION',
    'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
    'android.permission.RECEIVE_BOOT_COMPLETED',
  ])('uses-permission %s', (p) => {
    expect(MANIFEST()).toContain(`<uses-permission android:name="${p}"`);
  });

  it("only the drive detector's boot receiver hears a boot or an update", () => {
    const files = readdirSync(KT_DIR).filter((f) => f.endsWith('.kt'));
    for (const f of files) {
      const hears = /BOOT_COMPLETED|MY_PACKAGE_REPLACED/.test(code(read(join(KT_DIR, f))));
      expect({ f, hears }).toEqual({ f, hears: f === 'DetectBootReceiver.kt' });
    }
  });

  it('CaptureService is a location foreground service, not exported', () => {
    const m = /<service[^>]*android:name="\.CaptureService"[^>]*>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android:foregroundServiceType="location"');
    expect(m![0]).toContain('android:exported="false"');
  });

  it('DriveSenseHeadlessService is declared, not exported', () => {
    const m = /<service[^>]*android:name="\.DriveSenseHeadlessService"[^>]*>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android:exported="false"');
  });

  it("the receivers: the activity feeds, the parked geofence, the detector's boot one and the share sheet's Save image, none exported; the boot one disabled until automatic drives are armed", () => {
    const receivers = [...MANIFEST().matchAll(/<receiver[^>]*android:name="([^"]+)"[^>]*>/g)];
    expect(receivers.map((r) => r[1])).toEqual(['.ActivityTransitionReceiver', '.GeofenceReceiver', '.DetectBootReceiver', '.SaveImageReceiver']);
    for (const r of receivers) expect(r[0]).toContain('android:exported="false"');
    expect(receivers[2]![0]).toContain('android:enabled="false"');
    expect(receivers[0]![0]).not.toContain('android:enabled');
    expect(receivers[1]![0]).not.toContain('android:enabled');
    expect(MANIFEST()).not.toMatch(/ReminderActionReceiver|NOT_DRIVING/);
  });
});

describe('native-android: share images (WP09, ruling 10)', () => {
  const share = () => code(kt('ShareIntent'));
  const saver = () => code(kt('ImageSaver'));

  it('shareImage is an Android-only function that never rejects: the file into the cache off the main thread, the chooser on it', () => {
    const fn = /AsyncFunction\("shareImage"\)[\s\S]*?\n {4}\}\n/.exec(MODULE())?.[0] ?? '';
    expect(fn).toMatch(/ShareIntent\.intoCache\(context\.cacheDir, context\.externalCacheDir, uri\)/);
    expect(fn.indexOf('intoCache')).toBeLessThan(fn.indexOf('Looper.getMainLooper()'));
    expect(fn).toMatch(/Handler\(Looper\.getMainLooper\(\)\)\.post \{[\s\S]*ShareIntent\.shareImage\(activity, file\.absolutePath, text, title\)/);
    expect(fn).toMatch(/catch \(_: Exception\)/);
    expect(fn).not.toMatch(/reject|runOnQueue/);
    expect(DRIVE_SENSE_METHODS as readonly string[]).not.toContain('shareImage');
  });

  it('the image goes as a FileProvider content URI with a read grant, in EXTRA_STREAM and the ClipData, with EXTRA_TEXT beside it', () => {
    const src = share();
    expect(src).toMatch(/FileProvider\.getUriForFile\(/);
    expect(src).toMatch(/Intent\.EXTRA_STREAM/);
    expect(src).toMatch(/Intent\.EXTRA_TEXT/);
    expect(src).toMatch(/ClipData\.newUri\(/);
    expect(src).toMatch(/FLAG_GRANT_READ_URI_PERMISSION/);
    expect(src).toMatch(/Intent\.createChooser\(/);
    expect(src).not.toMatch(/FLAG_GRANT_WRITE_URI_PERMISSION/);
  });

  it('the provider is not exported and serves the cache only', () => {
    const m = /<provider[^>]*android:name="\.ShareFileProvider"[^>]*>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android:exported="false"');
    expect(m![0]).toContain('android:grantUriPermissions="true"');
    expect(m![0]).toContain('android:authorities="${applicationId}.drivesense.share"');
    const paths = read(join(MAIN, 'res', 'xml', 'drivesense_share_paths.xml')).replace(/<!--[\s\S]*?-->/g, '');
    expect([...paths.matchAll(/<([a-z-]+-path)\b/g)].map((x) => x[1])).toEqual(['cache-path']);
  });

  it('only an image inside the cache is ever shared or saved; a view-shot capture in the external cache is moved in first', () => {
    expect(share()).toMatch(/fun shareableImage\(cacheDir: File, uriOrPath: String\): File\?/);
    expect(share()).toMatch(/fun intoCache\(cacheDir: File, externalCacheDir: File\?, uriOrPath: String\): File\?/);
    expect(share()).toMatch(/CAPTURE_PREFIX = "ReactNative-snapshot-image"/);
    expect(share()).toMatch(/canonicalFile/);
    expect(saver()).toMatch(/ShareIntent\.shareableImage\(ctx\.cacheDir, path\)/);
  });

  it('Save image: a chooser action on 14+ (explicit, immutable broadcast), an initial intent on 10 to 13, nothing below 10', () => {
    const src = share();
    expect(src).toMatch(/SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE\)\s*\{\s*chooser\.putExtra\(Intent\.EXTRA_CHOOSER_CUSTOM_ACTIONS/);
    expect(src).toMatch(/else if \(saveOffered\)\s*\{\s*chooser\.putExtra\(Intent\.EXTRA_INITIAL_INTENTS/);
    expect(src).toMatch(/saveOffered: Boolean\s*get\(\) = Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q/);
    expect(src).toMatch(/Intent\(ctx, SaveImageReceiver::class\.java\)\s*\.setPackage\(ctx\.packageName\)/);
    expect(src).toMatch(/PendingIntent\.getBroadcast\([^)]*PendingIntent\.FLAG_IMMUTABLE/);
    expect(src).not.toMatch(/FLAG_MUTABLE/);
  });

  it('the save is MediaStore into Pictures/RoadWise, pending until written, with no storage permission', () => {
    const src = saver();
    expect(src).toMatch(/MediaStore\.Images\.Media\.RELATIVE_PATH/);
    expect(src).toMatch(/IS_PENDING, 1/);
    expect(src).toMatch(/IS_PENDING, 0/);
    expect(src).toMatch(/SDK_INT < Build\.VERSION_CODES\.Q/);
    expect(src).toMatch(/goAsync\(\)/);
    expect(MANIFEST()).not.toMatch(/WRITE_EXTERNAL_STORAGE|READ_MEDIA_IMAGES|READ_EXTERNAL_STORAGE/);
  });

  it('the save activity is unexported and translucent', () => {
    const m = /<activity[^>]*android:name="\.SaveImageActivity"[^>]*>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android:exported="false"');
    expect(m![0]).toContain('Theme.Translucent');
    expect(existsSync(join(MAIN, 'res', 'drawable', 'drivesense_save_image.xml'))).toBe(true);
  });
});

describe('native-android: the background-safe geocoder (WP10)', () => {
  const geo = () => code(kt('Geocode'));

  it.each([...ANDROID_GEOCODE_METHODS])('%s is an Android-only function that never rejects', (name) => {
    const start = MODULE().indexOf(`AsyncFunction("${name}")`);
    expect(start).toBeGreaterThan(-1);
    const fn = MODULE().slice(start, MODULE().indexOf('\n    }', start));
    expect(fn).toMatch(/promise\.resolve\(/);
    expect(fn).not.toMatch(/reject/);
    expect(DRIVE_SENSE_METHODS as readonly string[]).not.toContain(name);
  });

  it('uses android.location.Geocoder: the listener form on 33+, a small pool below (start and end side by side, stale jobs skipped), no activity', () => {
    const src = geo();
    expect(src).toMatch(/import android\.location\.Geocoder/);
    expect(src).toMatch(/SDK_INT >= Build\.VERSION_CODES\.TIRAMISU/);
    expect(src).toMatch(/Geocoder\.GeocodeListener/);
    expect(src).toMatch(/const val WORKERS = 2/);
    expect(src).toMatch(/ThreadPoolExecutor\(WORKERS, WORKERS, IDLE_S, TimeUnit\.SECONDS, LinkedBlockingQueue\(MAX_WAITING\)\)/);
    expect(src).toMatch(/allowCoreThreadTimeOut\(true\)/);
    expect(src).toMatch(/worker\.execute \{ runQueued\(once, work\) \}/);
    expect(src).toMatch(/fun runQueued\(once: Once, work: [^\n]*\) \{\s*if \(once\.settled\) return/);
    expect(src).not.toMatch(/newSingleThreadExecutor/);
    expect(src).not.toMatch(/currentActivity|\bActivity\b/);
  });

  it('no geocoder on the phone answers null (ruling 17: no label), and every lookup answers once within its timeout', () => {
    const src = geo();
    expect(src).toMatch(/Geocoder\.isPresent\(\)/);
    expect(src).toMatch(/const val TIMEOUT_MS = 5_000L/);
    expect(src).toMatch(/compareAndSet\(false, true\)/);
  });

  it("answers in expo-location's address shape", () => {
    const keys = [...geo().matchAll(/"(\w+)" to (?:clean\(|district\(\))/g)].map((x) => x[1]);
    expect(keys).toEqual(['city', 'district', 'streetNumber', 'street', 'region', 'subregion', 'country', 'postalCode', 'name', 'isoCountryCode']);
  });
});

describe('native-android: who starts the location service', () => {
  it('a wake broadcast never starts the service itself: it hands the batch to the detector under goAsync, and only the detector opens a watch', () => {
    for (const name of ['ActivityTransitionReceiver', 'GeofenceReceiver', 'DetectBootReceiver']) {
      const rx = code(kt(name));
      expect({ name, starts: /startForegroundService|startService\(|startFromJs|CaptureService\.start|ACTION_START|HeadlessJs/.test(rx) }).toEqual({ name, starts: false });
    }
    const rx = code(kt('ActivityTransitionReceiver'));
    expect(rx).toMatch(/val pending = goAsync\(\)\s*try \{\s*DriveDetector\.get\(context\)\.onTransitions\(batch, arrival\.toDouble\(\), subscribedAt\) \{ pending\.finish\(\) \}/);
    expect(code(kt('GeofenceReceiver'))).toMatch(/val pending = goAsync\(\)\s*try \{\s*DriveDetector\.get\(context\)\.onRegionExit \{ pending\.finish\(\) \}/);
    // The watch's service starts in one place: the detector's candidate (never the linger's, which runs on from the drive).
    const starts = readdirSync(KT_DIR_DETECT).filter((f) => f.endsWith('.kt') && code(read(join(KT_DIR_DETECT, f))).includes('CaptureService.startWatch('));
    expect(starts).toEqual(['DriveDetectorWatch.kt']);
    expect(code(allKotlin())).not.toMatch(/CaptureService\.startWatch\(/);
    expect(code(kt('CaptureService'))).toMatch(/fun startWatch\(context: Context, onResult: \(String\?\) -> Unit\)/);
  });

  it('CaptureService starts from JS, from the detector, or as the sticky restart of a capture that was open', () => {
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/ACTION_START_JS/);
    expect(svc).toMatch(/ACTION_DETECT/);
    expect(svc).toMatch(/ACTION_WATCH/);
    expect(svc).toMatch(/START_STICKY/);
    expect(svc).toMatch(/intent\s*==\s*null/);
    expect(svc).toMatch(/if \(!prefs\.captureOpen\) \{\s*stopSelf\(startId\)/);
    expect(svc).toMatch(/nativeStart = true/); // the sticky restart still needs the JS claim (watchdog)
  });

  it('every foreground-service start catches its refusals: SecurityException (14+, no location permission) and the 12+ background refusal', () => {
    const svc = code(kt('CaptureService'));
    for (const fn of ['startWatch', 'startDetector', 'startFromJs']) {
      const body = new RegExp(`fun ${fn}\\([\\s\\S]*?\\n {4}\\}`).exec(svc)?.[0] ?? '';
      expect(body).toMatch(/ContextCompat\.startForegroundService\(context, intent\)\s*\} catch \(_: SecurityException\) \{[\s\S]*?"E_PERMISSION"[\s\S]*?\} catch \(_: Exception\) \{[\s\S]*?"E_FGS_REFUSED"/);
    }
    const fg = /private fun goForeground\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(fg).toMatch(/ServiceInfo\.FOREGROUND_SERVICE_TYPE_LOCATION/);
    expect(fg).toMatch(/catch \(_: SecurityException\) \{[\s\S]*?"E_PERMISSION"[\s\S]*?catch \(_: Exception\) \{\s*"E_FGS_REFUSED"/);
  });

  it('the FGS refusal codes pass through unchanged', () => {
    const start = /AsyncFunction\("startCapture"\)[\s\S]*?\n {4}\}/.exec(MODULE())?.[0] ?? '';
    expect(start).toMatch(/promise\.reject\(coded\(code,/);
    expect(start).not.toMatch(/"always"/);
  });

  it('location is always, whenInUse or none: "Allow all the time" on Android 10+, any grant below 10', () => {
    const src = code(kt('DriveSensePermissions'));
    expect(src).toMatch(/\(Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.Q \|\| granted\(context, Manifest\.permission\.ACCESS_BACKGROUND_LOCATION\)\)/);
    expect(src).toMatch(/hasBackgroundLocation\(context\) -> "always"\s*hasForegroundLocation\(context\) -> "whenInUse"\s*else -> "none"/);
  });
});

describe('native-android: the activity feeds (the transitions while armed, the live reports while sensing)', () => {
  it('every PendingIntent Play services fills is explicit and FLAG_MUTABLE on API 31+', () => {
    const rx = code(kt('ActivityTransitionReceiver'));
    expect(rx.match(/Intent\(context, ActivityTransitionReceiver::class\.java\)\.setAction\(ACTION\)/g)).toHaveLength(2);
    expect(rx.match(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) flags = flags or PendingIntent\.FLAG_MUTABLE/g)).toHaveLength(2);
    const wakes = code(read(join(KT_DIR_DETECT, 'WakeSources.kt')));
    expect(wakes).toMatch(/Intent\(context, GeofenceReceiver::class\.java\)\.setAction\(GeofenceReceiver\.ACTION\)/);
    expect(wakes).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) flags = flags or PendingIntent\.FLAG_MUTABLE/);
    expect(rx).toMatch(/requestActivityTransitionUpdates\(request\(\), pendingIntent\(context\)\)/);
    expect(rx).toMatch(/requestActivityUpdates\(INTERVAL_MS, pendingIntent\(context\)\)/);
  });

  it("the detector's transitions: IN_VEHICLE in and out and the ENTERs of WALKING, RUNNING, ON_BICYCLE and STILL; never ON_FOOT or a STILL EXIT", () => {
    const src = code(kt('ActivityTransitionReceiver'));
    const set = /val DETECT: List<Pair<Int, Int>> = listOf\(([\s\S]*?)\n {2}\)/.exec(src)?.[1] ?? '';
    expect(set.split(',').map((x) => x.trim())).toEqual([
      'DetectedActivity.IN_VEHICLE to ENTER',
      'DetectedActivity.IN_VEHICLE to EXIT',
      'DetectedActivity.WALKING to ENTER',
      'DetectedActivity.RUNNING to ENTER',
      'DetectedActivity.ON_BICYCLE to ENTER',
      'DetectedActivity.STILL to ENTER',
    ]);
    expect(src).not.toMatch(/STILL to EXIT/);
    expect(src).not.toMatch(/ON_FOOT/);
    expect(src).toMatch(/ENTER = ActivityTransition\.ACTIVITY_TRANSITION_ENTER/);
    expect(src).toMatch(/EXIT = ActivityTransition\.ACTIVITY_TRANSITION_EXIT/);
    for (const [a, t] of [
      ['IN_VEHICLE', 'automotive'],
      ['WALKING', 'walking'],
      ['RUNNING', 'running'],
      ['STILL', 'stationary'],
      ['ON_BICYCLE', 'cycling'],
    ]) expect(src).toMatch(new RegExp(`DetectedActivity\\.${a}\\s*->\\s*"${t}"`));
  });

  it('a transition batch never reaches JS; the receiver checks "nothing wants the feed" first, unsubscribes and acts on nothing', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    const on = /private fun onTransitions\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(on).not.toMatch(/EventBus/);
    const stale = on.indexOf('if (!ActivityTransitions.wanted(context)) {');
    expect(stale).toBeGreaterThan(-1);
    expect(on.slice(stale, stale + 120)).toMatch(/ActivityTransitions\.unsubscribe\(context\)\s*return/);
    expect(stale).toBeLessThan(on.indexOf('ActivityTransitionResult.extractResult'));
    expect(stale).toBeLessThan(on.indexOf('goAsync'));
    // Each transition is dated when it happened (its boot-clock time), never after its arrival.
    expect(on).toMatch(/ActivityTransitions\.epochMs\(e\.elapsedRealTimeNanos, anchor, arrival\)/);
    expect(src).toMatch(/return if \(t\.isFinite\(\) && t <= arrival && t > 0\) Math\.round\(t\) else arrival/);
  });

  it('the live reports: every 5 s while a capture senses (started and stopped with its sensors); every one to the detector, to JS only a change and never during a watch', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    expect(src).toMatch(/const val INTERVAL_MS = 5_000L/);
    const res = /fun onResult\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(res).toMatch(/if \(!live \|\| !CaptureService\.isCapturing\) \{\s*stop\(context\)\s*return/);
    const toDetector = res.indexOf('DriveDetector.peek()?.onActivity(');
    const watchGate = res.indexOf('if (CaptureService.watching) return');
    const dedupe = res.indexOf('if (lastEmitted == report) return');
    expect(toDetector).toBeGreaterThan(-1);
    expect(toDetector).toBeLessThan(watchGate);
    expect(watchGate).toBeLessThan(dedupe);
    expect(res.match(/EventBus\.emit\("activity"/g)).toHaveLength(1);
    expect(code(allKotlin()).match(/EventBus\.emit\("activity"/g)).toHaveLength(1);
    const svc = code(kt('CaptureService'));
    expect(/private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '').toMatch(/ActivitySource\.start\(this\)/);
    expect(/private fun stopSources\(\) \{[\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '').toMatch(/ActivitySource\.stop\(this\)/);
    expect(/override fun onDestroy\(\)[\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '').toMatch(/ActivitySource\.stop\(this\)/);
  });

  it("the live mapping's activity numbers are Play services' DetectedActivity constants, with iOS's confidence words", () => {
    const src = code(read(join(KT_DIR_DETECT, 'LiveActivity.kt')));
    for (const [name, n] of [
      ['IN_VEHICLE', 0],
      ['ON_BICYCLE', 1],
      ['ON_FOOT', 2],
      ['STILL', 3],
      ['UNKNOWN', 4],
      ['TILTING', 5],
      ['WALKING', 7],
      ['RUNNING', 8],
    ] as const) expect(src).toMatch(new RegExp(`const val ${name} = ${n}\\b`));
    expect(src).toMatch(/const val MEDIUM_MIN = 50\s*const val HIGH_MIN = 75/);
    expect(src).not.toMatch(/^import /m);
  });

  it('the transitions follow the detector (its wakes run), with motion and Play services; synced best effort; a re-request only for a registration from another boot, one whose PendingIntent a force stop cancelled, or when forced', () => {
    const rx = code(kt('ActivityTransitionReceiver'));
    const sync = /fun sync\(context: Context, want: Boolean[\s\S]*?\n {2}\}/.exec(rx)?.[0] ?? '';
    expect(sync).toMatch(/try \{/);
    expect(sync).toMatch(/catch \(e: Exception\)/);
    expect(sync).not.toMatch(/throw /);
    expect(sync).toMatch(/val ok = want && DriveSensePermissions\.motionGranted\(context\) && DriveSensePermissions\.playServicesAvailable\(context\)\s*prefs\.transitionsWanted = ok/);
    expect(rx).toMatch(/Settings\.Global\.getInt\(context\.contentResolver, Settings\.Global\.BOOT_COUNT, -1\)/);
    expect(sync).toContain('val thisBoot = prefs.transitionsAtNanos in 1L..nowNanos && (boot < 0 || prefs.transitionsBoot == boot)');
    const skip = sync.indexOf('prefs.transitionsTier == SET && thisBoot && registered(context)');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(sync.indexOf('prefs.transitionsAtNanos = nowNanos'));
    expect(sync.indexOf('prefs.transitionsAtNanos = nowNanos')).toBeLessThan(sync.indexOf('subscribe(context) { e ->'));
    expect(sync).toMatch(/if \(force\) prefs\.transitionsTier = null/);
    // The request on file counts only while the system still holds its PendingIntent (never made by the check).
    // Same intent, request code and mutability as the subscription's (one builder).
    expect(rx).toMatch(/fun registered\(context: Context\): Boolean = try \{\s*broadcast\(context, PendingIntent\.FLAG_NO_CREATE\) != null/);
    expect(rx).toMatch(/fun pendingIntent\(context: Context\): PendingIntent = broadcast\(context, PendingIntent\.FLAG_UPDATE_CURRENT\)!!/);
    expect(rx).toMatch(/private fun broadcast\(context: Context, base: Int\): PendingIntent\? \{\s*val intent = Intent\(context, ActivityTransitionReceiver::class\.java\)\.setAction\(ACTION\)\s*var flags = base/);
    // Only the detector's wakes call it.
    expect(code(allKotlin())).not.toMatch(/ActivityTransitions\.sync\(/);
    expect(code(read(join(KT_DIR_DETECT, 'WakeSources.kt')))).toMatch(/ActivityTransitions\.sync\(app, run, force, onDone\)/);
  });

  it('requestMotionPermission requests ACTIVITY_RECOGNITION at run time on API 29+, and the detector follows a grant', () => {
    const src = MODULE();
    expect(src).toMatch(/askForPermissions\([\s\S]{0,200}Manifest\.permission\.ACTIVITY_RECOGNITION/);
    expect(src).toMatch(/Build\.VERSION_CODES\.Q/);
    expect(src).toMatch(/if \(status == PermissionsStatus\.GRANTED\) DriveDetector\.get\(ctx\)\.permissionsChanged\(\)/);
  });

  it('the headless task is DriveSenseTask with a bounded timeout and allowed in the foreground (N2N3 I4)', () => {
    const src = code(kt('DriveSenseHeadlessService'));
    expect(src).toMatch(/"DriveSenseTask"/);
    expect(src).toMatch(/timeout\s*=\s*TASK_TIMEOUT_MS/);
    expect(src).toMatch(/TASK_TIMEOUT_MS\s*=\s*6L \* 60 \* 60 \* 1000/);
    expect(src).toMatch(/isAllowedInForeground\s*=\s*true/);
    expect(src).toMatch(/HeadlessJsTaskConfig\(/);
  });
});

describe('native-android: automatic drives (WP03b, rulings 1-4)', () => {
  const det = (name: string) => code(read(join(KT_DIR_DETECT, `${name}.kt`)));

  it('no GPS while idle: location is asked for only by the capture service (a watch, a drive), never a passive or background request; a rest end reads the cached fix only', () => {
    const all = code(allKotlin()) + readdirSync(KT_DIR_DETECT).filter((f) => f.endsWith('.kt')).map((f) => det(f.replace(/\.kt$/, ''))).join('\n');
    expect(all).not.toMatch(/PRIORITY_PASSIVE|PRIORITY_LOW_POWER|requestLocationUpdates\([^)]*PendingIntent|getCurrentLocation|WorkManager|AlarmManager/);
    const users = [...readdirSync(KT_DIR), ...readdirSync(KT_DIR_DETECT)].filter((f) => f.endsWith('.kt')).filter((f) => {
      const p = existsSync(join(KT_DIR, f)) ? join(KT_DIR, f) : join(KT_DIR_DETECT, f);
      return /\brequestLocationUpdates\(/.test(code(read(p)));
    });
    expect(users).toEqual(['LocationSource.kt']);
    expect(det('WakeSources')).toMatch(/getFusedLocationProviderClient\(app\)\.lastLocation/);
    expect(det('WakeSources')).toMatch(/LAST_KNOWN_MAX_AGE_MS = 120_000L/);
    // The rest senses nothing itself.
    expect(det('DriveDetectorSensing')).not.toMatch(/CaptureService\.|LocationSource|startWatch/);
  });

  it('the parked geofence: "roadwise.parked", 100 m, exit only, never expiring, no initial trigger, replaced (never accumulated); dropped, refused or cancelled, it is set again at the next launch or foreground', () => {
    const w = det('WakeSources');
    expect(w).toMatch(/const val GEOFENCE_ID = "roadwise\.parked"/);
    expect(w).toMatch(/\.setCircularRegion\(p\.lat, p\.lng, DetectPolicy\.PARKED_REGION_RADIUS_M\.toFloat\(\)\)/);
    expect(w).toMatch(/\.setExpirationDuration\(Geofence\.NEVER_EXPIRE\)/);
    expect(w).toMatch(/\.setTransitionTypes\(Geofence\.GEOFENCE_TRANSITION_EXIT\)/);
    expect(w).toMatch(/GeofencingRequest\.Builder\(\)\.setInitialTrigger\(0\)\.addGeofence\(fence\)/);
    expect(w).toMatch(/removeGeofences\(listOf\(GEOFENCE_ID\)\)/);
    const g = code(kt('GeofenceReceiver'));
    expect(g).toMatch(/if \(event\.errorCode == GeofenceStatusCodes\.GEOFENCE_NOT_AVAILABLE\) DriveDetector\.get\(context\)\.onGeofenceLost\(\)/);
    expect(g).toMatch(/if \(event\.geofenceTransition != Geofence\.GEOFENCE_TRANSITION_EXIT\) return/);
    expect(g).toMatch(/it\.requestId == WakeSources\.GEOFENCE_ID/);
    // Refused, dropped (location off) or its PendingIntent cancelled (a force stop): owed, kept on disk.
    expect(w).toMatch(/\.addOnSuccessListener \{ onParked\(true\) \}/);
    expect(w).toMatch(/\.addOnFailureListener \{ e ->[\s\S]{0,120}onParked\(false\)/);
    expect(w).toMatch(/fun geofenceIntentAlive\(context: Context\): Boolean = try \{\s*broadcast\(context, PendingIntent\.FLAG_NO_CREATE\) != null/);
    expect(w).toMatch(/fun geofenceIntent\(context: Context\): PendingIntent = broadcast\(context, PendingIntent\.FLAG_UPDATE_CURRENT\)!!/);
    const d = det('DriveDetector');
    expect(d).toMatch(/WakeSources\(app\) \{ onFile -> handler\.post \{ fenceOwed\(!onFile\) \} \}/);
    expect(d).toMatch(/fun onGeofenceLost\(\) \{\s*handler\.post \{ fenceOwed\(true\) \}/);
    expect(d).toMatch(/store\.edit\(\)\.putBoolean\(FENCE_OWED_KEY, owed\)\.commit\(\)/);
    expect(d).not.toMatch(/geofenceLost/);
    expect(d).toMatch(/WakeFile\.parkedOwed\(r\.state == "off", r\.parked != null, store\.getBoolean\(FENCE_OWED_KEY, false\)\) \{ wakes\.parkedOnFile\(\) \}/);
    const fg = /fun appForeground\(\) \{[\s\S]*?\n {2}\}/.exec(d)?.[0] ?? '';
    expect(fg).toMatch(/refreshParked\(\)\s*onWake\(WakeReason\.APP\)/);
    const launch = /fun resumeAtLaunch\(\) \{[\s\S]*?\n {2}\}/.exec(d)?.[0] ?? '';
    expect(launch.match(/refreshParked\(\)/g)?.length).toBe(2);
  });

  it('the boot receiver only re-arms (under goAsync), switched on and off by the wakes alone, always with DONT_KILL_APP', () => {
    const b = code(kt('DetectBootReceiver'));
    expect(b).toMatch(/if \(action != Intent\.ACTION_BOOT_COMPLETED && action != Intent\.ACTION_MY_PACKAGE_REPLACED\) return/);
    expect(b).toMatch(/val pending = goAsync\(\)\s*try \{\s*DriveDetector\.get\(context\)\.rearm \{ pending\.finish\(\) \}/);
    const all = [...readdirSync(KT_DIR).map((f) => join(KT_DIR, f)), ...readdirSync(KT_DIR_DETECT).map((f) => join(KT_DIR_DETECT, f))].filter((f) => f.endsWith('.kt'));
    const switchers = all.filter((f) => /setComponentEnabledSetting\(/.test(code(read(f))));
    expect(switchers.map((f) => f.replace(/^.*[\\/]/, ''))).toEqual(['WakeSources.kt']);
    expect(det('WakeSources')).toMatch(/setComponentEnabledSetting\(component, want, PackageManager\.DONT_KILL_APP\)/);
    expect(det('WakeSources')).toMatch(/ComponentName\(app, DetectBootReceiver::class\.java\)/);
  });

  it('a wake: the rest and the permissions first, then the policy\'s wake gate, then (but for the geofence) its motion gate over the motion history', () => {
    const w = det('DriveDetectorWatch');
    const wake = /internal fun DriveDetector\.onWake\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(wake.indexOf('lingerToWatch()')).toBeLessThan(wake.indexOf('checkRest()'));
    expect(wake.indexOf('checkRest()')).toBeLessThan(wake.indexOf('sync("permissionLost")'));
    expect(wake.indexOf('sync("permissionLost")')).toBeLessThan(wake.indexOf('DetectPolicy.wakeGate(ctx)'));
    expect(wake).toMatch(/if \(DetectPolicy\.wakeGate\(ctx\) != WakeGate\.OK \|\| starting \|\| resuming \|\| CaptureService\.isCapturing\)/);
    expect(wake.indexOf('if (reason == WakeReason.REGION) {\n    beginCandidate("wake:region"')).toBeGreaterThan(-1);
    expect(wake.indexOf('beginCandidate("wake:region"')).toBeLessThan(wake.indexOf('DetectPolicy.motionGate(m, now)'));
    expect(wake).toMatch(/val m = motionSince\(now - DetectPolicy\.MOTION_LOOKBACK_MS, now\)/);
    // An IN_VEHICLE ENTER is the wake (a replay from well before the request is not), RoadWise in front the `app` one.
    const tr = /fun DriveDetector\.onTransitions\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(tr).toMatch(/if \(carNow && vehicle!!\.at >= subscribedAt - DetectPolicy\.SLC_STALE_MS\) onWake\(WakeReason\.SLC, done\) else done\(\)/);
    expect(code(read(join(KT_DIR_DETECT, 'DriveDetector.kt')))).toMatch(/onWake\(WakeReason\.APP\)/);
  });

  it('the watch: its candidate opens the watch service (the linger runs on from the drive), counts toward the hourly cap but for the linger, ends on the policy\'s deadline, and an empty timeout parks where it ran out', () => {
    const w = det('DriveDetectorWatch');
    const begin = /internal fun DriveDetector\.beginCandidate\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(begin).toMatch(/candidateStarts = if \(linger\) r\.candidateStarts else DetectPolicy\.recentStarts\(r\.candidateStarts, now\) \+ now/);
    expect(begin.indexOf('if (linger) {')).toBeLessThan(begin.indexOf('CaptureService.startWatch(app)'));
    const tick = /internal fun DriveDetector\.candidateTick\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(tick).toMatch(/DetectPolicy\.candidateDue\(/);
    expect(tick).toMatch(/endCandidate\(due\.wire, rest = !lingering && \(due == CandidateCause\.CAP \|\| \(due == CandidateCause\.TIMEOUT && lastVehicleTs == null\)\)\)/);
    const end = /internal fun DriveDetector\.endCandidate\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(end).toMatch(/val parkHere = r\.origin == "auto" && !lingering && reason == "timeout" && !sawVehicle/);
    expect(end).toMatch(/DetectPolicy\.startsAfter\(r\.candidateStarts, r\.since, sawVehicle\)/);
    // The confirmation: the speed hold and slow traffic (the car link comes with WP06), then the trace-back with the motion history.
    const row = /internal fun DriveDetector\.candidateRow\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(row).toMatch(/DetectPolicy\.confirmStep\(confirmState, d, TriggerKind\.AUTO, veto = veto, carFresh = carFresh\(\)\)/);
    expect(row).toMatch(/DetectPolicy\.slowTrafficStep\(slowState, d\)/);
    const confirm = /internal fun DriveDetector\.confirm\([\s\S]*?\n\}/.exec(w)?.[0] ?? '';
    expect(confirm).toMatch(/motionSince\(maxOf\(lastEnd\?\.decidedAt \?: 0\.0, now - DetectPolicy\.MOTION_LOOKBACK_MS\), now\)\.automotiveSince/);
    expect(confirm).toMatch(/DetectPolicy\.startOf\(rows, h, TriggerKind\.AUTO, automotiveSince, lastEnd\)/);
  });

  it('the linger: an automatic end of a drive no longer waiting turns its service into a watch in place; JS\'s automatic end counts too', () => {
    const d = det('DriveDetectorDrive');
    const commit = /internal fun DriveDetector\.commitEnd\([\s\S]*?\n\}/.exec(d)?.[0] ?? '';
    expect(commit).toMatch(/val lingerAfter = linger && r\.waitUntil == null && sensing && CaptureService\.detectorRunning\(\)/);
    expect(commit).toMatch(/finishSensing\(holdMs = DetectPolicy\.END_TASK_MAX_MS\.toLong\(\), demote = lingers\)/);
    expect(commit).toMatch(/if \(settled\.state == "armed" && spot != null\) park\(spot\)/);
    expect(commit).toMatch(/if \(lingers\) beginCandidate\("linger"\)/);
    expect(d).toMatch(/commitEnd\(due\.wire, now, linger = due == SafetyCause\.STILL \|\| due == SafetyCause\.WALKING\)/);
    expect(code(read(join(KT_DIR_DETECT, 'DriveDetector.kt')))).toMatch(/linger = end\?\.automatic == true \|\| automaticEndDue\(\)/);
  });

  it('the watch service: no step count, no capture-open flag, no rows, speed or activity to JS, "Checking for a drive"; confirmed in place, demoted in place', () => {
    const svc = code(kt('CaptureService'));
    const begin = /private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(begin).toMatch(/if \(!watch\) \{\s*prefs\.mode = mode[\s\S]*?prefs\.captureOpen = true\s*\}/);
    expect(begin).toMatch(/pedometer = if \(watch\) null else PedometerSource/);
    expect(svc).toMatch(/if \(!watching\) emitSpeed\(fix\)/);
    expect(svc).toMatch(/if \(detector != null\) detector\.onRow\(row, body, watching\) else if \(!watching\) EventBus\.emit\("row", body\)/);
    expect(svc).toMatch(/val notification = if \(watch\) WatchNotification\.build\(this\) else DriveNotificationController\.foreground\(this, display, restart\)/);
    const promote = /private fun promote\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(promote).toMatch(/prefs\.detectorOwned = true\s*prefs\.captureOpen = true/);
    expect(promote).toMatch(/postNotification\(DriveNotificationController\.startDrive\(this\)\)\s*if \(!AppVisibility\.visible\(\)\) startHeadless\(\)/);
    const demote = /private fun demote\(\)[\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(demote).toMatch(/prefs\.detectorOwned = false\s*prefs\.captureOpen = false/);
    expect(demote).toMatch(/DriveNotificationController\.endDrive\(this\)\s*postNotification\(WatchNotification\.build\(this\)\)/);
    expect(svc).toMatch(/nm\?\.notify\(NotificationFactory\.NOTIFICATION_ID, n\)/);
    // JS's own calls never touch a watch.
    expect(svc).toMatch(/if \(watching\) \{\s*onResult\(null\)\s*return\s*\}/);
    expect(svc).toMatch(/if \(\(!isCapturing && inst\.holding\) \|\| watching\) \{/);
    // DriveSense `capturing` is a drive, never a watch (as iOS reports it).
    expect(MODULE()).toMatch(/val capturing = CaptureService\.recording\(\)/);
    expect(code(kt('DriveNotificationController'))).toMatch(/if \(!CaptureService\.recording\(\) \|\| ended \|\| dismissed\) return/);
  });

  it('the watch notification: "Checking for a drive" on its own silent channel (created at minimum importance; Android shows a service notification at low), hidden on the lock screen; the retired reminder channel is deleted', () => {
    const n = code(kt('WatchNotification'));
    expect(n).toMatch(/const val CHANNEL_ID = "drive_check"/);
    expect(n).toMatch(/const val TITLE = "Checking for a drive"/);
    expect(n).toMatch(/NotificationChannel\(CHANNEL_ID, TITLE, NotificationManager\.IMPORTANCE_MIN\)/);
    expect(n).toMatch(/setSound\(null, null\)\s*enableVibration\(false\)\s*enableLights\(false\)\s*setShowBadge\(false\)\s*lockscreenVisibility = Notification\.VISIBILITY_SECRET/);
    expect(n).toMatch(/\.setSilent\(true\)/);
    expect(n).toMatch(/\.setPriority\(NotificationCompat\.PRIORITY_MIN\)/);
    expect(n).toMatch(/PendingIntent\.FLAG_UPDATE_CURRENT or PendingIntent\.FLAG_IMMUTABLE/);
    expect(n).toMatch(/private const val RETIRED_CHANNEL_ID = "trip_reminder"/);
    expect(n).toMatch(/nm\.deleteNotificationChannel\(RETIRED_CHANNEL_ID\)/);
  });

  it('the rest after "Not driving?" needs no GPS: its evidence is the transitions, kept in the record, checked at every wake, foreground and state read', () => {
    const s = det('DriveDetectorSensing');
    expect(s).toMatch(/val step = DetectPolicy\.restOnBatch\(since, until, r\.rest, batch, arrival\)\s*if \(step\.due != null\) \{\s*endSuppression\(\)/);
    expect(s).toMatch(/save\(r\.copy\(rest = step\.standing\)\)\s*checkRest\(\)/);
    expect(s).toMatch(/DetectPolicy\.restDue\(since, until, r\.rest, DriveDetector\.now\(\)\)/);
    expect(s).toMatch(/wakes\.lastKnown \{ spot -> if \(spot != null\) handler\.post \{ park\(spot\) \} \}/);
    // Seeded from the motion history's newest transition (in the vehicle holds; anything newer runs the 5 min from the tap); the live feed's last 2 min only with no history.
    expect(det('DriveDetectorDrive')).toMatch(/rest = DetectPolicy\.restSeed\(carFresh\(\), history\)/);
    expect(det('DriveDetectorWatch')).toMatch(/if \(r\.state == "suppressed"\) restOnTransitions\(batch, arrival\)/);
  });

  it('"Allow all the time": While Using first when missing, then the background request (the settings page on 11+); the answer is the grant then', () => {
    const m = code(kt('DriveDetectModule'));
    const ask = /AsyncFunction\("requestAlways"\)[\s\S]*?\n {4}\}/.exec(m)?.[0] ?? '';
    expect(ask).toMatch(/askForPermissions\(PermissionsResponseListener \{ answer\(\) \}, Manifest\.permission\.ACCESS_BACKGROUND_LOCATION\)/);
    expect(ask).toMatch(/PermissionsResponseListener \{ askBackground\(\) \},\s*Manifest\.permission\.ACCESS_FINE_LOCATION,\s*Manifest\.permission\.ACCESS_COARSE_LOCATION/);
    expect(ask).toMatch(/promise\.resolve\(detector\.access\.alwaysAnswer\(\)\)/);
    expect(ask).not.toMatch(/promise\.reject/);
    // Background location is asked for nowhere else.
    const others = code(allKotlin().replace(kt('DriveDetectModule'), '').replace(kt('DriveSensePermissions'), ''));
    expect(others).not.toMatch(/ACCESS_BACKGROUND_LOCATION/);
    // The automatic wakes exist with Play services; Precise is FINE.
    const a = det('DriveDetectAccess');
    expect(a).toMatch(/hardware = DriveSensePermissions\.playServicesAvailable\(app\)/);
    expect(a).toMatch(/canAskAlways = location == LocationAccess\.WHEN_IN_USE && Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q/);
    expect(a).toMatch(/backgroundRefresh = if \(backgroundRestricted\(\)\) BackgroundRefresh\.DENIED else BackgroundRefresh\.AVAILABLE/);
  });

  it('its pure half has JVM tests', () => {
    expect(existsSync(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'detect', 'AutoDetectTest.kt'))).toBe(true);
    for (const f of ['ActivityHistory', 'LiveActivity', 'RestFeed', 'RowBuffer']) {
      expect({ f, imports: /^import android|^import com\.google/m.test(read(join(KT_DIR_DETECT, `${f}.kt`))) }).toEqual({ f, imports: false });
    }
  });
});

describe('native-android: the retired forgot-to-start reminder', () => {
  it('none of it remains in the Kotlin or the manifest', () => {
    expect(allKotlin()).not.toMatch(/TripReminder(Policy|Notifier|State|SelfTest)?\.|class TripReminder|ReminderBootReceiver|EventBus\.emit\("reminderTap"|"trip_reminder" ->/);
    expect(MANIFEST()).not.toMatch(/Reminder/);
  });

  it('its shared methods answer fixed values, as on iOS', () => {
    const m = MODULE();
    expect(m).toMatch(/AsyncFunction\("setTripReminder"\) \{ _: Boolean ->\s*reminderOff\(\)\s*\}/);
    expect(m).toMatch(/AsyncFunction\("getTripReminderStatus"\) \{\s*reminderOff\(\)\s*\}/);
    expect(m).toMatch(/linkedMapOf\("enabled" to false, "state" to "off", "missing" to emptyList<String>\(\)\)/);
    expect(m).toMatch(/AsyncFunction\("requestReminderLocation"\) \{\s*val location = DriveSensePermissions\.location\(context\)\s*if \(location == "none"\) "denied" else location\s*\}/);
    expect(m).toMatch(/AsyncFunction\("takeReminderTap"\) \{ promise: Promise ->\s*promise\.resolve\(null\)\s*\}/);
    expect(m).toMatch(/AsyncFunction\("claimReminderTap"\) \{ _: String ->\s*false\s*\}/);
    expect(code(kt('SelfTest'))).not.toMatch(/"reminder"/);
  });
});

describe("native-android: the drive notification, Android's Live Activity (plan §6, ruling 6)", () => {
  const FACTORY = () => code(kt('NotificationFactory'));
  const CONTROLLER = () => code(kt('DriveNotificationController'));
  const TEXT = () => code(kt('DriveNotificationText'));

  it('its files exist', () => {
    for (const name of ['NotificationFactory', 'DriveNotificationController', 'DriveNotificationText', 'DriveNotificationRules', 'LimitSignBitmap', 'LimitSignGeometry', 'WeatherSymbol']) {
      expect({ name, exists: existsSync(join(KT_DIR, `${name}.kt`)) }).toEqual({ name, exists: true });
    }
  });

  it("shows the Live Activity's content: the tinted speed and its unit, the limit, the weather line, \"Not driving?\"", () => {
    const text = TEXT();
    expect(text).toMatch(/fun title\(d: DriveDisplay\): String = "\$\{number\(d\.speed\)\} \$\{d\.unit\}"/);
    expect(text).toMatch(/fun limitLine\(d: DriveDisplay\): String = "Limit \$\{number\(d\.limit\)\}"/);
    expect(text).toMatch(/const val NOT_DRIVING = "Not driving\?"/);
    expect(text).toMatch(/if \(v == null \|\| !v\.isFinite\(\)\) return "-"/);
    expect(text).toMatch(/"\$\{WeatherSymbol\.of\(kind\)\} \$text"/);
    // VoiceOver's words, the ticker
    expect(text).toContain('"Speed unknown"');
    expect(text).toContain('"kilometers per hour" else "miles per hour"');
    expect(text).toContain('", over the limit"');
    expect(text).toContain('"Speed limit unknown"');
    const f = FACTORY();
    expect(f).toMatch(/setContentTitle\(title\(d\)\)/);
    expect(f).toMatch(/ForegroundColorSpan\(tint\)/);
    expect(f).toMatch(/setContentText\(DriveNotificationText\.text\(d\)\)/);
    expect(f).toMatch(/setTicker\(DriveNotificationText\.accessibility\(d\)\)/);
    expect(f).toMatch(/NotificationCompat\.BigTextStyle\(\)\.bigText\(it\)/);
    expect(f).toMatch(/LimitSignBitmap\.of\(context, DriveNotificationText\.number\(d\.limit\), d\.unit\)\?\.let \{ builder\.setLargeIcon\(it\) \}/);
    // nothing about points, scores or spots
    expect(f + text).not.toMatch(/points|pts|setSubText|score/i);
  });

  it('every danger kind has its weather symbol (DANGER_ORDER), an unknown one the warning sign', () => {
    const src = code(kt('WeatherSymbol'));
    const cases = [...src.matchAll(/"([a-z_]+)" -> [A-Z_]+/g)].map((m) => m[1]!);
    expect([...cases].sort()).toEqual([...DANGER_ORDER].sort());
    expect(src).toMatch(/else -> WARNING/);
  });

  it('the parsed display takes the Live Activity keys, validated as liveDriveStateSchema validates them; no points', () => {
    const types = code(kt('Types'));
    for (const k of ['speedTint', 'skyTop', 'skyMid', 'skyLow', 'accent']) expect(types).toContain(`${k} = hex(m["${k}"])`);
    expect(types).toContain('notDrivingAvailable = m["notDrivingAvailable"] as? Boolean ?: false');
    expect(types).toContain('speeding = m["speeding"] as? Boolean ?: false');
    expect(types).toContain('Regex("^#[0-9A-Fa-f]{6}$")');
    expect(types).toContain('Regex("^[a-z][a-z_]{0,31}$")');
    expect(types).toMatch(/WEATHER_TEXT_MAX = 60/);
    expect(types).not.toMatch(/points|pointsDelta|stopped/);
    // the stale form keeps the limit, the unit and the sky
    const stale = /fun stale\(\): DriveDisplay = copy\([\s\S]*?\)/.exec(types)?.[0] ?? '';
    for (const k of ['speed = null', 'speedTint = null', 'speeding = false', 'notDrivingAvailable = false', 'weatherKind = null', 'weatherText = null']) expect(stale).toContain(k);
    expect(stale).not.toMatch(/limit|unit|sky|accent/);
  });

  it('no button: a tap opens the driving screen (roadwise://drive) through an immutable PendingIntent', () => {
    const f = FACTORY();
    expect(f).not.toMatch(/addAction\(|End drive|ACTION_END_DRIVE/);
    // (raw source: the comment stripper would take the "//" in the link for a comment)
    expect(kt('NotificationFactory')).toMatch(/const val DRIVE_LINK = "roadwise:\/\/drive"/);
    expect(f).toMatch(/Intent\(Intent\.ACTION_VIEW, Uri\.parse\(DRIVE_LINK\)\)\.setPackage\(context\.packageName\)/);
    expect(f).toMatch(/getLaunchIntentForPackage/);
    expect(f).toMatch(/PendingIntent\.getActivity\([\s\S]{0,120}PendingIntent\.FLAG_UPDATE_CURRENT or PendingIntent\.FLAG_IMMUTABLE/);
  });

  it('a Live Update on Android 16 QPR1+ when allowed (never colorized then); else colorized in the sky, navy by default', () => {
    const f = FACTORY();
    expect(f).toMatch(/SDK_INT_FULL_36_1 = 36 \* 100_000 \+ 1/);
    expect(f).toMatch(/@RequiresApi\(API_36\)\s*private fun sdkIntFull\(\): Int = Build\.VERSION\.SDK_INT_FULL/);
    expect(f).toMatch(/Build\.VERSION\.SDK_INT > API_36 \|\| \(Build\.VERSION\.SDK_INT == API_36 && sdkIntFull\(\) >= SDK_INT_FULL_36_1\)/);
    expect(f).toMatch(/NotificationManagerCompat\.from\(context\)\.canPostPromotedNotifications\(\)/);
    const promoted = /if \(promoted\) \{([\s\S]*?)\} else \{([\s\S]*?)\}/.exec(f);
    expect(promoted?.[1]).toMatch(/setRequestPromotedOngoing\(true\)/);
    expect(promoted?.[1]).toMatch(/setShortCriticalText\(DriveNotificationText\.chip\(d\)\)/);
    expect(promoted?.[1]).toMatch(/setColor\(accentColor\(d\)\)/);
    expect(promoted?.[1]).not.toMatch(/setColorized/);
    expect(promoted?.[2]).toMatch(/setColor\(skyColor\(d\)\)\.setColorized\(true\)/);
    expect(f).toMatch(/NAVY = 0xFF001D3D/);
    expect(f).toMatch(/GOLD = 0xFFFFC300/);
    expect(f.match(/setColorized\(/g)).toHaveLength(1);
    expect(MANIFEST()).toContain('<uses-permission android:name="android.permission.POST_PROMOTED_NOTIFICATIONS"');
  });

  it('its channel: drive_live at default importance (lock screens show it; it can be promoted), silent, public; drive_recording deleted', () => {
    const f = FACTORY();
    expect(f).toMatch(/const val CHANNEL_ID = "drive_live"/);
    expect(f).toMatch(/NotificationChannel\(CHANNEL_ID, "Drive in progress", NotificationManager\.IMPORTANCE_DEFAULT\)/);
    expect(f).toMatch(/setSound\(null, null\)\s*enableVibration\(false\)\s*enableLights\(false\)\s*setShowBadge\(false\)\s*lockscreenVisibility = Notification\.VISIBILITY_PUBLIC/);
    expect(f).toMatch(/deleteNotificationChannel\(OLD_CHANNEL_ID\)/);
    expect(f).toMatch(/OLD_CHANNEL_ID = "drive_recording"/);
    expect(f).not.toMatch(/IMPORTANCE_HIGH|IMPORTANCE_MIN|IMPORTANCE_LOW|Recording your drive|Checking for a drive/);
    for (const s of ['setOngoing(true)', 'setOnlyAlertOnce(true)', 'setVisibility(NotificationCompat.VISIBILITY_PUBLIC)', 'setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)']) {
      expect(f).toContain(s);
    }
    // the RoadWise mark: the app's own glyph, the module's as the fallback
    expect(f).toMatch(/"expo\.modules\.notifications\.default_notification_icon"/);
    expect(f).toMatch(/R\.drawable\.ic_drive_notification/);
  });

  it('posted only on a change; stale after 2 min; a swiped-away one stays away until RoadWise is in front or the next capture', () => {
    expect(TEXT()).toMatch(/const val STALE_AFTER_MS = 120_000L/);
    const c = CONTROLLER();
    expect(c).toMatch(/if \(key == postedKey\) return/);
    expect(c).toMatch(/if \(!CaptureService\.recording\(\) \|\| ended \|\| dismissed\) return/);
    expect(c).toMatch(/armStale\(DriveNotificationText\.STALE_AFTER_MS\)/);
    expect(c).toMatch(/return if \(stale\) d\.stale\(\) else d/);
    // the delete intent: explicit to the package, immutable, to an unexported runtime receiver
    expect(c).toMatch(/ContextCompat\.registerReceiver\(ctx, dismissReceiver, IntentFilter\(ACTION_DISMISSED\), ContextCompat\.RECEIVER_NOT_EXPORTED\)/);
    expect(c).toMatch(/Intent\(ACTION_DISMISSED\)\.setPackage\(ctx\.packageName\)/);
    expect(c).toMatch(/PendingIntent\.FLAG_UPDATE_CURRENT or PendingIntent\.FLAG_IMMUTABLE/);
    expect(c).not.toMatch(/FLAG_MUTABLE/);
    expect(code(kt('AppVisibility'))).toMatch(/val wasBehind = started == 0[\s\S]*?if \(wasBehind && started > 0\) \{\s*try \{\s*DriveNotificationController\.onAppFront\(\)/);
    // the kept state is the open capture's only, and the end forgets it
    expect(c).toMatch(/if \(!drive\.captureOpen \|\| p\.getLong\(KEY_DRIVE, -1L\) != drive\.captureStartedAt\)/);
    expect(c).toMatch(/if \(display\.ended\) \{[\s\S]*?forget\(ctx\)\s*return\s*\}/);
    // restored on the sticky restart only; a new capture starts empty and forgets the kept state
    const rules = code(kt('DriveNotificationRules'));
    expect(rules).toMatch(/hasDisplay -> Source\.DISPLAY\s*restart -> Source\.KEPT\s*capturing -> Source\.CURRENT\s*else -> Source\.EMPTY/);
    expect(c).toMatch(/DriveNotificationRules\.Source\.KEPT -> \{\s*val kept = restore\(ctx\)/);
    expect(c).toMatch(/DriveNotificationRules\.Source\.EMPTY -> \{\s*latest = null\s*latestAt = now\s*forget\(ctx\)\s*\}/);
    expect(c.match(/restore\(ctx\)/g)).toHaveLength(1);
    // the stale timer goes by the newest state's age: an update that lands as it fires is not marked stale
    expect(rules).toMatch(/fun staleIn\(now: Long, latestAt: Long\): Long = DriveNotificationText\.STALE_AFTER_MS - \(now - latestAt\)/);
    expect(c).toMatch(/private fun onStale\(\) \{\s*if \(latest == null \|\| stale\) return\s*val left = DriveNotificationRules\.staleIn\(SystemClock\.elapsedRealtime\(\), latestAt\)\s*if \(left > 0\) \{\s*armStale\(left\)\s*return\s*\}\s*stale = true/);
  });

  it('setDriveDisplay reaches the running capture only, and the display resets with each capture', () => {
    expect(MODULE()).toMatch(/AsyncFunction\("setDriveDisplay"\) \{ state: Map<String, Any\?> ->\s*CaptureService\.setDriveDisplay\(DriveDisplay\.from\(state\)\)/);
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/fun setDriveDisplay\(display: DriveDisplay\) \{\s*val inst = instance \?: return/);
    expect(svc).toMatch(/private fun goForeground\(restart: Boolean = false, watch: Boolean = false\): String\?/);
    expect(svc).toMatch(/val notification = if \(watch\) WatchNotification\.build\(this\) else DriveNotificationController\.foreground\(this, display, restart\)/);
    // only the START_STICKY restart (no intent) restores the kept state
    // (a detector drive's, then a plain capture's), and a detector drive resumed in a new process
    expect(svc).toMatch(/if \(intent == null\) \{[\s\S]*?if \(prefs\.detectorOwned\) \{\s*if \(goForeground\(restart = true\) != null\)[\s\S]*?if \(goForeground\(restart = true\) != null\)/);
    expect(svc.match(/goForeground\(restart = true\)/g)).toHaveLength(2);
    expect(svc).toMatch(/ACTION_DETECT -> \{\s*val restart = intent\.getBooleanExtra\(EXTRA_RESTART, false\)\s*val refused = goForeground\(restart = restart\)/);
    expect(svc).toMatch(/display\?\.let \{ DriveNotificationController\.update\(this, it\) \}/);
    const begin = /private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(begin).toMatch(/display = null/);
    expect(code(kt('Types'))).toMatch(/data class DriveDisplay\(/);
  });
});

describe('native-android: capture service and watchdog (rev1: I2, C2)', () => {
  it('starts foreground with the location type', () => {
    expect(code(kt('CaptureService'))).toMatch(/FOREGROUND_SERVICE_TYPE_LOCATION/);
  });

  it('the watchdog: 60 s to claim, 5 min without a row listener', () => {
    const src = code(kt('Watchdog'));
    expect(src).toMatch(/CLAIM_TIMEOUT_MS\s*=\s*60_000L/);
    expect(src).toMatch(/NO_ROW_LISTENER_MS\s*=\s*300_000L/);
  });

  it('the watchdog also ends the headless task at once; a normal stop ends it after a grace (N2N3 I4)', () => {
    const src = code(kt('CaptureService'));
    expect(src).toMatch(/stopService\(Intent\(app, DriveSenseHeadlessService::class\.java\)\)/);
    expect(src).toMatch(/endCapture\(clearOpen = true, headlessNow = true\)/);
    expect(src).toMatch(/HEADLESS_GRACE_MS = 2 \* 60_000L/);
  });

  it('a row closes after its IMU AND its fix (or 300 ms), capped at 1.5 s — the iOS rule (N2N3 I1)', () => {
    const src = code(kt('CaptureService'));
    expect(src).toMatch(/FIX_SETTLE_MS = 300L/);
    expect(src).toMatch(/ROW_MAX_WAIT_MS = 1_500L/);
    expect(src).toMatch(/val imuReady = !imuRunning \|\| latestImuT > ts/);
    expect(src).toMatch(/val fixReady = latestFixT > ts \|\| now >= ts \+ FIX_SETTLE_MS/);
    expect(src).toMatch(/force \|\| \(imuReady && fixReady\) \|\| now >= ts \+ ROW_MAX_WAIT_MS/);
  });

  it('arrival is measured on the anchored boot clock, never the wall clock (N2N3 I2)', () => {
    for (const f of ['SensorSource', 'LocationSource']) {
      const src = code(kt(f));
      expect(src).toMatch(/TimeBase\.anchoredNow\(/);
      expect(src).not.toMatch(/currentTimeMillis/);
    }
    expect(code(kt('CaptureService'))).toMatch(/nowEpochMs\(\): Double = TimeBase\.anchoredNow\(anchor\)/);
    expect(existsSync(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'TimeBaseTest.kt'))).toBe(true);
  });

  it('accelerometer–gyroscope pairing waits on arrival time and counts the unpaired (N2N3 I3)', () => {
    const src = code(kt('SensorSource'));
    expect(src).toMatch(/PAIR_WAIT_ARRIVAL_MS = 1_200\.0/);
    expect(src).toMatch(/nowArrivalMs - s\.arrivalClockMs > PAIR_WAIT_ARRIVAL_MS/);
    expect(src).toMatch(/unpaired\+\+/);
    expect(code(kt('CaptureService'))).toMatch(/addImuUnpaired\(/);
  });

  it('startCapture claims; the row listener feeds the watchdog', () => {
    const src = code(allKotlin());
    expect(src).toMatch(/\.claim\(\)/);
    expect(src).toMatch(/onRowListener\(/);
  });

  it('the event buffer holds EVENT_BUFFER_MAX events', () => {
    expect(code(kt('EventBus'))).toMatch(new RegExp(`MAX_BUFFERED\\s*=\\s*${EVENT_BUFFER_MAX}\\b`));
  });

  it('no WorkManager (design §3.5)', () => {
    expect(allKotlin()).not.toMatch(/WorkManager|androidx\.work/);
    expect(read(join(ANDROID, 'build.gradle'))).not.toMatch(/androidx\.work/);
  });
});

describe('native-android: sensors and location (README §7, rev1: O8, I5)', () => {
  it("the capture uses TYPE_ACCELEROMETER and TYPE_GYROSCOPE only — no rotation vector, no magnetometer; the rotation vector and the magnetometer's status only in the compass heading", () => {
    const src = code(kt('SensorSource'));
    expect(src).toMatch(/Sensor\.TYPE_ACCELEROMETER\b/);
    expect(src).toMatch(/Sensor\.TYPE_GYROSCOPE\b/);
    for (const f of readdirSync(KT_DIR).filter((x) => x.endsWith('.kt'))) {
      const banned =
        f === 'HeadingSource.kt'
          ? /TYPE_GAME_ROTATION_VECTOR|TYPE_GRAVITY|TYPE_LINEAR_ACCELERATION/
          : /TYPE_ROTATION_VECTOR|TYPE_MAGNETIC_FIELD|TYPE_GAME_ROTATION_VECTOR|TYPE_GRAVITY|TYPE_LINEAR_ACCELERATION/;
      expect({ f, banned: banned.test(read(join(KT_DIR, f))) }).toEqual({ f, banned: false });
    }
  });

  it('registers at 40 000 µs with 1 s of FIFO batching', () => {
    const src = code(kt('SensorSource'));
    expect(src).toMatch(/SAMPLING_PERIOD_US\s*=\s*40_000\b/);
    expect(src).toMatch(/MAX_REPORT_LATENCY_US\s*=\s*1_000_000\b/);
  });

  it('converts the accelerometer with a = −values / G_MPS2 (androidAccelToReference)', () => {
    const src = code(kt('SensorSource'));
    expect(src).toMatch(/fun androidAccelToReference\(/);
    expect(src).toMatch(/\(0\.0 - x\) \/ G_MPS2/);
  });

  it('sends each full-rate fix as a live `speed` event the moment it lands (never buffered)', () => {
    const src = code(kt('CaptureService'));
    // (a watch is no drive JS shows: no speed then)
    expect(src).toMatch(/\} else \{\s*if \(!watching\) emitSpeed\(fix\)\s*fixes\.add\(fix\)/);
    expect(src).toMatch(/EventBus\.emitLive\(\s*"speed",/);
    for (const key of ['"ts" to', '"speed" to', '"speedAcc" to', '"hAcc" to', '"ageMs" to']) expect(src).toContain(key);
    // The age on the capture's anchored boot clock, as the fix's own time.
    expect(src).toMatch(/val age = \(TimeBase\.anchoredNow\(anchor\) - fix\.t\)\.coerceAtLeast\(0\.0\)/);
    expect(MODULE()).toMatch(/OBSERVED_EVENTS = listOf\([^)]*"speed"[^)]*\)/);
  });

  it('sends `screen` and `thermal` live only: JS never listens, so buffering them would fill the buffer and evict rows', () => {
    const src = code(kt('PhoneStateReceiver'));
    expect(src).toMatch(/EventBus\.emitLive\(\s*"screen",/);
    expect(src).toMatch(/EventBus\.emitLive\("thermal", linkedMapOf\("level" to level, "ts" to System\.currentTimeMillis\(\)\)\)/);
    expect(code(allKotlin())).not.toMatch(/EventBus\.emit\(\s*"(screen|thermal)"/);
  });

  it('1 s high accuracy at full rate, 10 s balanced at low rate', () => {
    const src = code(kt('LocationSource'));
    expect(src).toMatch(/PRIORITY_HIGH_ACCURACY/);
    expect(src).toMatch(/PRIORITY_BALANCED_POWER_ACCURACY/);
    expect(src).toMatch(/1_000L/);
    expect(src).toMatch(/10_000L/);
  });

  it('never reads a Location unknown without its has…() check', () => {
    const src = code(kt('LocationSource'));
    expect(src).toMatch(/hasSpeed\(\)/);
    expect(src).toMatch(/hasSpeedAccuracy\(\)/);
    expect(src).toMatch(/hasBearing\(\)/);
    expect(src).toMatch(/hasAccuracy\(\)/);
    expect(src).toMatch(/hasAltitude\(\)/);
    expect(src).toMatch(/elapsedRealtimeNanos/);
  });

  // v3 (plan §6; spec "Integrity · GPS spoofing")
  it('flags a mock-provider fix (isMock on API 31+, isFromMockProvider before) and emits it as the row key `mock`, outside the FeatureRow map', () => {
    const loc = code(kt('LocationSource'));
    expect(loc).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) l\.isMock else l\.isFromMockProvider/);
    expect(loc).toMatch(/mock = isMock\(l\)/);
    expect(code(kt('Types'))).toMatch(/val mock: Boolean = false/);
    expect(code(kt('Types'))).not.toMatch(/"mock"/); // never in FeatureRow.toMap: the self-test rows stay the contract's keys
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/body\["mock"\] = mock/);
    expect(svc).toMatch(/emitRow\(out\.row, fix\.mock\)/);
    expect(svc).toMatch(/emitRow\(out\.row, fix\?\.mock \?: false\)/);
  });

  it('rows carry the bridge-only call state from the audio mode: ring, live (VoIP only with the microphone in use), nothing with none', () => {
    const fn = /fun callState\(context: Context\): String\? \{[\s\S]*?\n {4}\}/.exec(code(kt('PhoneStateReceiver')))?.[0] ?? '';
    expect(fn).toMatch(/AudioManager\.MODE_RINGTONE -> "ring"/);
    expect(fn).toMatch(/AudioManager\.MODE_IN_CALL -> "live"/);
    expect(fn).toMatch(/AudioManager\.MODE_IN_COMMUNICATION -> if \(am\.activeRecordingConfigurations\.isNotEmpty\(\)\) "live" else null/);
    expect(fn).toMatch(/else -> null/);
    expect(fn).toMatch(/catch \(_: Exception\) \{\s*null\s*\}/);
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/body\["mock"\] = mock\s*PhoneStateReceiver\.callState\(applicationContext\)\?\.let \{ body\["call"\] = it \}\s*pedometer\?\.steps\?\.let \{ body\["steps"\] = it \}\s*val detector = if \(detectorCapture\) DriveDetector\.peek\(\) else null\s*if \(detector != null\) detector\.onRow\(row, body, watching\) else if \(!watching\) EventBus\.emit\("row", body\)/);
    expect(code(kt('Types'))).not.toMatch(/"call"/);
    // One Kotlin reading of the call state: the audio-mode rules live in PhoneStateReceiver alone.
    for (const f of readdirSync(KT_DIR).filter((x) => x.endsWith('.kt') && x !== 'PhoneStateReceiver.kt')) {
      expect({ f, reads: /MODE_IN_CALL|MODE_RINGTONE|activeRecordingConfigurations/.test(code(read(join(KT_DIR, f)))) }).toEqual({ f, reads: false });
    }
  });
});

describe('native-android: the extraction port (README §7, §8)', () => {
  const kotlinConstants = (): Map<string, number> => {
    const out = new Map<string, number>();
    const src = code(kt('Constants'));
    for (const m of src.matchAll(/const val (\w+)(?:\s*:\s*\w+)?\s*=\s*(-?[\d_.]+(?:[eE]-?\d+)?)L?\b/g)) {
      out.set(m[1]!, Number(m[2]!.replace(/_/g, '')));
    }
    return out;
  };

  it.each(Object.entries(CONSTANTS).filter(([, v]) => typeof v === 'number'))(
    'Constants.kt %s equals the reference',
    (name, value) => {
      expect(kotlinConstants().get(name)).toBe(value);
    }
  );

  it.each([
    ['TIMEBASE_MAX_SKEW_MS', TIMEBASE_MAX_SKEW_MS],
    ['MAX_ROW_GAP_MS', MAX_ROW_GAP_MS],
    ['FIRST_WINDOW_MS', FIRST_WINDOW_MS],
  ])('Constants.kt %s equals the time-base reference', (name, value) => {
    expect(kotlinConstants().get(name)).toBe(value);
  });

  it('lateral is normalize(f × ĝ), left-positive', () => {
    expect(code(kt('FeatureExtractor'))).toMatch(/normalize\(cross\(f, gMean\)\)/);
  });

  it('selfTest drives the production classes and the production conversion', () => {
    const src = code(kt('SelfTest'));
    expect(src).toMatch(/SensorSource\.androidAccelToReference\(/);
    expect(src).toMatch(/GravityFilter\b/);
    expect(src).toMatch(/FeatureExtractor\b/);
    for (const kind of ['"extract"', '"gravityFilter"', '"androidRaw"']) expect(src).toContain(kind);
    expect(src).toMatch(/"platform",\s*"android"/);
    expect(src).not.toMatch(/"skipped"/);
  });

  it('the capture path uses the same classes', () => {
    const src = code(kt('CaptureService'));
    expect(src).toMatch(/FeatureExtractor\b/);
    expect(code(kt('SensorSource'))).toMatch(/androidAccelToReference\(/);
    expect(code(kt('SensorSource'))).toMatch(/GravityFilter\b/);
  });
});

describe('native-android: build.gradle pins exact versions', () => {
  it('no dynamic versions', () => {
    const g = code(read(join(ANDROID, 'build.gradle')));
    expect(g).not.toMatch(/:\s*[\d.]*\+['"]/);
    expect(g).not.toMatch(/latest\.(integration|release)/);
    expect(g).toContain("'com.google.android.gms:play-services-location:21.3.0'");
  });
});

// Screen switches (README §5): `appForeground` is RoadWise in front, not the process importance.
describe('native-android: RoadWise in front (AppVisibility)', () => {
  it('a Package found by autolinking registers AppVisibility at Application.onCreate', () => {
    const pkg = read(join(KT_DIR, 'DriveSensePackage.kt'));
    expect(pkg).toMatch(/^import expo\.modules\.core\.interfaces\.Package$/m);
    expect(pkg).toMatch(/^import expo\.modules\.core\.interfaces\.ApplicationLifecycleListener$/m);
    const src = code(pkg);
    expect(src).toMatch(/class DriveSensePackage : Package \{/);
    expect(src).toMatch(/override fun createApplicationLifecycleListeners\(context: Context\): List<ApplicationLifecycleListener> =/);
    expect(src).toMatch(/override fun onCreate\(application: Application\) \{\s*AppVisibility\.register\(application\)\s*try \{\s*DriveDetector\.get\(application\)\.resumeAtLaunch\(\)/);
    // the late fallback in the module, seeded from the activity on screen
    expect(MODULE()).toMatch(/\(context as\? Application\)\?\.let \{ AppVisibility\.registerLate\(it, appContext\.currentActivity\) \}/);
  });

  it('counts started activities, ignores a recreation, and reads split screen only on a phone-sized display', () => {
    const v = code(kt('AppVisibility'));
    expect(v).toMatch(/object AppVisibility : Application\.ActivityLifecycleCallbacks \{/);
    expect(v).toMatch(/const val LARGE_SCREEN_DP = 600\b/);
    expect(v).toMatch(/fun inFront\(\): Boolean = started > 0 && !multiWindow/);
    expect(v).toMatch(/fun visible\(\): Boolean = started > 0/);
    expect(v).toMatch(/@Volatile\s*private var started = 0/);
    expect(v).toMatch(/@Volatile\s*private var multiWindow = false/);
    expect(v.match(/registerActivityLifecycleCallbacks\(this\)/g)).toHaveLength(2);
    expect(v).toMatch(/if \(registered\) return\s*registered = true/);
    // split screen: the last started activity, on a display under 600 dp
    expect(v).toMatch(/a\.isInMultiWindowMode &&\s*a\.resources\.configuration\.smallestScreenWidthDp < LARGE_SCREEN_DP/);
    // a rotation or a fold: the stopped instance is being recreated and the new one does not count twice
    const stopped = /override fun onActivityStopped\(activity: Activity\) \{[\s\S]*?\n {2}\}/.exec(v)?.[0] ?? '';
    expect(stopped).toMatch(/if \(activity\.isChangingConfigurations\) \{\s*recreating = WeakReference\(activity\)\s*\} else \{\s*started = \(started - 1\)\.coerceAtLeast\(0\)\s*\}/);
    const startedFn = /override fun onActivityStarted\(activity: Activity\) \{[\s\S]*?\n {2}\}/.exec(v)?.[0] ?? '';
    expect(startedFn).toMatch(/if \(recreating != null\) \{\s*recreating = null\s*\} else \{\s*started \+= 1\s*\}/);
    const destroyed = /override fun onActivityDestroyed\(activity: Activity\) \{[\s\S]*?\n {2}\}/.exec(v)?.[0] ?? '';
    expect(destroyed).toMatch(/if \(recreating\?\.get\(\) === activity && !activity\.isChangingConfigurations\) \{\s*recreating = null\s*started = \(started - 1\)\.coerceAtLeast\(0\)\s*\}/);
  });

  it('the rows read it: appForeground delegates to inFront, and every emitted row re-samples split screen on main', () => {
    const phone = code(kt('PhoneStateReceiver'));
    expect(phone).toMatch(/fun appForeground\(\): Boolean = AppVisibility\.inFront\(\)/);
    expect(phone).not.toMatch(/getMyMemoryState|IMPORTANCE_FOREGROUND|ActivityManager/);
    expect(code(kt('CaptureService'))).toMatch(/EventBus\.emit\("row", body\)\s*main\.post \{ AppVisibility\.sample\(\) \}/);
  });

  it('navigation apps: listed by explicit <queries> packages (never QUERY_ALL_PACKAGES), opened like a launcher tap', () => {
    const list = /AsyncFunction\("listInstalledApps"\) \{ packages: List<String> ->[\s\S]*?\n {4}\}/.exec(MODULE())?.[0] ?? '';
    expect(list).toMatch(/if \(pm\.getLaunchIntentForPackage\(pkg\) == null\) continue/);
    expect(list).toMatch(/if \(!info\.enabled\) continue/);
    expect(list).toMatch(/"label" to pm\.getApplicationLabel\(info\)\.toString\(\)/);
    expect(list).toMatch(/catch \(_: Exception\) \{/);
    const launch = /AsyncFunction\("launchApp"\) \{ pkg: String ->[\s\S]*?\n {4}\}/.exec(MODULE())?.[0] ?? '';
    expect(launch).toMatch(/getLaunchIntentForPackage\(pkg\)/);
    expect(launch).toMatch(/intent\.addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK or Intent\.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED\)/);
    expect(launch).toMatch(/\(appContext\.currentActivity \?: ctx\)\.startActivity\(intent\)\s*true/);
    expect(launch).toMatch(/catch \(_: Exception\) \{\s*false\s*\}/);
    expect(MANIFEST()).toMatch(/<queries>[\s\S]*<package android:name="com\.waze" \/>[\s\S]*<\/queries>/);
    // only the navigation apps: NavPackages equals the manifest's <queries> and the JS list, in order
    expect(list).toMatch(/for \(pkg in packages\) \{\s*if \(pkg !in NavPackages\.ALLOWED\) continue\s*try \{/);
    expect(launch).toMatch(/val intent = if \(pkg in NavPackages\.ALLOWED\) ctx\.packageManager\.getLaunchIntentForPackage\(pkg\) else null\s*if \(intent == null\) \{\s*false/);
    const allowed = /val ALLOWED: Set<String> = setOf\(([\s\S]*?)\)/.exec(code(kt('NavPackages')))?.[1] ?? '';
    const queries = /<queries>([\s\S]*?)<\/queries>/.exec(MANIFEST())?.[1] ?? '';
    expect([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...NAV_APP_PACKAGES]);
    expect([...queries.matchAll(/<package android:name="([^"]+)" \/>/g)].map((m) => m[1])).toEqual([...NAV_APP_PACKAGES]);
    expect(MANIFEST()).not.toMatch(/<uses-permission[^>]*QUERY_ALL_PACKAGES/);
    expect(allKotlin()).not.toMatch(/QUERY_ALL_PACKAGES|getInstalledPackages|getInstalledApplications/);
  });

  it('needs no lock proof: getState reports none, and markLockProof does nothing', () => {
    expect(MODULE()).toMatch(/"lockSignal" to "reliable",\s*"lockProof" to false,\s*"lockDelayMs" to null,/);
    expect(MODULE()).toMatch(/AsyncFunction\("markLockProof"\) \{ _: Double ->\s*Unit\s*\}/);
  });
});

describe('native-android: DashPal alerts on the phone (README §2: the link service, the wake lock, the audio probe)', () => {
  const SVC = () => code(kt('DashpalLinkService'));
  const setFn = () => /fun set\(context: Context, state: String, onResult: \(String\) -> Unit\) \{[\s\S]*?\n {4}\}/.exec(SVC())?.[0] ?? '';

  it('the manifest declares the link service as a connectedDevice foreground service, not exported', () => {
    const m = /<service[^>]*android:name="\.DashpalLinkService"[^>]*>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android:foregroundServiceType="connectedDevice"');
    expect(m![0]).toContain('android:exported="false"');
  });

  it('the module bridges the four DashPal calls to their objects', () => {
    const src = MODULE();
    expect(src).toMatch(/AsyncFunction\("setDashpalLink"\) \{ state: String, promise: Promise ->\s*DashpalLinkService\.set\(context, state\) \{ promise\.resolve\(it\) \}\s*\}/);
    expect(src).toMatch(/Function\("audioOutputState"\) \{\s*AudioOutput\.state\(context\)\s*\}/);
    expect(src).toMatch(/Function\("holdAwake"\) \{ ms: Int ->\s*AlertWakeLock\.hold\(context, ms\)\s*\}/);
    expect(src).toMatch(/Function\("dashpalLinkRunning"\) \{\s*DashpalLinkService\.running\(\)\s*\}/);
    // The tick is observed like every event (OnStartObserving over OBSERVED_EVENTS).
    expect(src).toMatch(/OBSERVED_EVENTS = listOf\([^)]*"dashpalLinkTick"\)/);
  });

  it('a running service is updated through its instance only: the update path holds no start call', () => {
    const set = setFn();
    expect(set).not.toBe('');
    const updateAt = set.indexOf('if (inst != null) {\n');
    const startAt = set.indexOf('val inFlight');
    expect(updateAt).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(updateAt);
    const update = set.slice(updateAt, startAt);
    expect(update).toMatch(/inst\.handler\.post \{ inst\.apply\(next\) \}/);
    expect(update).toMatch(/onResult\("running"\)/);
    expect(update).not.toMatch(/startForegroundService|startForeground|startService/);
    // off stops a running instance (on its handler) and answers stopped; it never starts anything.
    const off = set.slice(set.indexOf('if (next == "off") {'), updateAt);
    expect(off).toMatch(/inst\.handler\.post \{ inst\.shutDown\(\) \}/);
    expect(off).toMatch(/onResult\("stopped"\)/);
    expect(off).not.toMatch(/startForegroundService|startForeground/);
  });

  it('a stopped service starts only after its prechecks, and every refusal is caught', () => {
    const src = SVC();
    const may = /private fun mayStart\(context: Context\): Boolean \{[\s\S]*?\n {4}\}/.exec(src)?.[0] ?? '';
    expect(may).toMatch(/AppVisibility\.visible\(\) \|\|/);
    expect(may).toMatch(/info\.importance == ActivityManager\.RunningAppProcessInfo\.IMPORTANCE_FOREGROUND/);
    expect(may).toMatch(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE &&\s*ContextCompat\.checkSelfPermission\(context, Manifest\.permission\.BLUETOOTH_CONNECT\) != PackageManager\.PERMISSION_GRANTED/);
    const set = setFn();
    const start = set.slice(set.indexOf('val inFlight'));
    expect(start.indexOf('if (!mayStart(ctx))')).toBeGreaterThan(0);
    expect(start.indexOf('if (!mayStart(ctx))')).toBeLessThan(start.indexOf('ContextCompat.startForegroundService('));
    expect(start).toMatch(/catch \(_: IllegalStateException\) \{[\s\S]*?resolve\("refused"\)/);
    expect(start).toMatch(/catch \(_: SecurityException\) \{[\s\S]*?resolve\("refused"\)/);
    // A start that never reports is refused after 10 s, for its own attempt only.
    expect(src).toMatch(/START_RESULT_TIMEOUT_MS = 10_000L/);
    expect(start).toMatch(/main\.postDelayed\(\{ if \(synchronized\(lock\) \{ attempt == mine \}\) resolve\("refused"\) \}, START_RESULT_TIMEOUT_MS\)/);
  });

  it('onStartCommand: in the foreground with the connectedDevice type before anything else, never sticky; a refusal stops it', () => {
    const src = SVC();
    const cmd = /override fun onStartCommand\(intent: Intent\?, flags: Int, startId: Int\): Int \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(cmd).toMatch(/ServiceInfo\.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0/);
    expect(cmd).toMatch(/ServiceCompat\.startForeground\(this, NOTIFICATION_ID,/);
    expect(cmd).toMatch(/catch \(_: SecurityException\) \{\s*resolve\("refused"\)\s*stopSelf\(\)/);
    expect(cmd).toMatch(/catch \(_: IllegalStateException\) \{\s*resolve\("refused"\)\s*stopSelf\(\)/);
    // Forgotten while the start was in flight: foreground first (Android requires it), then stopped.
    expect(cmd.indexOf('ServiceCompat.startForeground(')).toBeLessThan(cmd.indexOf('if (wanted == "off")'));
    expect(src).not.toMatch(/START_STICKY\b/);
    expect(src).toMatch(/START_NOT_STICKY/);
  });

  it('the notification: id 7310, a silent minimum-importance channel hidden on the lock screen (a new id; the old one deleted), "DashPal" and its two texts, opens RoadWise', () => {
    const src = SVC();
    expect(src).toMatch(/NOTIFICATION_ID = 7310/);
    // Android fixes a channel's importance at creation: the minimum-importance channel has its own id.
    expect(src).toMatch(/CHANNEL_ID = "dashpal_link_min"/);
    expect(src).toMatch(/RETIRED_CHANNEL_ID = "dashpal_link"/);
    expect(src).toMatch(/NotificationChannel\(CHANNEL_ID, "DashPal link", NotificationManager\.IMPORTANCE_MIN\)/);
    expect(src).not.toMatch(/IMPORTANCE_LOW|PRIORITY_LOW/);
    expect(src).toMatch(/setSound\(null, null\)\s*enableVibration\(false\)\s*setShowBadge\(false\)\s*lockscreenVisibility = Notification\.VISIBILITY_SECRET/);
    expect(src).toMatch(/\.setPriority\(NotificationCompat\.PRIORITY_MIN\)\s*\.setVisibility\(NotificationCompat\.VISIBILITY_SECRET\)/);
    // The old channel goes only after the new one exists, and a refusal (a foreground service still on it) never breaks the post.
    const ensure = /fun ensureChannel\(context: Context\) \{[\s\S]*?\n {4}\}/.exec(src)?.[0] ?? '';
    expect(ensure.indexOf('createNotificationChannel(channel)')).toBeGreaterThan(0);
    expect(ensure.indexOf('createNotificationChannel(channel)')).toBeLessThan(ensure.indexOf('deleteNotificationChannel(RETIRED_CHANNEL_ID)'));
    expect(ensure).toMatch(/try \{\s*nm\.deleteNotificationChannel\(RETIRED_CHANNEL_ID\)\s*\} catch \(_: SecurityException\) \{/);
    expect(src).toMatch(/TITLE = "DashPal"/);
    expect(src).toMatch(/TEXT_CONNECTED = "Connected\. DashPal alerts play on this phone\."/);
    expect(src).toMatch(/TEXT_WAITING = "Not connected\. DashPal plays its alerts itself\."/);
    expect(src).toMatch(/setSmallIcon\(R\.drawable\.ic_drive_notification\)/);
    expect(src).toMatch(/PendingIntent\.FLAG_IMMUTABLE/);
    // A running service re-posts only with notifications allowed.
    const apply = /fun apply\(next: String\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(apply).toMatch(/if \(NotificationManagerCompat\.from\(this\)\.areNotificationsEnabled\(\)\) \{[\s\S]*?notify\(NOTIFICATION_ID, build\(next\)\)/);
  });

  it('the reconnect tick: every 30 s while waiting only, to a listener only (never buffered)', () => {
    const src = SVC();
    expect(src).toMatch(/TICK_MS = 30_000L/);
    const apply = /fun apply\(next: String\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(apply).toMatch(/handler\.removeCallbacks\(tick\)\s*if \(next == "waiting"\) handler\.postDelayed\(tick, TICK_MS\)/);
    expect(src).toMatch(/EventBus\.emitLive\("dashpalLinkTick", emptyMap\(\)\)/);
    expect(src).not.toMatch(/EventBus\.emit\(/);
    const live = /fun emitLive\(name: String, body: Map<String, Any\?>\) \{[\s\S]*?\n {2}\}/.exec(code(kt('EventBus')))?.[0] ?? '';
    expect(live).toMatch(/observed\.contains\(name\)/);
    expect(live).not.toMatch(/buffer/);
  });

  it('the link service touches neither the capture nor any wake lock', () => {
    expect(SVC()).not.toMatch(/CaptureService|startCapture|WakeLock/);
    expect(code(kt('AlertWakeLock'))).not.toMatch(/DashpalLinkService|CaptureService/);
  });

  it('holdAwake: one partial wake lock, not reference counted, re-armed with a timeout clamped to 1-10 s', () => {
    const src = code(kt('AlertWakeLock'));
    expect(src).toMatch(/TAG = "RoadWise:DashPalAlert"/);
    expect(src).toMatch(/PowerManager\.PARTIAL_WAKE_LOCK/);
    expect(src).toMatch(/setReferenceCounted\(false\)/);
    expect(src).toMatch(/MIN_MS = 1_000/);
    expect(src).toMatch(/MAX_MS = 10_000/);
    expect(src).toMatch(/wl\.acquire\(ms\.coerceIn\(MIN_MS, MAX_MS\)\.toLong\(\)\)/);
    expect(src).not.toMatch(/\.release\(/);
    expect(src).toMatch(/catch \(_: Exception\) \{\s*false\s*\}/);
  });

  it('audioOutputState: the one call reader, the media stream (0 when muted) and the four headphone outputs', () => {
    const src = code(kt('AudioOutput'));
    expect(src).toMatch(/"callActive" to \(PhoneStateReceiver\.callState\(context\) != null\)/);
    expect(src).toMatch(/isStreamMute\(AudioManager\.STREAM_MUSIC\)\) \{\s*0\.0/);
    expect(src).toMatch(/getStreamVolume\(AudioManager\.STREAM_MUSIC\)\.toDouble\(\) \/ max\)\.coerceIn\(0\.0, 1\.0\)/);
    expect(src).toMatch(/getDevices\(AudioManager\.GET_DEVICES_OUTPUTS\)/);
    for (const t of ['TYPE_WIRED_HEADSET', 'TYPE_WIRED_HEADPHONES', 'TYPE_USB_HEADSET']) expect(src).toContain(`AudioDeviceInfo.${t}`);
    expect(src).toMatch(/Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S && d\.type == AudioDeviceInfo\.TYPE_BLE_HEADSET/);
    expect(src).not.toMatch(/TYPE_BLUETOOTH_A2DP|TYPE_HEARING_AID/);
    expect(src).not.toMatch(/MODE_IN_CALL|MODE_RINGTONE|activeRecordingConfigurations/);
  });
});

describe('native-android: the navigation bar ink (SystemBarsModule, src/ui/systemBars.ts)', () => {
  const src = () => code(kt('SystemBarsModule'));

  it('is its own module, registered for Android beside DriveSense, under the name the JS looks up', () => {
    const config = JSON.parse(read(join(__dirname, '..', 'expo-module.config.json'))) as { android: { modules: string[] } };
    expect(config.android.modules).toContain('expo.modules.drivesense.SystemBarsModule');
    expect(src()).toMatch(/class SystemBarsModule : Module\(\)/);
    expect(src()).toContain('Name("RoadWiseSystemBars")');
  });

  it('one main-thread call that only flips the bar appearance (a scrim below API 29), re-applied on each return to the front', () => {
    const s = src();
    expect(s).toMatch(/AsyncFunction\("setNavigationBarInk"\) \{ ink: String ->[\s\S]*?\}\.runOnQueue\(Queues\.MAIN\)/);
    expect(s).toMatch(/OnActivityEntersForeground \{/);
    expect(s).toMatch(/isAppearanceLightNavigationBars = !light/);
    expect(s).toMatch(/if \(sdk < 26 \|\| sdk >= 29\) null/);
    expect(s).not.toMatch(/Handler|postDelayed|Timer|setDecorFitsSystemWindows|systemUiVisibility/);
  });

  it('answers where the window starts on the screen (for the keyboard lift), on the main thread, 0 when unknown', () => {
    const s = src();
    expect(s).toMatch(/AsyncFunction\("windowTopOnScreen"\) \{[\s\S]*?\}\.runOnQueue\(Queues\.MAIN\)/);
    expect(s).toMatch(/peekDecorView\(\) \?: return 0\.0/);
    expect(s).toMatch(/getLocationOnScreen\(onScreen\)/);
    expect(s).toMatch(/getLocationInWindow\(inWindow\)/);
    expect(s).toMatch(/WindowTop\.dp\(onScreen\[1\], inWindow\[1\], decor\.resources\.displayMetrics\.density\)/);
  });

  it('its pure half has JVM tests', () => {
    expect(existsSync(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'NavBarInkTest.kt'))).toBe(true);
    expect(existsSync(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'WindowTopTest.kt'))).toBe(true);
  });
});

describe('native-android: the capture feed iOS has (steps, the call event; WP04)', () => {
  it('rows carry the step count: TYPE_STEP_COUNTER from the drive baseline (TYPE_STEP_DETECTOR without one), batched, behind Physical activity', () => {
    const src = code(kt('PedometerSource'));
    expect(src).toMatch(/MAX_REPORT_LATENCY_US = 1_000_000/);
    expect(src).toMatch(/val counter = sm\.getDefaultSensor\(Sensor\.TYPE_STEP_COUNTER\)/);
    expect(src).toMatch(/val s = counter \?: sm\.getDefaultSensor\(Sensor\.TYPE_STEP_DETECTOR\) \?: return/);
    expect(src).toMatch(/if \(!DriveSensePermissions\.motionGranted\(app\)\) return/);
    expect(src).toMatch(/sm\.registerListener\(this, s, SensorManager\.SENSOR_DELAY_NORMAL, MAX_REPORT_LATENCY_US, handler\)/);
    // Pure arithmetic, JVM-tested: the first total is the baseline, a lower one a new baseline.
    expect(src).toMatch(/if \(b == null \|\| total < b\) \{\s*baseline = total\s*return 0\s*\}/);
    expect(existsSync(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'StepCountTest.kt'))).toBe(true);
    // A capture the system restarts goes on from its own baseline, only in the same boot.
    expect(src).toMatch(/saved\.captureStartedAt != startedAt/);
    expect(src).toMatch(/val thisBoot = saved\.atClockMs in 1L\.\.nowClockMs && \(boot < 0 \|\| saved\.boot == boot\)/);
    // Registered at the capture's begin (both rates), unregistered with the capture's sources.
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/pedometer = if \(watch\) null else PedometerSource\(this, handler\)\.also \{ it\.start\(startedAt\) \}/);
    const stop = /private fun stopSources\(\) \{[\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(stop).toMatch(/pedometer\?\.stop\(\)\s*pedometer = null/);
    expect(code(kt('Types'))).not.toMatch(/"steps"/);
  });

  it('the call event: once at the start for a call up, on each change (the mode listener on 31+, the recording callback, the row tick below 31), active: false at the stop', () => {
    const src = code(kt('PhoneStateReceiver'));
    const start = /private fun startCallWatch\(\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(start).toMatch(/callActive = callState\(context\) != null\s*if \(callActive\) emitCall\(true\)/);
    expect(start).toMatch(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) \{\s*val listener = AudioManager\.OnModeChangedListener \{ checkCall\(\) \}/);
    expect(start).toMatch(/am\.addOnModeChangedListener\(\{ r -> handler\.post\(r\) \}, listener\)/);
    expect(start).toMatch(/am\.registerAudioRecordingCallback\(callback, handler\)/);
    const check = /fun checkCall\(\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(check).toMatch(/if \(!registered\) return\s*val now = callState\(context\) != null\s*if \(now == callActive\) return\s*callActive = now\s*emitCall\(now\)/);
    const stop = /private fun stopCallWatch\(\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(stop).toMatch(/removeOnModeChangedListener\(it\)/);
    expect(stop).toMatch(/unregisterAudioRecordingCallback\(it\)/);
    expect(stop).toMatch(/if \(callActive\) emitCall\(false\)\s*callActive = false/);
    expect(src).toMatch(/EventBus\.emit\("call", linkedMapOf\("active" to active, "ts" to System\.currentTimeMillis\(\)\)\)/);
    expect(/fun register\(\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '').toMatch(/startCallWatch\(\)\n {2}\}$/);
    expect(/fun unregister\(\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '').toMatch(/stopCallWatch\(\)\n {2}\}$/);
    // Below API 31 the row tick re-reads the mode, before the row goes out.
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/if \(Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.S\) phone\.checkCall\(\)\s*val body = LinkedHashMap/);
  });
});

describe('native-android: the phone heading for the driving-screen compass (PhoneHeading; WP08)', () => {
  const HEADING = () => code(kt('HeadingSource'));
  const PH = () => code(kt('PhoneHeadingModule'));

  it('its own Android-only module, so the shared DriveSense surface stays the same on both platforms', () => {
    const config = JSON.parse(read(join(__dirname, '..', 'expo-module.config.json'))) as { apple: { modules: string[] }; android: { modules: string[] } };
    expect(config.android.modules).toContain('expo.modules.drivesense.PhoneHeadingModule');
    expect(config.apple.modules).not.toContain('PhoneHeadingModule');
    expect(PH()).toMatch(/Name\("PhoneHeading"\)/);
    expect(PH()).toMatch(/Events\("heading"\)/);
    for (const f of ['available', 'start', 'stop']) expect(PH()).toContain(`Function("${f}")`);
    expect(PH()).not.toMatch(/AsyncFunction/);
    expect(PH()).toMatch(/OnDestroy \{ stopAll\(\) \}/);
    // Never on the DriveSense module (its events and methods are the shared lists).
    expect(MODULE()).not.toMatch(/HeadingSource|"heading"/);
  });

  it('starts and stops are counted: one sensor for every screen asking, off with the last stop', () => {
    const src = PH();
    expect(src).toMatch(/if \(!s\.start\(\)\) return@Function false\s*users \+= 1/);
    expect(src).toMatch(/if \(users > 0\) \{\s*users -= 1\s*if \(users == 0\) source\?\.stop\(\)/);
  });

  it('the rotation vector at 10 Hz, live, to JS at most 5 a second, registered only between start and stop', () => {
    const src = HEADING();
    expect(src).toMatch(/SAMPLING_PERIOD_US = 100_000/);
    expect(src).toMatch(/EMIT_MIN_INTERVAL_MS = 200L/);
    expect(src).toMatch(/sm\.registerListener\(this, s, SAMPLING_PERIOD_US, handler\)/);
    expect(src.match(/\bregisterListener\(/g)).toHaveLength(2); // the rotation vector and the magnetometer
    expect(src).toMatch(/fun stop\(\) \{[\s\S]*?unregisterListener\(this, s\)/);
    expect(allKotlin().match(/HeadingSource\(/g)?.length).toBe(2); // the class and the module's one instance
  });

  it('true north from the declination at the cached location (no fix asked for), else magnetic; unreliable readings carry accuracy 0', () => {
    const src = HEADING();
    expect(src).toMatch(/GeomagneticField\(/);
    expect(src).toMatch(/getLastKnownLocation\(p\)/);
    expect(src).not.toMatch(/requestLocationUpdates|getCurrentLocation|FusedLocationProviderClient/);
    expect(src).toMatch(/if \(!DriveSensePermissions\.hasForegroundLocation\(app\)\) return null/);
    expect(src).toMatch(/"trueHeading" to \(declination\?\.let \{ HeadingMath\.norm\(mag \+ it\) \} \?: -1\.0\)/);
    expect(src).toMatch(/"magHeading" to mag/);
    expect(src).toMatch(/"accuracy" to HeadingMath\.accuracyLevel\(HeadingMath\.status\(event\.accuracy, magnetStatus\), estimate\)/);
    expect(src).toMatch(/if \(status <= SENSOR_STATUS_UNRELIABLE\) return 0/);
    expect(existsSync(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'HeadingMathTest.kt'))).toBe(true);
  });

  it("the calibration is the magnetometer's status (Android sends every rotation-vector event as high), registered slow beside it and only while the heading runs", () => {
    const src = HEADING();
    expect(src).toMatch(/MAGNETOMETER_PERIOD_US = 200_000/);
    expect(src).toMatch(/getDefaultSensor\(Sensor\.TYPE_MAGNETIC_FIELD\)[\s\S]*?sm\.registerListener\(this, m, MAGNETOMETER_PERIOD_US, handler\)/);
    expect(src).toMatch(/if \(event\.sensor\.type == Sensor\.TYPE_MAGNETIC_FIELD\) \{\s*magnetStatus = event\.accuracy\s*return/);
    expect(src).toMatch(/if \(sensor\?\.type == Sensor\.TYPE_MAGNETIC_FIELD\) magnetStatus = accuracy/);
    expect(src).toMatch(/fun stop\(\) \{[\s\S]*?sensorManager\?\.unregisterListener\(this, m\)[\s\S]*?magnetStatus = null/);
    expect(src).toMatch(/magnetStatus = null\s*rotation = readRotation\(\)/);
    expect(src).toMatch(/if \(magnetStatus == null\) rotationStatus else minOf\(rotationStatus, magnetStatus\)/);
  });

  it('the top is the top of the screen: the display rotation, read at start and on every display change, is handed to the arithmetic', () => {
    const src = HEADING();
    expect(src).toMatch(/rotation = readRotation\(\)\s*val t = HandlerThread/);
    expect(src).toMatch(/displayManager\?\.registerDisplayListener\(displayListener, handler\)/);
    expect(src).toMatch(/fun stop\(\) \{[\s\S]*?displayManager\?\.unregisterDisplayListener\(displayListener\)/);
    expect(src).toMatch(/if \(displayId == Display\.DEFAULT_DISPLAY\) rotation = readRotation\(\)/);
    expect(src).toMatch(/getDisplay\(Display\.DEFAULT_DISPLAY\)\?\.rotation/);
    expect(src).toMatch(/HeadingMath\.heading\(HeadingMath\.rotationMatrix\([^\n]*\), rotation\)/);
    expect(src).not.toMatch(/defaultDisplay/);
  });
});
