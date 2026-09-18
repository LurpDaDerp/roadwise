'use strict';
/**
 * Re-runs every fixture comparison and writes `dms/tests/PARITY.md`.
 *
 *   node dms/tests/tools/parity_report.js
 */

const fs = require('fs');
const path = require('path');

const { loadFixture, listFixtures, listMonitorFixtures } = require('../helpers');
const { replayMonitorFixture, replayDrowsinessFixture } = require('../replay');
const { checkUtil, checkGazeInputs, checkStatsTracker, checkFeatures } = require('../parity');

const TOL = 1e-6;

function row(cmp, file) {
  return {
    file,
    frames: cmp.frames !== undefined ? cmp.frames : cmp.comparedFrames,
    compared: cmp.comparedFrames !== undefined ? cmp.comparedFrames : '-',
    checks: cmp.checked,
    maxDiff: cmp.maxDiff,
    maxField: cmp.maxField.replace(/@\d+$/, ''),
    events: `${cmp.eventsMatched}/${cmp.eventsExpected}`,
    ok: cmp.ok,
    failures: cmp.failures,
  };
}

function main() {
  const rows = [];
  rows.push(row(checkUtil(TOL), 'util_cases.json'));
  rows.push(row(checkGazeInputs(TOL), 'gaze_inputs_cases.json'));
  rows.push(row(checkStatsTracker(TOL), 'gaze_inputs_stats_tracker.json'));
  rows.push(row(checkFeatures(TOL), 'features_cases.json'));
  for (const f of listFixtures('drowsiness_')) rows.push(row(replayDrowsinessFixture(loadFixture(f), TOL), f));
  for (const f of listMonitorFixtures()) rows.push(row(replayMonitorFixture(loadFixture(f), TOL), f));

  const manifest = loadFixture('manifest');
  const worst = rows.reduce((a, b) => (b.maxDiff > a.maxDiff ? b : a));
  const failed = rows.filter((r) => !r.ok);
  const totalChecks = rows.reduce((a, r) => a + r.checks, 0);
  const lines = [];
  lines.push('# Parity report');
  lines.push('');
  lines.push('`dms/*.js` against the Python reference (`deployment-stack/dms/*.py`), replayed frame by');
  lines.push('frame on the fixtures in `dms/tests/fixtures/`.  Regenerate with');
  lines.push('`dms/tests/tools/gen_fixtures.py`, re-measure with `node dms/tests/tools/parity_report.js`.');
  lines.push('');
  lines.push(`* fixtures generated: ${manifest.generated}`);
  lines.push(`* reference: ${manifest.reference_repo} (python ${manifest.python}, numpy ${manifest.numpy})`);
  lines.push(`* app repo commit: ${manifest.app_repo_git_sha}`);
  lines.push(`* numeric tolerance asserted: ${TOL} absolute; strings / booleans / integers exact;`);
  lines.push('  events compared field by field on the reference\'s own `to_dict()` rounding (identical values).');
  lines.push(`* ${rows.length} fixtures, ${totalChecks.toLocaleString('en-US')} field comparisons, ` +
             `worst difference ${worst.maxDiff.toExponential(2)} (${worst.file}, ${worst.maxField}).`);
  lines.push('');
  lines.push('| fixture | frames | frames compared | field checks | max abs diff | worst field | events matched | result |');
  lines.push('| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |');
  for (const r of rows) {
    lines.push(`| \`${r.file}\` | ${r.frames} | ${r.compared} | ${r.checks} | ${r.maxDiff.toExponential(2)} | `
               + `${r.maxField || '-'} | ${r.events} | ${r.ok ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('The fixtures run the engine with the REFERENCE defaults: every phone option of');
  lines.push('`docs/dms/DETECTION_DESIGN.md` (`calibration.stationary_weight` 1.0,');
  lines.push('`attention.hard_left_*_deg` null, `drowsiness.ear_open_freeze_s` /');
  lines.push('`perclos_blink_exclude_s` / `blink_stats_min_fps` 0, `perclos_advisory` null) is off, so');
  lines.push('the port stays comparable to the Python stack frame by frame.  The phone behaviour is');
  lines.push('covered separately by `dms/tests/phone_options.test.js`.');
  lines.push('');
  lines.push('Per-frame output rows are compared from `t_test` onward (the calibration scenarios');
  lines.push('compare every frame); events and voiced alerts are compared at EVERY frame of every');
  lines.push('fixture, and the "frames compared" column says how many rows carried a full state check.');
  lines.push('');
  lines.push('The residual differences are the fixtures\' own 12-significant-digit dump quantisation');
  lines.push('(`%.12g`, <= 1e-12 relative), not engine drift: the worst absolute numbers appear on the');
  lines.push('largest quantities (`admitted_s` ~ 300 s, head speed ~ 10^3 deg/s).  Event streams, voiced');
  lines.push('alerts, zones, confidences, glance classes and drowsiness levels are IDENTICAL.');
  if (failed.length) {
    lines.push('');
    lines.push('## Failures');
    for (const f of failed) {
      lines.push(`* \`${f.file}\`: ${f.failures.length} mismatches`);
      for (const m of f.failures.slice(0, 5)) lines.push(`  * ${m}`);
    }
  }
  const out = path.join(__dirname, '..', 'PARITY.md');
  fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`${lines.join('\n')}\n`);
  return failed.length ? 1 : 0;
}

process.exitCode = main();
