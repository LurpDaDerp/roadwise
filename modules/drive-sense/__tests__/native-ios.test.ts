// The iOS module read as text. Swift cannot be compiled or run under Jest, so this suite pins what
// can be checked statically against the JS contract: the two modules' events and methods, the
// port's constants, the location and motion configuration, where each OS facility may be touched
// (wakes, "Always", background tasks, notifications), the drive detector's transitions as written,
// and the rule that `selfTest` runs the production extractor and policy rather than copies.
// Behaviour is proven by the device build and its self-test.
import * as CONSTANTS from '../src/extract/constants';
import { DETECT } from '../src/detect/policy';
import { DRIVE_DETECT_ERROR_CODES, DRIVE_DETECT_EVENTS, DRIVE_DETECT_METHODS } from '../src/detect/types';
import { FIRST_WINDOW_MS, MAX_ROW_GAP_MS, TIMEBASE_MAX_SKEW_MS } from '../src/extract/timebase';
import { EVENT_BUFFER_MAX } from '../src/fake';
import { DRIVE_SENSE_ERROR_CODES, DRIVE_SENSE_EVENTS, DRIVE_SENSE_METHODS, DRIVE_SENSE_SYNC_METHODS } from '../src/types';

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
const detectCode = () => code('DriveDetectModule.swift');
/** A function's body, from its declaration to the first line closing at two-space indent. */
const fn = (src: string, decl: string) => new RegExp(`${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n {2}\\}`).exec(src)?.[0] ?? '';
const detector = () => code('DriveDetector.swift') + code('DriveDetectorDrive.swift') + code('DriveDetectorSensing.swift') + code('DriveDetectorWatch.swift');

/** `re` matches in exactly the `allowed` files (and in each of them). */
function only(re: RegExp, allowed: string[]) {
  for (const f of swiftFiles) expect({ f, uses: re.test(code(f)) }).toEqual({ f, uses: allowed.includes(f) && re.test(code(f)) });
  for (const f of allowed) expect({ f, uses: re.test(code(f)) }).toEqual({ f, uses: true });
}

describe('iOS drive-sense module (text)', () => {
  it('has the files the contract names, and none of the retired ones', () => {
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
      'Backup.swift',
      'EventHub.swift',
      'DriveDetector.swift',
      'DriveDetectorDrive.swift',
      'DriveDetectorSensing.swift',
      'DriveDetectorWatch.swift',
      'DetectStateRecord.swift',
      'WakeSources.swift',
      'DriveDetectAccess.swift',
      'DetectPolicy.swift',
      'DetectStartPolicy.swift',
      'DetectEndPolicy.swift',
      'DetectSelfTest.swift',
      'RowBuffer.swift',
      'RowJournal.swift',
      'RowJournalRead.swift',
      'DriveNotifier.swift',
      'DriveDetectModule.swift',
      'DriveDetectAppDelegate.swift',
    ]) {
      expect(swiftFiles).toContain(f);
    }
    for (const f of swiftFiles) expect({ f, retired: /^(LockProbe|Watchdog|TripReminder)/.test(f) }).toEqual({ f, retired: false });
  });

  it('registers both modules for Apple and the detector launch hook; the Android block is untouched', () => {
    const config = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'expo-module.config.json'), 'utf8'));
    expect(config.platforms).toEqual(['apple', 'android']);
    expect(config.apple.modules).toEqual(['DriveSenseModule', 'DriveDetectModule']);
    expect(config.apple.appDelegateSubscribers).toEqual(['DriveDetectAppDelegate']);
    expect(config.android).toEqual({ modules: ['expo.modules.drivesense.DriveSenseModule'] });
    expect(code('DriveDetectAppDelegate.swift')).toMatch(/public class DriveDetectAppDelegate: ExpoAppDelegateSubscriber \{/);
  });

  it('writes every assignment `=` with the same whitespace on both sides (Swift refuses `a =b`)', () => {
    for (const f of swiftFiles) {
      const lines = code(f).split('\n');
      lines.forEach((raw, i) => {
        const line = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        for (const m of line.matchAll(/(?<![=!<>+\-*/%&|^?~])=(?!=)/g)) {
          const before = line[m.index! - 1] ?? ' ';
          const after = line[m.index! + 1] ?? ' ';
          expect({ f, line: i + 1, balanced: /\s/.test(before) === /\s/.test(after) }).toEqual({ f, line: i + 1, balanced: true });
        }
      });
    }
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

  it('observes listeners for every event (buffering)', () => {
    const src = moduleCode();
    for (const e of DRIVE_SENSE_EVENTS) {
      expect(src).toContain(`OnStartObserving("${e}") { EventHub.shared.startObserving("${e}") }`);
      expect(src).toContain(`OnStopObserving("${e}") { EventHub.shared.stopObserving("${e}") }`);
    }
  });

  it('rejects only with the contract error codes of each module, each one used', () => {
    const codes = (src: string) => new Set([...src.matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]));
    const sense = codes(swiftFiles.filter((f) => f !== 'DriveDetectModule.swift').map(code).join('\n'));
    for (const c of sense) expect(DRIVE_SENSE_ERROR_CODES).toContain(c);
    // iOS has no foreground service, so E_FGS_REFUSED is Android-only.
    for (const c of DRIVE_SENSE_ERROR_CODES.filter((x) => x !== 'E_FGS_REFUSED')) expect(sense).toContain(c);
    expect([...codes(detectCode())]).toEqual([...DRIVE_DETECT_ERROR_CODES]);
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

  it('configures location for 1 Hz automotive updates that never pause, with no indicator and no distance filter anywhere (U3; the iOS 16.4 rule)', () => {
    const src = code('LocationSource.swift');
    expect(src).toContain('pausesLocationUpdatesAutomatically = false');
    expect(src).toContain('allowsBackgroundLocationUpdates = true');
    expect(src).toContain('.automotiveNavigation');
    expect(src).toContain('case .full: manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation');
    expect(src).toContain('case .low: manager.desiredAccuracy = kCLLocationAccuracyHundredMeters');
    expect(src).toContain('case .suppressed: manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters');
    expect(src).toMatch(/manager\.distanceFilter = kCLDistanceFilterNone/);
    const all = allCode();
    expect(all).not.toMatch(/distanceFilter = \d/);
    expect(all).not.toMatch(/showsBackgroundLocationIndicator = true/);
    for (const f of ['LocationSource.swift', 'WakeSources.swift']) expect(code(f)).toContain('showsBackgroundLocationIndicator = false');
    expect(all).not.toMatch(/kCLLocationAccuracyKilometer|kCLLocationAccuracyThreeKilometers/);
  });

  it('touches each OS facility in one place only', () => {
    only(/startUpdatingLocation|requestLocation\(/, ['LocationSource.swift']);
    only(/startMonitoringSignificantLocationChanges/, ['WakeSources.swift']);
    only(/startMonitoringVisits/, ['WakeSources.swift']);
    only(/startMonitoring\(for|CLCircularRegion/, ['WakeSources.swift']);
    only(/requestAlwaysAuthorization/, ['DriveDetectAccess.swift']);
    only(/beginBackgroundTask/, ['DriveDetector.swift']);
    only(/launchOptions/, ['DriveDetectAppDelegate.swift']);
    only(/UNUserNotificationCenter|UNMutableNotificationContent/, ['DriveNotifier.swift']);
    only(/FileHandle|createFile/, ['RowJournal.swift', 'RowJournalRead.swift']);
    only(/UserDefaults/, ['CaptureController.swift', 'DetectStateRecord.swift', 'DriveDetectAccess.swift']);
  });

  it('nothing of the retired phone-use and reminder code remains, and no relaunch reading', () => {
    const src = allCode();
    expect(src).not.toMatch(
      /CLMonitor\b|CLBackgroundActivitySession|CLServiceSession|LAContext|LocalAuthentication|isProtectedDataAvailable|NO_LISTENER_TIMEOUT|LockProbe|Watchdog|\bTripReminder|lockSignal\(\)|passcodeGone|willFinishLaunchingWithOptions|UNUserNotificationCenter\.current\(\)\.delegate\s*=|\.location\]|addDelegate\(|NotificationCenterManager/
    );
    // The Live Activity is live-drive's: drive-sense never requests one.
    expect(src).not.toMatch(/Activity\.request|Activity<|import ActivityKit[\s\S]*Activity\.request/);
    expect(src).not.toMatch(/emit\("screen"/);
  });

  it('uses device motion in xArbitraryZVertical at 25 Hz and never the magnetometer', () => {
    const src = allCode();
    expect(code('MotionSource.swift')).toContain('.xArbitraryZVertical');
    expect(code('MotionSource.swift')).toContain('startDeviceMotionUpdates(using:');
    expect(src).not.toMatch(/xTrueNorth|xMagneticNorth|[Mm]agnetometer|magneticField|startUpdatingHeading/);
    expect(code('MotionSource.swift')).toMatch(/1\.0 \/ ExtractConstants\.IMU_RATE_HZ/);
  });

  it('maps motion activity with the README precedence, and hands every live report to the detector before the JS dedupe', () => {
    const src = code('ActivitySource.swift');
    const order = ['.walking', '.running', '.cycling', '.automotive', '.stationary'].map((k) => src.indexOf(`if a${k} {`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const live = fn(src, 'static func startLive()');
    expect(live.indexOf('onLive?(report)')).toBeGreaterThan(-1);
    expect(live.indexOf('onLive?(report)')).toBeLessThan(live.indexOf('if let l = lastEmitted'));
    expect(live).toMatch(/walking: a\.walking \|\| a\.running,\s*cycling: a\.cycling,/);
    expect(live).toMatch(/confident: a\.confidence != \.low,/);
  });

  it('reads motion history only for the permission prompt and the detector, all in ActivitySource', () => {
    const src = allCode();
    expect(src.match(/queryActivityStarting\(/g)).toHaveLength(2);
    expect(code('ActivitySource.swift').match(/queryActivityStarting\(/g)).toHaveLength(2);
    const lookBack = fn(code('ActivitySource.swift'), 'private static func lookBack(');
    expect(lookBack).toMatch(/guard status\(\) == "granted", from < to else/);
    expect(lookBack).toMatch(/onFoot: a\.walking \|\| a\.running \|\| a\.cycling,/);
    expect(code('ActivitySource.swift')).toMatch(/done\(DetectPolicy\.summarize\(list, to\.timeIntervalSince1970 \* 1000\)\)/);
    const prompt = fn(code('ActivitySource.swift'), 'static func requestPermission(');
    expect(prompt).toMatch(/guard s == "undetermined" else/);
    expect(prompt).toMatch(/queryActivityStarting\(from: now\.addingTimeInterval\(-60\), to: now/);
  });

  it('setDriveDisplay forwards every key to the Live Activity through the roadwise.driveDisplay notification', () => {
    const src = moduleCode();
    expect(src).toMatch(/AsyncFunction\("setDriveDisplay"\) \{ \(state: DriveDisplayRecord, promise: Promise\) in\s*DriveDisplayBridge\.post\(state\)/);
    expect(src).toMatch(/static let name = Notification\.Name\("roadwise\.driveDisplay"\)/);
    expect(src).toMatch(/NotificationCenter\.default\.post\(name: name, object: nil, userInfo: info\)/);
    for (const k of ['unit', 'stopped', 'ended', 'speed', 'limit', 'points', 'pointsDelta', 'speeding', 'notDrivingAvailable']) expect(src).toContain(`"${k}"`);
    expect(src).toMatch(/struct DriveDisplayRecord: Record/);
    for (const k of ['skyTop', 'skyMid', 'skyLow', 'accent', 'speedTint', 'weatherKind', 'weatherText']) {
      expect(src).toContain(`@Field var ${k}: String?`);
      expect(src).toContain(`if let v = s.${k} { info["${k}"] = v }`);
    }
    expect(src).toContain('@Field var speeding: Bool = false');
    expect(src).toContain('@Field var notDrivingAvailable: Bool = false');
    // every end ends the Live Activity: a detector drive's, a cancel's and a plain capture's
    expect(src).toMatch(/static func postEnded\(\)[\s\S]{0,200}"ended": true/);
    expect(fn(code('DriveDetectorDrive.swift'), 'func finishSensing()')).toContain('DriveDisplayBridge.postEnded()');
    expect(fn(code('CaptureController.swift'), 'func stopPlainCapture()')).toContain('DriveDisplayBridge.postEnded()');
  });

  // plan §6; spec "Integrity · GPS spoofing"
  it('flags a simulated fix (iOS 15+ sourceInformation) and emits it as the row key `mock`, outside the FeatureRow payload', () => {
    const loc = code('LocationSource.swift');
    expect(loc).toMatch(/sourceInformation\?\.isSimulatedBySoftware \?\? false/);
    expect(loc).toMatch(/#available\(iOS 15\.0, \*\)/);
    expect(loc).toMatch(/mock: Self\.isSimulated\(l\)/);
    expect(code('ExtractMath.swift')).toMatch(/var mock: Bool = false/);
    expect(code('ExtractMath.swift')).not.toMatch(/"mock"/); // never in `payload`: the self-test rows stay the contract's keys
    const deliver = fn(code('CaptureController.swift'), 'private func deliverRow(');
    expect(deliver).toMatch(/var body = row\.payload\s*body\["mock"\] = mock\s*if let c = calls\.state\(\) \{ body\["call"\] = c \}/);
    // a plain capture's rows go to JS as they are; the detector's go to it (buffer or journal + seq)
    expect(deliver).toMatch(/if sensing == \.plain \{\s*emitRow\(body, ts: row\.ts\)\s*\} else \{\s*onRow\?\(row, body\)\s*\}/);
    const pipe = code('RowPipeline.swift');
    expect(pipe).toMatch(/var onRow: \(\(ExtractedRow, Bool, Int\) -> Void\)\?/);
    expect(pipe).toMatch(/mock: fix\.mock\)/);
    expect(pipe).toMatch(/mock: fix\?\.mock \?\? false\)/);
  });

  it('rows carry the bridge-only call state: "live" for a connected call, "ring" for one ringing or dialing, nothing with none', () => {
    const state = fn(code('CallObserver.swift'), 'func state() -> String? {');
    expect(state).toMatch(/dispatchPrecondition\(condition: \.onQueue\(\.main\)\)/);
    expect(state).toMatch(/guard let calls = observer\?\.calls else \{ return nil \}/);
    expect(state).toMatch(/if calls\.contains\(where: \{ \$0\.hasConnected && !\$0\.hasEnded \}\) \{ return "live" \}\s*if calls\.contains\(where: \{ !\$0\.hasEnded \}\) \{ return "ring" \}\s*return nil/);
    expect(state).not.toMatch(/emit/);
    expect(code('ExtractMath.swift')).not.toMatch(/"call"/);
  });

  it('reads no phone state: every row carries the fixed sample, the screen state is fixed, no lock proof', () => {
    const p = code('PhoneState.swift');
    expect(p).toMatch(/static func snapshot\(\) -> PhoneSample \{\s*PhoneSample\(locked: false, screenOn: true, appForeground: true\)\s*\}/);
    expect(p).not.toMatch(/UIApplication|import UIKit|LocalAuthentication/);
    expect(p).toContain('thermalState');
    const state = fn(code('CaptureController.swift'), 'func state() -> [String: Any] {');
    expect(state).toMatch(/"lockSignal": "unreliable",\s*"lockProof": false,\s*"lockDelayMs": NSNull\(\),/);
    expect(moduleCode()).toMatch(/AsyncFunction\("markLockProof"\) \{ \(_: Double, promise: Promise\) in\s*promise\.resolve\(nil\)\s*\}/);
  });

  it('the shared reminder methods are fixed answers on iOS', () => {
    const src = moduleCode();
    expect(src).toMatch(/AsyncFunction\("setTripReminder"\) \{ \(_: Bool, promise: Promise\) in\s*promise\.resolve\(DriveSenseModule\.reminderOff\(\)\)/);
    expect(src).toMatch(/AsyncFunction\("getTripReminderStatus"\) \{ \(promise: Promise\) in\s*promise\.resolve\(DriveSenseModule\.reminderOff\(\)\)/);
    expect(src).toMatch(/\["enabled": false, "state": "off", "missing": \[String\]\(\)\]/);
    expect(src).toMatch(/AsyncFunction\("requestReminderLocation"\) \{ \(promise: Promise\) in\s*let a = CaptureController\.shared\.locationAuthorization\s*promise\.resolve\(a == "none" \? "denied" : a\)/);
    expect(src).toMatch(/AsyncFunction\("claimReminderTap"\) \{ \(_: String, promise: Promise\) in\s*promise\.resolve\(false\)/);
    expect(src).toMatch(/AsyncFunction\("takeReminderTap"\) \{ \(promise: Promise\) in\s*promise\.resolve\(nil\)/);
  });

  it('navigation apps are found and opened by URL scheme in JS: the native list is empty and a launch is false', () => {
    expect(moduleCode()).toMatch(/AsyncFunction\("listInstalledApps"\) \{ \(_: \[String\], promise: Promise\) in\s*promise\.resolve\(\[\[String: Any\]\]\(\)\)\s*\}/);
    expect(moduleCode()).toMatch(/AsyncFunction\("launchApp"\) \{ \(_: String, promise: Promise\) in\s*promise\.resolve\(false\)\s*\}/);
    expect(allCode()).not.toMatch(/canOpenURL|openURL|UIApplication\.shared\.open\(/);
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

  it('self-tests the production FeatureExtractor and DetectPolicy, not copies; reminder vectors are Android’s', () => {
    const src = allCode();
    expect([...src.matchAll(/class FeatureExtractor\b/g)]).toHaveLength(1);
    expect([...src.matchAll(/func extractSecond\(/g)]).toHaveLength(1);
    expect(code('SelfTest.swift')).toContain('FeatureExtractor()');
    expect(code('RowPipeline.swift')).toContain('FeatureExtractor()');
    expect(code('SelfTest.swift')).toMatch(/"skipped"/);
    expect(code('SelfTest.swift')).toContain('"gravityFilter"');
    expect(code('SelfTest.swift')).toContain('"androidRaw"');
    expect(code('SelfTest.swift')).toMatch(/case "detect":\s*results\.append\(DetectSelfTest\.result\(name, v\?\["inputs"\]\)\)/);
    expect(code('SelfTest.swift')).toMatch(/case "reminder":\s*results\.append\(\["name": name, "kind": kind, "skipped": "an Android rule"\]\)/);
    expect([...src.matchAll(/enum DetectPolicy\b/g)]).toHaveLength(1);
  });

  it('links the frameworks it uses, and no notification or authentication pods any more', () => {
    const podspec = fs.readFileSync(path.join(IOS_DIR, 'DriveSense.podspec'), 'utf8');
    expect(podspec).toContain("s.frameworks = 'CoreLocation', 'CoreMotion', 'CallKit', 'UserNotifications', 'ActivityKit'");
    expect(podspec).not.toMatch(/ExpoNotifications|LocalAuthentication/);
    expect(podspec).toContain("s.platforms      = { :ios => '16.4' }");
  });

  it('sends each full-rate fix as a live `speed` event the moment it lands (never buffered), a candidate’s too', () => {
    const cap = code('CaptureController.swift');
    expect(cap).toMatch(/emitSpeed\(fix\)\s*pipeline\.queue\.async \{ self\.pipeline\.addFix\(fix\) \}/);
    expect(cap).toMatch(/EventHub\.shared\.emitLive\("speed", \[/);
    for (const key of ['"ts"', '"speed"', '"speedAcc"', '"hAcc"', '"ageMs"']) expect(cap).toContain(key);
    expect(cap).toMatch(/let age = Swift\.max\(0, TimeBase\.nowEpochMs\(\) - fix\.t\)/);
    const live = fn(code('EventHub.swift'), 'func emitLive(');
    expect(live).toMatch(/guard self\.listening\.contains\(event\), let sink = self\.sink else \{ return \}/);
    expect(live).not.toMatch(/buffer/);
  });
});

describe('iOS drive detector: the bridge (text)', () => {
  it('declares exactly DRIVE_DETECT_EVENTS, one AsyncFunction per DRIVE_DETECT_METHODS entry, each on main', () => {
    const src = detectCode();
    expect(src).toMatch(/Name\("DriveDetect"\)/);
    const names = [...(src.match(/Events\(([^)]*)\)/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(names).toEqual([...DRIVE_DETECT_EVENTS]);
    const declared = [...src.matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_DETECT_METHODS].sort());
    expect(src.match(/\.runOnQueue\(\.main\)/g)).toHaveLength(DRIVE_DETECT_METHODS.length);
    for (const e of DRIVE_DETECT_EVENTS) {
      expect(src).toContain(`OnStartObserving("${e}") { EventHub.detect.startObserving("${e}") }`);
      expect(src).toContain(`OnStopObserving("${e}") { EventHub.detect.stopObserving("${e}") }`);
    }
    expect(src).toMatch(/OnCreate \{\s*EventHub\.detect\.attach\(self\)\s*\}/);
  });

  it('two event hubs, each buffering EVENT_BUFFER_MAX events for its own module', () => {
    const hub = code('EventHub.swift');
    expect(hub).toMatch(/static let shared = EventHub\(\)\s*static let detect = EventHub\(\)/);
    expect(moduleCode()).toMatch(/OnCreate \{\s*EventHub\.shared\.attach\(self\)\s*\}/);
    expect(hub).not.toMatch(/onListeningChanged/);
  });

  it('discardDrive refuses the live drive with E_BUSY; a drive id must be a lowercase UUID before it names a file', () => {
    const src = detectCode();
    expect(src).toMatch(/if DriveDetector\.shared\.isLive\(driveId\) \{\s*promise\.reject\("E_BUSY"/);
    expect(src).toContain('"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"');
    expect(src.match(/DriveDetectModule\.isDriveId\(driveId\)/g)).toHaveLength(2);
    expect(src).toMatch(/let n = min\(max\(1, limit\), DetectPolicy\.READ_ROWS_MAX\)/);
  });

  it('wipe: sensing stops with no driveEnded, every journal file goes, the record starts empty (off, unarmed, no owner, last end, rest or drive), the wakes and the parked region stop', () => {
    expect(detectCode()).toMatch(/AsyncFunction\("wipe"\) \{ \(promise: Promise\) in\s*DriveDetector\.shared\.wipe \{ promise\.resolve\(nil\) \}\s*\}\.runOnQueue\(\.main\)/);
    const w = fn(detector(), 'func wipe(done:');
    expect(w).toMatch(/if isRecording \{\s*finishSensing\(\)\s*\} else if capture\.sensing == \.detector \|\| capture\.sensing == \.suppressed \{\s*capture\.endSensing\(\)\s*\}/);
    for (const step of ['stopClock()', 'endWakeTask()', 'buffer.clear()', 'lastOverStopTs = nil', 'save(DetectStateRecord())', 'wakes.stop()', 'journal.wipe(done: done)']) {
      expect({ step, found: w.includes(step) }).toEqual({ step, found: true });
    }
    expect(w).not.toMatch(/driveEnded|commitEnd|stopPlainCapture/);
    expect(w).toMatch(/emitState\(waiting \? "cancelled" : "disarmed"\)/);
    // a fresh record: off, not armed, no owner, no drive, no last end, no rest
    const rec = code('DetectStateRecord.swift');
    for (const field of ['var armed = false', 'var ownerId: String?\n', 'var state = "off"', 'var driveId: String?\n', 'var lastEnd: DetectLastEnd?\n', 'var suppressedSince: Double?\n', 'var suppressedUntil: Double?\n']) {
      expect({ field, declared: rec.includes(field) }).toEqual({ field, declared: true });
    }
    // the wakes stop with the parked region
    expect(fn(code('WakeSources.swift'), 'func stop()')).toMatch(/manager\.stopMonitoringSignificantLocationChanges\(\)\s*manager\.stopMonitoringVisits\(\)\s*setParked\(nil\)/);
    // the journal: the open file closed, every place forgotten, the whole directory deleted
    const jw = fn(code('RowJournal.swift'), 'func wipe(done:');
    expect(jw).toMatch(/queue\.async \{\s*self\.closeHandle\(\)\s*self\.cursors\.removeAll\(\)\s*if let dir = Self\.directory \{ try\? FileManager\.default\.removeItem\(at: dir\) \}\s*DispatchQueue\.main\.async\(execute: done\)/);
  });

  it('the launch hook resumes at didFinishLaunching only and adds no notification delegate', () => {
    const d = code('DriveDetectAppDelegate.swift');
    expect(d).toMatch(/didFinishLaunchingWithOptions/);
    expect(d).toMatch(/DriveDetector\.shared\.resumeAtLaunch\(\)\s*return true/);
    expect(d).not.toMatch(/NotificationCenterManager|NotificationDelegate|didReceive|ExpoNotifications/);
    // the first unlock after a reboot runs it again
    expect(code('DriveDetector.swift')).toMatch(/UIApplication\.protectedDataDidBecomeAvailableNotification[\s\S]{0,120}self\?\.resumeAtLaunch\(\)/);
  });
});

describe('iOS drive detector: the state machine (text)', () => {
  it('the record: "drivesense.detect", a missing read decides nothing, every change saved before its side effects', () => {
    const rec = code('DetectStateRecord.swift');
    expect(rec).toMatch(/static let key = "drivesense\.detect"/);
    expect(rec).toMatch(/guard let data = UserDefaults\.standard\.data\(forKey: key\) else \{ return nil \}/);
    const d = detector();
    expect(d).toMatch(/func save\(_ r: DetectStateRecord\) \{\s*rec = r\s*r\.save\(\)\s*\}/);
    const before = (body: string, first: string, then: string) => {
      expect({ first, found: body.indexOf(first) }).not.toEqual({ first, found: -1 });
      expect({ first, then, ordered: body.indexOf(first) < body.indexOf(then) }).toEqual({ first, then, ordered: true });
    };
    before(fn(d, 'func beginCandidate('), 'save(r)', 'capture.beginSensing()');
    before(fn(d, 'func beginDrive('), 'save(r)', 'journal.open(');
    before(fn(d, 'func commitEnd('), 'save(r)', 'finishSensing()');
    before(fn(d, 'func notDriving()'), 'save(r)', 'capture.beginSuppressedSensing()');
    before(fn(d, 'func endCandidate('), 'save(r)', 'capture.endSensing()');
    before(fn(d, 'func endSuppression()'), 'save(r)', 'capture.endSensing()');
  });

  it('arming: JS arms for an owner; Always + Precise + Motion are required; a new owner forgets the last end', () => {
    const d = detector();
    expect(d).toMatch(/func allowed\(_ r: DetectStateRecord\) -> Bool \{ r\.armed && r\.ownerId != nil && access\.snapshot\(\)\.requiredOk \}/);
    expect(fn(d, 'func setArmed(')).toMatch(/if armed && r\.ownerId != nil && r\.ownerId != ownerId \{ r\.lastEnd = nil \}/);
    expect(code('DriveDetectAccess.swift')).toMatch(/var requiredOk: Bool \{ DetectPolicy\.statusOf\(inputs\(armed: true\)\)\.requiredOk \}/);
    // the wakes run only while allowed and not off
    expect(fn(d, 'func syncWakes()')).toMatch(/if allowed\(r\) && r\.state != "off" \{ wakes\.start\(\) \} else \{ wakes\.stop\(\) \}/);
  });

  it('a wake: the gate first; a region exit starts a candidate at once, the others after the motion gate; inside a background task', () => {
    const wake = fn(detector(), 'func onWake(');
    expect(wake).toMatch(/guard DetectPolicy\.wakeGate\(ctx\) == "ok", capture\.sensing == \.off else \{ return \}\s*beginWakeTask\(\)/);
    expect(wake.indexOf('if reason == "region"')).toBeLessThan(wake.indexOf('ActivitySource.motionSummary'));
    expect(wake).toMatch(/DetectPolicy\.motionGate\(m, DriveDetector\.now\(\)\) == "ok"/);
    expect(fn(detector(), 'func onFix(')).toMatch(/if wakeTask != \.invalid \{ endWakeTask\(\) \}/);
    expect(detector()).toMatch(/beginBackgroundTask\(withName: "drivesense\.wake"\)/);
    expect(detector()).toMatch(/asyncAfter\(wallDeadline: \.now\(\) \+ DetectPolicy\.WAKE_TASK_MAX_MS \/ 1000\)/);
    // the wake's motion history seeds the candidate's car motion (the 15-20 mph band needs it)
    expect(wake).toMatch(/self\.beginCandidate\(origin: "auto", reason: "wake:\\\(reason\)", carMotionAt: m\.lastAutomotiveAt\)/);
    expect(wake).toMatch(/if reason == "region" \{\s*beginCandidate\(origin: "auto", reason: "wake:region"\)/);
  });

  it('RoadWise coming to the front is an "app" wake: on didBecomeActive and from JS appForeground, through the same gate', () => {
    expect(code('DriveDetector.swift')).toMatch(/UIApplication\.didBecomeActiveNotification, object: nil, queue: \.main\s*\) \{ \[weak self\] _ in self\?\.appForeground\(\) \}/);
    expect(fn(detector(), 'func appForeground()')).toMatch(/onWake\("app"\)/);
    expect(detectCode()).toMatch(/AsyncFunction\("appForeground"\) \{ \(promise: Promise\) in\s*DriveDetector\.shared\.appForeground\(\)\s*promise\.resolve\(nil\)\s*\}\.runOnQueue\(\.main\)/);
    expect(code('DetectPolicy.swift')).toMatch(/if c\.reason != "region" && c\.reason != "app" && c\.now < c\.candidateRestUntil \{ return "resting" \}/);
  });

  it('a candidate: rows into the ring, the hold confirmed by the policy (the veto for auto only); its clock ends it', () => {
    const d = detector();
    const row = fn(d, 'func onRow(');
    expect(row).toMatch(/buffer\.append\(d, body\)/);
    expect(row).toMatch(/let veto = kind == "auto" && vetoNow\(\)/);
    expect(row).toMatch(/if kind == "auto" && DetectPolicy\.moving\(d\) && !veto \{ lastVehicleTs = d\.ts \}/);
    expect(row).toMatch(/DetectPolicy\.confirmStep\(confirmState, d, kind, veto: veto, carFresh: kind == "auto" && carFresh\(\)\)/);
    expect(row).toMatch(/case "recording", "ending":\s*record\(d, body\)/);
    expect(fn(d, 'func tick()')).toMatch(/case "candidate":\s*candidateTick\(r, now\)/);
    const tick = fn(d, 'func candidateTick(');
    expect(tick).toMatch(/guard !confirming else \{ return \}/);
    expect(tick).toMatch(/if kind == "auto" && vehicleStanding \{ lastVehicleTs = now \}/);
    expect(tick).toMatch(/DetectPolicy\.candidateDue\(kind, since: r\.since, waitUntil: r\.waitUntil, walkSince: walkSince, now: now,\s*lastVehicleTs: lingering \? nil : lastVehicleTs, hasEvidence: confirmState\.evidence > 0\)/);
    expect(tick).toMatch(/endCandidate\(reason: cause, rest: !lingering && \(cause == "cap" \|\| \(cause == "timeout" && lastVehicleTs == nil\)\)\)/);
    const end = fn(d, 'func endCandidate(');
    expect(end).toMatch(/if rest \{ r\.candidateRestUntil = now \+ DetectPolicy\.CANDIDATE_REST_MS \}/);
    // only an empty candidate stays in the hourly cap's record (read before settle clears since)
    expect(end).toMatch(/let sawVehicle = lastVehicleTs != nil/);
    expect(end).toMatch(/r\.candidateStarts = DetectPolicy\.startsAfter\(r\.candidateStarts, since: r\.since, sawVehicle: sawVehicle\)\s*settle\(&r, now\)/);
    // an empty timeout (not the linger) leaves the parked spot where the phone rests
    expect(end).toMatch(/let parkHere = r\.origin == "auto" && !lingering && reason == "timeout" && !sawVehicle/);
    expect(end.indexOf('let parkHere')).toBeLessThan(end.indexOf('settle(&r, now)'));
    expect(end).toMatch(/if parkHere, r\.state == "armed", let f = lastFix \{ wakes\.setParked\(f\) \}\s*lastFix = nil/);
    const begin = fn(d, 'func beginCandidate(');
    expect(begin).toMatch(/if origin == "auto" && !linger \{ r\.candidateStarts = DetectPolicy\.recentStarts\(r\.candidateStarts, now\) \+ \[now\] \}/);
    for (const step of ['lingering = linger', 'lastVehicleTs = nil', 'lastFix = nil', 'carStanding = false', 'vehicleStanding = false', 'lastCarMotionAt = max(lastCarMotionAt, carMotionAt)']) {
      expect({ step, found: begin.includes(step) }).toEqual({ step, found: true });
    }
    // a confirmed candidate leaves the cap's record too
    expect(fn(d, 'func beginDrive(')).toMatch(/r\.candidateStarts = DetectPolicy\.startsAfter\(r\.candidateStarts, since: r\.since, sawVehicle: true\)\s*r\.state = "recording"/);
    expect(d).toMatch(/schedule\(wallDeadline: \.now\(\) \+ DetectPolicy\.TICK_MS \/ 1000, repeating: DetectPolicy\.TICK_MS \/ 1000/);
  });

  it('motion: car motion lasts until the report that replaces it; an automotive report is a vehicle sign; a low-confidence walk keeps a standing walk (as JS)', () => {
    const d = detector();
    const act = fn(d, 'func onActivity(');
    expect(act).toMatch(/let car = a\.confident && a\.automotive && !a\.stationary\s*if car \|\| carStanding \{ lastCarMotionAt = max\(lastCarMotionAt, a\.at\) \}\s*carStanding = car/);
    expect(act).toMatch(/vehicleStanding = a\.confident && a\.automotive\s*if vehicleStanding && phase == "candidate" \{ lastVehicleTs = a\.at \}/);
    expect(act).toMatch(/if a\.walking \{\s*if a\.confident && walkSince == nil \{ walkSince = a\.at \}\s*\} else \{\s*walkSince = nil\s*\}/);
    expect(fn(d, 'func carFresh()')).toMatch(/carStanding \|\| DriveDetector\.now\(\) - lastCarMotionAt <= DetectPolicy\.AUTOMOTIVE_FRESH_MS/);
    // a candidate keeps its last trusted place (for a parked spot); only the rest keeps its last movement
    const fix = fn(d, 'func onFix(');
    expect(fix).toMatch(/guard p == "suppressed" \|\| p == "candidate" else \{ return \}/);
    expect(fix).toMatch(/if p == "suppressed" && d\.speed > DetectPolicy\.STOP_MPS \{ lastOverStopTs = d\.ts \}/);
  });

  it('the linger: an automatic end (5 min still or a walk; a JS end a JS rule would have made by now) opens a candidate at once, never for a Start-card drive still waiting', () => {
    const d = detector();
    const end = fn(d, 'func commitEnd(');
    expect(end).toMatch(/func commitEnd\(cause: String, endedAt: Double, linger: Bool = false\)/);
    expect(end).toMatch(/let lingerAfter = linger && r\.waitUntil == nil/);
    expect(end).toMatch(/emitState\("ended"\)\s*if lingerAfter, rec\?\.state == "armed", capture\.sensing == \.off \{ beginCandidate\(origin: "auto", reason: "linger"\) \}/);
    expect(fn(d, 'func evaluateEnd()')).toMatch(/commitEnd\(cause: cause, endedAt: now, linger: cause == "still" \|\| cause == "walking"\)/);
    const auto = fn(d, 'func automaticEndDue()');
    expect(auto).toMatch(/DetectPolicy\.endDue\(endClock, startedAt: startedAt, now: DriveDetector\.now\(\), walkSince: walkSince, waitUntil: r\.waitUntil\)\.overdue/);
    expect(auto).toMatch(/return o == "still" \|\| o == "walking"/);
    // a region exit during the linger is never dropped as "busy": the linger becomes an ordinary
    // watch from the exit (vehicle signs keep it open, an hourly cap entry, its evidence kept)
    const wake = fn(d, 'func onWake(');
    expect(wake).toMatch(/func onWake\(_ reason: String\) \{\s*if reason == "region", lingerToWatch\(\) \{ return \}\s*guard !waking, let r = rec else \{ return \}/);
    const toWatch = fn(d, 'func lingerToWatch()');
    expect(toWatch).toMatch(/guard lingering, var r = rec, r\.state == "candidate", r\.origin == "auto" else \{ return false \}/);
    expect(toWatch).toMatch(/lingering = false\s*r\.since = now\s*r\.candidateStarts = DetectPolicy\.recentStarts\(r\.candidateStarts, now\) \+ \[now\]\s*save\(r\)\s*emitState\("wake:region"\)\s*return true/);
    expect(toWatch).not.toMatch(/confirmState|buffer\.clear|beginCandidate/);
    // the orphan and "Not driving?" never linger
    expect(fn(d, 'func resumeDrive(')).toMatch(/self\.commitEnd\(cause: "orphan", endedAt: now\)/);
    expect(fn(d, 'func notDriving()')).not.toMatch(/linger|beginCandidate/);
  });

  it('a drive end runs inside a background task, begun before GPS goes off', () => {
    const d = detector();
    const end = fn(d, 'func commitEnd(');
    expect(end).toMatch(/save\(r\)\s*beginEndTask\(\)\s*finishSensing\(\)/);
    const task = fn(d, 'func beginEndTask()');
    expect(task).toMatch(/endEndTask\(\)\s*endTaskId &\+= 1/);
    expect(task).toMatch(/beginBackgroundTask\(withName: "drivesense\.end"\) \{ \[weak self\] in\s*if self\?\.endTaskId == id \{ self\?\.endEndTask\(\) \}/);
    expect(task).toMatch(/asyncAfter\(wallDeadline: \.now\(\) \+ DetectPolicy\.END_TASK_MAX_MS \/ 1000\) \{ \[weak self\] in\s*if self\?\.endTaskId == id \{ self\?\.endEndTask\(\) \}/);
    expect(fn(d, 'func endEndTask()')).toMatch(/guard endTask != \.invalid else \{ return \}\s*UIApplication\.shared\.endBackgroundTask\(endTask\)\s*endTask = \.invalid/);
  });

  it('a confirmation: the start traced back (the motion history only for an auto drive that began moving), journaled from the first kept row with seq 1, announced', () => {
    const d = detector();
    const confirm = fn(d, 'func confirm(');
    // a run that began before the oldest buffered row still confirms (traced from the first row)
    expect(confirm).toMatch(/let h = confirmState\.runStartTs\.flatMap \{ buffer\.index\(ofTs: \$0\) \} \?\? 0\s*confirming = true/);
    expect(confirm).not.toMatch(/guard let runStart/);
    expect(confirm).toMatch(/guard kind == "auto", DetectPolicy\.traceStart\(rows, h\) == nil else \{\s*finish\(0\)/);
    expect(confirm).toMatch(/DetectPolicy\.startOf\(rows, h, kind, automotiveSince, lastEnd\)/);
    const begin = fn(d, 'func beginDrive(');
    expect(begin).toMatch(/let driveId = UUID\(\)\.uuidString\.lowercased\(\)/);
    expect(begin).toMatch(/DetectPolicy\.continuesFrom\(r\.lastEnd, start\.startedAt, start\.startLat, start\.startLng\)/);
    expect(begin).toMatch(/nextSeq = 1/);
    expect(begin).toMatch(/let kept = buffer\.items\.filter \{ \$0\.row\.ts >= firstTs \}/);
    expect(begin).toMatch(/capture\.openCapture\(startedAt: start\.startedAt, mode: kind == "auto" \? "auto" : "mounted"\)/);
    expect(begin).toMatch(/DriveNotifier\.scheduleFallback/);
    expect(begin.indexOf('for item in kept { record(item.row, item.body, evaluate: false) }')).toBeGreaterThan(-1);
    expect(begin.indexOf('for item in kept { record(item.row, item.body, evaluate: false) }')).toBeLessThan(begin.indexOf('EventHub.detect.emit("driveStarted"'));
    for (const k of ['"driveId"', '"origin"', '"startedAt"', '"startSource"', '"startLat"', '"startLng"', '"continues"', '"confirmedAt"', '"firstSeq"', '"nativeBuild"']) expect(begin).toContain(k);
    // JS sees a capture only while a drive records
    only(/openCapture\(startedAt:/, ['CaptureController.swift', 'DriveDetectorDrive.swift', 'DriveDetectorSensing.swift']);
  });

  it('a drive row: journaled and emitted with the next seq, then the safety stop checked', () => {
    const rec = fn(detector(), 'func record(');
    expect(rec).toMatch(/line\["seq"\] = nextSeq\s*nextSeq \+= 1\s*journal\.appendRow\(driveId, line\)\s*capture\.emitRow\(line, ts: Int64\(d\.ts\)\)/);
    expect(rec).toMatch(/func record\(_ d: DetectRow, _ body: \[String: Any\], evaluate: Bool = true\)/);
    expect(rec).toMatch(/endClock = DetectPolicy\.endOnRow\(endClock, d, automotiveNow: automotiveNow\(\)\)\s*if evaluate \{ evaluateEnd\(\) \}/);
  });

  it('the safety stop: the policy decides; native commits with endedAt = when it decided and tells JS; a JS end is journaled as "js" and not echoed', () => {
    const d = detector();
    const ev = fn(d, 'func evaluateEnd()');
    expect(ev).toMatch(/DetectPolicy\.endDue\(endClock, startedAt: startedAt, now: now, walkSince: walkSince, waitUntil: r\.waitUntil\)/);
    expect(ev).toMatch(/if let cause = d\.due \{\s*commitEnd\(cause: cause, endedAt: now, linger: cause == "still" \|\| cause == "walking"\)/);
    const end = fn(d, 'func commitEnd(');
    expect(end).toMatch(/"k": "end"/);
    expect(end).toMatch(/close: true/);
    expect(end).toMatch(/cut: cause == "js" \? endedAt : now/);
    expect(end).toMatch(/if cause != "js" \{\s*EventHub\.detect\.emit\("driveEnded"/);
    expect(end).toMatch(/if r\.state == "armed" \{ wakes\.setParked\(lastFix\) \}/);
    expect(fn(d, 'func stopCapture(')).toMatch(/commitEnd\(cause: "js", endedAt: end\?\.drivingEndedAt \?\? DriveDetector\.now\(\), linger: automaticEndDue\(\)\)/);
    expect(moduleCode()).toMatch(/AsyncFunction\("stopCapture"\)[\s\S]{0,140}DriveDetector\.shared\.stopCapture\(end: CaptureEnd\.of\(kind, endedAt, drivingAtEnd\)\)/);
  });

  it('"Not driving?": the journal deleted, driveEnded cancelled, a rest of at most 3 h on ten-metre GPS; the last end untouched', () => {
    const nd = fn(detector(), 'func notDriving()');
    expect(nd).toMatch(/journal\.delete\(driveId\)/);
    expect(nd).toMatch(/r\.suppressedUntil = now \+ DetectPolicy\.SUPPRESS_MAX_MS/);
    expect(nd).toMatch(/"cause": "cancelled"/);
    expect(nd).not.toMatch(/lastEnd/);
    const tick = fn(detector(), 'func tick()');
    expect(tick).toMatch(/DetectPolicy\.suppressionDue\(since: since, until: until, lastOverStopTs: lastOverStopTs, walkSince: walkSince, now: now\) != nil/);
    expect(fn(detector(), 'func endSuppression()')).not.toMatch(/lastEnd =/);
    expect(fn(code('CaptureController.swift'), 'func beginSuppressedSensing()')).toMatch(/location\.start\(\.suppressed\)/);
  });

  it('a relaunch: a candidate never survives; a drive resumes with a gap line or ends as an orphan; a rest resumes until its cap', () => {
    const d = detector();
    const launch = fn(d, 'func resumeAtLaunch()');
    expect(launch).toMatch(/case "candidate":\s*settle\(&r, now\)/);
    expect(launch).toMatch(/resumeDrive\(driveId\)/);
    // a rest: kept until its cap (from when it began), its still clock from the relaunch (review M5)
    expect(launch).toMatch(/if let moved = DetectPolicy\.suppressionResume\(until: r\.suppressedUntil, now: now\) \{\s*lastOverStopTs = moved\s*capture\.beginSuppressedSensing\(\)\s*startClock\(\)/);
    expect(launch).not.toMatch(/suppressedSince =|suppressedUntil =/);
    // the rest's start and cap are in the record, saved when "Not driving?" begins it
    expect(code('DetectStateRecord.swift')).toMatch(/var suppressedSince: Double\?\s*var suppressedUntil: Double\?/);
    const nd = fn(d, 'func notDriving()');
    expect(nd.indexOf('r.suppressedSince = now')).toBeGreaterThan(-1);
    expect(nd.indexOf('r.suppressedSince = now')).toBeLessThan(nd.indexOf('save(r)'));
    const resume = fn(d, 'func resumeDrive(');
    expect(resume).toMatch(/DetectPolicy\.resumeDecision\(lastRowTs: s\.lastRowTs, startedAt: startedAt, now: now\) == "resume" else \{\s*self\.commitEnd\(cause: "orphan", endedAt: now\)/);
    expect(resume).toMatch(/"k": "gap"/);
    // an orphan's end line keeps the durable last seq
    expect(resume.indexOf('self.nextSeq = s.lastSeq + 1')).toBeGreaterThan(-1);
    expect(resume.indexOf('self.nextSeq = s.lastSeq + 1')).toBeLessThan(resume.indexOf('self.commitEnd(cause: "orphan"'));
  });

  it('a resume hands out no seq twice: rows go on past the journal’s highest seq plus RESUME_SEQ_GAP, which the gap line carries (review M7)', () => {
    const resume = fn(detector(), 'func resumeDrive(');
    expect(resume).toMatch(/let skipTo = DetectPolicy\.resumeSeq\(s\.topSeq\)\s*self\.nextSeq = skipTo \+ 1\s*self\.journal\.appendMarker\(driveId, \[\s*"k": "gap", "from": [^\n]*"lastSeq": skipTo,\s*\], close: false\)/);
    expect(resume.indexOf('let skipTo')).toBeGreaterThan(resume.indexOf('self.commitEnd(cause: "orphan"'));
    expect(code('DetectPolicy.swift')).toMatch(/static func resumeSeq\(_ topSeq: Int\) -> Int \{ topSeq \+ RESUME_SEQ_GAP \}/);
    // the highest seq: the last row's, or a later resume's reservation
    const r = code('RowJournalRead.swift');
    expect(r).toMatch(/var topSeq = 0/);
    expect(r).toMatch(/if k == "gap", s\.lastRowTs == nil, let g = \(o\["lastSeq"\] as\? NSNumber\)\?\.intValue \{ s\.topSeq = max\(s\.topSeq, g\) \}/);
    expect(r).toMatch(/s\.topSeq = max\(s\.topSeq, s\.lastSeq\)\s*return s/);
    // a reader goes on from the gap's seq
    const read = fn(r, 'private func readNow(');
    expect(read).toMatch(/if o\?\["k"\] as\? String == "gap", let g = \(o\?\["lastSeq"\] as\? NSNumber\)\?\.intValue, g > last \{\s*last = g\s*\} else if let o = o, o\["k"\] as\? String == "row"/);
  });

  it('the Start card: While Using and Precise; busy while a drive records; else a manual drive opens at once from the tap (an auto candidate gives way), waiting for driving speed', () => {
    const d = detector();
    const sw = fn(d, 'func startWaiting()');
    expect(sw).toMatch(/guard p\.location != "none", p\.precise else \{ return \["ok": false, "reason": "permission"\] \}/);
    expect(sw).toMatch(/return \["ok": false, "reason": "busy"\]/);
    expect(sw.indexOf('return ["ok": false, "reason": "busy"]')).toBeLessThan(sw.indexOf('beginManualDrive()'));
    // JS takes the drive in from the answer: its id, the tap and the wait's deadline
    expect(sw).toMatch(/return \["ok": true, "waitUntil": DetectStateRecord\.ms\(waitUntil\), "driveId": driveId, "startedAt": DetectStateRecord\.ms\(startedAt\)\]/);
    const manual = fn(d, 'func beginManualDrive()');
    expect(manual).toMatch(/if phase == "candidate", var r = rec \{\s*r\.origin = "manual"\s*save\(r\)\s*\} else \{\s*beginCandidate\(origin: "manual", reason: "waiting"\)\s*\}/);
    expect(manual).toMatch(/buffer\.clear\(\)/);
    expect(manual).toMatch(/TracedStart\(index: 0, startedAt: now, startSource: "wake", startLat: nil, startLng: nil\)/);
    expect(manual).toMatch(/beginDrive\(start, kind: "manual", firstTs: now, waitUntil: now \+ DetectPolicy\.WAIT_MAX_MS\)/);
    // the wait is saved with the drive, before its side effects
    expect(fn(d, 'func beginDrive(')).toMatch(/r\.waitUntil = waitUntil\s*save\(r\)/);
    // a touch moves it on; the manual trigger (10 mph held 15 s) ends it
    const ext = fn(d, 'func extendWaiting()');
    expect(ext).toMatch(/guard var r = rec, isRecording, r\.origin == "manual", r\.waitUntil != nil else \{ return nil \}/);
    expect(ext).toMatch(/let until = DriveDetector\.now\(\) \+ DetectPolicy\.WAIT_MAX_MS/);
    expect(fn(d, 'func onRow(')).toMatch(/case "recording", "ending":\s*record\(d, body\)\s*if rec\?\.waitUntil != nil \{ waitForDriving\(d\) \}/);
    const wait = fn(d, 'func waitForDriving(');
    expect(wait).toMatch(/DetectPolicy\.confirmStep\(confirmState, d, "manual"\)/);
    expect(wait).toMatch(/guard step\.confirmed, var r = rec, r\.waitUntil != nil else \{ return \}\s*r\.waitUntil = nil\s*save\(r\)/);
    // "Not driving?" ends any wait with the drive
    expect(fn(d, 'func notDriving()')).toMatch(/r\.waitUntil = nil/);
  });

  it('"Always" is asked once, only from While Using, through DriveDetectAccess', () => {
    const a = code('DriveDetectAccess.swift');
    expect(a).toMatch(/if current != \.authorizedWhenInUse \|\| defaults\.bool\(forKey: Self\.alwaysAskedKey\) \|\| pending != nil \{/);
    expect(a.indexOf('defaults.set(true, forKey: Self.alwaysAskedKey)')).toBeLessThan(a.indexOf('manager.requestAlwaysAuthorization()'));
    expect(a).toMatch(/private static let alwaysAskedKey = "drivesense\.detect\.alwaysAsked"/);
    expect(a).toMatch(/liveActivities: ActivityAuthorizationInfo\(\)\.areActivitiesEnabled/);
    expect(a).toMatch(/UIApplication\.shared\.backgroundRefreshStatus/);
  });
});

describe('iOS drive detector: wakes and the note (text)', () => {
  it('the parked region: one, "roadwise.parked", 150 m, exit only; only it is ever touched', () => {
    const w = code('WakeSources.swift');
    expect(w).toMatch(/static let regionId = "roadwise\.parked"/);
    expect(w).toMatch(/for r in manager\.monitoredRegions where r\.identifier == Self\.regionId \{\s*manager\.stopMonitoring\(for: r\)/);
    expect(w).toMatch(/min\(DetectPolicy\.PARKED_REGION_RADIUS_M, manager\.maximumRegionMonitoringDistance\)/);
    expect(w).toMatch(/region\.notifyOnEntry = false\s*region\.notifyOnExit = true/);
    expect(w).toMatch(/guard region\.identifier == Self\.regionId else \{ return \}\s*onWake\?\("region"\)/);
  });

  it('a significant change older than SLC_STALE_MS is not a wake; a visit is one only when left in the last 10 min', () => {
    const w = code('WakeSources.swift');
    expect(w).toMatch(/l\.timestamp\.timeIntervalSince1970 \* 1000 >= startedAt - DetectPolicy\.SLC_STALE_MS/);
    expect(w).toMatch(/visit\.departureDate != Date\.distantFuture/);
    expect(w).toMatch(/<= DetectPolicy\.VISIT_FRESH_MS/);
  });

  it('the note: "Recording your drive", quiet, opens the driving screen, only if no Live Activity runs 20 s after the confirmation (A3)', () => {
    const n = code('DriveNotifier.swift');
    expect(n).toMatch(/static let identifier = "roadwise\.driveRecording"/);
    expect(n).toMatch(/static let title = "Recording your drive"/);
    expect(n).toMatch(/static let body = "Tap to open it\. Not driving\? You can stop it there\."/);
    expect(n).toContain('content.interruptionLevel = .active');
    expect(n).not.toMatch(/content\.sound|timeSensitive|\.critical|UNNotificationAction|categoryIdentifier/);
    expect(n).toMatch(/content\.threadIdentifier = "drive-recording"/);
    expect(n).toMatch(/content\.userInfo = \["kind": "driveRecording", "url": "\/drive"\]/);
    expect(n).toMatch(/asyncAfter\(wallDeadline: \.now\(\) \+ DetectPolicy\.FALLBACK_NOTE_DELAY_MS \/ 1000, execute: work\)/);
    expect(n).toMatch(/guard stillRecording\(\), !activityRunning else \{ return \}\s*post\(\)/);
    expect(n).toMatch(/Notification\.Name\("roadwise\.liveActivity"\)/);
    expect(n).toMatch(/if activityRunning \{\s*cancel\(\)\s*remove\(\)/);
    expect(allCode().match(/DriveNotifier\.scheduleFallback/g)).toHaveLength(1);
    const finish = fn(code('DriveDetectorDrive.swift'), 'func finishSensing()');
    expect(finish).toMatch(/DriveNotifier\.cancel\(\)\s*DriveNotifier\.remove\(\)/);
  });
});

describe('iOS: DashPal alerts on the phone (README §2)', () => {
  it.each([...DRIVE_SENSE_SYNC_METHODS])('Function("%s") is declared (sync, never an AsyncFunction)', (name) => {
    expect(moduleCode()).toMatch(new RegExp(`(?<!Async)Function\\("${name}"\\)`));
    expect(moduleCode()).not.toContain(`AsyncFunction("${name}")`);
  });

  it('declares no sync Function outside DRIVE_SENSE_SYNC_METHODS, and none twice', () => {
    const declared = [...moduleCode().matchAll(/(?<!Async)Function\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_SENSE_SYNC_METHODS].sort());
  });

  it('audioOutputState reads a fresh call, the output volume (0-1) and wired or USB headphones as the route', () => {
    const src = moduleCode();
    expect(src).toMatch(/^import AVFoundation$/m);
    const fn = /Function\("audioOutputState"\) \{ \(\) -> \[String: Any\] in[\s\S]*?\n {4}\}/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/let session = AVAudioSession\.sharedInstance\(\)/);
    expect(fn).toMatch(/min\(max\(Double\(session\.outputVolume\), 0\), 1\)/);
    expect(fn).toMatch(/session\.currentRoute\.outputs\.contains \{ \$0\.portType == \.headphones \|\| \$0\.portType == \.usbAudio \}/);
    expect(fn).toMatch(/"callActive": CallObserver\.anyCallActiveNow\(\), "volume": volume, "headphones": headphones/);
    expect(fn).not.toMatch(/bluetoothA2DP|bluetoothLE|carAudio|setActive|setCategory/);
  });


  it('holdAwake and dashpalLinkRunning answer false, setDashpalLink unsupported, and the tick is never emitted', () => {
    const src = moduleCode();
    expect(src).toMatch(/Function\("holdAwake"\) \{ \(_: Int\) -> Bool in\s*false\s*\}/);
    expect(src).toMatch(/Function\("dashpalLinkRunning"\) \{ \(\) -> Bool in\s*false\s*\}/);
    expect(src).toMatch(/AsyncFunction\("setDashpalLink"\) \{ \(_: String, promise: Promise\) in\s*promise\.resolve\("unsupported"\)\s*\}/);
    expect(allCode()).not.toMatch(/emit\("dashpalLinkTick"/);
  });
});

// The drive detector's policy, self-test and journal (plan §3.2, §3.3).
describe('iOS drive detector: the policy and the journal (text)', () => {
  const POLICY = ['DetectPolicy.swift', 'DetectStartPolicy.swift', 'DetectEndPolicy.swift', 'DetectSelfTest.swift', 'RowBuffer.swift'];

  it('the policy declares exactly the reference constants, with the reference values', () => {
    const src = code('DetectPolicy.swift');
    const declared = new Map([...src.matchAll(/static let ([A-Z][A-Z0-9_]*)(?:\s*:\s*\w+)?\s*=\s*([\d_.]+)/g)].map((m) => [m[1]!, Number(m[2]!.replace(/_/g, ''))] as const));
    for (const [name, value] of Object.entries(DETECT)) expect({ name, value: declared.get(name) }).toEqual({ name, value });
    expect([...declared.keys()].sort()).toEqual(Object.keys(DETECT).sort());
  });

  it('the policy, its end half, the self-test and the ring buffer are pure: Foundation only, no phone, no clock', () => {
    for (const f of POLICY) {
      expect({ f, imports: [...read(f).matchAll(/^import (\w+)/gm)].map((m) => m[1]) }).toEqual({ f, imports: ['Foundation'] });
      expect({ f, impure: /UserDefaults|CLLocationManager|CMMotion|UIApplication|Date\(\)|EventHub|DispatchQueue/.test(code(f)) }).toEqual({ f, impure: false });
    }
  });

  it('each rule of policy.ts has its Swift function, and the self-test runs every row kind through them', () => {
    const policy = code('DetectPolicy.swift') + code('DetectStartPolicy.swift') + code('DetectEndPolicy.swift');
    for (const fn of ['trusted', 'slow', 'moving', 'rolling', 'distanceM', 'autoHoldMs', 'autoStep', 'confirmStep', 'traceStart', 'startOf', 'continuesFrom', 'summarize', 'motionGate', 'recentStarts', 'wakeGate', 'candidateDue', 'startsAfter', 'resumeDecision', 'statusOf', 'endClockAt', 'endOnRow', 'endDue', 'suppressionDue', 'suppressionResume', 'resumeSeq']) {
      expect({ fn, declared: new RegExp(`static func ${fn}\\(`).test(policy) }).toEqual({ fn, declared: true });
    }
    const st = code('DetectSelfTest.swift');
    for (const kind of ['confirm', 'trace', 'start', 'summary', 'motionGate', 'wake', 'candidate', 'startsAfter', 'end', 'suppress', 'suppressResume', 'resume', 'resumeSeq', 'status']) expect(st).toContain(`case "${kind}":`);
    for (const call of ['confirmStep(', 'traceStart(', 'startOf(', 'continuesFrom(', 'summarize(', 'motionGate(', 'wakeGate(', 'candidateDue(', 'startsAfter(', 'endClockAt(', 'endOnRow(', 'endDue(', 'suppressionDue(', 'suppressionResume(', 'resumeDecision(', 'resumeSeq(', 'statusOf(']) {
      expect({ call, used: st.includes(`DetectPolicy.${call}`) }).toEqual({ call, used: true });
    }
    // the trace-back loop is bounded and goes back over a stop the car rolled (5 mph) into; the
    // Start card's dip breaks only past 5 s
    expect(policy).toMatch(/for _ in 0\.\.\.rows\.count \{/);
    expect(policy).toMatch(/guard let j = \(0\.\.<s\)\.reversed\(\)\.first\(where: \{ rolling\(rows\[\$0\]\) \}\) else \{ return s \}/);
    expect(policy).toMatch(/if r\.ts - dip > CONFIRM_DIP_MAX_MS \{ return \(ConfirmState\(\), false\) \}/);
    // the auto evidence: the same order of operations as policy.ts autoStep
    const step = fn(code('DetectStartPolicy.swift'), 'static func autoStep(');
    const order = [
      'let earns = ok && !veto && r.speed > AUTO_MIN_MPS && (r.speed >= AUTO_MPS_20 || carFresh)',
      'let rate: Double = earns ? 1 / autoHoldMs(r.speed) : 0',
      'if let p = s.prevTs, rate > 0, s.prevRate > 0, r.ts - p > 0, r.ts - p <= AUTO_ROW_GAP_MAX_MS {',
      'e += (r.ts - p) * min(rate, s.prevRate)',
      'if first == nil { first = p }',
      'let lastMove: Double? = ok && r.speed > STOP_MPS ? r.ts : s.lastMoveTs',
      'if e > 0, let m = lastMove, r.ts - m >= AUTO_FORGET_MS {',
      'return (state, e >= 1 - evidenceEps && !veto)',
    ];
    let at = -1;
    for (const line of order) {
      const i = step.indexOf(line);
      expect({ line, after: i > at }).toEqual({ line, after: true });
      at = i;
    }
    expect(code('DetectStartPolicy.swift')).toMatch(/private static let evidenceEps: Double = 0\.000000001/);
    expect(fs.readFileSync(path.join(MODULE_DIR, 'src', 'detect', 'policy.ts'), 'utf8')).toMatch(/const EVIDENCE_EPS = 0\.000000001;/);
    // the hold: (5/3)·(30 − mph) s over 15 mph, the line from AUTO_HOLD_MS_15 to 0 at AUTO_INSTANT_MPS,
    // floored at AUTO_HOLD_MIN_MS, in policy.ts's order of operations
    const hold = fn(code('DetectStartPolicy.swift'), 'static func autoHoldMs(');
    expect(hold).toMatch(/if !\(mps > AUTO_MIN_MPS\) \{ return Double\.infinity \}/);
    expect(hold).toContain('return max(AUTO_HOLD_MIN_MS, AUTO_HOLD_MS_15 * (AUTO_INSTANT_MPS - mps) / (AUTO_INSTANT_MPS - AUTO_MIN_MPS))');
    expect(fs.readFileSync(path.join(MODULE_DIR, 'src', 'detect', 'policy.ts'), 'utf8')).toContain(
      'return Math.max(DETECT.AUTO_HOLD_MIN_MS, (DETECT.AUTO_HOLD_MS_15 * (DETECT.AUTO_INSTANT_MPS - mps)) / (DETECT.AUTO_INSTANT_MPS - DETECT.AUTO_MIN_MPS));'
    );
    // the drive's walking end is 5 s (the candidate and the rest keep 20 s)
    expect(code('DetectEndPolicy.swift')).toMatch(/if walked >= WALK_END_MS \+ slack \{ return "walking" \}/);
    expect(code('DetectEndPolicy.swift')).toMatch(/if let w = walkSince, now - w >= WALK_CONFIRM_MS \{ return "walking" \}/);
    expect(code('DetectPolicy.swift')).toMatch(/if let w = walkSince, now - w >= WALK_CONFIRM_MS \{ return "walking" \}/);
  });

  it('the journal: one file per drive under Application Support, excluded from backup, protected until the first unlock', () => {
    const j = code('RowJournal.swift');
    expect(j).toContain('.applicationSupportDirectory');
    expect(j).toContain('appendingPathComponent("drivesense", isDirectory: true)');
    expect(j).toContain('appendingPathComponent("journal", isDirectory: true)');
    expect(j).toContain('appendingPathComponent("\\(driveId).ndjson")');
    expect(j).toContain('isExcludedFromBackup = true');
    expect(j.match(/FileProtectionType\.completeUntilFirstUserAuthentication/g)?.length).toBeGreaterThanOrEqual(2);
    expect(j).toMatch(/label: "drivesense\.journal", qos: \.utility/);
  });

  it('the journal fsyncs the start, every gap and end, and every JOURNAL_SYNC_EVERY_ROWS rows; caps a drive and the files', () => {
    const j = code('RowJournal.swift');
    const open = /func open\([\s\S]*?\n {2}\}/.exec(j)?.[0] ?? '';
    expect(open).toMatch(/self\.attach\(driveId, url\)\s*self\.sync\(\)/);
    expect(open).toMatch(/self\.rotate\(keepingRoomFor: driveId\)/);
    const row = /func appendRow\([\s\S]*?\n {2}\}/.exec(j)?.[0] ?? '';
    expect(row).toMatch(/self\.bytes \+ data\.count <= DetectPolicy\.JOURNAL_MAX_BYTES_PER_DRIVE/);
    expect(row).toMatch(/if self\.rowsSinceSync >= DetectPolicy\.JOURNAL_SYNC_EVERY_ROWS \{ self\.sync\(\) \}/);
    const marker = /func appendMarker\([\s\S]*?\n {2}\}/.exec(j)?.[0] ?? '';
    expect(marker).toMatch(/self\.bytes \+= data\.count\s*self\.sync\(\)/);
    expect(j).toMatch(/private func sync\(\) \{\s*try\? handle\?\.synchronize\(\)/);
    // rotation: the oldest undrained file by its start, ended or orphaned (review M6); never the new one
    const rotate = /private func rotate\([\s\S]*?\n {2}\}/.exec(j)?.[0] ?? '';
    expect(rotate).toMatch(/var list = files\(\)\.filter \{ \$0\.id != driveId \}/);
    expect(rotate).toMatch(/while list\.count >= DetectPolicy\.JOURNAL_MAX_DRIVES/);
    expect(rotate).toMatch(/guard let s = summary\(f\.url\) else \{ return nil \}/);
    expect(rotate).not.toMatch(/s\.end != nil/);
    expect(rotate).toMatch(/undrained\.min\(by: \{ \$0\.startedAt < \$1\.startedAt \}\)/);
  });

  it('an orphan (no end, not the live drive) is listed as ended, cause orphan, at its last row; only with the record read (review M6)', () => {
    expect(detectCode()).toMatch(
      /AsyncFunction\("listDrives"\) \{ \(promise: Promise\) in\s*let d = DriveDetector\.shared\s*let liveId = d\.isRecording \? d\.rec\?\.driveId : nil\s*RowJournal\.shared\.list\(liveId: liveId, recordKnown: d\.rec != nil\)/
    );
    const r = code('RowJournalRead.swift');
    expect(r).toMatch(/out\.append\(Self\.listed\(f\.id, s, orphan: recordKnown && f\.id != liveId\)\)/);
    const listed = fn(r, 'static func listed(');
    expect(listed).toMatch(/if let e = s\.end \{[\s\S]*?\} else if orphan \{\s*let at = DetectStateRecord\.ms\(s\.lastRowTs \?\? jsonNumber\(st\["startedAt"\]\) \?\? 0\)\s*let endInfo: \[String: Any\] = \["endedAt": at, "cause": "orphan", "decidedAt": at\]/);
    // the live drive stays unended: JS adopts it as the live drive
    expect(listed).toMatch(/var ended: Any = NSNull\(\)/);
  });

  it('a reader never reads a torn last line, drops a seq out of order, and keeps its place; a resume cuts the torn tail off', () => {
    const r = code('RowJournalRead.swift');
    expect(r).toMatch(/seq == last \+ 1/);
    expect(r).toMatch(/while let nl = buf\[lineStart\.\.\.\]\.firstIndex\(of: 0x0A\)/);
    expect(r).toMatch(/cursors\[driveId\] = \(seq: seq, offset: lineEnd\)/);
    expect(r).toMatch(/s\.cleanEnd = from \+ UInt64/);
    expect(code('RowJournal.swift')).toMatch(/if s\.cleanEnd < s\.bytes, let w = try\? FileHandle\(forWritingTo: url\) \{\s*try\? w\.truncate\(atOffset: s\.cleanEnd\)/);
  });

  it('no file timestamps, attribute reads or disk-space reads anywhere', () => {
    expect(allCode()).not.toMatch(/attributesOfItem|contentModificationDate|creationDate|modificationDate|volumeAvailableCapacity|fileSize/);
  });

  it('the ring buffer keeps the last CANDIDATE_BUFFER_MAX_ROWS rows', () => {
    const b = code('RowBuffer.swift');
    expect(b).toMatch(/init\(capacity: Int = DetectPolicy\.CANDIDATE_BUFFER_MAX_ROWS\)/);
    expect(b).toMatch(/if items\.count > capacity \{ items\.removeFirst\(items\.count - capacity\) \}/);
  });
});
