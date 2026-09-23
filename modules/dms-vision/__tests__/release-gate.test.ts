/** @jest-environment node */
// The gaze_direct release gate (plan Global Constraints; security I-1; rev2: rev1-M1). The model and
// ONNX Runtime reach a binary only with DMS_GAZE_NET=1, never in a production build:
// - the production EAS profile does not set the switch;
// - the podspec and build.gradle bundle the model and depend on ORT only inside their switch branch;
// - both REFUSE the switch for a production build: the podspec on EAS_BUILD_PROFILE=production, and
//   Gradle on that profile or on any release task with no EAS profile.
// The build scripts are checked as text (Jest runs neither Ruby nor Gradle). The Ruby logic was also
// evaluated for real (see the Task 2 report).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const MODULE = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const REFUSAL = 'DMS_GAZE_NET=1 is refused in a production build (release gate, U-2)';

/** Source with `#` or `//` line comments removed, so a comment can neither satisfy nor trip a check. */
const code = (src: string, marker: '#' | '//') =>
  src
    .split('\n')
    .map((l) => {
      const i = l.indexOf(marker);
      return i >= 0 && !l.slice(0, i).includes("'") ? l.slice(0, i) : l;
    })
    .join('\n');

describe('eas.json', () => {
  const eas = JSON.parse(read(MODULE, '..', '..', 'eas.json')) as { build: Record<string, { env?: Record<string, string> }> };
  test('the production profile never sets DMS_GAZE_NET', () => {
    expect(eas.build.production).toBeDefined();
    expect(eas.build.production!.env?.DMS_GAZE_NET).toBeUndefined();
  });
  test('the preview profile does not either (it compiles the production variant at D1)', () => {
    expect(eas.build.preview?.env?.DMS_GAZE_NET).toBeUndefined();
  });
});

describe('ios/DmsVision.podspec', () => {
  const pod = code(read(MODULE, 'ios', 'DmsVision.podspec'), '#');

  test('the switch is read from the environment, and a production profile raises before the spec', () => {
    expect(pod).toMatch(/gaze_net = ENV\['DMS_GAZE_NET'\] == '1'/);
    const refuse = pod.indexOf(`raise '${REFUSAL}'`);
    expect(refuse).toBeGreaterThan(0);
    expect(pod.slice(0, refuse)).toMatch(/if gaze_net && ENV\['EAS_BUILD_PROFILE'\] == 'production'\s*$/);
    expect(refuse).toBeLessThan(pod.indexOf('Pod::Spec.new'));
  });

  test('ORT, the model bundle and the net sources appear only inside the switch branch', () => {
    const branch = /if gaze_net\n([\s\S]*?)\n\s*else\n([\s\S]*?)\n\s*end/.exec(pod);
    expect(branch).not.toBeNull();
    const [, on, off] = branch!;
    expect(on).toContain("s.dependency 'onnxruntime-objc', '1.30.0'");
    expect(on).toContain("'GazeNetResources/*'");
    expect(on).toContain("'GazeNetStub/**'");
    expect(off).toContain("'GazeNet/**'");
    expect(off).not.toMatch(/onnxruntime|GazeNetResources/);
    // Nowhere else.
    const outside = pod.replace(branch![0], '');
    expect(outside).not.toMatch(/onnxruntime|GazeNetResources|gaze_direct/);
    expect(pod.match(/onnxruntime-objc/g)).toHaveLength(1);
  });

  test('MediaPipe is pinned exactly', () => {
    expect(pod).toContain("s.dependency 'MediaPipeTasksVision', '0.10.35'");
    expect(pod).not.toMatch(/~>|>=/);
  });
});

describe('android/build.gradle', () => {
  const gradle = code(read(MODULE, 'android', 'build.gradle'), '//');

  test('the switch and the production refusal, before any configuration', () => {
    expect(gradle).toContain("def dmsGazeNet = System.getenv('DMS_GAZE_NET') == '1' || project.findProperty('dmsGazeNet') == '1'");
    expect(gradle).toContain("def easProfile = System.getenv('EAS_BUILD_PROFILE')");
    expect(gradle).toContain("def releaseRequested = gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }");
    expect(gradle).toContain("if (dmsGazeNet && (easProfile == 'production' || (easProfile == null && releaseRequested))) {");
    const refuse = gradle.indexOf(`throw new GradleException('${REFUSAL}')`);
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(gradle.indexOf('android {'));
  });

  test('ORT and the gated source set appear only under the switch', () => {
    const deps = /if \(dmsGazeNet\) \{\n\s*implementation 'com\.microsoft\.onnxruntime:onnxruntime-android:1\.30\.0'\n\s*\}/;
    expect(gradle).toMatch(deps);
    expect(gradle.match(/com.microsoft.onnxruntime:/g)).toHaveLength(1);
    expect(gradle).toMatch(/if \(dmsGazeNet\) \{\n\s*java\.srcDirs \+= 'src\/gazenet\/java'\n\s*assets\.srcDirs \+= 'src\/gazenet\/assets'\n\s*\} else \{\n\s*java\.srcDirs \+= 'src\/nogazenet\/java'\n\s*\}/);
  });

  test('every dependency is pinned exactly', () => {
    expect(gradle).toContain("implementation 'com.google.mediapipe:tasks-vision:0.10.35'");
    expect(gradle).toContain("def cameraxVersion = '1.4.2'");
    for (const a of ['camera-core', 'camera-camera2', 'camera-lifecycle', 'camera-view']) {
      expect(gradle).toContain(`implementation "androidx.camera:${a}:\${cameraxVersion}"`);
    }
    expect(gradle).not.toMatch(/:\+['"]|latest\.integration/);
  });
});
