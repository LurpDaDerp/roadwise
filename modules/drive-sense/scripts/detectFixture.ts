// The drive detector's decision table as the Android JVM unit tests read it
// (`android/src/test/resources/detect-vectors.json`). Gradle cannot run TypeScript, so the table is
// written down here: each row exactly as the phone's self-test sends it (`detectWireVectors`: its
// name, `kind: 'detect'` and its inputs) plus the row's `expected` in the shape of its `actual`
// (`expectedActual`), which the Kotlin test matches with the same rules as `matchDetectRow`.
// `__tests__/detectFixture.test.ts` holds the committed file to a fresh generation, so neither the
// table nor the file can drift without Jest failing. It also rewrites it (the table's imports reach
// the app's path aliases, which only Jest resolves, so there is no plain-Node script):
//
//   UPDATE_DETECT_FIXTURE=1 npx jest modules/drive-sense/__tests__/detectFixture.test.ts
import { detectWireVectors, expectedActual, type DetectActual, type DetectWireVector } from '../src/detect/selfTest';
import { DETECT_VECTORS } from '../src/detect/vectors';

/** One fixture row: the wire vector, and what a correct policy answers for it. */
export interface DetectFixtureRow extends DetectWireVector {
  expected: DetectActual;
}

/** The repo-relative path of the fixture, from the drive-sense module's root. */
export const DETECT_FIXTURE_PATH = ['android', 'src', 'test', 'resources', 'detect-vectors.json'] as const;

export function detectFixture(): DetectFixtureRow[] {
  const wire = detectWireVectors(DETECT_VECTORS);
  return wire.map((w, i) => ({ ...w, expected: expectedActual(DETECT_VECTORS[i]!) }));
}

/** One row a line, so a changed rule shows as the rows it changed. */
export function serializeDetectFixture(rows: readonly DetectFixtureRow[] = detectFixture()): string {
  return `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
}
