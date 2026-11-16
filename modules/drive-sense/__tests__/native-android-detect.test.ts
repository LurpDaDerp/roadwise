/** @jest-environment node */
// The Android port of the drive detector's policy (`android/.../detect/`), read as text, as
// `native-android.test.ts` reads the rest of the Kotlin and `native-ios.test.ts` the Swift policy.
// Behaviour is proven by the JVM unit tests (`DetectPolicyVectorsTest.kt` runs every row of the
// decision table through `SelfTest.run`) and the phone's self-test; this suite pins what can be
// checked statically: the constants against `DETECT`, the purity that keeps the policy
// JVM-testable, one Kotlin function per rule of policy.ts, the reference's order of operations
// where a float sum depends on it, and the self-test's routing to the production policy.
import { DETECT, MPS_PER_MPH } from '../src/detect/policy';

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
const KT_DIR = join(ANDROID, 'src', 'main', 'java', 'expo', 'modules', 'drivesense');
const DETECT_DIR = join(KT_DIR, 'detect');

const read = (file: string): string => readFileSync(file, 'utf8');
/** Kotlin source with line comments and block comments removed, so a rule cannot be met by a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const detect = (name: string): string => code(read(join(DETECT_DIR, `${name}.kt`)));
/** A function's body, from its declaration to the first line closing at column 0. */
const fn = (src: string, decl: string) => new RegExp(`${decl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';

const POLICY = ['DetectTypes', 'DetectPolicy', 'DetectStartPolicy', 'DetectEndPolicy'];
const policy = () => POLICY.map(detect).join('\n');

describe('native-android: the drive detector policy (text)', () => {
  it('has the policy, its halves, its types and its self-test, in package expo.modules.drivesense.detect', () => {
    for (const f of [...POLICY, 'DetectSelfTest']) {
      expect({ f, exists: existsSync(join(DETECT_DIR, `${f}.kt`)) }).toEqual({ f, exists: true });
      expect(read(join(DETECT_DIR, `${f}.kt`))).toMatch(/^package expo\.modules\.drivesense\.detect\n/);
    }
    expect(readdirSync(DETECT_DIR).filter((f) => f.startsWith('Detect') && f.endsWith('.kt')).sort()).toEqual([...POLICY, 'DetectSelfTest'].map((f) => `${f}.kt`).sort());
  });

  it('declares exactly the reference constants, with the reference values', () => {
    const src = detect('DetectPolicy');
    const declared = new Map(
      [...src.matchAll(/const val ([A-Z][A-Z0-9_]*)(?:\s*:\s*\w+)?\s*=\s*([\d_.]+)L?\b/g)].map((m) => [m[1]!, Number(m[2]!.replace(/_/g, ''))] as const)
    );
    const reference: Record<string, number> = { ...DETECT, MPS_PER_MPH };
    for (const [name, value] of Object.entries(reference)) expect({ name, value: declared.get(name) }).toEqual({ name, value });
    expect([...declared.keys()].sort()).toEqual(Object.keys(reference).sort());
    // a time, distance or speed is a Double (the reference's number), so no rule rounds; only counts are whole
    const WHOLE = ['LINK_PACE_ROWS', 'CARS_MAX', 'CAR_DRIVES_KEPT', 'CAR_DRIVE_MIN_ROWS', 'CAR_NOT_MINE_MAX', 'MOVE_PACE_ROWS', 'CANDIDATE_BUFFER_MAX_ROWS', 'CANDIDATES_PER_HOUR_MAX', 'RESUME_SEQ_GAP', 'STEP_WALK_MIN', 'JOURNAL_SYNC_EVERY_ROWS', 'JOURNAL_MAX_BYTES_PER_DRIVE', 'JOURNAL_MAX_DRIVES', 'READ_ROWS_MAX'];
    for (const [, name, raw] of src.matchAll(/const val ([A-Z][A-Z0-9_]*)\s*=\s*([\d_.]+L?)/g)) {
      expect({ name, double: raw!.includes('.') }).toEqual({ name, double: !WHOLE.includes(name!) });
    }
  });

  it('is pure: no android, androidx or clock in the policy; the self-test adds org.json only', () => {
    for (const f of POLICY) {
      const raw = read(join(DETECT_DIR, `${f}.kt`));
      const imports = [...raw.matchAll(/^import ([\w.]+)/gm)].map((m) => m[1]!);
      expect({ f, foreign: imports.filter((i) => !i.startsWith('kotlin.') && i !== 'expo.modules.drivesense.FeatureRow') }).toEqual({ f, foreign: [] });
    }
    const st = [...read(join(DETECT_DIR, 'DetectSelfTest.kt')).matchAll(/^import ([\w.]+)/gm)].map((m) => m[1]!);
    expect(st.sort()).toEqual(['org.json.JSONArray', 'org.json.JSONObject']);
    for (const f of [...POLICY, 'DetectSelfTest']) {
      expect({ f, impure: /android\.|androidx\.|System\.currentTimeMillis|SystemClock|Date\(|Instant\.|Handler|Thread|SharedPreferences|Context\b/.test(detect(f)) }).toEqual({ f, impure: false });
    }
  });

  it('each rule of policy.ts has its Kotlin function on DetectPolicy, and the self-test runs every row kind through them', () => {
    const src = policy();
    for (const name of ['trusted', 'slow', 'moving', 'rolling', 'distanceM', 'summarize', 'motionGate', 'recentStarts', 'wakeGate', 'candidateDue', 'startsAfter', 'resumeDecision', 'resumeSeq', 'statusOf']) {
      expect({ name, declared: new RegExp(`\\n {2}fun ${name}\\(`).test(detect('DetectPolicy')) }).toEqual({ name, declared: true });
    }
    for (const name of ['autoHoldMs', 'autoStep', 'confirmStep', 'noteVeto', 'onFootVeto', 'slowTrafficCarMs', 'slowTrafficVehMs', 'slowTrafficHeld', 'slowTrafficReport', 'slowTrafficConfirmed', 'slowTrafficStep', 'carLinked', 'carPlayOn', 'carMostOfDrive', 'linkReport', 'linkStep', 'traceStart', 'startOf', 'continuesFrom', 'endClockAt', 'endOnRow', 'endOnSteps', 'walkStanding', 'endDue', 'lingerAfterJsEnd', 'suppressionDue', 'suppressionResume']) {
      expect({ name, declared: new RegExp(`fun DetectPolicy\\.${name}\\(`).test(src) }).toEqual({ name, declared: true });
    }
    const st = detect('DetectSelfTest');
    for (const kind of ['confirm', 'trace', 'start', 'summary', 'motionGate', 'veto', 'wake', 'candidate', 'startsAfter', 'end', 'suppress', 'suppressResume', 'resume', 'resumeSeq', 'status', 'slow', 'link', 'car']) {
      expect({ kind, handled: st.includes(`"${kind}" ->`) }).toEqual({ kind, handled: true });
    }
    for (const call of ['slowTrafficReport(', 'slowTrafficStep(', 'slowTrafficCarMs(', 'linkReport(', 'linkStep(', 'carLinked(', 'carMostOfDrive(', 'confirmStep(', 'noteVeto(', 'onFootVeto(', 'traceStart(', 'startOf(', 'continuesFrom(', 'summarize(', 'motionGate(', 'wakeGate(', 'candidateDue(', 'startsAfter(', 'endClockAt(', 'endOnRow(', 'endOnSteps(', 'endDue(', 'lingerAfterJsEnd(', 'suppressionDue(', 'suppressionResume(', 'resumeDecision(', 'resumeSeq(', 'statusOf(']) {
      expect({ call, used: st.includes(`DetectPolicy.${call}`) }).toEqual({ call, used: true });
    }
    expect(st).not.toMatch(/"skipped"/);
  });

  it('SelfTest hands each detect row to DetectSelfTest, which runs the production policy', () => {
    const st = code(read(join(KT_DIR, 'SelfTest.kt')));
    expect(st).toMatch(/import expo\.modules\.drivesense\.detect\.DetectSelfTest/);
    expect(st).toMatch(/"detect" -> DetectSelfTest\.result\(name, inputs\)/);
    expect(detect('DetectSelfTest')).toMatch(/fun result\(name: String, inputs: JSONObject\): JSONObject \{\s*val out = JSONObject\(\)\.put\("name", name\)\.put\("kind", KIND\)/);
  });

  it("keeps policy.ts's order of operations in the auto evidence and the hold", () => {
    const step = fn(detect('DetectStartPolicy'), 'private fun DetectPolicy.autoStep(');
    const order = [
      'val earns = ok && !veto && r.speed > AUTO_MIN_MPS && (r.speed >= AUTO_MPS_20 || carFresh)',
      'val rate = if (earns) 1 / autoHoldMs(r.speed) else 0.0',
      'if (p != null && rate > 0 && s.prevRate > 0 && r.ts - p > 0 && r.ts - p <= AUTO_ROW_GAP_MAX_MS) {',
      'e += (r.ts - p) * min(rate, s.prevRate)',
      'if (first == null) first = p',
      'val lastMove = if (ok && r.speed > STOP_MPS) r.ts else s.lastMoveTs',
      'if (e > 0 && lastMove != null && r.ts - lastMove >= AUTO_FORGET_MS) {',
      'return PolicyStep(state, e >= 1 - EVIDENCE_EPS && !veto)',
    ];
    let at = -1;
    for (const line of order) {
      const i = step.indexOf(line);
      expect({ line, after: i > at }).toEqual({ line, after: true });
      at = i;
    }
    expect(detect('DetectStartPolicy')).toMatch(/private const val EVIDENCE_EPS = 0\.000000001/);
    const hold = fn(detect('DetectStartPolicy'), 'fun DetectPolicy.autoHoldMs(');
    expect(hold).toMatch(/if \(!\(mps > AUTO_MIN_MPS\)\) return Double\.POSITIVE_INFINITY/);
    expect(hold).toContain('return max(AUTO_HOLD_MIN_MS, (AUTO_HOLD_MS_15 * (AUTO_INSTANT_MPS - mps)) / (AUTO_INSTANT_MPS - AUTO_MIN_MPS))');
  });

  it('keeps the gates and the end in the reference order', () => {
    const gate = fn(detect('DetectPolicy'), '  fun wakeGate(').replace(/\n {2}\}[\s\S]*$/, '');
    const reasons = ['OFF', 'NO_OWNER', 'PERMISSION', 'BUSY', 'RESTING', 'CAPPED', 'OK'].map((r) => gate.indexOf(`WakeGate.${r}`));
    expect(reasons.every((i) => i > 0)).toBe(true);
    expect([...reasons].sort((a, b) => a - b)).toEqual(reasons);
    // Android's paired car connecting (ruling 2; not in policy.ts) skips the rest as the region and the app do.
    expect(gate).toMatch(/if \(c\.reason != WakeReason\.REGION && c\.reason != WakeReason\.APP && c\.reason != WakeReason\.CAR && c\.now < c\.candidateRestUntil\) return WakeGate\.RESTING/);
    const end = detect('DetectEndPolicy');
    expect(end).toMatch(/if \(walked >= WALK_END_MS \+ walkSlack \|\| stepped >= walkSlack\) return SafetyCause\.WALKING/);
    expect(end).toMatch(/if \(gone >= CAR_GONE_MS \+ slack\) return SafetyCause\.STILL/);
    expect(end).toMatch(/return EndDecision\(due = pick\(SAFETY_SLACK_MS, WALK_SAFETY_SLACK_MS\), overdue = pick\(0\.0, 0\.0\)\)/);
    expect(end).toMatch(/if \(walkSince != null && now - walkSince >= WALK_CONFIRM_MS\) return SuppressionCause\.WALKING/);
    expect(detect('DetectPolicy')).toMatch(/if \(walkSince != null && now - walkSince >= WALK_CONFIRM_MS\) return CandidateCause\.WALKING/);
  });

  it('the JVM tests run the generated decision table through SelfTest.run, on the real org.json', () => {
    const test = read(join(ANDROID, 'src', 'test', 'java', 'expo', 'modules', 'drivesense', 'detect', 'DetectPolicyVectorsTest.kt'));
    expect(test).toMatch(/getResourceAsStream\("detect-vectors\.json"\)/);
    expect(test).toMatch(/SelfTest\.run\(wire\.toString\(\)\)/);
    expect(existsSync(join(ANDROID, 'src', 'test', 'resources', 'detect-vectors.json'))).toBe(true);
    expect(read(join(ANDROID, 'build.gradle'))).toMatch(/testImplementation 'org\.json:json:\d{8}'/);
  });
});
