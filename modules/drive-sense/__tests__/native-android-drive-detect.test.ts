/** @jest-environment node */
// The Android drive detector's runtime (`DriveDetectModule.kt`, `detect/DriveDetector*.kt`,
// `RowJournal*.kt`, the capture service's detector mode), read as text as `native-android.test.ts`
// reads the rest of the Kotlin. Behaviour is proven by the JVM unit tests (`RowJournalTest.kt`,
// `DriveDetectRecordTest.kt`) and the host's Android tests with the fake detector; this suite pins
// what can be checked statically: the bridge's surface against `src/detect/types.ts` (without the
// car link, which JS reads as absent), the journal's place and its sync rules, the one thread, the
// policy the safety stop and the resume decide with, the capture service's detector mode (no
// watchdog, a refusal that never loses the drive) and the launch hook.
import { DRIVE_DETECT_ERROR_CODES, DRIVE_DETECT_EVENTS, DRIVE_DETECT_METHODS } from '../src/detect/types';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node typings (see native-android.test.ts)
const { existsSync, readFileSync } = require('node:fs') as {
  existsSync: (file: string) => boolean;
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const ANDROID = join(__dirname, '..', 'android');
const KT_DIR = join(ANDROID, 'src', 'main', 'java', 'expo', 'modules', 'drivesense');
const TEST_DIR = join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense');

const read = (file: string): string => readFileSync(file, 'utf8');
/** Kotlin source with line comments and block comments removed, so a rule cannot be met by a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const kt = (name: string): string => code(read(join(KT_DIR, `${name}.kt`)));
const det = (name: string): string => kt(`detect/${name}`);
/** A function's body, from its declaration to the first line closing at its own indent. */
const fn = (src: string, decl: string, indent = 0): string =>
  new RegExp(`${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n {${indent}}\\}`).exec(src)?.[0] ?? '';

/** The car link's half of the contract: not on Android yet (JS reads `carLinkAvailable` from `carLinkState`). */
const CAR_METHODS = ['carLinkState', 'pairCar', 'forgetCar', 'notMyCar'];

describe('native-android: DriveDetect, the bridge (src/detect/types.ts)', () => {
  const MODULE = () => kt('DriveDetectModule');

  it('is registered for Android beside the other modules', () => {
    const config = JSON.parse(read(join(__dirname, '..', 'expo-module.config.json'))) as { android: { modules: string[] } };
    expect(config.android.modules).toContain('expo.modules.drivesense.DriveDetectModule');
    expect(config.android.modules).toContain('expo.modules.drivesense.DriveSenseModule');
    expect(MODULE()).toMatch(/class DriveDetectModule : Module\(\) \{/);
    expect(MODULE()).toMatch(/Name\("DriveDetect"\)/);
  });

  it('declares the contract events but the car link’s, in order', () => {
    const m = /Events\(([^)]*)\)/.exec(MODULE());
    expect([...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual(DRIVE_DETECT_EVENTS.filter((e) => e !== 'carLink'));
    const observed = /OBSERVED_EVENTS = listOf\(([^)]*)\)/.exec(MODULE());
    expect([...observed![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual(DRIVE_DETECT_EVENTS.filter((e) => e !== 'carLink'));
  });

  it('declares one AsyncFunction per contract method but the car link’s, none twice, and none of the car link’s', () => {
    const declared = [...MODULE().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual(DRIVE_DETECT_METHODS.filter((x) => !CAR_METHODS.includes(x)).sort());
    for (const car of CAR_METHODS) expect(MODULE()).not.toContain(`"${car}"`);
    expect(MODULE()).not.toContain('"carLink"');
  });

  it('rejects only discardDrive on the live drive, with E_BUSY', () => {
    const codes = [...MODULE().matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]);
    expect(codes).toEqual(['E_BUSY']);
    expect(DRIVE_DETECT_ERROR_CODES).toContain('E_BUSY');
    expect(fn(MODULE(), 'AsyncFunction("discardDrive")', 4)).toMatch(/if \(busy\) promise\.reject\(CodedException\("E_BUSY"/);
  });

  it('its events go through their own buffer: the drive events wait for a listener, the state is live only', () => {
    const bus = kt('EventBus');
    expect(bus).toMatch(/object DetectEventBus : EventQueue\(\)/);
    expect(bus).toMatch(/object EventBus : EventQueue\(\)/);
    expect(MODULE()).toMatch(/OnCreate \{\s*DetectEventBus\.attach\(emitter\)/);
    expect(MODULE()).toMatch(/OnDestroy \{\s*DetectEventBus\.detach\(emitter\)/);
    const all = det('DriveDetector') + det('DriveDetectorDrive');
    expect(all).toMatch(/DetectEventBus\.emitLive\("detectState"/);
    expect(all).not.toMatch(/DetectEventBus\.emit\("detectState"/);
    expect(all.match(/DetectEventBus\.emit\(\s*"driveStarted"/g)).toHaveLength(1);
    expect(all.match(/DetectEventBus\.emit\(\s*"driveEnded"/g)).toHaveLength(2);
    // The rows themselves go to DriveSense's row event, with their seq.
    expect(fn(det('DriveDetectorDrive'), 'internal fun DriveDetector.record(')).toMatch(/line\["seq"\] = nextSeq[\s\S]*journal\.appendRow\(driveId, it\)[\s\S]*EventBus\.emit\("row", line\)/);
  });
});

describe('native-android: the drive detector runs on one thread, its journal on another', () => {
  it('a process-wide singleton on one HandlerThread; every JS call posts to it', () => {
    const d = det('DriveDetector');
    expect(d).toMatch(/class DriveDetector private constructor\(context: Context\)/);
    expect(d).toMatch(/fun get\(context: Context\): DriveDetector =\s*shared \?: synchronized\(this\)/);
    expect(d.match(/HandlerThread\(/g)).toHaveLength(1);
    for (const name of ['setArmed', 'getState', 'requestAlways', 'startWaiting', 'extendWaiting', 'cancelWaiting', 'stopCapture', 'listDrives', 'discardDrive', 'wipe', 'appForeground', 'resumeAtLaunch']) {
      expect({ name, posts: /^\s*handler\.post \{/m.test(fn(d, `  fun ${name}(`, 2).split('\n').slice(1, 3).join('\n')) }).toEqual({ name, posts: true });
    }
    expect(fn(det('DriveDetectorDrive'), 'fun DriveDetector.notDriving(')).toMatch(/^\s*handler\.post \{/m);
    expect(fn(det('DriveDetectorDrive'), 'fun DriveDetector.onRow(')).toMatch(/handler\.post \{/);
  });

  it('the journal: one executor thread, in noBackupFilesDir/drivesense/journal, never touching android.*', () => {
    expect(det('DriveDetector')).toMatch(/RowJournal\(\s*File\(app\.noBackupFilesDir, "drivesense\/journal"\),\s*Executors\.newSingleThreadExecutor/);
    for (const f of ['RowJournal', 'RowJournalRead']) {
      expect({ f, android: /^import android/m.test(read(join(KT_DIR, `${f}.kt`))) }).toEqual({ f, android: false });
    }
    expect(kt('RowJournal')).toMatch(/class RowJournal\(val directory: File, private val io: Executor\)/);
  });

  it('fsync on start, gap, end and every JOURNAL_SYNC_EVERY_ROWS rows; 32 MiB per drive; 4 files', () => {
    const j = kt('RowJournal');
    expect(fn(j, '  fun open(', 2)).toMatch(/s\.fd\.sync\(\)/);
    expect(fn(j, '  fun appendRow(', 2)).toMatch(/bytes \+ data\.size > DetectPolicy\.JOURNAL_MAX_BYTES_PER_DRIVE/);
    expect(fn(j, '  fun appendRow(', 2)).toMatch(/if \(rowsSinceSync >= DetectPolicy\.JOURNAL_SYNC_EVERY_ROWS\) sync\(\)/);
    expect(fn(j, '  fun appendMarker(', 2)).toMatch(/sync\(\)/);
    expect(fn(j, '  private fun rotate(', 2)).toMatch(/while \(list\.size >= DetectPolicy\.JOURNAL_MAX_DRIVES\)/);
    // A torn tail is cut before a resume writes again.
    expect(fn(j, '  fun reopen(', 2)).toMatch(/if \(s\.cleanEnd < s\.bytes\)[\s\S]*truncate\(s\.cleanEnd\)/);
  });

  it('readRows: rising seq, a gap moves the last seq, a place kept per file; listDrives: an orphan ends at its last row', () => {
    const r = kt('RowJournalRead');
    expect(r).toMatch(/if \(gap != null && gap > last\) \{\s*last = gap/);
    expect(r).toMatch(/else if \(o != null && seq != null && seq > last\) \{/);
    expect(r).toMatch(/journal\.cursors\[driveId\] = seq to lineEnd/);
    expect(r).toMatch(/orphan -> \{\s*val at = jsMs\(s\.lastRowTs \?: num\(st, "startedAt"\) \?: 0\.0\)\s*linkedMapOf\("endedAt" to at, "cause" to "orphan", "decidedAt" to at\)/);
    expect(det('DriveDetector')).toMatch(/RowJournalRead\.list\(journal, if \(r\?\.recording == true\) r\.driveId else null, r != null, done\)/);
  });

  it('the JVM tests hold the journal and the record', () => {
    expect(existsSync(join(TEST_DIR, 'RowJournalTest.kt'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'detect', 'DriveDetectRecordTest.kt'))).toBe(true);
  });
});

describe('native-android: the drive (policy.ts decides, as on iOS)', () => {
  const drive = () => det('DriveDetectorDrive');

  it('the Start card needs While Using and Precise, answers busy while a drive records, and opens the drive only once its service runs', () => {
    const start = fn(det('DriveDetector'), '  fun startWaiting(', 2);
    expect(start).toMatch(/if \(p\.location == LocationAccess\.NONE \|\| !p\.precise\) \{\s*done\(refusal\("permission"\)\)/);
    expect(start).toMatch(/if \(r\.recording \|\| starting \|\| resuming \|\| CaptureService\.plainCapturing\(\)\) \{\s*done\(refusal\("busy"\)\)/);
    expect(start.indexOf('CaptureService.startDetector(')).toBeLessThan(start.indexOf('beginManualDrive(tap)'));
    expect(start).toMatch(/done\(refusal\(if \(code == "E_PERMISSION"\) "permission" else "unavailable"\)\)/);
    expect(det('DriveDetectAccess')).toMatch(/precise = location != LocationAccess\.NONE && granted\(Manifest\.permission\.ACCESS_FINE_LOCATION\)/);
    expect(fn(drive(), 'internal fun DriveDetector.beginManualDrive(')).toMatch(/waitUntil = tap \+ DetectPolicy\.WAIT_MAX_MS/);
    expect(fn(det('DriveDetector'), '  fun extendWaiting(', 2)).toMatch(/val until = now\(\) \+ DetectPolicy\.WAIT_MAX_MS/);
  });

  it('the safety stop: endDue on every row and every 5 s tick; the journal’s end before driveEnded', () => {
    expect(fn(drive(), 'internal fun DriveDetector.record(')).toMatch(/evaluateEnd\(\)/);
    expect(fn(drive(), 'internal fun DriveDetector.evaluateEnd(')).toMatch(/DetectPolicy\.endDue\(endClock, startedAt, now, walkSince, r\.waitUntil, null\)/);
    expect(det('DriveDetector')).toMatch(/handler\.postDelayed\(tickTask, DetectPolicy\.TICK_MS\.toLong\(\)\)/);
    const commit = fn(drive(), 'internal fun DriveDetector.commitEnd(');
    expect(commit.indexOf('journal.appendMarker(')).toBeLessThan(commit.indexOf('"driveEnded"'));
    expect(commit).toMatch(/if \(cause != "js"\)/);
    expect(commit).toMatch(/finishSensing\(holdMs = DetectPolicy\.END_TASK_MAX_MS\.toLong\(\)\)/);
  });

  it('a new process resumes a drive whose last row is 5 min old or less (a gap past resumeSeq), else ends it as an orphan', () => {
    const resume = fn(drive(), 'internal fun DriveDetector.resumeDrive(');
    expect(resume).toMatch(/if \(DetectPolicy\.resumeDecision\(summary\.lastRowTs, startedAt, now\) != ResumeDecision\.RESUME\) \{\s*commitEnd\("orphan", now\)/);
    const sensed = fn(drive(), 'private fun DriveDetector.onResumeSensing(');
    expect(sensed).toMatch(/if \(code != null\) \{[\s\S]*?resumePending = true\s*return\s*\}/);
    expect(sensed).toMatch(/val skipTo = DetectPolicy\.resumeSeq\(s\.topSeq\)\s*nextSeq = skipTo \+ 1/);
    expect(sensed).toMatch(/JSONObject\(\)\.put\("k", "gap"\)/);
    expect(sensed).toMatch(/endClock = DetectPolicy\.endClockAt\(s\.lastRowTs \?: now\)/);
    // The refused resume is tried again when RoadWise comes to the front.
    expect(fn(det('DriveDetector'), '  fun appForeground(', 2)).toMatch(/if \(resumePending && !resuming && !sensing && r\.recording\) r\.driveId\?\.let \{ resumeDrive\(it\) \}/);
    expect(kt('AppVisibility')).toMatch(/DriveDetector\.peek\(\)\?\.appForeground\(\)/);
  });

  it('every process start hands itself to the detector (DriveSensePackage), and the sticky restart too', () => {
    expect(kt('DriveSensePackage')).toMatch(/DriveDetector\.get\(application\)\.resumeAtLaunch\(\)/);
    const svc = kt('CaptureService');
    expect(svc).toMatch(/if \(prefs\.detectorOwned\) \{\s*if \(goForeground\(restart = true\) != null\) \{\s*stopSelf\(startId\)\s*return START_NOT_STICKY\s*\}\s*DriveDetector\.get\(this\)\.resumeAtLaunch\(\)\s*return START_STICKY/);
  });

  it('"Not driving?" deletes the journal and rests (no GPS); the wipe deletes every file and empties the record', () => {
    const nd = fn(drive(), 'fun DriveDetector.notDriving(');
    expect(nd).toMatch(/journal\.delete\(driveId\)/);
    expect(nd).toMatch(/state = "suppressed"/);
    expect(nd).toMatch(/suppressedUntil = now \+ DetectPolicy\.SUPPRESS_MAX_MS/);
    expect(nd).toMatch(/"cause" to "cancelled"/);
    const wipe = fn(det('DriveDetector'), '  fun wipe(', 2);
    expect(wipe).toMatch(/save\(DriveDetectRecord\(\)\)/);
    expect(wipe).toMatch(/journal\.wipe \{ done\(\) \}/);
  });

  it('no wakes yet: the status is unavailable when armed, and "Always" is never asked for', () => {
    const access = det('DriveDetectAccess');
    expect(access).toMatch(/canAskAlways = false,\s*hardware = false/);
    expect(access).not.toMatch(/ACCESS_BACKGROUND_LOCATION|requestPermissions/);
    // Ruling 5: only battery Restricted is missing; the drive notification is the Live Activity.
    expect(access).toMatch(/backgroundRefresh = if \(backgroundRestricted\(\)\) BackgroundRefresh\.DENIED else BackgroundRefresh\.AVAILABLE/);
    expect(access).toMatch(/isBackgroundRestricted == true/);
    expect(access).toMatch(/getNotificationChannel\(NotificationFactory\.CHANNEL_ID\)/);
  });
});

describe('native-android: the capture service’s detector mode', () => {
  const svc = () => kt('CaptureService');

  it('a location foreground service started with the drive’s start; a refusal comes back as a code, never a crash', () => {
    const start = fn(svc(), '    fun startDetector(', 4);
    expect(start).toMatch(/\.setAction\(ACTION_DETECT\)/);
    expect(start).toMatch(/catch \(_: SecurityException\) \{\s*resolveDetectOne\(pending, "E_PERMISSION"\)/);
    expect(start).toMatch(/catch \(_: Exception\) \{[\s\S]*?resolveDetectOne\(pending, "E_FGS_REFUSED"\)/);
    // A service already in the foreground takes it directly: no new start for Android to refuse.
    expect(start).toMatch(/if \(inst != null && inst\.inForeground\) \{/);
  });

  it('no watchdog for a detector drive (the safety stop and the 12 h cap bound it); rows go to the detector', () => {
    const begin = fn(svc(), '  private fun beginCapture(', 2);
    expect(begin).toMatch(/if \(!detector\) watchdog\.start\(nativeStart, EventBus\.rowListenerAttached\)/);
    expect(begin).toMatch(/prefs\.detectorOwned = detector\s*prefs\.captureOpen = true/);
    expect(svc()).toMatch(/if \(detector != null\) detector\.onRow\(row, body\) else EventBus\.emit\("row", body\)/);
  });

  it('a detector drive’s end: sensing and the notification stop at once, RoadWise held 25 s under a wake lock, then the service stops', () => {
    const end = fn(svc(), '  private fun endDetector(', 2);
    expect(end).toMatch(/stopSources\(\)/);
    expect(end).toMatch(/ServiceCompat\.stopForeground\(this, ServiceCompat\.STOP_FOREGROUND_REMOVE\)/);
    expect(end).toMatch(/acquireWakeLock\(holdMs\)\s*main\.postDelayed\(endHold, holdMs\)/);
    expect(fn(svc(), '  private fun finishHold(', 2)).toMatch(/if \(isCapturing\) return\s*releaseWakeLock\(\)\s*stopSelf\(lastStartId\)/);
  });

  it('JS’s stopCapture ends a detector drive through the detector; its startCapture never starts a second capture beside one', () => {
    const m = kt('DriveSenseModule');
    expect(m).toMatch(/DriveDetector\.get\(ctx\)\.stopCapture\(end\)/);
    expect(m).toMatch(/if \(DriveDetector\.get\(ctx\)\.recordingNow\) \{/);
  });

  it('the activity feed reaches the detector’s safety stop during its drive', () => {
    expect(kt('ActivityTransitionReceiver')).toMatch(/if \(CaptureService\.detectorCapture\) DriveDetector\.peek\(\)\?\.onTransition\(type, enter, arrival\.toDouble\(\)\)/);
  });
});
