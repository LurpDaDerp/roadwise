/** @jest-environment node */
// The Android half of drive-sense cannot be compiled or run in Jest, so this suite holds the Kotlin
// sources and the module manifest to the binding contract by reading them as text (README §1, §2,
// §6, §7). Each check names the contract rule it guards; a failure here means the Android build
// would ship something the JS side, the watchdog ruling (rev1: C2), the battery rules (design
// §3.5) or plan §1 decision 4 (manual start only, no Always) do not allow. The forgot-to-start
// reminder (README "Forgot-to-start reminder") is held to "it only notifies": no reminder file
// can reach a capture start, and its policy mirrors src/reminder/policy.ts.
import * as CONSTANTS from '../src/extract/constants';
import { PAUSE_DAYS, REMINDER } from '../src/reminder/policy';
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
    'NotificationFactory',
    'ExitInfoReader',
    'EventBus',
    'TripReminder',
    'TripReminderPolicy',
    'TripReminderState',
    'TripReminderNotifier',
    'ReminderActionReceiver',
    'ReminderBootReceiver',
    'TripReminderSelfTest',
  ];
  it.each(files)('%s.kt', (name) => {
    expect(existsSync(join(KT_DIR, `${name}.kt`))).toBe(true);
  });
  it('the notification icon drawable', () => {
    expect(existsSync(join(MAIN, 'res', 'drawable', 'ic_drive_notification.xml'))).toBe(true);
  });
  // plan §1 decision 4
  it.each(['BootReceiver', 'ForgotToStartReminder', 'TransitionStore'])('no %s.kt', (name) => {
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
    for (const c of ['E_PERMISSION', 'E_FGS_REFUSED', 'E_INVALID_INPUT']) {
      expect(DRIVE_SENSE_ERROR_CODES as readonly string[]).toContain(c);
      expect(used).toContain(c);
    }
  });

  it('isIgnoringBatteryOptimizations reads PowerManager for this package', () => {
    expect(code(allKotlin())).toMatch(/isIgnoringBatteryOptimizations\(\s*[\w.]*packageName\s*\)/);
  });
});

describe('native-android: manifest (plan §1 decision 4: While Using only, no auto-start)', () => {
  it.each([
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACTIVITY_RECOGNITION',
    'com.google.android.gms.permission.ACTIVITY_RECOGNITION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
    'android.permission.RECEIVE_BOOT_COMPLETED',
  ])('uses-permission %s', (p) => {
    expect(MANIFEST()).toContain(`<uses-permission android:name="${p}"`);
  });

  it('never asks for background location', () => {
    expect(allKotlin() + MANIFEST()).not.toMatch(/ACCESS_BACKGROUND_LOCATION/);
  });

  it("only the reminder's boot receiver hears a boot or an update", () => {
    const files = readdirSync(KT_DIR).filter((f) => f.endsWith('.kt'));
    for (const f of files) {
      const hears = /BOOT_COMPLETED|MY_PACKAGE_REPLACED/.test(code(read(join(KT_DIR, f))));
      expect({ f, hears }).toEqual({ f, hears: f === 'ReminderBootReceiver.kt' });
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

  it("the receivers: the transitions feed and the reminder's two, none exported; the boot one disabled until the reminder is on", () => {
    const receivers = [...MANIFEST().matchAll(/<receiver[^>]*android:name="([^"]+)"[^>]*>/g)];
    expect(receivers.map((r) => r[1])).toEqual(['.ActivityTransitionReceiver', '.ReminderActionReceiver', '.ReminderBootReceiver']);
    for (const r of receivers) expect(r[0]).toContain('android:exported="false"');
    expect(receivers[2]![0]).toContain('android:enabled="false"');
    expect(receivers[0]![0]).not.toContain('android:enabled');
    expect(receivers[1]![0]).not.toContain('android:enabled');
  });
});

describe('native-android: a capture starts only from JS (plan §1 decision 4)', () => {
  it('the transition receiver never starts the capture service or emits a wake', () => {
    const rx = code(kt('ActivityTransitionReceiver'));
    expect(rx).not.toMatch(/startForegroundService|startService|startNative|startFromJs|CaptureService\.start|ACTION_START|HeadlessJs|getService\(|getForegroundService\(|"wake"/);
    expect(code(allKotlin())).not.toMatch(/ACTION_START_NATIVE|fun startNative|"wake"|\barmed\b/);
  });

  // The forgot-to-start reminder only notifies.
  it.each(['TripReminder', 'TripReminderPolicy', 'TripReminderState', 'TripReminderNotifier', 'ReminderActionReceiver', 'ReminderBootReceiver', 'TripReminderSelfTest'])(
    '%s.kt can never start a capture nor reach JS',
    (name) => {
      const src = code(kt(name));
      expect(src).not.toMatch(/startForegroundService|startService|startFromJs|startNative|CaptureService\.start|ACTION_START|EventBus\.emit|HeadlessJs|getService\(|getForegroundService\(/);
      // The only thing a reminder file reads of the capture is whether one is running.
      for (const m of src.matchAll(/CaptureService\.(\w+)/g)) expect(m[1]).toBe('isCapturing');
    }
  );

  it('CaptureService starts from JS or as the sticky restart of a capture JS had opened', () => {
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/ACTION_START_JS/);
    expect(svc).toMatch(/START_STICKY/);
    expect(svc).toMatch(/intent\s*==\s*null/);
    expect(svc).toMatch(/if \(!prefs\.captureOpen\) \{\s*stopSelf\(startId\)/);
    expect(svc).toMatch(/nativeStart = true/); // the sticky restart still needs the JS claim (watchdog)
  });

  it('the FGS refusal codes pass through unchanged (no Always to blame)', () => {
    const start = /AsyncFunction\("startCapture"\)[\s\S]*?\n {4}\}/.exec(MODULE())?.[0] ?? '';
    expect(start).toMatch(/promise\.reject\(coded\(code,/);
    expect(start).not.toMatch(/"always"/);
  });

  it('location is whenInUse or none: Android never reports always', () => {
    const src = code(kt('DriveSensePermissions'));
    expect(src).toMatch(/fun location\(context: Context\): String = if \(hasForegroundLocation\(context\)\) "whenInUse" else "none"/);
    expect(src).not.toMatch(/"always"/);
  });
});

describe('native-android: the activity feed (walking auto-end) and its one rule', () => {
  it('the transitions PendingIntent is FLAG_MUTABLE on API 31+', () => {
    const src = code(allKotlin());
    expect(src).toMatch(/PendingIntent\.FLAG_MUTABLE/);
    expect(src).toMatch(/requestActivityTransitionUpdates\(/);
  });

  it('the tiers: the capture asks for IN_VEHICLE, WALKING and RUNNING (ENTER and EXIT); the reminder IN_VEHICLE ENTER when idle, and in a trip IN_VEHICLE ENTER and EXIT with the ENTERs of STILL, WALKING and RUNNING; never ON_FOOT', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    expect(src).toMatch(/CAPTURE_TYPES\s*=\s*listOf\(DetectedActivity\.IN_VEHICLE,\s*DetectedActivity\.WALKING,\s*DetectedActivity\.RUNNING\)/);
    const tiers = /fun transitions\(tier: TripReminderPolicy\.Tier\)[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(tiers).toMatch(/Tier\.NONE -> emptyList\(\)/);
    expect(tiers).toMatch(/Tier\.CAPTURE -> CAPTURE_TYPES\.flatMap \{ type -> listOf\(type to ENTER, type to EXIT\) \}/);
    expect(tiers).toMatch(/Tier\.IDLE -> listOf\(DetectedActivity\.IN_VEHICLE to ENTER\)\n/);
    const trip = /Tier\.TRIP -> listOf\(([\s\S]*?)\)\n/.exec(tiers)?.[1] ?? '';
    expect(trip.split(',').map((x) => x.trim())).toEqual([
      'DetectedActivity.IN_VEHICLE to ENTER',
      'DetectedActivity.IN_VEHICLE to EXIT',
      'DetectedActivity.STILL to ENTER',
      'DetectedActivity.WALKING to ENTER',
      'DetectedActivity.RUNNING to ENTER',
    ]);
    expect(src).not.toMatch(/STILL to EXIT/);
    expect(src).not.toMatch(/ON_FOOT/);
    expect(src).toMatch(/ENTER = ActivityTransition\.ACTIVITY_TRANSITION_ENTER/);
    expect(src).toMatch(/EXIT = ActivityTransition\.ACTIVITY_TRANSITION_EXIT/);
  });

  it('maps ENTERs to automotive/walking/running at high, EXITs of the on-foot types to exit: true, an IN_VEHICLE EXIT to nothing', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    expect(src).toMatch(/DetectedActivity\.IN_VEHICLE\s*->\s*"automotive"/);
    expect(src).toMatch(/DetectedActivity\.WALKING\s*->\s*"walking"/);
    expect(src).toMatch(/DetectedActivity\.RUNNING\s*->\s*"running"/);
    expect(src).toMatch(/"exit" to true/);
    expect(src).not.toMatch(/"(low|medium)"/);
    expect(src).toMatch(/else if \(type != "automotive"\) \{\s*EventBus\.emit\("activity", linkedMapOf\("type" to type, "confidence" to "high", "ts" to ts, "exit" to true\)\)/);
  });

  it('activity reaches JS only while capturing; with no drive open the batch goes to the reminder, natively; the receiver writes no store or prefs itself', () => {
    const on = /override fun onReceive\([\s\S]*?\n {2}\}/.exec(code(kt('ActivityTransitionReceiver')))?.[0] ?? '';
    expect(on.match(/EventBus\.emit\("activity"/g)).toHaveLength(2);
    const capture = /if \(CaptureService\.isCapturing\) \{[\s\S]*?\n {6}return\n {4}\}/.exec(on)?.[0] ?? '';
    expect(capture.match(/EventBus\.emit\("activity"/g)).toHaveLength(2);
    expect(on.indexOf('TripReminder.onTransitions(')).toBeGreaterThan(on.indexOf(capture) + capture.length - 1);
    expect(on).toMatch(/val pending = goAsync\(\)[\s\S]*ActivityTransitions\.sync\(context\) \{ pending\.finish\(\) \}/);
    expect(on).not.toMatch(/\.append\(|\.edit\(\)|prefs\.\w+\s*=/);
  });

  it('the feed follows the tier (capture, or the reminder while it is on), with motion and Play services; synced at every entry point, best effort', () => {
    const rx = code(kt('ActivityTransitionReceiver'));
    expect(rx).toMatch(/fun tier\(context: Context\): TripReminderPolicy\.Tier =\s*TripReminderPolicy\.tier\(TripReminder\.state\(context\), CaptureService\.isCapturing, TripReminder\.transitionsOk\(context\)\)/);
    expect(code(kt('TripReminder'))).toMatch(/fun transitionsOk\(context: Context\): Boolean =\s*DriveSensePermissions\.motionGranted\(context\) && DriveSensePermissions\.playServicesAvailable\(context\)/);
    const policyTier = /fun tier\(s: ReminderState[\s\S]*?\n {2}\}/.exec(code(kt('TripReminderPolicy')))?.[0] ?? '';
    expect(policyTier).toMatch(/if \(!transitionsOk\) return Tier\.NONE\s*if \(capturing\) return Tier\.CAPTURE\s*if \(!s\.enabled\) return Tier\.NONE/);
    const sync = /fun sync\([\s\S]*?\n {2}\}/.exec(rx)?.[0] ?? '';
    expect(sync).toMatch(/try \{/);
    expect(sync).toMatch(/catch \(e: Exception\)/);
    expect(sync).not.toMatch(/throw /);
    expect(sync).toMatch(/if \(want == TripReminderPolicy\.Tier\.NONE\) \{\s*unsubscribe\(context\)/);
    // An identical request on file (this boot) is skipped; every new request is stamped before it goes out.
    expect(sync).toContain('val thisBoot = prefs.transitionsAtNanos in 1L..nowNanos');
    const skip = sync.indexOf('prefs.transitionsTier == want.name && thisBoot');
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(sync.indexOf('prefs.transitionsAtNanos = nowNanos'));
    expect(sync.indexOf('prefs.transitionsAtNanos = nowNanos')).toBeLessThan(sync.indexOf('subscribe(context, want)'));
    expect(sync).toMatch(/if \(force\) prefs\.transitionsTier = null/);
    const svc = code(kt('CaptureService'));
    const begin = /private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(begin).toMatch(/ActivityTransitions\.sync\(this\)/);
    const end = /private fun endCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(end).toMatch(/ActivityTransitions\.sync\(this\)/);
    const destroy = /override fun onDestroy\(\)[\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(destroy).toMatch(/ActivityTransitions\.sync\(this\)/);
    // At launch the feed is re-requested (force): one the system dropped comes back, one left behind goes.
    const create = /OnCreate \{[\s\S]*?\n {4}\}/.exec(MODULE())?.[0] ?? '';
    expect(create).toMatch(/TripReminder\.onLaunch\(context\)/);
    expect(code(kt('TripReminder'))).toMatch(/fun onLaunch\([\s\S]*?ActivityTransitions\.sync\(context, force = true\)/);
  });

  // C12 round 1 (review-C12 m1): no stale registration survives an abnormal end.
  it('the receiver checks "nothing wants the feed" FIRST: it unsubscribes and acts on nothing', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    const on = /override fun onReceive\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    const stale = on.indexOf('if (ActivityTransitions.tier(context) == TripReminderPolicy.Tier.NONE) {');
    expect(stale).toBeGreaterThan(-1);
    expect(on.slice(stale, stale + 200)).toMatch(/ActivityTransitions\.unsubscribe\(context\)\s*return/);
    expect(stale).toBeLessThan(on.indexOf('ActivityTransitionResult.extractResult'));
    expect(stale).toBeLessThan(on.indexOf('EventBus.emit'));
    expect(stale).toBeLessThan(on.indexOf('TripReminder.onTransitions'));
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

describe('native-android: with no drive open, only the forgot-to-start reminder, and it only notifies', () => {
  it('no motion history and none of the old reminder anywhere in the Kotlin', () => {
    const src = code(allKotlin());
    expect(src).not.toMatch(/ForgotToStart|TransitionStore|reminderEnabled|vehicleEnteredAt|captureRanInVehicle|lastReminderAt|queryMotionHistory|checkForgottenDrive/);
  });

  it("two notification channels: the capture's (NotificationFactory) and the reminder's (TripReminderNotifier)", () => {
    const src = code(allKotlin());
    expect(src.match(/\bNotificationChannel\(/g)).toHaveLength(2);
    expect(code(kt('NotificationFactory'))).toMatch(/\bNotificationChannel\(/);
    expect(code(kt('TripReminderNotifier'))).toMatch(/\bNotificationChannel\(CHANNEL_ID, "Drive reminder", NotificationManager\.IMPORTANCE_DEFAULT\)/);
    expect(src).not.toMatch(/"reminders"/);
  });

  it('the notification: silent, withdrawn after TTL_MS, tap opens roadwise://home, one action "Not driving", nothing that starts a drive', () => {
    const n = code(kt('TripReminderNotifier'));
    expect(n).toMatch(/const val CHANNEL_ID = "trip_reminder"/);
    expect(n).toMatch(/const val NOTIFICATION_ID = 7305/);
    expect(n).toMatch(/const val TITLE = "Want to record this drive\?"/);
    expect(n).toContain("when you're stopped and it's safe to open RoadWise and start your drive.");
    expect(n.match(/addAction\(/g)).toHaveLength(1);
    expect(n).toMatch(/addAction\(0, NOT_DRIVING, notDriving\(context\)\)/);
    expect(n).toMatch(/const val NOT_DRIVING = "Not driving"/);
    expect(n).not.toMatch(/"Start/);
    // read raw: the comment stripper would take the URL's `//` for a comment
    expect(kt('TripReminderNotifier')).toMatch(/val home = Intent\(Intent\.ACTION_VIEW, Uri\.parse\("roadwise:\/\/home"\)\)\s*\.setPackage\(context\.packageName\)/);
    for (const s of ['setTimeoutAfter(TripReminderPolicy.TTL_MS)', 'setSilent(true)', 'setSound(null, null)', 'enableVibration(false)', 'CATEGORY_RECOMMENDATION', 'setOngoing(false)']) {
      expect(n).toContain(s);
    }
    expect(n).not.toMatch(/CATEGORY_REMINDER|setFullScreenIntent|setOngoing\(true\)|setSound\(Uri|DEFAULT_SOUND|DEFAULT_VIBRATE/);
    // Both PendingIntents are immutable; the action goes to the unexported receiver.
    expect(n.match(/PendingIntent\.FLAG_IMMUTABLE or PendingIntent\.FLAG_UPDATE_CURRENT/g)).toHaveLength(2);
    expect(n).toMatch(/Intent\(context, ReminderActionReceiver::class\.java\)\.setAction\(ACTION_NOT_DRIVING\)/);
  });

  it('"Not driving" only quiets the reminder', () => {
    const rx = code(kt('ReminderActionReceiver'));
    expect(rx).toMatch(/if \(intent\.action != TripReminderNotifier\.ACTION_NOT_DRIVING\) return\s*DriveSensePrefs\.init\(context\)\s*TripReminder\.onNotDriving\(context\)\s*\}/);
  });

  it('the boot receiver only re-subscribes, under goAsync', () => {
    const on = /override fun onReceive\([\s\S]*?\n {2}\}/.exec(code(kt('ReminderBootReceiver')))?.[0] ?? '';
    expect(on).toMatch(
      /val action = intent\.action\s*if \(action != Intent\.ACTION_BOOT_COMPLETED && action != Intent\.ACTION_MY_PACKAGE_REPLACED\) return\s*val pending = goAsync\(\)\s*DriveSensePrefs\.init\(context\)\s*ActivityTransitions\.sync\(context, force = true\) \{ pending\.finish\(\) \}\s*\}$/
    );
  });

  it('only TripReminder switches the boot receiver, always with DONT_KILL_APP', () => {
    const files = readdirSync(KT_DIR).filter((f) => f.endsWith('.kt'));
    for (const f of files) {
      const calls = [...code(read(join(KT_DIR, f))).matchAll(/setComponentEnabledSetting\(([^)]*)\)/g)];
      if (f !== 'TripReminder.kt') expect({ f, calls: calls.length }).toEqual({ f, calls: 0 });
      else {
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c[1]).toMatch(/PackageManager\.DONT_KILL_APP/);
      }
    }
    expect(code(kt('TripReminder'))).toMatch(/ComponentName\(context, ReminderBootReceiver::class\.java\)/);
  });

  it('the phone as the reminder reads it: RoadWise in front, a call (a VoIP mode counts only with the microphone in use)', () => {
    const r = code(kt('TripReminder'));
    expect(r).toMatch(/info\.importance == ActivityManager\.RunningAppProcessInfo\.IMPORTANCE_FOREGROUND/);
    expect(r).toMatch(/AudioManager\.MODE_IN_CALL, AudioManager\.MODE_RINGTONE -> true/);
    expect(r).toMatch(/AudioManager\.MODE_IN_COMMUNICATION -> am\.activeRecordingConfigurations\.isNotEmpty\(\)/);
  });

  it('a drive tells the reminder when it starts and ends (one direction only)', () => {
    const svc = code(kt('CaptureService'));
    const begin = /private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(begin).toMatch(/TripReminder\.onCaptureStarted\(this\)/);
    const end = /private fun endCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(end).toMatch(/TripReminder\.onCaptureEnded\(this\)/);
    expect(svc.match(/TripReminder\./g)).toHaveLength(2);
  });

  it('the module: switch and status go to TripReminder; Android needs no reminder location; RoadWise in front takes the note down', () => {
    const m = MODULE();
    expect(m).toMatch(/AsyncFunction\("setTripReminder"\) \{ enabled: Boolean ->\s*TripReminder\.setEnabled\(context, enabled\)/);
    expect(m).toMatch(/AsyncFunction\("getTripReminderStatus"\) \{\s*TripReminder\.status\(context\)/);
    expect(m).toMatch(/AsyncFunction\("requestReminderLocation"\) \{\s*"notNeeded"\s*\}/);
    expect(m).toMatch(/OnActivityEntersForeground \{[\s\S]{0,80}TripReminder\.onAppForeground\(context\)/);
  });

  it('TripReminderPolicy is pure and mirrors src/reminder/policy.ts', () => {
    const raw = kt('TripReminderPolicy');
    expect(raw).not.toMatch(/^import /m);
    const src = code(raw);
    const declared = new Map(
      [...src.matchAll(/const val ([A-Z][A-Z0-9_]*)\s*=\s*([\d_.]+)L?\b/g)].map((m) => [m[1]!, Number(m[2]!.replace(/_/g, ''))] as const)
    );
    for (const [name, value] of Object.entries(REMINDER)) expect({ name, value: declared.get(name) }).toEqual({ name, value });
    expect(src).toMatch(new RegExp(`val PAUSE_DAYS = longArrayOf\\(${PAUSE_DAYS.map((d) => `${d}L`).join(', ')}\\)`));
    // The stop gate's reasons, in the reference's order.
    const order = ['off', 'paused', 'quiet', 'permission', 'capturing', 'no-trip', 'recorded', 'reminded', 'after-drive', 'daily-cap', 'too-soon', 'foreground', 'in-call', 'stale', 'on-foot', 'ok'];
    const gate = /fun gateStop\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    const at = order.map((r) => gate.indexOf(`"${r}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('native-android: the background surface (plan §6) — the foreground notification', () => {
  it('title "Driving", "34 mph · limit 35" with "—" for unknowns, points line only with points', () => {
    const src = code(kt('NotificationFactory'));
    expect(src).toMatch(/const val TITLE = "Driving"/);
    expect(src).toMatch(/setContentTitle\(TITLE\)/);
    expect(src).toMatch(/"\$speed · limit \$limit"/);
    expect(src).toMatch(/\?: "— \$\{d\.unit\}"/);
    expect(src).toMatch(/\?: "—"/);
    expect(src).toMatch(/val points = d\.points \?: return null/);
    expect(src).toMatch(/pointsLine\(d\)\?\.let \{ builder\.setSubText\(it\) \}/);
    expect(src).toMatch(/"\$\{n\.format\(Math\.round\(points\)\)\} pts\$deltaText"/);
  });

  it('the End drive action only while stopped (and not ended); tapping opens the app', () => {
    const src = code(kt('NotificationFactory'));
    expect(src).toMatch(/if \(d\.stopped && !d\.ended\) \{[\s\S]{0,400}addAction\(0, "End drive", pi\)/);
    expect(src).toMatch(/getLaunchIntentForPackage/);
  });

  it('setDriveDisplay reaches the running capture only, and the display resets with each capture', () => {
    expect(MODULE()).toMatch(/AsyncFunction\("setDriveDisplay"\) \{ state: Map<String, Any\?> ->\s*CaptureService\.setDriveDisplay\(DriveDisplay\.from\(state\)\)/);
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/fun setDriveDisplay\(display: DriveDisplay\) \{\s*val inst = instance \?: return/);
    expect(svc).toMatch(/NotificationFactory\.build\(this, display\)/);
    const begin = /private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(begin).toMatch(/display = null/);
    expect(code(kt('Types'))).toMatch(/data class DriveDisplay\(/);
  });

  it('the notification channel is drive_recording at low importance', () => {
    const src = code(kt('NotificationFactory'));
    expect(src).toMatch(/"drive_recording"/);
    expect(src).toMatch(/IMPORTANCE_LOW/);
    expect(src).not.toMatch(/Recording your drive|Checking for a drive/);
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

describe('native-android: the reminder posts in one place, and its rules run in the self-test', () => {
  it("one post call in all the Kotlin: the policy's POST effect, and a post that never showed is taken back", () => {
    expect(code(allKotlin()).match(/TripReminderNotifier\.post\(/g)).toHaveLength(1);
    expect(code(kt('TripReminder'))).toMatch(
      /TripReminderPolicy\.Effect\.POST -> if \(!TripReminderNotifier\.post\(context\)\) save\(context, unposted\(r\.state, arrival\)\)/
    );
  });

  it('a stored pause level out of range is read back into range', () => {
    expect(code(kt('TripReminderState'))).toMatch(/pauseLevel = o\.getInt\("pauseLevel"\)\.coerceIn\(0, TripReminderPolicy\.PAUSE_DAYS\.size\)/);
  });

  it('the feed skips a re-request only for a registration from this boot', () => {
    const rx = code(kt('ActivityTransitionReceiver'));
    expect(rx).toMatch(/Settings\.Global\.getInt\(context\.contentResolver, Settings\.Global\.BOOT_COUNT, -1\)/);
    expect(rx).toMatch(/val thisBoot = prefs\.transitionsAtNanos in 1L\.\.nowNanos && \(boot < 0 \|\| prefs\.transitionsBoot == boot\)/);
    expect(rx).toMatch(/if \(prefs\.transitionsTier == want\.name && thisBoot\) \{/);
    expect(rx).toMatch(/prefs\.transitionsAtNanos = nowNanos\s*prefs\.transitionsBoot = boot/);
  });

  it('SelfTest hands each reminder row to TripReminderSelfTest, which runs the production policy for every Android row kind', () => {
    expect(code(kt('SelfTest'))).toMatch(/"reminder" -> TripReminderSelfTest\.result\(name, inputs\)/);
    const st = code(kt('TripReminderSelfTest'));
    for (const call of ['gateStop(', 'onTransitions(', 'settle(', 'posted(', 'resolve(', 'captureStarted(', 'captureEnded(', 'appForeground(', 'setEnabled(']) {
      expect({ call, used: st.includes(`TripReminderPolicy.${call}`) }).toEqual({ call, used: true });
    }
    expect(st).toMatch(/TripReminderState\.fromJson\(o\.toString\(\)\)/);
    // the same rows the JS diff expects Android to skip
    expect(st).toMatch(/"transitions" -> null\s*else -> "an iOS rule"/);
    expect(st).toMatch(/"gate" -> if \(row\.getString\("phase"\) == "stop"\) null/);
    expect(st).toMatch(/getString\("op"\) == "sessionEnded"/);
    // nothing in it touches the phone
    expect(st).not.toMatch(/Context|DriveSensePrefs|TripReminderNotifier|ActivityTransitions/);
  });
});
