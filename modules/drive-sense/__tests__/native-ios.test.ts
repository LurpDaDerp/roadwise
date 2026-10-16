// The iOS module read as text. Swift cannot be compiled or run under Jest, so this suite pins what
// can be checked statically against the JS contract: the event list, one AsyncFunction per contract
// method, the port's constants, the location and motion configuration, the manual-start-only rule
// (plan §1 decision 4), and the rule that `selfTest` runs the production extractor rather than a
// copy. The forgot-to-start reminder is held to "it only notifies" and to its policy mirror.
// Behaviour is proven by the device build.
import * as CONSTANTS from '../src/extract/constants';
import { REMINDER } from '../src/reminder/policy';
import { FIRST_WINDOW_MS, MAX_ROW_GAP_MS, TIMEBASE_MAX_SKEW_MS } from '../src/extract/timebase';
import { EVENT_BUFFER_MAX } from '../src/fake';
import { DRIVE_SENSE_ERROR_CODES, DRIVE_SENSE_EVENTS, DRIVE_SENSE_METHODS } from '../src/types';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The root
// tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the local
// shapes rather than an `import` from 'node:fs'.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const fs = require('node:fs') as {
  existsSync: (file: string) => boolean;
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...parts: string[]) => string };

const MODULE_DIR = path.join(__dirname, '..');
const IOS_DIR = path.join(MODULE_DIR, 'ios');

const swiftFiles = fs
  .readdirSync(IOS_DIR)
  .filter((f) => f.endsWith('.swift'))
  .sort();
const read = (f: string) => fs.readFileSync(path.join(IOS_DIR, f), 'utf8');
/** Swift source with `//` line comments removed, so a comment cannot satisfy or trip a check. */
const code = (f: string) =>
  read(f)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
const allCode = () => swiftFiles.map(code).join('\n');
const moduleCode = () => code('DriveSenseModule.swift');

describe('iOS drive-sense module (text)', () => {
  it("has the files the contract names; the one app-delegate subscriber is the reminder's launch hook", () => {
    for (const f of [
      'DriveSenseModule.swift',
      'CaptureController.swift',
      'LocationSource.swift',
      'MotionSource.swift',
      'ActivitySource.swift',
      'FeatureExtractor.swift',
      'Alignment.swift',
      'PhoneState.swift',
      'CallObserver.swift',
      'Watchdog.swift',
      'Backup.swift',
      'TripReminder.swift',
      'TripReminderLook.swift',
      'TripReminderAccess.swift',
      'TripReminderPolicy.swift',
      'TripReminderWakePolicy.swift',
      'TripReminderNotifier.swift',
      'TripReminderAppDelegate.swift',
      'TripReminderSelfTest.swift',
    ]) {
      expect(swiftFiles).toContain(f);
    }
    expect(swiftFiles).not.toContain('DriveSenseAppDelegateSubscriber.swift');
    const config = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'expo-module.config.json'), 'utf8'));
    expect(config.apple.modules).toEqual(['DriveSenseModule']);
    expect(config.apple.appDelegateSubscribers).toEqual(['TripReminderAppDelegate']);
    expect(code('TripReminderAppDelegate.swift')).toMatch(/public class TripReminderAppDelegate: ExpoAppDelegateSubscriber \{/);
  });

  it('keeps every Swift file under 300 lines', () => {
    for (const f of swiftFiles) {
      expect({ file: f, lines: read(f).split('\n').length < 300 }).toEqual({ file: f, lines: true });
    }
  });

  it('declares exactly DRIVE_SENSE_EVENTS, in order', () => {
    const m = moduleCode().match(/Events\(([^)]*)\)/);
    expect(m).not.toBeNull();
    const names = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(names).toEqual([...DRIVE_SENSE_EVENTS]);
  });

  it('declares one AsyncFunction per DRIVE_SENSE_METHODS entry and no others', () => {
    const declared = [...moduleCode().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_SENSE_METHODS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('observes listeners for every event (buffering and the row watchdog)', () => {
    const src = moduleCode();
    for (const e of DRIVE_SENSE_EVENTS) {
      expect(src).toContain(`OnStartObserving("${e}")`);
      expect(src).toContain(`OnStopObserving("${e}")`);
    }
  });

  it('rejects only with the contract error codes, each one used', () => {
    const used = new Set([...allCode().matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]));
    for (const c of used) expect(DRIVE_SENSE_ERROR_CODES).toContain(c);
    // iOS has no foreground service, so E_FGS_REFUSED is Android-only.
    for (const c of DRIVE_SENSE_ERROR_CODES.filter((x) => x !== 'E_FGS_REFUSED')) {
      expect(used).toContain(c);
    }
  });

  it('declares every extraction constant with the reference value', () => {
    const src = allCode();
    const declared = new Map(
      [...src.matchAll(/static let ([A-Z][A-Z0-9_]*)(?:\s*:\s*\w+)?\s*=\s*([-0-9.e]+)/g)].map(
        (x) => [x[1]!, Number(x[2])] as const
      )
    );
    const expected: Record<string, number> = {
      ...(CONSTANTS as unknown as Record<string, number>),
      TIMEBASE_MAX_SKEW_MS,
      MAX_ROW_GAP_MS,
      FIRST_WINDOW_MS,
      EVENT_BUFFER_MAX,
    };
    // The gravity filter's constants are Android-only (iOS answers its vectors `skipped`); the two
    // GRAVITY_* names the extractor itself uses are still required.
    const filterOnly = (name: string) =>
      name.startsWith('GRAVITY_') && name !== 'GRAVITY_MEAN_S' && name !== 'GRAVITY_STABILITY_RAD';
    for (const [name, value] of Object.entries(expected)) {
      if (typeof value !== 'number' || filterOnly(name)) continue;
      expect({ name, value: declared.get(name) }).toEqual({ name, value });
    }
  });

  it('configures capture location for 1 Hz automotive updates that never pause', () => {
    const src = code('LocationSource.swift');
    expect(src).toContain('pausesLocationUpdatesAutomatically = false');
    expect(src).toContain('allowsBackgroundLocationUpdates = true');
    expect(src).toContain('showsBackgroundLocationIndicator = false');
    expect(src).toContain('.automotiveNavigation');
    expect(src).toContain('kCLLocationAccuracyBest');
    expect(src).toContain('kCLDistanceFilterNone');
    // low rate (rev1: I5)
    expect(src).toContain('kCLLocationAccuracyHundredMeters');
    expect(src).toMatch(/distanceFilter = 50\b/);
  });

  it("starts standard location updates only from the capture source and the reminder's bounded look", () => {
    for (const f of swiftFiles) {
      const src = code(f);
      if (f === 'LocationSource.swift' || f === 'TripReminderLook.swift') continue;
      expect({ f, gps: /startUpdatingLocation|requestLocation\(/.test(src) }).toEqual({ f, gps: false });
    }
    expect(code('TripReminderLook.swift').match(/startUpdatingLocation\(/g)).toHaveLength(1);
  });

  // plan §1 decision 4: no arming and nothing that starts a capture by itself. The reminder's wake,
  // its "Always" request and its launch hook live in the reminder's own files only.
  it("wakes, Always and launch hooks only in the reminder's files; no regions, no relaunch reading, no arming", () => {
    const only = (re: RegExp, allowed: string[]) => {
      for (const f of swiftFiles) expect({ f, uses: re.test(code(f)) }).toEqual({ f, uses: allowed.includes(f) && re.test(code(f)) });
      for (const f of allowed) expect({ f, uses: re.test(code(f)) }).toEqual({ f, uses: true });
    };
    only(/startMonitoringSignificantLocationChanges/, ['TripReminder.swift']);
    only(/requestAlwaysAuthorization/, ['TripReminderAccess.swift']);
    only(/beginBackgroundTask/, ['TripReminder.swift']);
    only(/launchOptions/, ['TripReminderAppDelegate.swift']);
    only(/isProtectedDataAvailable/, ['PhoneState.swift']);
    const src = allCode();
    expect(src).not.toMatch(/CLCircularRegion|startMonitoring\(for|CLBackgroundActivitySession|CLServiceSession|willFinishLaunchingWithOptions|UNUserNotificationCenter\.current\(\)\.delegate\s*=|\.location\]/);
    expect(src).not.toMatch(/\barmed\b|func arm\(|disarm|WakeLocation|WakeTask|nativeStarted: true/);
    // No "wake" event: the string appears only in the self-test, as a decision-table row kind and a gate phase.
    for (const f of swiftFiles.filter((x) => x !== 'TripReminderSelfTest.swift')) expect({ f, wake: /"wake"/.test(code(f)) }).toEqual({ f, wake: false });
    const ctrl = code('CaptureController.swift');
    expect(ctrl).toMatch(/func startCapture\(mode newMode: String\) -> Bool \{\s*guard locationAuthorization != "none" else \{ return false \}/);
    // the motion feed runs only inside a capture
    expect(ctrl).toMatch(/private func beginCapture\([\s\S]*?ActivitySource\.startLive\(\)/);
    expect(ctrl).toMatch(/func stopCapture\(\)[\s\S]*?ActivitySource\.stopLive\(\)/);
    expect(ctrl.match(/ActivitySource\.startLive\(\)/g)).toHaveLength(1);
  });

  it('uses device motion in xArbitraryZVertical at 25 Hz and never the magnetometer', () => {
    const src = allCode();
    expect(code('MotionSource.swift')).toContain('.xArbitraryZVertical');
    expect(code('MotionSource.swift')).toContain('startDeviceMotionUpdates(using:');
    expect(src).not.toMatch(/xTrueNorth|xMagneticNorth|[Mm]agnetometer|magneticField|startUpdatingHeading/);
    expect(code('MotionSource.swift')).toMatch(/1\.0 \/ ExtractConstants\.IMU_RATE_HZ/);
  });

  it('runs the row-listener watchdog with the contract limit', () => {
    const src = code('Watchdog.swift');
    expect(src).toMatch(/NO_LISTENER_TIMEOUT_S\s*(?::\s*\w+)?\s*=\s*300\b/);
    expect(src).not.toMatch(/CLAIM_TIMEOUT/);
  });

  it('keeps watchdog deadlines on a clock that runs in sleep, checked on rows and fixes (N2N3 M1)', () => {
    const src = code('Watchdog.swift');
    expect(src).toContain('asyncAfter(wallDeadline:');
    expect(src).not.toMatch(/asyncAfter\(deadline:/);
    expect(src).toContain('CLOCK_MONOTONIC');
    const ctrl = code('CaptureController.swift');
    expect(ctrl).toMatch(/func handleFix[\s\S]{0,80}watchdog\.check\(\)/);
    expect(ctrl).toMatch(/func emitRow[\s\S]{0,120}watchdog\.check\(\)/);
  });

  it('tells the watchdog the old listeners are gone when a new module attaches (N2N3 M2)', () => {
    expect(code('EventHub.swift')).toMatch(
      /func attach[\s\S]{0,200}for e in had \{ self\.onListeningChanged\?\(e, false\) \}/
    );
  });

  it('maps motion activity with the README precedence', () => {
    const src = code('ActivitySource.swift');
    const order = ['.walking', '.running', '.cycling', '.automotive', '.stationary'].map((k) =>
      src.indexOf(`if a${k} {`)
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // No trip detection outside a capture: no look-back at the OS motion history.
  it("reads motion history only for the permission prompt and the reminder's look-backs, all in ActivitySource", () => {
    const src = allCode();
    expect(src).not.toMatch(/forgottenDrive|FORGOTTEN_MIN_S|checkForgottenDrive|setForgotToStartReminder|queryMotionHistory|static func history\(/);
    expect(src.match(/queryActivityStarting\(/g)).toHaveLength(2);
    expect(code('ActivitySource.swift').match(/queryActivityStarting\(/g)).toHaveLength(2);
    const lookBack = /private static func lookBack\([\s\S]*?\n {2}\}/.exec(code('ActivitySource.swift'))?.[0] ?? '';
    expect(lookBack).toMatch(/guard status\(\) == "granted", from < to else/);
    expect(lookBack).toMatch(/queryActivityStarting\(/);
    expect(lookBack).not.toMatch(/EventHub/);
    const prompt = /static func requestPermission\([\s\S]*?\n {2}\}/.exec(code('ActivitySource.swift'))?.[0] ?? '';
    expect(prompt).toMatch(/guard s == "undetermined" else/);
    expect(prompt).toMatch(/queryActivityStarting\(from: now\.addingTimeInterval\(-60\), to: now/);
  });

  // plan §6: the background surface
  it('setDriveDisplay forwards to the Live Activity through the roadwise.driveDisplay notification', () => {
    const src = moduleCode();
    expect(src).toMatch(/AsyncFunction\("setDriveDisplay"\) \{ \(state: DriveDisplayRecord, promise: Promise\) in\s*DriveDisplayBridge\.post\(state\)/);
    expect(src).toMatch(/static let name = Notification\.Name\("roadwise\.driveDisplay"\)/);
    expect(src).toMatch(/NotificationCenter\.default\.post\(name: name, object: nil, userInfo: info\)/);
    for (const k of ['unit', 'stopped', 'ended', 'speed', 'limit', 'points', 'pointsDelta']) expect(src).toContain(`"${k}"`);
    expect(src).toMatch(/struct DriveDisplayRecord: Record/);
    // review I1: a native stop (JS or the watchdog) ends the Live Activity too
    expect(src).toMatch(/static func postEnded\(\)[\s\S]{0,200}"ended": true/);
    const stop = /func stopCapture\(\) \{[\s\S]*?\n {2}\}/.exec(code('CaptureController.swift'))?.[0] ?? '';
    expect(stop).toContain('DriveDisplayBridge.postEnded()');
  });

  // plan §6; spec "Integrity · GPS spoofing"
  it('flags a simulated fix (iOS 15+ sourceInformation) and emits it as the row key `mock`, outside the FeatureRow payload', () => {
    const loc = code('LocationSource.swift');
    expect(loc).toMatch(/sourceInformation\?\.isSimulatedBySoftware \?\? false/);
    expect(loc).toMatch(/#available\(iOS 15\.0, \*\)/);
    expect(loc).toMatch(/mock: Self\.isSimulated\(l\)/);
    expect(code('ExtractMath.swift')).toMatch(/var mock: Bool = false/);
    expect(code('ExtractMath.swift')).not.toMatch(/"mock"/); // never in `payload`: the self-test rows stay the contract's keys
    const ctrl = code('CaptureController.swift');
    expect(ctrl).toMatch(/var body = row\.payload\s*body\["mock"\] = mock\s*EventHub\.shared\.emit\("row", body\)/);
    const pipe = code('RowPipeline.swift');
    expect(pipe).toMatch(/var onRow: \(\(ExtractedRow, Bool, Int\) -> Void\)\?/);
    expect(pipe).toMatch(/mock: fix\.mock\)/);
    expect(pipe).toMatch(/mock: fix\?\.mock \?\? false\)/);
  });

  it('polls protected data for the lock state and reports the lock signal', () => {
    const src = code('PhoneState.swift');
    expect(src).toContain('isProtectedDataAvailable');
    expect(src).toContain('canEvaluatePolicy(.deviceOwnerAuthentication');
    expect(src).toContain('thermalState');
  });

  it('observes calls and excludes files from backup', () => {
    expect(code('CallObserver.swift')).toContain('CXCallObserver');
    expect(code('Backup.swift')).toContain('isExcludedFromBackup = true');
  });

  it('maps excludeFromBackup failures to E_NOT_FOUND (nothing there) and E_IO (attribute not set)', () => {
    const src = moduleCode();
    expect(src).toMatch(/Backup\.Failure\.notFound\(let message\) \{\s*promise\.reject\("E_NOT_FOUND"/);
    expect(src).toMatch(/Backup\.Failure\.failed\(let message\) \{\s*promise\.reject\("E_IO"/);
  });

  it('answers the documented iOS constants', () => {
    const src = moduleCode();
    expect(src).toMatch(/AsyncFunction\("isIgnoringBatteryOptimizations"\)[\s\S]{0,120}resolve\(true\)/);
    expect(src).toMatch(/AsyncFunction\("getLastExitInfo"\)[\s\S]{0,120}resolve\(nil\)/);
  });

  it('self-tests the production FeatureExtractor, not a copy', () => {
    const src = allCode();
    // exactly one extractor implementation, and the self-test and the capture path both use it
    expect([...src.matchAll(/class FeatureExtractor\b/g)]).toHaveLength(1);
    expect([...src.matchAll(/func extractSecond\(/g)]).toHaveLength(1);
    expect(code('SelfTest.swift')).toContain('FeatureExtractor()');
    expect(code('RowPipeline.swift')).toContain('FeatureExtractor()');
    expect(code('SelfTest.swift')).toMatch(/"skipped"/);
    expect(code('SelfTest.swift')).toContain('"gravityFilter"');
    expect(code('SelfTest.swift')).toContain('"androidRaw"');
  });

  it('links the frameworks it uses', () => {
    const podspec = fs.readFileSync(path.join(IOS_DIR, 'DriveSense.podspec'), 'utf8');
    expect(podspec).toContain("s.frameworks = 'CoreLocation', 'CoreMotion', 'CallKit', 'LocalAuthentication', 'UserNotifications'");
    expect(podspec).toContain("s.dependency 'ExpoNotifications'");
    expect(podspec).toContain("s.platforms      = { :ios => '16.4' }");
  });
});

// The forgot-to-start reminder (README "Forgot-to-start reminder"): it only ever notifies.
describe('iOS forgot-to-start reminder (text)', () => {
  const reminderFiles = () => swiftFiles.filter((f) => f.startsWith('TripReminder'));

  it('no reminder file can start a capture, emit to JS or touch the capture core', () => {
    for (const f of reminderFiles()) {
      expect({ f, starts: /startCapture\(|beginCapture\(|EventHub\.shared\.emit|nativeStarted|CaptureController\.shared/.test(code(f)) }).toEqual({ f, starts: false });
    }
  });

  it('the capture pushes its start and end to the reminder (one direction only)', () => {
    const ctrl = code('CaptureController.swift');
    const begin = /private func beginCapture\([\s\S]*?\n {2}\}/.exec(ctrl)?.[0] ?? '';
    expect(begin).toContain('TripReminder.shared.onCaptureStarted()');
    const stop = /func stopCapture\(\) \{[\s\S]*?\n {2}\}/.exec(ctrl)?.[0] ?? '';
    expect(stop).toContain('TripReminder.shared.onCaptureEnded()');
    expect(ctrl.match(/TripReminder\./g)).toHaveLength(2);
  });

  it('the GPS look: automotive, ten-metre accuracy, every fix, never paused, no indicator; no watch after the post', () => {
    const src = code('TripReminderLook.swift');
    for (const s of [
      'm.activityType = .automotiveNavigation',
      'm.desiredAccuracy = kCLLocationAccuracyNearestTenMeters',
      'm.distanceFilter = kCLDistanceFilterNone',
      'm.pausesLocationUpdatesAutomatically = false',
      'm.allowsBackgroundLocationUpdates = true',
      'm.showsBackgroundLocationIndicator = false',
      'lookManager.allowsBackgroundLocationUpdates = false',
      'lookManager.stopUpdatingLocation()',
      'timer.schedule(wallDeadline:',
    ]) {
      expect(src).toContain(s);
    }
    expect(src).not.toMatch(/distanceFilter = 10|watch|"moved"|"driving"|"ttl"|horizontalAccuracy/);
    expect(allCode()).not.toMatch(/kCLLocationAccuracyKilometer|kCLLocationAccuracyThreeKilometers/);
    for (const f of reminderFiles()) expect({ f, coarse: /kCLLocationAccuracyHundredMeters/.test(code(f)) }).toEqual({ f, coarse: false });
    // every outcome of a held stop ends the look; a look that ran its full 10 min rests the next
    const stopped = /private func stopped\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(stopped).toMatch(/self\.endLook\("stopped"\)\s*\}\s*\}$/);
    expect(src).toMatch(/case "no-drive", "look-max":\s*endLook\(verdict\)/);
    expect(src).toMatch(/saveState\(TripReminderPolicy\.lookEnded\(s0, Self\.nowMs\(\), tr\.lastFastAt, verdict\)\)/);
  });

  it('the note: "Forgot to start drive?" / "Tap here to start", sound, interruption level active, the token in userInfo, no buttons, no link', () => {
    const n = code('TripReminderNotifier.swift');
    expect(n).toContain('content.interruptionLevel = .active');
    expect(n).toContain('content.sound = .default');
    expect(n).not.toMatch(/timeSensitive|\.critical/);
    expect(n).toMatch(/static let identifier = "roadwise\.tripReminder"/);
    expect(n).toMatch(/static let title = "Forgot to start drive\?"/);
    expect(n).toMatch(/static let body = "Tap here to start"/);
    expect(n).toMatch(/content\.userInfo = \["kind": "tripReminder", "reminderToken": token\]/);
    expect(read('TripReminderNotifier.swift')).not.toMatch(/"url"|\/home/);
    expect(n).not.toMatch(/UNNotificationAction|UNNotificationCategory|categoryIdentifier|setNotificationCategories|"Not driving"/);
    expect(n).toMatch(/settings\.authorizationStatus == \.authorized\b/);
    // a note iOS refused is reported, on main
    expect(n).toMatch(/add\(request\) \{ error in\s*DispatchQueue\.main\.async \{ done\(error == nil\) \}/);
    // the token: random per note
    expect(code('TripReminderLook.swift')).toContain('let token = UUID().uuidString');
  });

  it('the launch hook: didFinishLaunching only, no notification delegate anywhere; the notification center delegate is never set', () => {
    const d = code('TripReminderAppDelegate.swift');
    expect(d).toMatch(/didFinishLaunchingWithOptions/);
    expect(d).toMatch(/TripReminder\.shared\.resumeAtLaunch\(\)\s*return true/);
    expect(d).not.toMatch(/NotificationCenterManager|NotificationDelegate|didReceive|ExpoNotifications/);
    for (const f of swiftFiles) expect({ f, adds: /addDelegate\(|NotificationCenterManager/.test(code(f)) }).toEqual({ f, adds: false });
  });

  it('the reminder reads no call, no Low Power Mode and no app-in-front state: only the session rule decides', () => {
    const call = /static func anyCallActiveNow\(\)[\s\S]*?\n {2}\}/.exec(code('CallObserver.swift'))?.[0] ?? '';
    expect(call).toMatch(/CXCallObserver\(\)\.calls\.contains \{ !\$0\.hasEnded \}/);
    expect(call).not.toMatch(/emit/);
    for (const f of reminderFiles()) {
      expect({ f, reads: /CallObserver|isLowPowerModeEnabled|applicationState|appForeground|onNotDriving|registerCategory/.test(code(f)) }).toEqual({ f, reads: false });
    }
    // RoadWise coming to the front only brings the state up to now: a live note and a running look stay
    const active = /@objc private func appBecameActive\(\) \{[\s\S]*?\n {2}\}/.exec(code('TripReminder.swift'))?.[0] ?? '';
    expect(active).toMatch(/refresh \{ s in/);
    expect(active).not.toMatch(/TripReminderNotifier\.remove|endLook/);
  });

  it("the tap: claimed on main through the reminder's own claim (motion folded in first); nothing is ever held or emitted on iOS", () => {
    const m = moduleCode();
    expect(m).toMatch(/AsyncFunction\("claimReminderTap"\) \{ \(token: String, promise: Promise\) in\s*TripReminder\.shared\.claim\(token\) \{ promise\.resolve\(\$0\) \}\s*\}\.runOnQueue\(\.main\)/);
    expect(m).toMatch(/AsyncFunction\("takeReminderTap"\) \{ \(promise: Promise\) in\s*promise\.resolve\(nil\)\s*\}/);
    expect(allCode()).not.toMatch(/emit\("reminderTap"/);
  });

  it('"Always" is asked once, only from While Using, through the reminder; precise is required', () => {
    const a = code('TripReminderAccess.swift');
    expect(a).toMatch(/if current != \.authorizedWhenInUse \|\| defaults\.bool\(forKey: Key\.alwaysAsked\) \|\| alwaysPending != nil \{/);
    expect(a.indexOf('defaults.set(true, forKey: Key.alwaysAsked)')).toBeLessThan(a.indexOf('slcManager.requestAlwaysAuthorization()'));
    expect(code('TripReminder.swift')).toMatch(/slcManager\.authorizationStatus == \.authorizedAlways && slcManager\.accuracyAuthorization == \.fullAccuracy/);
    expect(moduleCode()).toMatch(/AsyncFunction\("requestReminderLocation"\) \{ \(promise: Promise\) in\s*TripReminder\.shared\.requestAlways \{ promise\.resolve\(\$0\) \}\s*\}\.runOnQueue\(\.main\)/);
  });

  it('the policy mirror is pure and has the reference constants', () => {
    for (const f of ['TripReminderPolicy.swift', 'TripReminderWakePolicy.swift']) {
      expect([...read(f).matchAll(/^import (\w+)/gm)].map((m) => m[1])).toEqual(['Foundation']);
    }
    const src = code('TripReminderPolicy.swift');
    const declared = new Map(
      [...src.matchAll(/static let ([A-Z][A-Z0-9_]*)(?:\s*:\s*\w+)?\s*=\s*([\d_.]+)/g)].map((m) => [m[1]!, Number(m[2]!.replace(/_/g, ''))] as const)
    );
    for (const [name, value] of Object.entries(REMINDER)) expect({ name, value: declared.get(name) }).toEqual({ name, value });
    expect([...declared.keys()].sort()).toEqual(Object.keys(REMINDER).sort());
    const gate = /static func gate\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    const inOrder = (order: string[]) => {
      const at = order.map((r) => gate.indexOf(`"${r}"`));
      expect({ order, found: at.every((i) => i > 0) }).toEqual({ order, found: true });
      expect([...at].sort((x, y) => x - y)).toEqual(at);
    };
    // the stop gate and the look gate, in the reference's order; no limit besides the session rule
    inOrder(['off', 'permission', 'capturing', 'no-session', 'reminded', 'not-driven', 'stale', 'on-foot']);
    inOrder(['off', 'permission', 'capturing', 'no-session', 'reminded', 'resting', 'not-fresh']);
    const both = src + code('TripReminderWakePolicy.swift');
    expect(both).not.toMatch(/PAUSE_DAYS|DAILY_CAP|POST_SPACING|TTL_MS|UNUSED_QUIET|NOT_DRIVING|MIN_IN_VEHICLE|AFTER_DRIVE|lowPower|inCall|appForeground|"too-soon"|"foreground"|"in-call"|"paused"|"quiet"|"sessions"/);
    // iOS has no vehicle state: nothing in the policy ever puts a session in the vehicle
    for (const f of ['TripReminderPolicy.swift', 'TripReminderWakePolicy.swift']) {
      expect({ f, sets: /inVehicle = true|inVehicle: true/.test(code(f)) }).toEqual({ f, sets: false });
    }
    expect(code('TripReminderWakePolicy.swift')).toContain('newSession(m.automotiveSince > 0 ? m.automotiveSince : a, a, inVehicle: false)');
    // a car standing still is no car motion; only 30 min without it starts a new run
    expect(code('TripReminderWakePolicy.swift')).toMatch(/if a\.automotive && !a\.stationary && a\.confident \{/);
    // the stored state: v3; a v2 keeps only its switch
    expect(src).toMatch(/if probe\.v == 2 \{\s*var s = ReminderState\(\)\s*s\.enabled = probe\.enabled \?\? false\s*return s\s*\}/);
  });

});

describe('iOS forgot-to-start reminder: one post, a stored state never overwritten by a missing read, every async step reloads, bounded checks', () => {
  it('one post call in all the Swift: the held stop, after the checks, with the stop still held; a note iOS refused is taken back', () => {
    expect(allCode().match(/TripReminderNotifier\.post\(/g)).toHaveLength(1);
    const look = code('TripReminderLook.swift');
    const stopped = /private func stopped\([\s\S]*?\n {2}\}/.exec(look)?.[0] ?? '';
    expect(stopped).toMatch(/if r\.effect == "post" \{\s*TripReminderNotifier\.post\(token\) \{ added in/);
    expect(stopped).toMatch(/if !added, let s1 = self\.loadState\(\) \{ self\.saveState\(TripReminderPolicy\.unposted\(s1, token\)\) \}/);
    // a check's answer for a look that has ended, or for a stop the car pulled away from, posts nothing
    expect(stopped.indexOf('guard let cur = self.current(tr) else { return }')).toBeGreaterThan(-1);
    const pulled = stopped.indexOf('if cur.stopStart != tr.stopStart {');
    expect(pulled).toBeGreaterThan(-1);
    expect(stopped.slice(pulled, pulled + 120)).toMatch(/self\.look = TripReminderPolicy\.seekAgain\(cur, Self\.nowMs\(\)\)\s*return/);
    expect(pulled).toBeLessThan(stopped.indexOf('TripReminderNotifier.post('));
    expect(stopped).toMatch(/TripReminderPolicy\.onStop\(s0, self\.context\(notificationsOk: notificationsOk\), Self\.nowMs\(\), walked: walked, token: token, lastFastAt: cur\.lastFastAt\)/);
    // fixes keep moving the tracker while a check is in flight; only the check acts
    expect(look).toMatch(/look = r\.tracker\s*if !checking \{ handle\(r\.verdict\) \}/);
  });

  it('a missing read is never saved back: nothing stored is nil, and only setEnabled writes a first state', () => {
    const load = /func loadState\(\) -> ReminderState\? \{[\s\S]*?\n {2}\}/.exec(code('TripReminder.swift'))?.[0] ?? '';
    expect(load).toMatch(/guard let data = defaults\.data\(forKey: Key\.state\) else \{ return nil \}\s*return TripReminderPolicy\.fromStored\(data\)/);
    expect(code('TripReminderAccess.swift')).toMatch(/TripReminderPolicy\.setEnabled\(TripReminderPolicy\.settle\(loadState\(\) \?\? ReminderState\(\), Self\.nowMs\(\), captureOpen\), on\)/);
    for (const f of swiftFiles) {
      const n = (code(f).match(/loadState\(\) \?\? /g) ?? []).length;
      expect({ f, n }).toEqual({ f, n: f === 'TripReminderAccess.swift' ? 1 : 0 });
    }
  });

  it('every async continuation reloads the state before it saves (no step saves a copy taken before its await)', () => {
    const r = code('TripReminder.swift');
    const after = (src: string, open: string) => {
      const i = src.indexOf(open);
      expect({ open, found: i }).not.toEqual({ open, found: -1 });
      const body = src.slice(i + open.length);
      const save = body.indexOf('saveState(');
      const load = body.indexOf('loadState()');
      expect({ open, reloads: load > -1 && load < save }).toEqual({ open, reloads: true });
    };
    // the refresh, the wake's motion read, the capture's start and end, and the claim (after its refresh)
    const fnBody = (fn: string) => new RegExp(`${fn.replace(/[()]/g, '\\$&')}[\\s\\S]*?\\n {2}\\}`).exec(r)?.[0] ?? '';
    after(fnBody('private func onWake()'), 'ActivitySource.recentAutomotive { motion in');
    for (const fn of ['func refresh(', 'func onCaptureStarted()', 'func onCaptureEnded()']) after(fnBody(fn), 'motionWhileOn { motion in');
    const claim = /func claim\(_ token: String[\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    after(claim, 'refresh { _ in');
    expect(claim).toMatch(/TripReminderPolicy\.claim\(s0, token, Self\.nowMs\(\), self\.captureOpen, false\)/);
    // the look's stop checks and the post's completion
    const stopped = /private func stopped\([\s\S]*?\n {2}\}/.exec(code('TripReminderLook.swift'))?.[0] ?? '';
    after(stopped, 'TripReminderNotifier.authorized { notificationsOk in');
    after(stopped, 'TripReminderNotifier.post(token) { added in');
    // a drive's start and end fold the motion history in first, so a stale clock never ends a live session
    expect(r).toMatch(/TripReminderPolicy\.captureStarted\(folded, at\)/);
    expect(r).toMatch(/TripReminderPolicy\.captureEnded\(folded, at, at\)/);
    expect(r).toMatch(/TripReminderPolicy\.foldMotion\(TripReminderPolicy\.clampTimes\(s0, at\), at, motion, false\)/);
    expect(r).toMatch(/TripReminderPolicy\.foldMotion\(TripReminderPolicy\.clampTimes\(s0, at\), at, motion, true\)/);
  });

  it('the motion history is read only while the reminder is on: off, no query at all (a refresh, a drive start or end)', () => {
    const r = code('TripReminder.swift');
    const helper = /func motionWhileOn\(_ done: @escaping \(MotionSummary\) -> Void\) \{[\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    expect(helper).toMatch(
      /guard loadState\(\)\?\.enabled == true else \{\s*done\(MotionSummary\(lastAutomotiveAt: 0, automotiveSince: 0, onFootNow: false\)\)\s*return\s*\}\s*ActivitySource\.recentAutomotive\(done\)/
    );
    // the helper and the wake are the only reads; the wake reads only after its gate, which answers "off" first
    expect(r.split('ActivitySource.recentAutomotive').length - 1).toBe(2);
    const wake = /private func onWake\(\)[\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    const gate = wake.indexOf('TripReminderPolicy.gate(s1, ctx, Self.nowMs(), .wake) == "ok"');
    expect(gate).toBeGreaterThan(-1);
    expect(wake.indexOf('ActivitySource.recentAutomotive')).toBeGreaterThan(gate);
    expect(code('TripReminderPolicy.swift')).toMatch(/static func gate\([^)]*\) -> String \{\s*if !s\.enabled \{ return "off" \}/);
    // off forgets the session, and the folds act only on a session, so the empty summary changes nothing
    expect(code('TripReminderPolicy.swift')).toMatch(/static func setEnabled\([^)]*\) -> ReminderState \{\s*if !on \{ return ReminderState\(\) \}/);
    expect(code('TripReminderWakePolicy.swift')).toMatch(/static func foldMotion\([^)]*\) -> ReminderState \{\s*var s = s0\s*if let x = s\.session \{/);
  });

  it('the wake off ends the look and takes a note still up down, its token gone', () => {
    const r = code('TripReminder.swift');
    const sync = /func syncWake\([\s\S]*?\n {2}\}/.exec(r)?.[0] ?? '';
    expect(sync).toMatch(/\} else if !want \{[\s\S]*endLook\("ended"\)\s*TripReminderNotifier\.remove\(\)\s*if let s0 = loadState\(\), !s0\.token\.isEmpty \{ saveState\(TripReminderPolicy\.noteGone\(s0\)\) \}/);
  });

  it('a wake whose background task expires lets the next wake run, and its late finish leaves a newer wake alone; the look clock bounds a check in flight', () => {
    const r = code('TripReminder.swift');
    expect(r).toMatch(/wakeId &\+= 1\s*let thisWake = wakeId\s*waking = true/);
    expect(r).toMatch(/task\.begin\(onExpire: \{ if self\.wakeId == thisWake \{ self\.waking = false \} \}\)/);
    expect(r).toMatch(/let finish = \{\s*if self\.wakeId == thisWake \{ self\.waking = false \}\s*task\.end\(\)/);
    expect(r.match(/self\.waking = false/g)).toHaveLength(2);
    expect(r).toMatch(/beginBackgroundTask\(withName: "drivesense\.tripReminder"\) \{ \[weak self\] in\s*onExpire\(\)\s*self\?\.end\(\)/);
    const look = code('TripReminderLook.swift');
    expect(look).toMatch(/private static let lookBoundMs = TripReminderPolicy\.IOS_LOOK_MAX_MS \+ TripReminderPolicy\.IOS_LOOK_NO_DRIVE_MS/);
    const tick = /private func tick\(\) \{[\s\S]*?\n {2}\}/.exec(look)?.[0] ?? '';
    expect(tick.indexOf('Self.lookBoundMs')).toBeGreaterThan(-1);
    expect(tick.indexOf('Self.lookBoundMs')).toBeLessThan(tick.indexOf('guard !checking else { return }'));
  });

  it('"walked off" is walking or running; cycling counts as on foot only at the look gate; a car standing still is read as such; every motion read is the last 3 h', () => {
    const a = code('ActivitySource.swift');
    expect(a).toMatch(/automotive: a\.automotive,\s*stationary: a\.stationary,\s*onFoot: a\.walking \|\| a\.running \|\| a\.cycling,\s*walking: a\.walking \|\| a\.running,/);
    expect(a).toMatch(/done\(list\.contains \{ \$0\.walking && \$0\.confident \}\)/);
    expect(a).toMatch(/static func recentAutomotive\(_ done: @escaping \(MotionSummary\) -> Void\) \{\s*let now = Date\(\)\s*lookBack\(from: now\.addingTimeInterval\(-TripReminderPolicy\.IOS_MOTION_LOOKBACK_MS \/ 1000\), to: now\)/);
    expect(code('TripReminderLook.swift')).toContain('ReminderFix(t: l.timestamp.timeIntervalSince1970 * 1000, speed: l.speed, speedAcc: l.speedAccuracy)');
  });

  it('SelfTest hands each reminder row to TripReminderSelfTest, which runs the production policy for every iOS row kind', () => {
    expect(code('SelfTest.swift')).toMatch(/case "reminder":\s*results\.append\(TripReminderSelfTest\.result\(name, v\?\["inputs"\]\)\)/);
    const st = code('TripReminderSelfTest.swift');
    for (const call of ['gate(', 'settle(', 'posted(', 'unposted(', 'noteGone(', 'claim(', 'captureStarted(', 'captureEnded(', 'setEnabled(', 'lookEnded(', 'onWake(', 'summarize(', 'onFix(', 'onStop(', 'foldMotion(', 'fromStored(']) {
      expect({ call, used: st.includes(`TripReminderPolicy.${call}`) }).toEqual({ call, used: true });
    }
    for (const kind of ['gate', 'ops', 'claim', 'wake', 'summary', 'fixes', 'stop', 'stored']) expect(st).toContain(`case "${kind}":`);
    // the same rows the JS diff expects iOS to skip
    expect(st).toMatch(/case "tap", "transitions", "expires":\s*return "an Android rule"/);
    expect(st).toMatch(/jsonBool\(row\["requireDelivery"\]\) == true \? "the hand-over check is Android's" : nil/);
    expect(st).toMatch(/== "captureTransitions" \} \? "a capture batch is an Android rule" : nil/);
    // the iOS claim: the motion history first, never the hand-over check
    expect(st).toMatch(/TripReminderPolicy\.claim\(s, token, now, capturing, false\)/);
    expect([...read('TripReminderSelfTest.swift').matchAll(/^import (\w+)/gm)].map((m) => m[1])).toEqual(['Foundation']);
    expect(st).not.toMatch(/TripReminder\.shared|UserDefaults|TripReminderNotifier|CLLocationManager/);
  });
});
