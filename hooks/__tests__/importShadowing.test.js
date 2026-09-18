// Guards the class of bug that silently disabled the whole GPS path of a drive:
// `const distanceMeters = distance` in hooks/useDriveSession.js shadowed the imported
// `distanceMeters`, so the second GPS fix threw inside an un-awaited async handler and
// nothing after it ever ran (no speed, no points, no speed limits, no drive record).
//
// scripts/check-imports.js does the real work with @babel/parser + @babel/traverse; this
// test keeps it in the standing suite so a re-introduction fails CI rather than a drive.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('no app module shadows one of its own imports, and every import resolves', () => {
  const script = path.join(__dirname, '..', '..', 'scripts', 'check-imports.js');
  let output = '';
  let failed = false;
  try {
    output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  } catch (err) {
    failed = true;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.ok(!failed, `scripts/check-imports.js reported problems:\n${output}`);
});
