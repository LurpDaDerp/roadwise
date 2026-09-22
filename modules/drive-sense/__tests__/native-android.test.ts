/** @jest-environment node */
// Task N3: the Android half of drive-sense cannot be compiled or run in Jest, so this suite holds
// the Kotlin sources and the module manifest to the binding contract by reading them as text
// (README §1, §2, §6, §7). Each check names the contract rule it guards; a failure here means the
// Android build would ship something the JS side, the watchdog ruling (rev1: C2) or the battery
// rules (design §3.5) do not allow.
import * as CONSTANTS from '../src/extract/constants';
import { FIRST_WINDOW_MS, MAX_ROW_GAP_MS, TIMEBASE_MAX_SKEW_MS } from '../src/extract/timebase';
import { EVENT_BUFFER_MAX } from '../src/fake';
import { DRIVE_SENSE_ERROR_CODES, DRIVE_SENSE_EVENTS, DRIVE_SENSE_METHODS } from '../src/types';

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

describe('native-android: files the brief names exist', () => {
  const files = [
    'DriveSenseModule',
    'CaptureService',
    'Watchdog',
    'ActivityTransitionReceiver',
    'BootReceiver',
    'DriveSenseHeadlessService',
    'LocationSource',
    'SensorSource',
    'GravityFilter',
    'FeatureExtractor',
    'Alignment',
    'PhoneStateReceiver',
    'NotificationFactory',
    'ExitInfoReader',
    'TransitionStore',
    'EventBus',
  ];
  it.each(files)('%s.kt', (name) => {
    expect(existsSync(join(KT_DIR, `${name}.kt`))).toBe(true);
  });
  it('the notification icon drawable', () => {
    expect(existsSync(join(MAIN, 'res', 'drawable', 'ic_drive_notification.xml'))).toBe(true);
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

  it('declares no AsyncFunction outside DRIVE_SENSE_METHODS, and none twice', () => {
    const declared = [...MODULE().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_SENSE_METHODS].sort());
  });

  it('registers the module under the name the JS wrapper requires', () => {
    expect(MODULE()).toMatch(/Name\("DriveSense"\)/);
  });

  it('observes every event (buffer flush) and the row listener (watchdog liveness)', () => {
    const src = MODULE();
    expect(src).toMatch(/OnStartObserving\(/);
    expect(src).toMatch(/OnStopObserving\(/);
  });

  it('rejects only with the contract error codes', () => {
    const used = new Set([...code(allKotlin()).matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]!));
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(DRIVE_SENSE_ERROR_CODES as readonly string[]).toContain(c);
    // The codes Android can raise (README §2 "Errors"); the excludeFromBackup codes are iOS-only.
    for (const c of ['E_PERMISSION', 'E_UNAVAILABLE', 'E_FGS_REFUSED', 'E_INVALID_INPUT']) {
      expect(DRIVE_SENSE_ERROR_CODES as readonly string[]).toContain(c);
      expect(used).toContain(c);
    }
  });

  it('isIgnoringBatteryOptimizations reads PowerManager for this package', () => {
    expect(code(allKotlin())).toMatch(/isIgnoringBatteryOptimizations\(\s*[\w.]*packageName\s*\)/);
  });
});

describe('native-android: manifest (brief Interfaces, rev1: I15)', () => {
  it.each([
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    'android.permission.ACTIVITY_RECOGNITION',
    'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.WAKE_LOCK',
  ])('uses-permission %s', (p) => {
    expect(MANIFEST()).toContain(`<uses-permission android:name="${p}"`);
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

  it('ActivityTransitionReceiver is not exported', () => {
    const m = /<receiver[^>]*android:name="\.ActivityTransitionReceiver"[^>]*>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android:exported="false"');
  });

  it('BootReceiver listens for BOOT_COMPLETED and MY_PACKAGE_REPLACED', () => {
    const m = /<receiver[^>]*android:name="\.BootReceiver"[\s\S]*?<\/receiver>/.exec(MANIFEST());
    expect(m).not.toBeNull();
    expect(m![0]).toContain('android.intent.action.BOOT_COMPLETED');
    expect(m![0]).toContain('android.intent.action.MY_PACKAGE_REPLACED');
  });
});

describe('native-android: arming and wakes', () => {
  it('the transitions PendingIntent is FLAG_MUTABLE on API 31+', () => {
    const src = code(allKotlin());
    expect(src).toMatch(/PendingIntent\.FLAG_MUTABLE/);
    expect(src).toMatch(/requestActivityTransitionUpdates\(/);
  });

  it('subscribes to IN_VEHICLE and WALKING, enter and exit', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    expect(src).toMatch(/DetectedActivity\.IN_VEHICLE/);
    expect(src).toMatch(/DetectedActivity\.WALKING/);
    expect(src).toMatch(/ACTIVITY_TRANSITION_ENTER/);
    expect(src).toMatch(/ACTIVITY_TRANSITION_EXIT/);
  });

  it('maps ENTER to automotive/high and walking/high (README §3)', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    expect(src).toMatch(/"automotive"/);
    expect(src).toMatch(/"walking"/);
    expect(src).toMatch(/"high"/);
    expect(src).not.toMatch(/"(low|medium)"/);
  });

  it('requestMotionPermission requests ACTIVITY_RECOGNITION at run time on API 29+', () => {
    const src = MODULE();
    expect(src).toMatch(/askForPermissions\([\s\S]{0,200}Manifest\.permission\.ACTIVITY_RECOGNITION/);
    expect(src).toMatch(/Build\.VERSION_CODES\.Q/);
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

describe('native-android: capture service and watchdog (rev1: I2, C2)', () => {
  it('CaptureService is START_STICKY and resumes on a null intent', () => {
    const src = code(kt('CaptureService'));
    expect(src).toMatch(/START_STICKY/);
    expect(src).toMatch(/intent\s*==\s*null/);
  });

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

  it('the notification channel is drive_recording at low importance', () => {
    const src = code(kt('NotificationFactory'));
    expect(src).toMatch(/"drive_recording"/);
    expect(src).toMatch(/IMPORTANCE_LOW/);
    expect(src).toMatch(/Recording your drive/);
    // A candidate that may be discarded is "Checking for a drive" (final review M5), and a
    // capture native starts in 'auto' mode opens as one until JS says otherwise.
    expect(src).toMatch(/Checking for a drive/);
    expect(src).toMatch(/if \(candidate\) return "Checking for a drive"/);
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/notifCandidate = mode == "auto"/);
    expect(svc).toMatch(/NotificationFactory\.build\(this, notifStartedAt, notifStationary, notifCandidate\)/);
    expect(code(kt('DriveSenseModule'))).toMatch(/state\["candidate"\] as\? Boolean \?: false/);
    expect(src).toMatch(/Recording drive · /);
  });

  it('no WorkManager (design §3.5)', () => {
    expect(allKotlin()).not.toMatch(/WorkManager|androidx\.work/);
    expect(read(join(ANDROID, 'build.gradle'))).not.toMatch(/androidx\.work/);
  });
});

describe('native-android: sensors and location (README §7, rev1: O8, I5)', () => {
  it('uses TYPE_ACCELEROMETER and TYPE_GYROSCOPE only — no rotation vector, no magnetometer', () => {
    const src = code(allKotlin());
    expect(src).toMatch(/Sensor\.TYPE_ACCELEROMETER\b/);
    expect(src).toMatch(/Sensor\.TYPE_GYROSCOPE\b/);
    expect(allKotlin()).not.toMatch(/TYPE_ROTATION_VECTOR|TYPE_MAGNETIC_FIELD|TYPE_GAME_ROTATION_VECTOR|TYPE_GRAVITY|TYPE_LINEAR_ACCELERATION/);
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
