/** @jest-environment node */
// The iOS module (Task 3) read as text. Swift cannot run under Jest, so this pins what can be checked
// statically against the JS contract:
// - events, methods and error codes;
// - the argument Records field-for-field against the zod schemas;
// - every wire and lifecycle constant against src/constants.ts;
// - the pure files' imports (they compile on Linux, where the self-test ran over every vector);
// - the privacy bans, the stride-aware pixel reader, the matrix-layout rule;
// - the background stop, the wall-clock timers and process CPU;
// - the gaze net only behind the build switch.
// Behaviour is proven by the Linux self-test run (Task 3 report) and by the EAS build and device pass.
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

const IOS = path.join(__dirname, '..', 'ios');
const TOP = fs.readdirSync(IOS).filter((f) => f.endsWith('.swift')).sort();
const ALL = [...TOP, 'GazeNet/GazeNet.swift', 'GazeNetStub/GazeNet.swift'];
const raw = (f: string) => fs.readFileSync(path.join(IOS, f), 'utf8');
/** Swift with `//` comments removed (outside string literals on the line's start), so a comment can neither satisfy nor trip a check. */
const code = (f: string) =>
  raw(f)
    .split('\n')
    .map((l) => l.replace(/(^|[^:"])\/\/.*$/, '$1'))
    .join('\n');
const allCode = () => ALL.map(code).join('\n');
const controller = () => `${code('CaptureController.swift')}\n${code('CaptureControllerLifecycle.swift')}`;

/** The Foundation-only files compiled and run on Linux (the self-test's production classes). */
const PURE = [
  'DmsConstants.swift',
  'DmsError.swift',
  'FeatureExtractor.swift',
  'GazeInputs.swift',
  'HeadPose.swift',
  'Landmarks.swift',
  'Lifecycle.swift',
  'RecordEncoder.swift',
  'Roi.swift',
  'SelfTest.swift',
  'GazeNetStub/GazeNet.swift',
];

const schemaKeys = (s: unknown) => Object.keys((s as { shape: Record<string, unknown> }).shape).sort();
function recordFields(struct: string): string[] {
  const m = new RegExp(`struct ${struct}: Record \\{([\\s\\S]*?)\\n  func validated`).exec(code('DmsRecords.swift'));
  expect(m).not.toBeNull();
  return [...m![1]!.matchAll(/@Field var (\w+):/g)].map((x) => x[1]!).sort();
}

test('the files of the task exist, and the V1 sources are gone', () => {
  for (const f of [
    'DmsVisionModule.swift',
    'CaptureController.swift',
    'CaptureControllerLifecycle.swift',
    'CaptureSession.swift',
    'Landmarker.swift',
    'DmsPreviewView.swift',
    'DmsRecords.swift',
    'DmsBundle.swift',
    'DmsLog.swift',
    ...PURE.filter((p) => !p.includes('/')),
  ]) {
    expect(TOP).toContain(f);
  }
  for (const f of ['DmsVisionPipeline.swift', 'DmsVisionGaze.swift', 'DmsVisionSupport.swift']) expect(TOP).not.toContain(f);
  for (const f of ALL) expect({ f, lines: raw(f).split('\n').length <= 400 }).toEqual({ f, lines: true });
});

test('declares exactly DMS_VISION_EVENTS, and sends no other event', () => {
  const m = /Events\(([^)]*)\)/.exec(code('DmsVisionModule.swift'));
  expect([...m![1]!.matchAll(/"(\w+)"/g)].map((x) => x[1])).toEqual([...DMS_VISION_EVENTS]);
  const sent = [...allCode().matchAll(/sendEvent\("(\w+)"/g)].map((x) => x[1]);
  expect(new Set(sent)).toEqual(new Set(DMS_VISION_EVENTS));
});

test('one AsyncFunction per DMS_VISION_METHODS entry and no others', () => {
  const declared = [...code('DmsVisionModule.swift').matchAll(/AsyncFunction\("(\w+)"\)/g)].map((x) => x[1]);
  expect([...declared].sort()).toEqual([...DMS_VISION_METHODS].sort());
});

test('the argument Records have exactly the schema keys (Task 1 review m3)', () => {
  expect(recordFields('StartOptionsRecord')).toEqual(schemaKeys(startOptionsSchema));
  expect(recordFields('CapturePolicyRecord')).toEqual(schemaKeys(capturePolicySchema));
});

test('the status payload has exactly the status schema keys', () => {
  const m = /let status: \[String: Any\?\] = \[([\s\S]*?)\n\s*\]/.exec(controller());
  expect(m).not.toBeNull();
  const keys = [...m![1]!.matchAll(/"(\w+)":/g)].map((x) => x[1]!).sort();
  expect(keys).toEqual(schemaKeys(statusSchema));
});

test('rejects only with contract codes, and uses every native one', () => {
  const used = new Set([...allCode().matchAll(/"(E_[A-Z_]+)"/g)].map((x) => x[1]));
  for (const c of used) expect(DMS_VISION_ERROR_CODES).toContain(c);
  for (const c of DMS_VISION_ERROR_CODES.filter((x) => x !== 'E_UNAVAILABLE' && x !== 'E_RESULT')) expect(used).toContain(c);
});

test('every wire and lifecycle constant equals src/constants.ts', () => {
  const src = code('DmsConstants.swift');
  const num = (name: string) => Number(new RegExp(`static let ${name} = (\\d+)`).exec(src)![1]);
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
  const list = (name: string) => JSON.parse(new RegExp(`static let ${name}: \\[\\w+\\] = (\\[[^\\]]*\\])`).exec(src)![1]!) as unknown[];
  expect(list('ALLOWED_FPS')).toEqual([...ALLOWED_FPS]);
  expect(list('ALLOWED_ROTATIONS')).toEqual([...ALLOWED_ROTATIONS]);
  expect(list('THERMAL_FPS_CAP')).toEqual(THERMAL_FLOOR.map((s) => s.fpsCap));
  expect(list('THERMAL_GAZE_NET')).toEqual(THERMAL_FLOOR.map((s) => s.gazeNet));
  const names = /static let FIELD_NAMES: \[String\] = \[([\s\S]*?)\]/.exec(src)![1]!;
  expect([...names.matchAll(/"(\w+)"/g)].map((x) => x[1])).toEqual([...FRAME_FIELDS]);
  // The F index table matches the field order.
  const idx = code('DmsConstants.swift').slice(src.indexOf('enum F {'));
  FRAME_FIELDS.forEach((f, i) => expect({ f, i: Number(new RegExp(`\\b${f} = (\\d+)`).exec(idx)?.[1]) }).toEqual({ f, i }));
});

test('the pure files import only Foundation (they compile on Linux)', () => {
  for (const f of PURE) {
    const imports = [...code(f).matchAll(/^import (\w+)/gm)].map((x) => x[1]);
    expect({ f, imports }).toEqual({ f, imports: ['Foundation'] });
  }
});

test('privacy: no pixels out, no storage, no network, logging only through DmsLog', () => {
  for (const f of ALL) {
    const src = code(f);
    const hit = (re: RegExp) => ({ f, re: String(re), hit: re.test(src) });
    for (const re of [
      /\bprint\(/,
      /\bNSLog\(/,
      /\bdebugPrint\(/,
      /\bURLSession\b/,
      /\bNWConnection\b/,
      /\bwrite\(to/,
      /\bcreateFile\(/,
      /\bjpegData\b|\bpngData\b|CGImageDestination|UIImageWriteToSavedPhotosAlbum|PHPhotoLibrary/,
      /AVCapturePhotoOutput|AVCaptureMovieFileOutput/,
    ]) {
      expect(hit(re)).toEqual({ f, re: String(re), hit: false });
    }
    if (f !== 'DmsLog.swift') expect({ f, oslog: /\bos_log\(|\bLogger\(/.test(src) }).toEqual({ f, oslog: false });
  }
  // The frames payload carries only the encoded records and the header.
  const payload = /return \[\s*"v":([\s\S]*?)\]/.exec(code('RecordEncoder.swift'))![0];
  expect([...payload.matchAll(/"(\w+)":/g)].map((x) => x[1]).sort()).toEqual(['anchorEpochMs', 'anchorTMs', 'data', 'n', 'v']);
});

test('pixels are read through the buffer stride, never width × 4 (Task 2 review I1)', () => {
  expect(code('Roi.swift')).toContain('let p = bytes + y * rowBytes + x * 4');
  expect(code('CaptureController.swift')).toContain('rowBytes: CVPixelBufferGetBytesPerRow(f.pixel)');
  expect(code('SelfTest.swift')).toContain('rowBytes: img.stride');
  expect(allCode()).not.toMatch(/rowBytes:\s*\w+\s*\*\s*4/);
});

test('every head pose goes through the layout rule (Task 2 review I2)', () => {
  expect(code('HeadPose.swift')).toContain('static func normaliseLayout');
  expect(code('FeatureExtractor.swift')).toContain('HeadPose.fromAnyLayout(m, f.rotationDeg)');
  expect(code('SelfTest.swift')).toContain('HeadPose.fromAnyLayout(');
  expect(allCode().match(/HeadPose\.fromMatrix\(/g) ?? []).toHaveLength(0); // only via fromAnyLayout
  expect(code('Landmarker.swift')).toContain('outputFacialTransformationMatrixes = true');
});

test('tOffMs is computed in Double before the Float store (Task 1 review C1)', () => {
  expect(code('RecordEncoder.swift')).toContain('Float(value - anchorTMs)');
  expect(code('RecordEncoder.swift')).toContain('let anchorTMs = first[F.tOffMs]');
});

test('the self-test runs the production classes, and holds no copy of their logic', () => {
  const src = code('SelfTest.swift');
  for (const s of ['FeatureExtractor.buildRecord(', 'RecordEncoder.encode(', 'GazeInputAssembler()', 'SubjectStatisticTracker(', 'GazeNetFactory.', 'LumaSource(']) {
    expect(src).toContain(s);
  }
  expect(src).not.toMatch(/func (luma|eyeLuma|blurScore|irisOffset|weak3dCloud|fromMatrix)\b/);
});

test('native owns the lifecycle: background stop, wall-clock timers, process CPU, the thermal floor', () => {
  const mod = code('DmsVisionModule.swift');
  expect(mod).toMatch(/OnAppEntersBackground \{[\s\S]*?stop\(reason: "background"\)/);
  const cc = controller();
  expect(cc).toContain('schedule(wallDeadline:');
  expect(allCode()).not.toMatch(/schedule\(deadline:/);
  expect(cc).toContain('getrusage(RUSAGE_SELF');
  expect(cc).toContain('ProcessInfo.thermalStateDidChangeNotification');
  expect(cc).toContain('LifecycleRules.decide(');
  expect(cc).toContain('thermal.fpsCap');
  expect(cc).toContain('thermal.allowsGazeNet');
});

test('camera configuration: BGRA, late frames discarded, stabilisation and mirroring off, CPU delegate default', () => {
  const s = code('CaptureSession.swift');
  expect(s).toContain('kCVPixelFormatType_32BGRA');
  expect(s).toContain('alwaysDiscardsLateVideoFrames = true');
  expect(s).toContain('preferredVideoStabilizationMode = .off');
  expect(s).toContain('isVideoMirrored = false');
  const l = code('Landmarker.swift');
  expect(l).toContain('base.delegate = gpu ? .GPU : .CPU');
  expect(l).toContain('options.numFaces = 1');
});

test('the gaze net and ONNX Runtime live only in GazeNet/ (behind the build switch)', () => {
  for (const f of ALL) {
    const usesOrt = /onnxruntime_objc|ORTSession|ORTEnv/.test(code(f));
    expect({ f, usesOrt }).toEqual({ f, usesOrt: f === 'GazeNet/GazeNet.swift' });
  }
  const net = code('GazeNet/GazeNet.swift');
  expect(net).toContain('setIntraOpNumThreads(1)');
  expect(net).toContain('"session.intra_op.allow_spinning", value: "0"');
  expect(net).toContain('static let available = true');
  expect(code('GazeNetStub/GazeNet.swift')).toContain('static let available = false');
});

/** The body of `func name(` in the controller, up to the next top-level member. */
function body(src: string, name: string): string {
  const start = src.indexOf(`func ${name}(`);
  expect({ name, found: start >= 0 }).toEqual({ name, found: true });
  const next = src.slice(start + 1).search(/\n  (?:func |var |let |@objc |static |\/\/ MARK)/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

test('the batcher flushes predictively, with no timer (Task 3 review I1)', () => {
  expect(code('RecordEncoder.swift')).toContain('nowMs - startedAtMs + intervalMs >= Double(DmsConstants.BATCH_MS)');
  expect(code('CaptureController.swift')).toMatch(/batcher\.isDue\(nowMs: now, intervalMs: /);
  const self = code('SelfTest.swift');
  expect(self).toContain('case "batcher"');
  expect(self).toContain('Batcher()');
});

test('pause: paused under the lock, then capture stops, then the flush, then the event; resume starts a fresh batch (Task 3 review m1)', () => {
  const p = body(code('CaptureController.swift'), 'pause');
  const order = ['state = "paused"', 'stopRunning()', 'flushBatch()', 'emitState("paused"'].map((s) => p.indexOf(s));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(body(code('CaptureController.swift'), 'resume')).toContain('batcher.clear()');
  // Stop has the same order: stopped first, the flush inside teardown after the session stops.
  const t = body(code('CaptureController.swift'), 'teardown');
  expect(t.indexOf('stopRunning()')).toBeLessThan(t.indexOf('flushBatch()'));
  expect(body(code('CaptureController.swift'), 'stop')).toMatch(/state = "stopped"[\s\S]*teardown\(\)[\s\S]*emitState\("stopped"/);
  // A result that lands after the pause is dropped.
  expect(body(code('CaptureController.swift'), 'handleResult')).toContain('guard locked({ state == "running" }) else { return }');
});

test('a lost landmarker callback holds capture for at most max(3 intervals, 250 ms) (Task 3 review m2)', () => {
  expect(code('CaptureController.swift')).toContain('max(3 * interval, 250)');
  expect(code('CaptureController.swift')).not.toMatch(/f\.ptsMs < 1000/);
});

test('an interruption holds the pause until it ends: no resume churn (Task 3 review m3)', () => {
  const cc = controller();
  expect(cc).toContain('.AVCaptureSessionInterruptionEnded');
  expect(body(code('CaptureController.swift'), 'applyPolicy')).toMatch(/!interrupted/);
});

test('start reads a cached foreground flag, never main.sync (Task 3 review nit)', () => {
  expect(allCode()).not.toContain('DispatchQueue.main.sync');
  expect(code('DmsVisionModule.swift')).toContain('AppActivity.shared.isActive');
});
