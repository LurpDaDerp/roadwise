/** @jest-environment node */
// The Android drive detector's runtime (`DriveDetectModule.kt`, `detect/DriveDetector*.kt`,
// `RowJournal*.kt`, the capture service's detector mode), read as text as `native-android.test.ts`
// reads the rest of the Kotlin. Behaviour is proven by the JVM unit tests (`RowJournalTest.kt`,
// `DriveDetectRecordTest.kt`) and the host's Android tests with the fake detector; this suite pins
// what can be checked statically: the bridge's surface against `src/detect/types.ts` (the car link
// included, so JS reads `carLinkAvailable` as on iPhone), the journal's place and its sync rules, the one thread, the
// policy the safety stop and the resume decide with, the capture service's detector mode (no
// watchdog, a refusal that never loses the drive) and the launch hook. The automatic wakes, the
// watch, the linger and the rest are held in native-android.test.ts.
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

/** The car link's half of the contract (JS reads `carLinkAvailable` from `carLinkState`). */
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

  it('declares the contract events, the car link’s included, in order', () => {
    const m = /Events\(([^)]*)\)/.exec(MODULE());
    expect([...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual([...DRIVE_DETECT_EVENTS]);
    const observed = /OBSERVED_EVENTS = listOf\(([^)]*)\)/.exec(MODULE());
    expect([...observed![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])).toEqual([...DRIVE_DETECT_EVENTS]);
  });

  it('declares one AsyncFunction per contract method, the car link’s included, none twice; each car call answers from the detector’s thread', () => {
    const declared = [...MODULE().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...DRIVE_DETECT_METHODS].sort());
    expect(new Set(declared).size).toBe(declared.length);
    for (const car of CAR_METHODS) expect(fn(MODULE(), `AsyncFunction("${car}")`, 4)).toMatch(new RegExp(`detector\\(\\)\\.${car}[ (]`));
    const d = det('DriveDetector');
    for (const car of CAR_METHODS) expect({ car, posts: /^\s*handler\.post \{/m.test(fn(d, `  fun ${car}(`, 2).split('\n').slice(1, 3).join('\n')) }).toEqual({ car, posts: true });
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
    for (const name of ['setArmed', 'getState', 'permissionsChanged', 'rearm', 'startWaiting', 'extendWaiting', 'cancelWaiting', 'stopCapture', 'listDrives', 'discardDrive', 'wipe', 'appForeground', 'resumeAtLaunch']) {
      expect({ name, posts: /^\s*handler\.post \{/m.test(fn(d, `  fun ${name}(`, 2).split('\n').slice(1, 3).join('\n')) }).toEqual({ name, posts: true });
    }
    expect(fn(det('DriveDetectorDrive'), 'fun DriveDetector.notDriving(')).toMatch(/^\s*handler\.post \{/m);
    expect(fn(det('DriveDetectorDrive'), 'fun DriveDetector.onRow(')).toMatch(/handler\.post \{/);
    // The wakes and the live feed post too (their broadcasts and Play services answer on main).
    for (const decl of ['fun DriveDetector.onTransitions(', 'fun DriveDetector.onRegionExit(']) expect(fn(det('DriveDetectorWatch'), decl)).toMatch(/^\s*handler\.post \{/m);
    expect(fn(det('DriveDetectorSensing'), 'fun DriveDetector.onActivity(')).toMatch(/^\s*handler\.post \{/m);
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
    expect(fn(drive(), 'internal fun DriveDetector.evaluateEnd(')).toMatch(/DetectPolicy\.endDue\(endClock, startedAt, now, walkSince, r\.waitUntil, carLink\.goneSince\)/);
    expect(det('DriveDetector')).toMatch(/handler\.postDelayed\(tickTask, DetectPolicy\.TICK_MS\.toLong\(\)\)/);
    const commit = fn(drive(), 'internal fun DriveDetector.commitEnd(');
    expect(commit.indexOf('journal.appendMarker(')).toBeLessThan(commit.indexOf('"driveEnded"'));
    expect(commit).toMatch(/if \(cause != "js"\)/);
    expect(commit).toMatch(/finishSensing\(holdMs = DetectPolicy\.END_TASK_MAX_MS\.toLong\(\), demote = lingers\)/);
  });

  it('a new process resumes a drive whose last row is 5 min old or less (a gap past resumeSeq), else ends it as an orphan', () => {
    const settle = fn(drive(), 'private fun DriveDetector.settleResume(');
    expect(settle).toMatch(/if \(DetectPolicy\.resumeDecision\(summary\.lastRowTs, startedAt, now\) != ResumeDecision\.RESUME\) \{\s*commitEnd\("orphan", now\)\s*return true/);
    // Wakes that came while the journal was read wait for it (held with their done), then are
    // replayed; a sticky restart's service is kept through them, so a drive that ended can watch.
    const resume = fn(drive(), 'internal fun DriveDetector.resumeDrive(');
    expect(resume).toMatch(/val sticky = stickyResume \|\| \(CaptureService\.foregroundRunning\(\) && !CaptureService\.isCapturing\)\s*stickyResume = false/);
    expect(resume).toMatch(/if \(sticky\) CaptureService\.holdRelease\(\)\s*heldWakes\.settling\(sticky\)\s*val ended = settleResume\(driveId, summary\)\s*for \(\(reason, done\) in heldWakes\.drain\(ended, sticky, noop = \{\}\)\) onWake\(reason, done\)\s*if \(sticky\) CaptureService\.endReleaseHold\(\)/);
    expect(fn(det('DriveDetectorWatch'), 'internal fun DriveDetector.onWake(')).toMatch(/if \(resuming\) \{\s*heldWakes\.hold\(reason, done\)\s*return\s*\}/);
    expect(kt('CaptureService')).toMatch(/main\.post \{ if \(!releaseHeld && !isCapturing/);
    const sensed = fn(drive(), 'private fun DriveDetector.onResumeSensing(');
    expect(sensed).toMatch(/if \(code != null\) \{[\s\S]*?resumePending = true\s*return\s*\}/);
    expect(sensed).toMatch(/val skipTo = DetectPolicy\.resumeSeq\(s\.topSeq\)\s*nextSeq = skipTo \+ 1/);
    expect(sensed).toMatch(/JSONObject\(\)\.put\("k", "gap"\)/);
    expect(sensed).toMatch(/endClock = DetectPolicy\.endClockAt\(s\.lastRowTs \?: now\)/);
    // The refused resume is tried again when RoadWise comes to the front.
    expect(fn(det('DriveDetector'), '  fun appForeground(', 2)).toMatch(/if \(resumePending && !resuming && !sensing && r\.recording\) r\.driveId\?\.let \{ resumeDrive\(it\) \}/);
    // ...and at any wake (its broadcast may start the location service), never answered busy while
    // nothing senses the drive: the wake is held through the resume, the flag cleared first so its
    // replay never retries, all before the gate.
    const wake = fn(det('DriveDetectorWatch'), 'internal fun DriveDetector.onWake(');
    expect(wake).toMatch(
      /if \(resuming\) \{\s*heldWakes\.hold\(reason, done\)\s*return\s*\}\s*val pendingId = rec\?\.takeIf \{ it\.recording \}\?\.driveId\s*if \(resumePending && pendingId != null && !sensing && !CaptureService\.isCapturing\) \{\s*resumePending = false\s*heldWakes\.hold\(reason, done\)\s*resumeDrive\(pendingId\)\s*return\s*\}/,
    );
    expect(wake.indexOf('resumeDrive(pendingId)')).toBeLessThan(wake.indexOf('DetectPolicy.wakeGate(ctx)'));
    expect(kt('AppVisibility')).toMatch(/DriveDetector\.peek\(\)\?\.appForeground\(\)/);
  });

  it('every process start hands itself to the detector (DriveSensePackage), and the sticky restart too', () => {
    expect(kt('DriveSensePackage')).toMatch(/DriveDetector\.get\(application\)\.resumeAtLaunch\(\)/);
    const svc = kt('CaptureService');
    expect(svc).toMatch(
      /val owned = prefs\.detectorOwned\s*if \(owned \|\| DriveDetector\.peek\(\)\?\.owesStickyWake\(\) == true\) \{\s*if \(goForeground\(restart = owned, watch = !owned\) != null\) \{\s*stopSelf\(startId\)\s*return START_NOT_STICKY\s*\}\s*holdRelease\(\)\s*DriveDetector\.get\(this\)\.resumeAtLaunch\(sticky = true\)\s*return START_STICKY/,
    );
  });

  it("the sticky restart settles whichever comes first, its service's start or the launch's journal read", () => {
    const d = det('DriveDetector');
    const launch = fn(d, '  fun resumeAtLaunch(', 2);
    // The launch's resume already ended the drive before the service was up: its app wake now.
    expect(launch).toMatch(/if \(sticky && heldWakes\.takeOwed\(\)\) \{\s*onWake\(WakeReason\.APP\)\s*CaptureService\.endReleaseHold\(\)\s*return@post\s*\}/);
    // Busy: the hold ends without letting the service go; a resume reading settles as the restart's.
    expect(launch).toMatch(/if \(sensing \|\| resuming \|\| starting \|\| watching\) \{\s*if \(sticky\) stickySettles\(release = false\)\s*return@post\s*\}/);
    expect(launch).toMatch(/resumeDrive\(id\)\s*if \(sticky\) stickySettles\(\)/);
    expect(launch.match(/if \(sticky\) stickySettles\(/g)?.length).toBe(4);
    expect(fn(d, '  private fun stickySettles(', 2)).toMatch(/if \(resuming\) stickyResume = true else CaptureService\.endReleaseHold\(release\)/);
    expect(d).toMatch(/internal fun owesStickyWake\(\): Boolean = heldWakes\.owed/);
    expect(det('DriveDetectRecord')).toMatch(/@Volatile var owed = false/);
    expect(kt('CaptureService')).toMatch(/releaseHeld = false\s*if \(release\) releaseIfIdle\(\)/);
  });

  it("a watch begun on a service already in the foreground swaps the ended drive's notification for \"Checking for a drive\"", () => {
    const svc = kt('CaptureService');
    expect(svc).toMatch(/inst\.handler\.post \{ inst\.beginWatch\(inPlace = true\) \}/);
    expect(fn(svc, '  private fun beginWatch(', 2)).toMatch(
      /beginCapture\("auto"[^\n]*watch = true\)\s*if \(inPlace\) \{\s*main\.post \{\s*DriveNotificationController\.endDrive\(this\)\s*postNotification\(WatchNotification\.build\(this\)\)/,
    );
    // The ACTION_WATCH path posts it as it goes to the foreground.
    expect(svc).toMatch(/handler\.post \{ beginWatch\(\) \}/);
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

  it('the wakes exist with Play services; "Allow all the time" is asked for by the module alone; the status the UI reads', () => {
    const access = det('DriveDetectAccess');
    expect(access).toMatch(/hardware = DriveSensePermissions\.playServicesAvailable\(app\)/);
    expect(access).not.toMatch(/ACCESS_BACKGROUND_LOCATION|requestPermissions/);
    expect(kt('DriveDetectModule')).toMatch(/Manifest\.permission\.ACCESS_BACKGROUND_LOCATION/);
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
    expect(svc()).toMatch(/if \(detector != null\) detector\.onRow\(row, body, watching\) else if \(!watching\) EventBus\.emit\("row", body\)/);
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

  it('the live activity reports reach the detector’s safety stop during its drive (a walk is walking or running, as iOS counts it)', () => {
    const r = kt('ActivityTransitionReceiver');
    expect(r).toMatch(/val detector = DriveDetector\.peek\(\)\s*detector\?\.onActivity\(report\.motion\(arrival\.toDouble\(\)\)\)/);
    expect(det('LiveActivity')).toMatch(/walking = type == "walking" \|\| type == "running"/);
    // A confident walk stands from its first report until a report other than a walk replaces it.
    const on = fn(det('DriveDetectorSensing'), 'fun DriveDetector.onActivity(');
    expect(on).toMatch(/if \(a\.walking\) \{\s*if \(a\.confident && walkSince == null\) walkSince = a\.at\s*\} else \{\s*walkSince = null\s*\}/);
    expect(on).toMatch(/carStanding = car/);
    // The batch rule stays pure and JVM-tested (the rest folds its transitions with restAfter).
    expect(det('DetectEndPolicy')).toMatch(/val onFoot = t\.type == "walking" \|\| t\.type == "running"/);
    expect(read(join(TEST_DIR, 'detect', 'DetectPolicyTest.kt'))).toContain('a walk is walking or running, as iOS counts it');
  });

  it('a capture row with no sensed drive is waited on, stops the capture, or takes its recording drive back (a resume counted as refused that began after all)', () => {
    const onRow = fn(det('DriveDetectorDrive'), 'fun DriveDetector.onRow(');
    expect(onRow).toMatch(/when \(captureRowFate\(sensing, starting, resuming, r\?\.recording == true\)\)/);
    expect(onRow).toMatch(/CaptureRowFate\.STOP -> \{\s*CaptureService\.stopDetector\(app, 0L\)/);
    expect(onRow).toMatch(/CaptureRowFate\.TAKE_BACK -> \{\s*r\?\.driveId\?\.let \{ resumeDrive\(it\) \} \?: CaptureService\.stopDetector\(app, 0L\)/);
    expect(read(join(TEST_DIR, 'detect', 'DriveDetectRecordTest.kt'))).toContain('CaptureRowFate.TAKE_BACK, captureRowFate(sensing = false, starting = false, resuming = false, recording = true)');
  });
});

describe('native-android: the "drive started" note (DriveStartNote.kt)', () => {
  const NOTE = () => kt('DriveStartNote');

  it('is posted once, where an automatic drive begins, and is proven by its JVM test', () => {
    expect(fn(det('DriveDetectorDrive'), 'internal fun DriveDetector.beginAutoDrive(')).toMatch(/DriveStartNote\.driveStarted\(app, "auto"\)/);
    expect(fn(det('DriveDetectorDrive'), 'internal fun DriveDetector.beginDrive(')).not.toContain('DriveStartNote');
    expect(existsSync(join(TEST_DIR, 'DriveStartNoteTest.kt'))).toBe(true);
  });

  it('only for an automatic drive, with the switch on, RoadWise not showing, and notifications allowed', () => {
    expect(NOTE()).toMatch(/fun due\(kind: String, switchOff: Boolean, appVisible: Boolean\): Boolean = kind == "auto" && !switchOff && !appVisible/);
    expect(NOTE()).toMatch(/if \(!due\(kind, prefs\.driveStartNoteOff, AppVisibility\.visible\(\)\)\) return/);
    expect(NOTE()).toMatch(/if \(!NotificationManagerCompat\.from\(context\)\.areNotificationsEnabled\(\)\) return/);
  });

  it('a silent heads-up on its own channel; a tap opens the driving screen', () => {
    expect(NOTE()).toMatch(/const val CHANNEL_ID = "drive_started"/);
    expect(NOTE()).toMatch(/NotificationChannel\(CHANNEL_ID, CHANNEL_NAME, NotificationManager\.IMPORTANCE_HIGH\)/);
    expect(NOTE()).toMatch(/setSound\(null, null\)\s*enableVibration\(false\)/);
    expect(NOTE()).toMatch(/setShowBadge\(false\)/);
    expect(NOTE()).not.toMatch(/setSilent\(/);
    expect(NOTE()).toMatch(/\.setAutoCancel\(true\)/);
    expect(NOTE()).toMatch(/Uri\.parse\(NotificationFactory\.DRIVE_LINK\)/);
  });

  it('the switch is kept natively (absent is on) and set from JS; off takes the note down', () => {
    expect(kt('DriveSensePrefs')).toMatch(/var driveStartNoteOff: Boolean\s*get\(\) = p\.getBoolean\(DRIVE_START_NOTE_OFF, false\)/);
    expect(fn(kt('DriveDetectModule'), 'AsyncFunction("setStartNote")', 4)).toMatch(/DriveStartNote\.setEnabled\(context, on\)/);
    expect(NOTE()).toMatch(/driveStartNoteOff = !on\s*if \(!on\) remove\(context\)/);
  });

  it('comes down at every end or cancel and when RoadWise comes to the front', () => {
    expect(fn(det('DriveDetectorDrive'), 'internal fun DriveDetector.finishSensing(')).toMatch(/DriveStartNote\.remove\(app\)/);
    expect(kt('AppVisibility')).toMatch(/if \(wasBehind && started > 0\) \{[\s\S]*DriveStartNote\.remove\(activity\.applicationContext\)/);
  });
});
