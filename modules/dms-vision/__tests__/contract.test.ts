// The README is the binding prose contract for the Swift and Kotlin modules; the TypeScript is the
// machine-checked half. This suite fails if the two drift: the wire table (index, name, mask class),
// the method table, the event list, the error codes and the timing constants must match exactly.
import {
  BATCH_MS,
  FRAME_BYTES,
  FRAME_FIELDS,
  FRAME_MASK,
  MODEL_RELEASE_AFTER_PAUSE_MS,
  PAUSE_AFTER_STOP_MS,
  THERMAL_COOL_DWELL_MS,
  THERMAL_L1_ENTRY_DWELL_MS,
  WATCHDOG_PAUSE_MS,
  WATCHDOG_STOP_MS,
} from '../src/constants';
import { DMS_VISION_ERROR_CODES, DMS_VISION_EVENTS, DMS_VISION_METHODS } from '../src/types';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

test('the wire table lists every field with its index and mask class, in order', () => {
  const rows = [...readme.matchAll(/^\| (\d+) \| `(\w+)` \| ([AFPNRLM]) \|/gm)].map((m) => ({
    i: Number(m[1]),
    name: m[2],
    mask: m[3],
  }));
  expect(rows).toEqual(FRAME_FIELDS.map((name, i) => ({ i, name, mask: FRAME_MASK[i] })));
});

test('the method table names exactly the bridged methods, in order', () => {
  const names = [...readme.matchAll(/^\| `(\w+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'isAvailable');
  expect(names).toEqual([...DMS_VISION_METHODS]);
});

test('the event declaration is the event list', () => {
  const m = /Events\(([^)]*)\)/.exec(readme);
  expect(m).not.toBeNull();
  const names = [...m![1]!.matchAll(/"(\w+)"/g)].map((x) => x[1]);
  expect(names).toEqual([...DMS_VISION_EVENTS]);
});

test('every error code is documented', () => {
  for (const code of DMS_VISION_ERROR_CODES) expect(readme).toContain(`\`${code}\``);
});

test('the timing constants in the README are the code constants', () => {
  const pairs: [string, number][] = [
    ['BATCH_MS', BATCH_MS],
    ['FRAME_BYTES', FRAME_BYTES],
    ['WATCHDOG_PAUSE_MS', WATCHDOG_PAUSE_MS],
    ['WATCHDOG_STOP_MS', WATCHDOG_STOP_MS],
    ['MODEL_RELEASE_AFTER_PAUSE_MS', MODEL_RELEASE_AFTER_PAUSE_MS],
    ['PAUSE_AFTER_STOP_MS', PAUSE_AFTER_STOP_MS],
    ['THERMAL_L1_ENTRY_DWELL_MS', THERMAL_L1_ENTRY_DWELL_MS],
    ['THERMAL_COOL_DWELL_MS', THERMAL_COOL_DWELL_MS],
  ];
  for (const [name, value] of pairs) expect(readme).toContain(`\`${name} = ${value}\``);
});
