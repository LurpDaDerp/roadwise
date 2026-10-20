/** @jest-environment node */
// The Android half of drive-sense cannot be compiled or run in Jest, so this suite holds the Kotlin
// sources and the module manifest to the binding contract by reading them as text (README §1, §2,
// §6, §7). Each check names the contract rule it guards; a failure here means the Android build
// would ship something the JS side, the watchdog ruling (rev1: C2), the battery rules (design
// §3.5) or plan §1 decision 4 (manual start only, no Always) do not allow. The forgot-to-start
// reminder (README "Forgot-to-start reminder") is held to "it only notifies": no reminder file
// can reach a capture start, and its policy mirrors src/reminder/policy.ts.
import * as CONSTANTS from '../src/extract/constants';
import { NAV_APP_PACKAGES } from '../src/navPackages';
import { REMINDER } from '../src/reminder/policy';
import { FIRST_WINDOW_MS, MAX_ROW_GAP_MS, TIMEBASE_MAX_SKEW_MS } from '../src/extract/timebase';
import { EVENT_BUFFER_MAX } from '../src/fake';
import { DRIVE_SENSE_ERROR_CODES, DRIVE_SENSE_EVENTS, DRIVE_SENSE_METHODS, DRIVE_SENSE_SYNC_METHODS } from '../src/types';

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
    'AppVisibility',
    'DriveSensePackage',
    'NotificationFactory',
    'ExitInfoReader',
    'EventBus',
    'TripReminder',
    'TripReminderPolicy',
    'TripReminderState',
    'TripReminderNotifier',
    'ReminderBootReceiver',
    'TripReminderSelfTest',
    'DashpalLinkService',
    'AlertWakeLock',
    'AudioOutput',
  ];
  it.each(files)('%s.kt', (name) => {
    expect(existsSync(join(KT_DIR, `${name}.kt`))).toBe(true);
  });
  it('the notification icon drawable', () => {
    expect(existsSync(join(MAIN, 'res', 'drawable', 'ic_drive_notification.xml'))).toBe(true);
  });
  // plan §1 decision 4
  it.each(['BootReceiver', 'ForgotToStartReminder', 'TransitionStore', 'ReminderActionReceiver'])('no %s.kt', (name) => {
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
    'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
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

  it("the receivers: the transitions feed and the reminder's boot one, none exported; the boot one disabled until the reminder is on", () => {
    const receivers = [...MANIFEST().matchAll(/<receiver[^>]*android:name="([^"]+)"[^>]*>/g)];
    expect(receivers.map((r) => r[1])).toEqual(['.ActivityTransitionReceiver', '.ReminderBootReceiver']);
    for (const r of receivers) expect(r[0]).toContain('android:exported="false"');
    expect(receivers[1]![0]).toContain('android:enabled="false"');
    expect(receivers[0]![0]).not.toContain('android:enabled');
    expect(MANIFEST()).not.toMatch(/ReminderActionReceiver|NOT_DRIVING/);
  });
});

describe('native-android: a capture starts only from JS (plan §1 decision 4)', () => {
  it('the transition receiver never starts the capture service or emits a wake', () => {
    const rx = code(kt('ActivityTransitionReceiver'));
    expect(rx).not.toMatch(/startForegroundService|startService|startNative|startFromJs|CaptureService\.start|ACTION_START|HeadlessJs|getService\(|getForegroundService\(|"wake"/);
    expect(code(allKotlin())).not.toMatch(/ACTION_START_NATIVE|fun startNative|"wake"|\barmed\b/);
  });

  // The forgot-to-start reminder only notifies.
  it.each(['TripReminder', 'TripReminderPolicy', 'TripReminderState', 'TripReminderNotifier', 'ReminderBootReceiver', 'TripReminderSelfTest'])(
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

  it('the tiers: the capture asks for IN_VEHICLE, WALKING and RUNNING (ENTER and EXIT); the reminder IN_VEHICLE ENTER when idle, and in a session IN_VEHICLE ENTER and EXIT with the ENTERs of STILL, WALKING and RUNNING; never ON_FOOT', () => {
    const src = code(kt('ActivityTransitionReceiver'));
    expect(src).toMatch(/CAPTURE_TYPES\s*=\s*listOf\(DetectedActivity\.IN_VEHICLE,\s*DetectedActivity\.WALKING,\s*DetectedActivity\.RUNNING\)/);
    const tiers = /fun transitions\(tier: TripReminderPolicy\.Tier\)[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(tiers).toMatch(/Tier\.NONE -> emptyList\(\)/);
    expect(tiers).toMatch(/Tier\.CAPTURE -> CAPTURE_TYPES\.flatMap \{ type -> listOf\(type to ENTER, type to EXIT\) \}/);
    expect(tiers).toMatch(/Tier\.IDLE -> listOf\(DetectedActivity\.IN_VEHICLE to ENTER\)\n/);
    const trip = /Tier\.SESSION -> listOf\(([\s\S]*?)\)\n/.exec(tiers)?.[1] ?? '';
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
    // While capturing, the reminder gets the batch as vehicle state only, after JS has its events,
    // best effort, with the same replay stamp; it never posts from there.
    const fold = capture.indexOf('TripReminder.onCaptureTransitions(context, batch, subscribedAt)');
    expect(fold).toBeGreaterThan(capture.lastIndexOf('EventBus.emit("activity"'));
    expect(capture.slice(capture.lastIndexOf("try {", fold), fold + 120)).toMatch(/try \{\s*TripReminder\.onCaptureTransitions\(context, batch, subscribedAt\)\s*\} catch \(e: Exception\)/);
    const reminder = code(kt('TripReminder'));
    const onCapture = /fun onCaptureTransitions\([\s\S]*?\n {2}\}/.exec(reminder)?.[0] ?? '';
    expect(onCapture).toMatch(/TripReminderPolicy\.foldCaptureTransitions\(/);
    expect(onCapture).not.toMatch(/post\(|Notifier/);
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

  it("three notification channels: the capture's (NotificationFactory), the reminder's (TripReminderNotifier) and the DashPal link's (DashpalLinkService)", () => {
    const src = code(allKotlin());
    expect(src.match(/\bNotificationChannel\(/g)).toHaveLength(3);
    expect(code(kt('DashpalLinkService'))).toMatch(/\bNotificationChannel\(CHANNEL_ID, "DashPal link", NotificationManager\.IMPORTANCE_LOW\)/);
    expect(code(kt('NotificationFactory'))).toMatch(/\bNotificationChannel\(/);
    expect(code(kt('TripReminderNotifier'))).toMatch(/\bNotificationChannel\(CHANNEL_ID, "Drive reminder", NotificationManager\.IMPORTANCE_DEFAULT\)/);
    expect(src).not.toMatch(/"reminders"/);
  });

  it('the note: "Forgot to start drive?" / "Tap here to start", silent, no buttons; a tap opens RoadWise with the one-use token and nothing else', () => {
    const n = code(kt('TripReminderNotifier'));
    expect(n).toMatch(/const val CHANNEL_ID = "trip_reminder"/);
    expect(n).toMatch(/const val NOTIFICATION_ID = 7305/);
    expect(n).toMatch(/const val TITLE = "Forgot to start drive\?"/);
    expect(n).toMatch(/const val TEXT = "Tap here to start"/);
    expect(n).toMatch(/const val EXTRA_TAP = "expo\.modules\.drivesense\.REMINDER_TAP"/);
    expect(n).not.toMatch(/addAction\(|NOT_DRIVING|"Not driving"|ACTION_VIEW|Uri\.parse|getBroadcast|BigTextStyle/);
    expect(kt('TripReminderNotifier')).not.toMatch(/roadwise:\/\//);
    for (const s of ['setSilent(true)', 'setOnlyAlertOnce(true)', 'setSound(null, null)', 'enableVibration(false)', 'CATEGORY_RECOMMENDATION', 'setOngoing(false)', 'setAutoCancel(true)', 'setWhen(postedAt)', 'setShowWhen(true)', 'VISIBILITY_PUBLIC']) {
      expect(n).toContain(s);
    }
    expect(n).not.toMatch(/CATEGORY_REMINDER|setFullScreenIntent|setOngoing\(true\)|setSound\(Uri|DEFAULT_SOUND|DEFAULT_VIBRATE/);
    // The launcher activity, explicit, with the token; one immutable PendingIntent.
    const open = /private fun open\([\s\S]*?\n {2}\}/.exec(n)?.[0] ?? '';
    expect(open).toMatch(/context\.packageManager\.getLaunchIntentForPackage\(context\.packageName\) \?: return null/);
    expect(open).toMatch(/launch\.putExtra\(EXTRA_TAP, token\)\.addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK\)/);
    expect(n.match(/PendingIntent\.FLAG_IMMUTABLE or PendingIntent\.FLAG_UPDATE_CURRENT/g)).toHaveLength(1);
    expect(n.match(/PendingIntent\.get\w+\(/g)).toEqual(['PendingIntent.getActivity(']);
  });

  it('every notify carries a positive system timeout: none goes out without one, and a timeout not ahead cancels instead', () => {
    const n = code(kt('TripReminderNotifier'));
    const build = /private fun build\([\s\S]*?\n {2}\}/.exec(n)?.[0] ?? '';
    expect(build).toContain('.setTimeoutAfter(timeoutMs)');
    expect(n.match(/setTimeoutAfter\(/g)).toHaveLength(1);
    const notifies = [...n.matchAll(/\.notify\(/g)];
    expect(notifies).toHaveLength(2);
    for (const fn of ['post', 'refresh']) {
      const body = new RegExp(`fun ${fn}\\(context: Context, token: String, postedAt: Long, timeoutMs: Long\\)[\\s\\S]*?\\n {2}\\}`).exec(n)?.[0] ?? '';
      expect({ fn, guard: body.indexOf('if (timeoutMs <= 0L) {') }).not.toEqual({ fn, guard: -1 });
      expect(body.indexOf('if (timeoutMs <= 0L) {')).toBeLessThan(body.indexOf('.notify('));
      expect(body).toMatch(/nm\.notify\(NOTIFICATION_ID, note\)/);
      expect(body).toMatch(/build\(context, token, postedAt, timeoutMs\)/);
    }
    // A refresh never brings back a note that is no longer up.
    const refresh = /fun refresh\([\s\S]*?\n {2}\}/.exec(n)?.[0] ?? '';
    expect(refresh.indexOf('if (!showing(context)) return')).toBeGreaterThan(-1);
    expect(refresh.indexOf('if (!showing(context)) return')).toBeLessThan(refresh.indexOf('.notify('));
    expect(n).toMatch(/manager\(context\)\?\.activeNotifications\?\.any \{ it\.id == NOTIFICATION_ID \}/);
    // The timeout is the policy's: expiresAt − arrival.
    const r = code(kt('TripReminder'));
    expect(r).toMatch(/val timeout = r\.expiresAt - arrival/);
    expect(r).toMatch(/TripReminderPolicy\.Effect\.REFRESH -> TripReminderNotifier\.refresh\(context, r\.state\.token, r\.state\.postedAt, timeout\)/);
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

  it('the reminder reads no call and no app-in-front state any more: only the session rule decides', () => {
    for (const f of ['TripReminder', 'TripReminderPolicy', 'TripReminderNotifier', 'ActivityTransitionReceiver']) {
      expect({ f, reads: /AudioManager|getMyMemoryState|IMPORTANCE_FOREGROUND|MODE_IN_CALL|activeRecordingConfigurations/.test(code(kt(f))) }).toEqual({ f, reads: false });
    }
    const r = code(kt('TripReminder'));
    expect(r).toMatch(/private fun ctx\(context: Context\): ReminderCtx = ReminderCtx\(\s*permissionsOk = transitionsOk\(context\) && TripReminderNotifier\.enabled\(context\),\s*capturing = CaptureService\.isCapturing\s*\)/);
    expect(r).not.toMatch(/onNotDriving|inCall|appInForeground|paused|autoOff/);
  });

  it("a tap's token: random per note, handed over once (persisted), claimed only with the hand-over check; the claim takes the note down when the token goes", () => {
    const r = code(kt('TripReminder'));
    expect(r).toMatch(/private fun newToken\(\): String = UUID\.randomUUID\(\)\.toString\(\)/);
    expect(r).toMatch(/TripReminderPolicy\.onTransitions\(load\(context\), events, arrival, subscribedAt, ctx\(context\), newToken\(\)\)/);
    const tap = /fun onTapIntent\([\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    expect(tap).toMatch(/TripReminderPolicy\.tapDelivered\(load\(context\), token, now\)/);
    expect(tap).toMatch(/if \(!r\.delivered\) return TapDelivery\(false, now\)\s*save\(context, r\.state\)/);
    const claim = /fun claim\(context: Context, token: String\): Boolean \{[\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    expect(claim).toMatch(/TripReminderPolicy\.claim\(s0, token, now\(\), CaptureService\.isCapturing, true\)/);
    expect(claim).toMatch(/save\(context, r\.state\)/);
    expect(claim).toMatch(/if \(s0\.token\.isNotEmpty\(\) && r\.state\.token\.isEmpty\(\)\) TripReminderNotifier\.cancel\(context\)/);
    expect(claim).toMatch(/return r\.ok\s*\}$/);
    // RoadWise in front keeps a live note (same name as before: the motion design pins it), re-syncs the feed.
    const fg = /fun onAppForeground\([\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    expect(fg).toContain('ActivityTransitions.sync(context)');
    expect(fg).toContain('dropNoteIfNoToken(context, s)');
    expect(fg).not.toMatch(/TripReminderNotifier\.cancel/);
    expect(r).toMatch(/private fun dropNoteIfNoToken\(context: Context, s: ReminderState\) \{\s*if \(s\.token\.isEmpty\(\)\) TripReminderNotifier\.cancel\(context\)/);
  });

  it('a drive tells the reminder when it starts and ends (one direction only)', () => {
    const svc = code(kt('CaptureService'));
    const begin = /private fun beginCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(begin).toMatch(/TripReminder\.onCaptureStarted\(this\)/);
    const end = /private fun endCapture\([\s\S]*?\n {2}\}/.exec(svc)?.[0] ?? '';
    expect(end).toMatch(/private fun endCapture\(clearOpen: Boolean, headlessNow: Boolean = false, end: CaptureEnd\? = null\)/);
    expect(end).toMatch(/TripReminder\.onCaptureEnded\(this, end\)/);
    // JS's stop passes the drive's end; the watchdog's stop passes none (now)
    expect(svc).toMatch(/fun stopFromJs\(context: Context, end: CaptureEnd\?, done: \(\) -> Unit\)[\s\S]*?inst\.endCapture\(clearOpen = true, end = end\)/);
    expect(svc).toMatch(/endCapture\(clearOpen = true, headlessNow = true\)/);
    expect(MODULE()).toMatch(/AsyncFunction\("stopCapture"\) \{ kind: String, endedAt: Double, drivingAtEnd: Boolean, promise: Promise ->\s*CaptureService\.stopFromJs\(context, CaptureEnd\.of\(kind, endedAt, drivingAtEnd\)\) \{ promise\.resolve\(null\) \}/);
    const ce = code(kt('CaptureEnd'));
    expect(ce).toMatch(/"dropped" -> CaptureEnd\(null, drivingAtEnd\)/);
    expect(ce).toMatch(/"at" -> if \(endedAt\.isFinite\(\) && endedAt >= 0\.0\) CaptureEnd\(endedAt\.toLong\(\), drivingAtEnd\) else null/);
    expect(ce).toMatch(/else -> null/);
    const rem = code(kt('TripReminder'));
    expect(rem).toMatch(/fun onCaptureEnded\(context: Context, end: CaptureEnd\? = null\) \{\s*val now = now\(\)\s*val drivingEndedAt: Long\? = if \(end == null\) now else end\.drivingEndedAt\s*val drivingAtEnd = end\?\.drivingAtEnd == true\s*save\(context, TripReminderPolicy\.captureEnded\(TripReminderPolicy\.settle\(load\(context\), now, true\), now, drivingEndedAt, drivingAtEnd, true\)\)/);
    expect(svc.match(/TripReminder\./g)).toHaveLength(2);
  });

  it('the module: switch and status go to TripReminder; Android needs no reminder location; RoadWise in front takes the note down', () => {
    const m = MODULE();
    expect(m).toMatch(/AsyncFunction\("setTripReminder"\) \{ enabled: Boolean ->\s*TripReminder\.setEnabled\(context, enabled\)/);
    expect(m).toMatch(/AsyncFunction\("getTripReminderStatus"\) \{\s*TripReminder\.status\(context\)/);
    expect(m).toMatch(/AsyncFunction\("requestReminderLocation"\) \{\s*"notNeeded"\s*\}/);
    expect(m).toMatch(/OnActivityEntersForeground \{[\s\S]{0,160}TripReminder\.onAppForeground\(context\)/);
  });

  it("the module hands a tap's token to JS once: off the intent at once, never from Recents, only once handed over, and announced only then", () => {
    const m = MODULE();
    const read = /private fun readReminderTap\(intent: Intent\?\) \{[\s\S]*?\n {2}\}/.exec(m)?.[0] ?? '';
    expect(read).toMatch(/val token = i\.getStringExtra\(TripReminderNotifier\.EXTRA_TAP\) \?: return\s*i\.removeExtra\(TripReminderNotifier\.EXTRA_TAP\)\s*if \(\(i\.flags and Intent\.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY\) != 0\) return/);
    expect(read.indexOf('removeExtra(')).toBeLessThan(read.indexOf('TripReminder.onTapIntent('));
    expect(read.indexOf('FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY')).toBeLessThan(read.indexOf('TripReminder.onTapIntent('));
    expect(read).toMatch(/val tap = TripReminder\.onTapIntent\(ctx, token\)\s*if \(tap\.delivered\) \{\s*synchronized\(tapLock\) \{ heldTap = token to tap\.at \}\s*EventBus\.emit\("reminderTap", emptyMap\(\)\)\s*\}/);
    // the only reminderTap emit in all the Kotlin
    expect(code(allKotlin()).match(/EventBus\.emit\("reminderTap"/g)).toHaveLength(1);
    // warm (singleTask: a new intent), cold (the foreground hook, before the reminder settles), and the take itself
    expect(m).toMatch(/OnNewIntent \{ intent -> readReminderTap\(intent\) \}/);
    const fg = /OnActivityEntersForeground \{[\s\S]*?\n {4}\}/.exec(m)?.[0] ?? '';
    expect(fg.indexOf('readReminderTap(appContext.currentActivity?.intent)')).toBeGreaterThan(-1);
    expect(fg.indexOf('readReminderTap(appContext.currentActivity?.intent)')).toBeLessThan(fg.indexOf('TripReminder.onAppForeground(context)'));
    const take = /AsyncFunction\("takeReminderTap"\) \{[\s\S]*?\n {4}\}/.exec(m)?.[0] ?? '';
    expect(take).toMatch(/if \(none\) readReminderTap\(appContext\.currentActivity\?\.intent\)/);
    expect(take).toMatch(/heldTap\.also \{ heldTap = null \}/);
    expect(take).toMatch(/linkedMapOf<String, Any\?>\("token" to it\.first, "at" to it\.second\)/);
    expect(m).toMatch(/AsyncFunction\("claimReminderTap"\) \{ token: String ->\s*TripReminder\.claim\(context, token\)\s*\}/);
    // the module never starts a capture for a tap
    expect(read + take).not.toMatch(/CaptureService|startCapture/);
  });

  it('TripReminderPolicy is pure and mirrors src/reminder/policy.ts', () => {
    const raw = kt('TripReminderPolicy');
    expect(raw).not.toMatch(/^import /m);
    const src = code(raw);
    const declared = new Map(
      [...src.matchAll(/const val ([A-Z][A-Z0-9_]*)\s*=\s*([\d_.]+)L?\b/g)].map((m) => [m[1]!, Number(m[2]!.replace(/_/g, ''))] as const)
    );
    for (const [name, value] of Object.entries(REMINDER)) expect({ name, value: declared.get(name) }).toEqual({ name, value });
    expect([...declared.keys()].sort()).toEqual(Object.keys(REMINDER).sort());
    // The stop gate's reasons, in the reference's order; no limit besides the session rule.
    const order = ['off', 'permission', 'capturing', 'no-session', 'reminded', 'not-driven', 'stale', 'on-foot', 'ok'];
    const gate = /fun gateStop\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    const at = order.map((r) => gate.indexOf(`"${r}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(gate.match(/return "/g)).toHaveLength(order.length);
    expect(src).not.toMatch(/PAUSE_DAYS|DAILY_CAP|POST_SPACING|TTL_MS|UNUSED_QUIET|NOT_DRIVING|MIN_IN_VEHICLE|AFTER_DRIVE|appForeground|inCall|"too-soon"|"foreground"|"in-call"|"paused"|"quiet"/);
    // The session ends only by time out of the vehicle, never while a drive is open.
    expect(src).toMatch(/if \(capturing \|\| x\.inVehicle \|\| t - x\.lastDrivingAt < SESSION_GAP_MS\) return s0/);
    // Each live event first decides the session's end on its own time; a lost EXIT opens a new session.
    expect(src).toMatch(/for \(e in events\.filter \{ it\.ts >= subscribedAt \}\.sortedWith\(BY_TIME\)\) \{\s*s = endIfOver\(s, e\.ts, cap\)/);
    expect(src).toMatch(/x\.inVehicle && e\.ts - x\.lastNewsAt >= SESSION_GAP_MS/);
    // A capture batch never posts and never marks driving speed.
    const fold = /fun foldCaptureTransitions\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(fold).toMatch(/x\.inVehicle = false/);
    expect(fold).not.toMatch(/posted|drove|token|endIfOver/);
  });
});

describe('native-android: the background surface (plan §6) — the foreground notification', () => {
  it('title "Driving", "34 mph · limit 35" with "-" for unknowns, points line only with points', () => {
    const src = code(kt('NotificationFactory'));
    expect(src).toMatch(/const val TITLE = "Driving"/);
    expect(src).toMatch(/setContentTitle\(TITLE\)/);
    expect(src).toMatch(/"\$speed · limit \$limit"/);
    expect(src).toMatch(/\?: "- \$\{d\.unit\}"/);
    expect(src).toMatch(/\?: "-"/);
    expect(src).toMatch(/val points = d\.points \?: return null/);
    expect(src).toMatch(/pointsLine\(d\)\?\.let \{ builder\.setSubText\(it\) \}/);
    // the total only
    expect(src).toMatch(/return "\$\{n\.format\(Math\.round\(points\)\)\} pts"/);
    expect(src).not.toMatch(/pointsDelta|deltaText/);
  });

  it("wears the app's sky: colorized in its middle stop once JS sends one, plain before", () => {
    const src = code(kt('NotificationFactory'));
    expect(src).toMatch(/fun skyColor\(d: DriveDisplay\): Int\? = d\.skyMid\?\.let \{ runCatching \{ Color\.parseColor\(it\) \}\.getOrNull\(\) \}/);
    expect(src).toMatch(/skyColor\(d\)\?\.let \{ builder\.setColor\(it\)\.setColorized\(true\) \}/);
    const types = code(kt('Types'));
    for (const k of ['skyTop', 'skyMid', 'skyLow', 'accent']) {
      expect(types).toContain(`val ${k}: String? = null`);
      expect(types).toContain(`${k} = hex(m["${k}"])`);
    }
    // "#RRGGBB" only; anything else is no colour
    expect(types).toContain('Regex("^#[0-9A-Fa-f]{6}$")');
    expect(types).toMatch(/private fun hex\(v: Any\?\): String\? = \(v as\? String\)\?\.takeIf \{ HEX\.matches\(it\) \}/);
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

  it('rows carry the bridge-only call state from the audio mode: ring, live (VoIP only with the microphone in use), nothing with none', () => {
    const fn = /fun callState\(context: Context\): String\? \{[\s\S]*?\n {4}\}/.exec(code(kt('PhoneStateReceiver')))?.[0] ?? '';
    expect(fn).toMatch(/AudioManager\.MODE_RINGTONE -> "ring"/);
    expect(fn).toMatch(/AudioManager\.MODE_IN_CALL -> "live"/);
    expect(fn).toMatch(/AudioManager\.MODE_IN_COMMUNICATION -> if \(am\.activeRecordingConfigurations\.isNotEmpty\(\)\) "live" else null/);
    expect(fn).toMatch(/else -> null/);
    expect(fn).toMatch(/catch \(_: Exception\) \{\s*null\s*\}/);
    const svc = code(kt('CaptureService'));
    expect(svc).toMatch(/body\["mock"\] = mock\s*PhoneStateReceiver\.callState\(applicationContext\)\?\.let \{ body\["call"\] = it \}\s*EventBus\.emit\("row", body\)/);
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

describe('native-android: the reminder posts in one place, and its rules run in the self-test', () => {
  it("one post call in all the Kotlin: the policy's POST effect, and a post that never showed is taken back", () => {
    expect(code(allKotlin()).match(/TripReminderNotifier\.post\(/g)).toHaveLength(1);
    expect(code(kt('TripReminder'))).toMatch(
      /TripReminderPolicy\.Effect\.POST ->\s*if \(!TripReminderNotifier\.post\(context, r\.state\.token, r\.state\.postedAt, timeout\)\) save\(context, TripReminderPolicy\.unposted\(r\.state, r\.state\.token\)\)/
    );
  });

  it('the stored state is v3; a stored v2 keeps only its switch; anything else is off', () => {
    const st = code(kt('TripReminderState'));
    expect(st).toMatch(/\.put\("v", 3\)/);
    expect(st).toMatch(/2 -> ReminderState\(enabled = o\.optBoolean\("enabled", false\)\)\s*3 -> v3\(o\)\s*else -> null/);
    expect(st).toMatch(/while \(tapSeen\.size > TripReminderPolicy\.TAP_SEEN_MAX\) tapSeen\.removeAt\(0\)/);
    expect(st).not.toMatch(/pauseLevel|missStreak|"posts"|showing|quietUntil/);
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
    for (const call of ['gateStop(', 'onTransitions(', 'settle(', 'posted(', 'unposted(', 'noteGone(', 'tapDelivered(', 'claim(', 'captureStarted(', 'captureEnded(', 'foldCaptureTransitions(', 'setEnabled(', 'noteExpiresAt(']) {
      expect({ call, used: st.includes(`TripReminderPolicy.${call}`) }).toEqual({ call, used: true });
    }
    expect(st).toMatch(/TripReminderState\.fromJson\(o\.toString\(\)\)/);
    expect(st).toMatch(/TripReminderState\.fromJson\(text\) \?: ReminderState\(\)/);
    // the same rows the JS diff expects Android to skip
    expect(st).toMatch(/"tap", "transitions", "expires", "stored" -> null\s*\/?\/?[^\n]*\n?\s*else -> "an iOS rule"/);
    expect(st).toMatch(/"gate" -> if \(row\.getString\("phase"\) == "stop"\) null/);
    expect(st).toMatch(/getString\("op"\) == "lookEnded"/);
    expect(st).toMatch(/"claim" -> if \(row\.getBoolean\("requireDelivery"\) && row\.isNull\("motion"\)\) null/);
    // the claim is the Android one, with the hand-over check
    expect(st).toMatch(/row\.getBoolean\("requireDelivery"\)\s*\)\s*JSONObject\(\)\.put\("ok", r\.ok\)/);
    // nothing in it touches the phone
    expect(st).not.toMatch(/Context|DriveSensePrefs|TripReminderNotifier|ActivityTransitions/);
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
    expect(src).toMatch(/override fun onCreate\(application: Application\) \{\s*AppVisibility\.register\(application\)\s*\}/);
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

  it('the notification: id 7310, a silent low-importance channel, "DashPal" and its two texts, opens RoadWise', () => {
    const src = SVC();
    expect(src).toMatch(/NOTIFICATION_ID = 7310/);
    expect(src).toMatch(/CHANNEL_ID = "dashpal_link"/);
    expect(src).toMatch(/IMPORTANCE_LOW/);
    expect(src).not.toMatch(/IMPORTANCE_MIN/);
    expect(src).toMatch(/setSound\(null, null\)\s*enableVibration\(false\)\s*setShowBadge\(false\)/);
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
