/** @jest-environment node */
// The bundled models (plan keep table): pinned digests, every native copy byte-identical to the
// canonical copy in assets/models, and the gaze network's copies ONLY in the gated folders that
// DMS_GAZE_NET=1 builds bundle (the release gate). scripts/check-models.js checks the same by hand.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string) => Uint8Array; existsSync: (f: string) => boolean; readdirSync: (d: string) => string[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const crypto = require('node:crypto') as { createHash: (a: string) => { update: (b: Uint8Array) => { digest: (e: 'hex') => string } } };

const MODULE = path.join(__dirname, '..');
const APP = path.join(MODULE, '..', '..');
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const PINNED = {
  'face_landmarker.task': '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  'gaze_direct.onnx': '4aa9661091efbdc28b20927f905c78097b9a7b5b787401f74ce6259f8f7666c8',
  'gaze_direct.meta.json': '007335e0dc34e4e9b1aeb5c4c34b65f1c1c811365d6768d3d814b70e47d35ca6',
} as const;

const EVERY_BUILD = [path.join(MODULE, 'ios', 'Resources'), path.join(MODULE, 'android', 'src', 'main', 'assets')];
const GATED = [path.join(MODULE, 'ios', 'GazeNetResources'), path.join(MODULE, 'android', 'src', 'gazenet', 'assets')];

test.each(Object.entries(PINNED))('%s: the canonical copy has its pinned digest', (name, digest) => {
  expect(sha(path.join(APP, 'assets', 'models', name))).toBe(digest);
});

test('the landmarker is in the every-build folders, byte-identical', () => {
  for (const dir of EVERY_BUILD) expect(sha(path.join(dir, 'face_landmarker.task'))).toBe(PINNED['face_landmarker.task']);
});

test('the gaze network is ONLY in the gated folders (release gate), byte-identical', () => {
  for (const dir of GATED) {
    expect(sha(path.join(dir, 'gaze_direct.onnx'))).toBe(PINNED['gaze_direct.onnx']);
    expect(sha(path.join(dir, 'gaze_direct.meta.json'))).toBe(PINNED['gaze_direct.meta.json']);
  }
  for (const dir of EVERY_BUILD) {
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('gaze_direct'))).toEqual([]);
  }
});

test('the meta file names the pinned graph', () => {
  const meta = JSON.parse(new TextDecoder().decode(fs.readFileSync(path.join(APP, 'assets', 'models', 'gaze_direct.meta.json')))) as {
    onnx_sha256: string;
    output_frame: string;
    parameters: number;
  };
  expect(meta.onnx_sha256).toBe(PINNED['gaze_direct.onnx']);
  expect(meta.output_frame).toBe('camera');
  expect(meta.parameters).toBe(867069);
});
