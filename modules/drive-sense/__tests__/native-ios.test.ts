// The iOS module (N2) read as text. Swift cannot be compiled or run under Jest, so this suite pins
// what can be checked statically against the JS contract: the event list, one AsyncFunction per
// contract method, the port's constants, the location and motion configuration the battery rules
// depend on, the app-delegate subscriber registration, and the rule that `selfTest` runs the
// production extractor rather than a copy. Behaviour is proven by the V1 compile and the device
// pass (see the N2 report).
import * as CONSTANTS from '../src/extract/constants';
import { FIRST_WINDOW_MS, MAX_ROW_GAP_MS, TIMEBASE_MAX_SKEW_MS } from '../src/extract/timebase';
import { EVENT_BUFFER_MAX } from '../src/fake';
import { DRIVE_SENSE_ERROR_CODES, DRIVE_SENSE_EVENTS, DRIVE_SENSE_METHODS } from '../src/types';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The root
// tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the local
// shapes rather than an `import` from 'node:fs'.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const fs = require('node:fs') as {
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
  it('has the files the task names', () => {
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
      'DriveSenseAppDelegateSubscriber.swift',
      'Backup.swift',
    ]) {
      expect(swiftFiles).toContain(f);
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

  it('starts standard location updates only from the capture source (no GPS on arm)', () => {
    for (const f of swiftFiles) {
      const src = code(f);
      if (f === 'LocationSource.swift') continue;
      expect({ f, gps: /startUpdatingLocation|requestLocation\(/.test(src) }).toEqual({ f, gps: false });
    }
  });

  it('arms with significant-change monitoring and one re-centred 150 m exit region', () => {
    const src = allCode();
    expect(src).toContain('startMonitoringSignificantLocationChanges');
    expect(src).toContain('CLCircularRegion');
    expect(src).toMatch(/EXIT_REGION_RADIUS_M\s*(?::\s*\w+)?\s*=\s*150\b/);
    expect(src).toContain('notifyOnEntry = false');
    expect(src).toContain('notifyOnExit = true');
  });

  it('uses device motion in xArbitraryZVertical at 25 Hz and never the magnetometer', () => {
    const src = allCode();
    expect(code('MotionSource.swift')).toContain('.xArbitraryZVertical');
    expect(code('MotionSource.swift')).toContain('startDeviceMotionUpdates(using:');
    expect(src).not.toMatch(/xTrueNorth|xMagneticNorth|[Mm]agnetometer|magneticField|startUpdatingHeading/);
    expect(code('MotionSource.swift')).toMatch(/1\.0 \/ ExtractConstants\.IMU_RATE_HZ/);
  });

  it('holds a background task over every wake', () => {
    expect(allCode()).toContain('beginBackgroundTask');
    expect(allCode()).toContain('endBackgroundTask');
    expect(allCode()).toMatch(/WAKE_TASK_S\s*(?::\s*\w+)?\s*=\s*25\b/);
  });

  it('runs the watchdog with the contract limits', () => {
    const src = code('Watchdog.swift');
    expect(src).toMatch(/CLAIM_TIMEOUT_S\s*(?::\s*\w+)?\s*=\s*60\b/);
    expect(src).toMatch(/NO_LISTENER_TIMEOUT_S\s*(?::\s*\w+)?\s*=\s*300\b/);
  });

  it('maps motion activity with the README precedence', () => {
    const src = code('ActivitySource.swift');
    const order = ['.walking', '.running', '.cycling', '.automotive', '.stationary'].map((k) =>
      src.indexOf(`if a${k} {`)
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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

  it('registers the app-delegate subscriber that restarts capture on a location launch', () => {
    const config = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, 'expo-module.config.json'), 'utf8'));
    expect(config.apple.modules).toEqual(['DriveSenseModule']);
    expect(config.apple.appDelegateSubscribers).toEqual(['DriveSenseAppDelegateSubscriber']);
    const src = code('DriveSenseAppDelegateSubscriber.swift');
    expect(src).toMatch(/class DriveSenseAppDelegateSubscriber:\s*ExpoAppDelegateSubscriber/);
    expect(src).toContain('didFinishLaunchingWithOptions');
    expect(src).toContain('.location');
  });

  it('links the frameworks it uses', () => {
    const podspec = fs.readFileSync(path.join(IOS_DIR, 'DriveSense.podspec'), 'utf8');
    expect(podspec).toContain("s.frameworks = 'CoreLocation', 'CoreMotion', 'CallKit', 'LocalAuthentication'");
  });
});
