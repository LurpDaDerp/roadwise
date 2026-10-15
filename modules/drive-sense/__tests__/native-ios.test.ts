// The iOS module read as text. Swift cannot be compiled or run under Jest, so this suite pins what
// can be checked statically against the JS contract: the event list, one AsyncFunction per contract
// method, the port's constants, the location and motion configuration, the manual-start-only rule
// (plan §1 decision 4), and the rule that `selfTest` runs the production extractor rather than a
// copy. The forgot-to-start reminder is held to "it only notifies" and to its policy mirror.
// Behaviour is proven by the device build.
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
      'TripReminderSession.swift',
      'TripReminderAccess.swift',
      'TripReminderPolicy.swift',
      'TripReminderWakePolicy.swift',
      'TripReminderNotifier.swift',
      'TripReminderAppDelegate.swift',
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

  it("starts standard location updates only from the capture source and the reminder's bounded session", () => {
    for (const f of swiftFiles) {
      const src = code(f);
      if (f === 'LocationSource.swift' || f === 'TripReminderSession.swift') continue;
      expect({ f, gps: /startUpdatingLocation|requestLocation\(/.test(src) }).toEqual({ f, gps: false });
    }
    expect(code('TripReminderSession.swift').match(/startUpdatingLocation\(/g)).toHaveLength(1);
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
    only(/isProtectedDataAvailable/, ['PhoneState.swift', 'TripReminder.swift']);
    const src = allCode();
    expect(src).not.toMatch(/CLCircularRegion|startMonitoring\(for|CLBackgroundActivitySession|CLServiceSession|willFinishLaunchingWithOptions|UNUserNotificationCenter\.current\(\)\.delegate\s*=|\.location\]/);
    expect(src).not.toMatch(/\barmed\b|func arm\(|disarm|"wake"|WakeLocation|WakeTask|nativeStarted: true/);
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

  it('the GPS session: automotive, ten-metre accuracy, every fix, never paused, no indicator; the watch filters at 10 m', () => {
    const src = code('TripReminderSession.swift');
    for (const s of [
      'm.activityType = .automotiveNavigation',
      'm.desiredAccuracy = kCLLocationAccuracyNearestTenMeters',
      'm.distanceFilter = kCLDistanceFilterNone',
      'm.pausesLocationUpdatesAutomatically = false',
      'm.allowsBackgroundLocationUpdates = true',
      'm.showsBackgroundLocationIndicator = false',
      'self.sessionManager.distanceFilter = 10',
      'sessionManager.allowsBackgroundLocationUpdates = false',
      'sessionManager.stopUpdatingLocation()',
      'timer.schedule(wallDeadline:',
    ]) {
      expect(src).toContain(s);
    }
    expect(allCode()).not.toMatch(/kCLLocationAccuracyKilometer|kCLLocationAccuracyThreeKilometers/);
    for (const f of reminderFiles()) expect({ f, coarse: /kCLLocationAccuracyHundredMeters/.test(code(f)) }).toEqual({ f, coarse: false });
  });

  it('the notification: sound, interruption level active (never time-sensitive or critical), url /home, one background "Not driving" action, categories merged', () => {
    const n = code('TripReminderNotifier.swift');
    expect(n).toContain('content.interruptionLevel = .active');
    expect(n).not.toMatch(/timeSensitive|\.critical/);
    // read raw for the url: a value, not a comment
    expect(read('TripReminderNotifier.swift')).toMatch(/content\.userInfo = \["url": "\/home"\]\n/);
    expect(n).not.toMatch(/"body"/);
    expect(n.match(/UNNotificationAction\(/g)).toHaveLength(1);
    expect(n).toMatch(/UNNotificationAction\(identifier: actionId, title: "Not driving", options: \[\]\)/);
    expect(read('TripReminderNotifier.swift')).not.toMatch(/\.foreground/);
    expect(n.indexOf('getNotificationCategories')).toBeGreaterThan(-1);
    expect(n.indexOf('getNotificationCategories')).toBeLessThan(n.indexOf('setNotificationCategories'));
    expect(n).toMatch(/static let identifier = "roadwise\.tripReminder"/);
    expect(n).toMatch(/static let title = "Want to record this drive\?"/);
    expect(n).toContain("when you're stopped and it's safe to open RoadWise and start your drive.");
    expect(n).toMatch(/settings\.authorizationStatus == \.authorized\b/);
  });

  it('the launch hook: didFinishLaunching only; "Not driving" only quiets the reminder; the notification center delegate is never set', () => {
    const d = code('TripReminderAppDelegate.swift');
    expect(d).toMatch(/didFinishLaunchingWithOptions/);
    expect(d).toMatch(/NotificationCenterManager\.shared\.addDelegate\(notDriving\)/);
    for (const f of swiftFiles.filter((x) => x !== 'TripReminderAppDelegate.swift')) {
      expect({ f, adds: /addDelegate\(/.test(code(f)) }).toEqual({ f, adds: false });
    }
    const body = /func didReceive\(_ response: UNNotificationResponse[\s\S]*?\n {2}\}/.exec(d)?.[0] ?? '';
    expect(body).toMatch(
      /guard response\.actionIdentifier == TripReminderNotifier\.notDrivingAction else \{ return false \}\s*TripReminder\.shared\.onNotDriving\(\)\s*return true\s*\}$/
    );
  });

  it('the stop check reads a fresh call state without emitting; the wake checks Low Power Mode', () => {
    const call = /static func anyCallActiveNow\(\)[\s\S]*?\n {2}\}/.exec(code('CallObserver.swift'))?.[0] ?? '';
    expect(call).toMatch(/CXCallObserver\(\)\.calls\.contains \{ !\$0\.hasEnded \}/);
    expect(call).not.toMatch(/emit/);
    expect(code('TripReminderSession.swift')).toContain('ctx.inCall = CallObserver.anyCallActiveNow()');
    expect(code('TripReminder.swift')).toContain('c.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled');
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
    expect(src).toContain(`static let PAUSE_DAYS: [Double] = [${PAUSE_DAYS.join(', ')}]`);
    const order = ['off', 'paused', 'quiet', 'permission', 'capturing', 'no-trip', 'recorded', 'reminded', 'after-drive', 'daily-cap'];
    const gate = /static func gate\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    const at = order.map((r) => gate.indexOf(`"${r}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    const stop = gate.slice(gate.indexOf('"too-soon"'));
    const stopOrder = ['too-soon', 'foreground', 'in-call', 'stale', 'on-foot'].map((r) => stop.indexOf(`"${r}"`));
    expect([...stopOrder].sort((x, y) => x - y)).toEqual(stopOrder);
  });
});
