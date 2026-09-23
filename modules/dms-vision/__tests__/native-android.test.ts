/** @jest-environment node */
// The Android module (Task 4) read as text. Kotlin cannot run under Jest, so this pins what can be
// checked statically against the JS contract, as native-ios.test.ts does for Swift:
// - events, methods and error codes;
// - the argument Records field-for-field against the zod schemas, the status payload keys;
// - every wire and lifecycle constant against src/constants.ts;
// - the pure files' imports (they compile and run on a plain JVM, where the self-test ran over every vector);
// - the privacy bans, the stride-aware pixel reader, the matrix-layout rule;
// - the batcher, the pause order, the in-flight timeout and the interruption hold (Task 3 review);
// - the background stop, the lifecycle clock, the frame clock and process CPU;
// - the gaze net and ONNX Runtime only in the gazenet source set.
// Behaviour is proven by the JVM self-test run (Task 4 report) and by the EAS build and device pass.
import {
  ALLOWED_FPS,
  ALLOWED_ROTATIONS,
  BATCH_MS,
  FLAG,
  FRAME_BYTES,
  FRAME_FIELDS,
  FRAME_STRIDE,
  FRAME_WIRE_VERSION,
  MAX_T_OFF_MS,
  MODEL_RELEASE_AFTER_PAUSE_MS,
  THERMAL_COOL_DWELL_MS,
  THERMAL_FLOOR,
  THERMAL_L1_ENTRY_DWELL_MS,
  WATCHDOG_PAUSE_MS,
  WATCHDOG_STOP_MS,
} from '../src/constants';
import { DMS_VISION_ERROR_CODES, DMS_VISION_EVENTS, DMS_VISION_METHODS } from '../src/types';
import { capturePolicySchema, startOptionsSchema, statusSchema } from '../src/wire';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readdirSync: (d: string) => string[]; readFileSync: (f: string, e: 'utf8') => string; existsSync: (f: string) => boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const SRC = path.join(__dirname, '..', 'android', 'src');
const PKG = path.join('java', 'expo', 'modules', 'dmsvision');
const MAIN_DIR = path.join(SRC, 'main', PKG);
const MAIN = fs.readdirSync(MAIN_DIR).filter((f) => f.endsWith('.kt')).sort();
const NET = 'gazenet/GazeNet.kt';
const STUB = 'nogazenet/GazeNet.kt';
const ALL = [...MAIN, NET, STUB];
const file = (f: string) => (f === NET ? path.join(SRC, 'gazenet', PKG, 'GazeNet.kt') : f === STUB ? path.join(SRC, 'nogazenet', PKG, 'GazeNet.kt') : path.join(MAIN_DIR, f));
const raw = (f: string) => fs.readFileSync(file(f), 'utf8');
/** Kotlin with `//` line comments and KDoc/block comments removed, so a comment can neither satisfy nor trip a check. */
const code = (f: string) =>
  raw(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:"])\/\/.*$/, '$1'))
    .join('\n');
const allCode = () => ALL.map(code).join('\n');
const controller = () => `${code('CaptureController.kt')}\n${code('CaptureControllerLifecycle.kt')}`;

/** The JVM-only files compiled and run on the host (the self-test's production classes). */
const PURE = [
  'DmsConstants.kt',
  'DmsError.kt',
  'FeatureExtractor.kt',
  'Focal.kt',
  'GazeInputs.kt',
  'HeadPose.kt',
  'Landmarks.kt',
  'Lifecycle.kt',
  'RecordEncoder.kt',
  'Roi.kt',
  'SelfTest.kt',
];

const schemaKeys = (s: unknown) => Object.keys((s as { shape: Record<string, unknown> }).shape).sort();
function recordFields(cls: string): string[] {
  const m = new RegExp(`class ${cls} : Record \\{([\\s\\S]*?)\\n  fun validated`).exec(code('DmsRecords.kt'));
  expect(m).not.toBeNull();
  return [...m![1]!.matchAll(/@Field var (\w+):/g)].map((x) => x[1]!).sort();
}

/** The body of `fun name(` in a file: up to the first later line at the declaration's own indent (its closing brace). */
function body(src: string, name: string): string {
  const m = new RegExp(`\\n( *)(?:\\w+ )*fun (?:\\w+\\.)?${name}\\(`).exec(src);
  expect({ name, found: m !== null }).toEqual({ name, found: true });
  const start = m!.index + 1;
  const indent = m![1]!;
  const end = src.slice(start).search(new RegExp(`\\n${indent}\\S`));
  return end < 0 ? src.slice(start) : src.slice(start, start + end + indent.length + 2);
}

test('the files of the task exist, and the V1 sources are gone', () => {
  for (const f of [
    'DmsVisionModule.kt',
    'CaptureController.kt',
    'CaptureControllerLifecycle.kt',
    'CameraSetup.kt',
    'Landmarker.kt',
    'DmsPreviewView.kt',
    'DmsRecords.kt',
    'DmsAssets.kt',
    'DmsLog.kt',
    'FrameBitmap.kt',
    ...PURE,
  ]) {
    expect(MAIN).toContain(f);
  }
  for (const f of ['DmsVisionPipeline.kt', 'DmsVisionGaze.kt', 'DmsVisionSupport.kt']) expect(MAIN).not.toContain(f);
  expect(MAIN).not.toContain('GazeNet.kt'); // only in the two variant source sets
  for (const f of ALL) expect({ f, lines: raw(f).split('\n').length <= 400 }).toEqual({ f, lines: true });
});

test('declares exactly DMS_VISION_EVENTS, and sends no other event', () => {
  const m = /Events\(([^)]*)\)/.exec(code('DmsVisionModule.kt'));
  expect([...m![1]!.matchAll(/"(\w+)"/g)].map((x) => x[1])).toEqual([...DMS_VISION_EVENTS]);
  const sent = [...allCode().matchAll(/sendEvent\("(\w+)"/g)].map((x) => x[1]);
  expect(new Set(sent)).toEqual(new Set(DMS_VISION_EVENTS));
});

test('one AsyncFunction per DMS_VISION_METHODS entry and no others', () => {
  const declared = [...code('DmsVisionModule.kt').matchAll(/AsyncFunction\("(\w+)"\)/g)].map((x) => x[1]);
  expect([...declared].sort()).toEqual([...DMS_VISION_METHODS].sort());
  // No labelled return inside an AsyncFunction body (EAS build cc91ab36 refused one).
  expect(code('DmsVisionModule.kt')).not.toContain('return@AsyncFunction');
});

test('the argument Records have exactly the schema keys (Task 1 review m3)', () => {
  expect(recordFields('StartOptionsRecord')).toEqual(schemaKeys(startOptionsSchema));
  expect(recordFields('CapturePolicyRecord')).toEqual(schemaKeys(capturePolicySchema));
});

test('the status payload has exactly the status schema keys', () => {
  const m = /val status: Map<String, Any\?> = mapOf\(([\s\S]*?)\n\s*\)\n/.exec(controller());
  expect(m).not.toBeNull();
  const keys = [...m![1]!.matchAll(/"(\w+)" to/g)].map((x) => x[1]!).sort();
  expect(keys).toEqual(schemaKeys(statusSchema));
});

test('rejects only with contract codes, and uses every native one', () => {
  const used = new Set([...allCode().matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]));
  for (const c of used) expect(DMS_VISION_ERROR_CODES).toContain(c);
  for (const c of DMS_VISION_ERROR_CODES.filter((x) => x !== 'E_UNAVAILABLE' && x !== 'E_RESULT')) expect(used).toContain(c);
});

test('every wire and lifecycle constant equals src/constants.ts', () => {
  const src = code('DmsConstants.kt');
  const num = (name: string) => Number(new RegExp(`const val ${name} = (\\d+)`).exec(src)![1]);
  const expected: Record<string, number> = {
    FRAME_WIRE_VERSION,
    FRAME_STRIDE,
    FRAME_BYTES,
    BATCH_MS,
    WATCHDOG_PAUSE_MS,
    WATCHDOG_STOP_MS,
    MODEL_RELEASE_AFTER_PAUSE_MS,
    THERMAL_L1_ENTRY_DWELL_MS,
    THERMAL_COOL_DWELL_MS,
    MAX_T_OFF_MS,
    FLAG_NET_RAN: FLAG.NET_RAN,
    FLAG_EYE_CLIPPED_R: FLAG.EYE_CLIPPED_R,
    FLAG_EYE_CLIPPED_L: FLAG.EYE_CLIPPED_L,
    FLAG_MOUTH_CLIPPED: FLAG.MOUTH_CLIPPED,
    FLAG_POSE_MISSING: FLAG.POSE_MISSING,
  };
  for (const [name, value] of Object.entries(expected)) expect({ name, value: num(name) }).toEqual({ name, value });
  const list = (name: string) => JSON.parse(`[${new RegExp(`val ${name}: List<\\w+> = listOf\\(([^)]*)\\)`).exec(src)![1]!}]`) as unknown[];
  expect(list('ALLOWED_FPS')).toEqual([...ALLOWED_FPS]);
  expect(list('ALLOWED_ROTATIONS')).toEqual([...ALLOWED_ROTATIONS]);
  expect(list('THERMAL_FPS_CAP')).toEqual(THERMAL_FLOOR.map((s) => s.fpsCap));
  expect(list('THERMAL_GAZE_NET')).toEqual(THERMAL_FLOOR.map((s) => s.gazeNet));
  const names = /val FIELD_NAMES: List<String> = listOf\(([\s\S]*?)\)/.exec(src)![1]!;
  expect([...names.matchAll(/"(\w+)"/g)].map((x) => x[1])).toEqual([...FRAME_FIELDS]);
  const idx = src.slice(src.indexOf('object F {'));
  FRAME_FIELDS.forEach((f, i) => expect({ f, i: Number(new RegExp(`const val ${f} = (\\d+)`).exec(idx)?.[1]) }).toEqual({ f, i }));
});

test('the pure files import only kotlin, java.nio and org.json (they run on a plain JVM)', () => {
  for (const f of PURE) {
    const imports = [...code(f).matchAll(/^import ([\w.]+)/gm)].map((x) => x[1]!);
    const bad = imports.filter((i) => !/^(kotlin\.|java\.nio\.|org\.json\.)/.test(i));
    expect({ f, bad }).toEqual({ f, bad: [] });
  }
});

test('privacy: no pixels out, no storage, no network, logging only through DmsLog with static codes', () => {
  for (const f of ALL) {
    const src = code(f);
    const hit = (re: RegExp) => ({ f, re: String(re), hit: re.test(src) });
    for (const re of [
      /\bprintln\(|\bprint\(|System\.out|System\.err|printStackTrace/,
      /\bURL\(|HttpURLConnection|OkHttp|java\.net\.Socket/,
      /FileOutputStream|openFileOutput|\.writeBytes\(|\.writeText\(|MediaStore|getExternal/,
      /\.compress\(Bitmap|ImageCapture|VideoCapture|MediaRecorder/,
      /\bputExtra\(|sendBroadcast/,
    ]) {
      expect(hit(re)).toEqual({ f, re: String(re), hit: false });
    }
    if (f !== 'DmsLog.kt') expect({ f, log: /\bLog\.[vdiwe]\(|android\.util\.Log\b/.test(src) }).toEqual({ f, log: false });
  }
  // DmsLog writes only the enum name.
  expect(code('DmsLog.kt')).toMatch(/Log\.i\(TAG, c\.name\)/);
  // The frames payload carries only the encoded records and the header.
  const payload = /return mapOf\(\s*"v" to([\s\S]*?)\n\s*\)/.exec(code('RecordEncoder.kt'))![0];
  expect([...payload.matchAll(/"(\w+)" to/g)].map((x) => x[1]).sort()).toEqual(['anchorEpochMs', 'anchorTMs', 'data', 'n', 'v']);
});

test('pixels are read through the plane strides, RGBA, never width × 4 (Task 2 review I1)', () => {
  expect(code('Roi.kt')).toContain('val p = y * rowStride + x * pixelStride');
  const cc = code('CaptureController.kt');
  expect(cc).toContain('val plane = f.proxy.planes[0]');
  expect(cc).toContain('LumaSource(plane.buffer, w, h, plane.rowStride, plane.pixelStride, false)');
  expect(code('SelfTest.kt')).toContain('LumaSource(img.bytes, img.w, img.h, img.stride, 4, img.bgra)');
  expect(allCode()).not.toMatch(/LumaSource\([^)]*\b\w+\s*\*\s*4\b/);
  expect(code('CameraSetup.kt')).toContain('ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888');
  expect(code('CameraSetup.kt')).toContain('ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST');
});

test("every head pose goes through the layout rule, on MediaPipe's raw float[16] (Task 2 review I2)", () => {
  expect(code('HeadPose.kt')).toContain('fun normaliseLayout(m: DoubleArray): DoubleArray?');
  expect(code('FeatureExtractor.kt')).toContain('HeadPose.fromAnyLayout(it, f.rotationDeg)');
  expect(code('SelfTest.kt')).toContain('HeadPose.fromAnyLayout(');
  expect(allCode().match(/HeadPose\.fromMatrix\(/g) ?? []).toHaveLength(0);
  const l = code('Landmarker.kt');
  expect(l).toContain('.setOutputFacialTransformationMatrixes(true)');
  expect(l).toContain('facialTransformationMatrixes()?.orElse(null)?.firstOrNull()');
  expect(l).toContain('DoubleArray(16) { m[it].toDouble() }'); // as delivered: no transpose here
});

test('tOffMs is computed in Double before the Float store, and anchorTMs is a Double (Task 1 review C1)', () => {
  const e = code('RecordEncoder.kt');
  expect(e).toContain('(value - anchorTMs).toFloat()');
  expect(e).toContain('val anchorTMs = first[F.tOffMs]');
  expect(e).toContain('class EncodedBatch(val anchorTMs: Double');
  expect(e).toContain('ByteOrder.LITTLE_ENDIAN');
});

test('the self-test runs the production classes, and holds no copy of their logic', () => {
  const src = code('SelfTest.kt');
  for (const s of ['FeatureExtractor.buildRecord(', 'RecordEncoder.encode(', 'GazeInputAssembler()', 'SubjectStatisticTracker(', 'Batcher()', 'Focal.focalScale(', 'LumaSource(']) {
    expect(src).toContain(s);
  }
  expect(src).not.toMatch(/fun (luma|eyeLuma|blurScore|irisOffset|weak3dCloud|fromMatrix|isDue|normaliseLayout)\b/);
  expect(code('DmsVisionModule.kt')).toContain('SelfTest.run(vectorsJson, GazeNetFactory.available) { GazeNetFactory.make(ctx) }');
});

test('the batcher flushes predictively, with no timer (Task 3 review I1)', () => {
  expect(code('RecordEncoder.kt')).toContain('nowMs - startedAtMs + intervalMs >= DmsConstants.BATCH_MS.toDouble()');
  expect(code('CaptureController.kt')).toMatch(/batcher\.isDue\(now, 1000\.0 \/ max\(snap\.cap, 1\)\)/);
  expect(code('SelfTest.kt')).toContain('"batcher" -> ');
});

test('pause: paused under the lock, then capture stops, then the flush, then the event; resume starts a fresh batch (Task 3 review m1)', () => {
  const cc = code('CaptureController.kt');
  const p = body(cc, 'pause');
  const order = ['state = "paused"', 'unbindCamera()', 'flushBatch()', 'emitState("paused"'].map((s) => p.indexOf(s));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(body(cc, 'resume')).toContain('batcher.clear()');
  const t = body(cc, 'teardown');
  expect(t.indexOf('unbindCamera()')).toBeLessThan(t.indexOf('flushBatch()'));
  expect(t.indexOf('exec.awaitTermination')).toBeLessThan(t.indexOf('lmk?.close()')); // no detectAsync can run into a closed graph
  expect(body(cc, 'stop')).toMatch(/state = "stopped"[\s\S]*teardown\(\)[\s\S]*emitState\("stopped"/);
  expect(body(cc, 'handleResult')).toContain('if (state != "running") null');
  // The ImageProxy is closed on every path.
  expect(body(cc, 'analyze')).toMatch(/finally \{\s*if \(!keep\) proxy\.close\(\)/);
  expect(body(cc, 'handleResult')).toMatch(/finally \{\s*f\.proxy\.close\(\)/);
});

test('a lost landmarker callback holds capture for at most max(3 intervals, 250 ms) (Task 3 review m2)', () => {
  const cc = code('CaptureController.kt');
  expect(cc).toContain('max(3 * interval, 250.0)');
  expect(cc).toMatch(/analysis\?\.schedule\(\{ onTimeout\(tsMs\) \}, holdMs, TimeUnit\.MILLISECONDS\)/);
});

test('an interruption holds the pause until the camera reopens: no re-bind churn (Task 3 review m3)', () => {
  const cc = controller();
  expect(body(code('CaptureController.kt'), 'applyPolicy')).toMatch(/thermal\.allowsCamera && !interrupted/);
  const s = body(code('CaptureControllerLifecycle.kt'), 'onCameraState');
  expect(s).toContain('interrupted = true');
  expect(s).toContain('CameraState.Type.OPEN');
  expect(s).toContain('interrupted = false');
  expect(s).not.toMatch(/resume\(\)|bindCamera\(\)/); // never resumes by itself
  // An interruption keeps the binding (CameraX retries); other pauses unbind.
  expect(body(code('CaptureController.kt'), 'pause')).toContain('if (reason != "interrupted" && reason != "error") unbindCamera()');
  expect(cc).toContain('cameraInfo.cameraState.observe(');
});

test('native owns the lifecycle: background stop, the lifecycle clock, process CPU, the thermal floor', () => {
  const mod = code('DmsVisionModule.kt');
  expect(mod).toMatch(/OnActivityEntersBackground \{[\s\S]*?stop\("background"\)/);
  expect(mod).not.toMatch(/runBlocking|\.get\(\)\s*$/m);
  const cc = controller();
  expect(cc).toContain('Process.getElapsedCpuTime()');
  expect(cc).toContain('SystemClock.elapsedRealtime()'); // the lifecycle clock counts through deep sleep
  expect(cc).toContain('LifecycleRules.decide(');
  expect(cc).toContain('addThermalStatusListener(');
  expect(cc).toContain('thermal.fpsCap');
  expect(cc).toContain('thermal.allowsGazeNet');
  expect(cc).toContain('HandlerThread("DmsVisionSession")');
  // The foreground check reads a cached flag, never the main thread synchronously (Task 3 review nit).
  expect(mod).toMatch(/if \(!foreground \|\| owner == null\) throw DmsError\.notForeground/);
  expect(mod).toContain('OnActivityEntersForeground');
});

test('the frame clock is rebased at the first frame, and the anchor epoch reads the same base (Task 3 review flag 4)', () => {
  const l = code('Lifecycle.kt');
  expect(l).toContain('abs(elapsedNs - frameNs) <= WITHIN_NS -> { base = Base.ELAPSED');
  expect(l).toContain('abs(uptimeNs - frameNs) <= WITHIN_NS -> { base = Base.UPTIME');
  expect(l).toContain('const val WITHIN_NS = 1_000_000_000L');
  expect(l).toContain('(if (base == Base.UPTIME) uptimeNs else elapsedNs) / 1e6');
  const cc = code('CaptureController.kt');
  expect(cc).toContain('clock.calibrate(frameNs, SystemClock.elapsedRealtimeNanos(), System.nanoTime())');
  expect(cc).toContain('val now = clock.baseNowMs(SystemClock.elapsedRealtimeNanos(), System.nanoTime())');
  expect(cc).toContain('batcher.append(record, now, epochNow)');
  expect(allCode()).not.toContain('uptimeNanos()'); // API 33
});

test('the thermal names follow README §6 (level 1 is MODERATE)', () => {
  const s = code('CameraSetup.kt');
  expect(s).toContain('PowerManager.THERMAL_STATUS_NONE, PowerManager.THERMAL_STATUS_LIGHT -> "nominal"');
  expect(s).toContain('PowerManager.THERMAL_STATUS_MODERATE -> "fair"');
  expect(s).toContain('PowerManager.THERMAL_STATUS_SEVERE -> "serious"');
});

test('landmarker and camera configuration: CPU delegate default, one face, the front camera', () => {
  const l = code('Landmarker.kt');
  expect(l).toContain('.setDelegate(if (gpu) Delegate.GPU else Delegate.CPU)');
  expect(l).toContain('.setNumFaces(1)');
  expect(l).toContain('RunningMode.LIVE_STREAM');
  expect(controller()).toContain('CameraSelector.DEFAULT_FRONT_CAMERA');
  expect(allCode()).not.toContain('DEFAULT_BACK_CAMERA');
});

test('the gaze net and ONNX Runtime live only in the gazenet source set (behind the build switch)', () => {
  for (const f of ALL) {
    const usesOrt = /ai\.onnxruntime|OrtSession|OrtEnvironment/.test(code(f));
    expect({ f, usesOrt }).toEqual({ f, usesOrt: f === NET });
    expect({ f, model: /gaze_direct/.test(code(f)) }).toEqual({ f, model: f === NET });
  }
  const net = code(NET);
  expect(net).toContain('options.setIntraOpNumThreads(1)');
  expect(net).toContain('options.setInterOpNumThreads(1)');
  expect(net).toContain('options.addConfigEntry("session.intra_op.allow_spinning", "0")');
  expect(net).toContain('const val available = true');
  expect(code(STUB)).toContain('const val available = false');
  // The two variants declare the same factory surface.
  const surface = (f: string) => [...code(f).matchAll(/(?:fun|val) (\w+)/g)].map((x) => x[1]).filter((n) => ['available', 'onnxRuntimeVersion', 'modelSha256', 'make'].includes(n!)).sort();
  expect(surface(NET)).toEqual(surface(STUB));
});

test('the predictive flush is also checked at the top of every analyze call, before any early return (round-1 m-r1)', () => {
  const a = body(code('CaptureController.kt'), 'analyze');
  const check = a.indexOf('batcher.isDue(');
  expect(check).toBeGreaterThan(0);
  expect(check).toBeLessThan(a.search(/\breturn\b/));
  expect(code('SelfTest.kt')).toContain('"arriveMs"');
  expect(code('SelfTest.kt')).toContain('"skipped"');
});

test('one reusable bitmap per session, filled from the plane; no per-frame toBitmap() (T4-I2)', () => {
  const fb = code('FrameBitmap.kt');
  expect(allCode()).not.toContain('toBitmap(');
  expect(fb).toContain('copyPixelsFromBuffer(');
  expect(allCode().match(/Bitmap\.createBitmap\(/g) ?? []).toHaveLength(1);
  // …created only when the size changes, and recycled only there and at teardown.
  expect(fb).toMatch(/if \(b == null \|\| b\.width != w \|\| b\.height != h\) \{\s*b\?\.recycle\(\)\s*b = Bitmap\.createBitmap\(/);
  expect(body(code('CaptureController.kt'), 'analyze')).toContain('val bitmap = frameBitmap.fill(proxy)');
  expect(body(code('CaptureController.kt'), 'analyze')).not.toContain('recycle()');
  const t = body(code('CaptureController.kt'), 'teardown');
  expect(t.indexOf('lmk?.close()')).toBeLessThan(t.indexOf('frameBitmap.release()'));
  // Padded rows are packed into a reusable buffer first; the plane's own buffer is never moved.
  expect(fb).toContain('plane.rowStride == w * 4');
  expect(fb).toContain('val src = plane.buffer.duplicate()');
});

test('the gaze net is created at start whenever the build has it; gazeNetWanted only gates running it (T4-I1)', () => {
  const start = body(code('CaptureController.kt'), 'start');
  expect(start).toMatch(/if \(GazeNetFactory\.available\) \{[\s\S]*?GazeNetFactory\.make\(context\)/);
  expect(start).not.toMatch(/o\.gazeNet && GazeNetFactory\.available/);
  expect(body(code('CaptureController.kt'), 'handleResult')).toContain('snap.wantNet && snap.netOk');
});

test('a bind that times out on the main thread is undone there (T4 m3)', () => {
  const b = body(code('CaptureControllerLifecycle.kt'), 'bindCamera');
  expect(b).toMatch(/if \(!done\) \{[\s\S]*?\.post \{[\s\S]*?unbind\(/);
  expect(code('CaptureControllerLifecycle.kt')).toContain('internal fun CaptureController.runOnMain(block: () -> Unit): Boolean');
});

test('the frame clock base is fixed per session (T4 nit)', () => {
  expect(raw('Lifecycle.kt')).toMatch(/base is then fixed for[\s*]+the session/);
});

test('after an in-flight timeout the next frame gets a fresh bitmap; the old one waits for its late result (D2 review m1)', () => {
  const cc = code('CaptureController.kt');
  expect(body(cc, 'onTimeout')).toContain('frameBitmap.abandon(tsMs)');
  expect(body(cc, 'handleResult')).toMatch(/if \(f == null \|\| \(ts >= 0 && f\.tsMs != ts\)\) \{\s*[\s\S]*?frameBitmap\.lateResult\(ts\)/);
  const fb = code('FrameBitmap.kt');
  // abandon() drops the current bitmap, so fill() allocates a new one; lateResult() recycles only the matching one.
  expect(body(fb, 'abandon')).toMatch(/bitmap = null[\s\S]*abandoned\.add\(tsMs to b\)/);
  expect(body(fb, 'lateResult')).toMatch(/indexOfFirst \{ it\.first == tsMs \}[\s\S]*\.recycle\(\)/);
  expect(body(fb, 'release')).toMatch(/for \(\(_, b\) in abandoned\) b\.recycle\(\)/);
  expect(fb).toContain('const val MAX_ABANDONED = 4');
});
