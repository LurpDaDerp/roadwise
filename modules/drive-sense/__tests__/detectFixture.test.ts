/** @jest-environment node */
// The Android JVM unit tests run the drive detector's decision table from a JSON file
// (`android/src/test/resources/detect-vectors.json`, read by `DetectPolicyVectorsTest.kt`), since
// Gradle cannot run TypeScript. The committed file must be byte-for-byte a fresh generation of
// `src/detect/vectors.ts`, and each row's `expected` must be what the reference answers for its
// inputs, so neither the table, the reference nor the file can drift without this suite failing.
//
// To rewrite the file after changing the table: UPDATE_DETECT_FIXTURE=1 npx jest modules/drive-sense/__tests__/detectFixture.test.ts
import { matchDetectRow, runDetectRow } from '../src/detect/selfTest';
import { DETECT_VECTORS } from '../src/detect/vectors';
import { DETECT_FIXTURE_PATH, detectFixture, serializeDetectFixture } from '../scripts/detectFixture';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time. The root
// tsconfig's `types` is ["jest"], so Node's own typings are not in the program — hence the local
// shapes rather than an `import` from 'node:fs'.
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs') as {
  existsSync: (file: string) => boolean;
  mkdirSync: (dir: string, opts: { recursive: true }) => void;
  readFileSync: (file: string, encoding: 'utf8') => string;
  writeFileSync: (file: string, data: string, encoding: 'utf8') => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { dirname, join } = require('node:path') as { dirname: (p: string) => string; join: (...parts: string[]) => string };

const FILE = join(__dirname, '..', ...DETECT_FIXTURE_PATH);

if (process.env.UPDATE_DETECT_FIXTURE === '1') {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, serializeDetectFixture(), 'utf8');
}

describe('the Android detect fixture', () => {
  test('the committed file is exactly a fresh generation of the decision table', () => {
    expect(existsSync(FILE)).toBe(true);
    // `.gitattributes` checks text out with LF, but a CRLF checkout must not read as drift.
    expect(readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).toBe(serializeDetectFixture());
  });

  test('every row of the table is in it, once, in order, with no answer among its inputs', () => {
    const rows = detectFixture();
    expect(rows.map((r) => r.name)).toEqual(DETECT_VECTORS.map((v) => v.name));
    for (const r of rows) {
      expect(r.kind).toBe('detect');
      expect('expected' in r.inputs).toBe(false);
      expect('name' in r.inputs).toBe(false);
    }
    expect(new Set(rows.map((r) => r.inputs.kind))).toEqual(new Set(DETECT_VECTORS.map((v) => v.kind)));
  });

  test("each row's expected is what the reference answers for its inputs", () => {
    detectFixture().forEach((r, i) => {
      expect({ name: r.name, mismatches: matchDetectRow(DETECT_VECTORS[i]!, runDetectRow(r.inputs)) }).toEqual({ name: r.name, mismatches: [] });
    });
  });
});
