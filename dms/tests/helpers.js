'use strict';
/**
 * Fixture loading, column decoding and the numeric comparator shared by the parity tests.
 * `dms/tests/tools/parity_report.js` reuses the same functions to write PARITY.md.
 */

const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name.endsWith('.json') ? name : `${name}.json`), 'utf8'));
}

function listFixtures(prefix) {
  return fs.readdirSync(FIXTURES).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
}

/** Monitor scenario fixtures (the shared `monitor_warmup_*.json` prefixes are not scenarios). */
function listMonitorFixtures() {
  return listFixtures('monitor_').filter((f) => !f.startsWith('monitor_warmup_'));
}

/** Expand one encoded column (raw array / {const,n} / {runs} / {same}). */
function decodeColumn(col, decoded) {
  if (Array.isArray(col)) return col;
  if (col && typeof col === 'object') {
    if ('const' in col) return new Array(col.n).fill(col.const);
    if ('runs' in col) {
      const out = [];
      for (const [v, n] of col.runs) for (let i = 0; i < n; i++) out.push(v);
      return out;
    }
    if ('same' in col) return decoded[col.same];
  }
  throw new Error(`unknown column encoding: ${JSON.stringify(col).slice(0, 80)}`);
}

/** Expand a whole `{name: encodedColumn}` group in insertion order (aliases resolve backwards). */
function decodeFrames(encoded) {
  const out = {};
  for (const name of Object.keys(encoded)) out[name] = decodeColumn(encoded[name], out);
  return out;
}

/** JSON null (NaN / None in the reference) matches null, undefined or NaN here. */
function isNullish(v) {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
}

/** Accumulates per-fixture parity statistics and the first few failures. */
class Cmp {
  constructor(label, tol = 1e-6) {
    this.label = label;
    this.tol = tol;
    this.maxDiff = 0.0;
    this.maxField = '';
    this.checked = 0;
    this.failures = [];
    this.eventsMatched = 0;
    this.eventsExpected = 0;
  }

  fail(message) {
    if (this.failures.length < 12) this.failures.push(message);
  }

  /** Numeric field: absolute difference against the reference (null == NaN / None). */
  num(field, actual, expected, tol = this.tol) {
    this.checked += 1;
    if (isNullish(expected)) {
      if (!isNullish(actual)) this.fail(`${field}: expected null/NaN, got ${actual}`);
      return;
    }
    if (isNullish(actual)) {
      this.fail(`${field}: expected ${expected}, got null/NaN`);
      return;
    }
    const d = Math.abs(actual - expected);
    if (d > this.maxDiff) {
      this.maxDiff = d;
      this.maxField = field;
    }
    if (!(d <= tol)) this.fail(`${field}: |${actual} - ${expected}| = ${d.toExponential(3)} > ${tol}`);
  }

  /** Exact field (strings, booleans, integers). */
  exact(field, actual, expected) {
    this.checked += 1;
    if (typeof expected === 'boolean' ? Boolean(actual) !== expected : actual !== expected) {
      this.fail(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  /** One event dict against the reference `to_dict()` (all keys, both ways). */
  event(field, actual, expected) {
    this.eventsExpected += 1;
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    let ok = true;
    for (const k of keys) {
      const a = actual[k];
      const b = expected[k];
      if (typeof b === 'number' && typeof a === 'number') {
        if (Math.abs(a - b) > 0) {   // to_dict() rounds: the values must be identical
          ok = false;
          this.fail(`${field}.${k}: ${a} !== ${b}`);
        }
      } else if (isNullish(a) && isNullish(b)) {
        // both absent
      } else if (a !== b) {
        ok = false;
        this.fail(`${field}.${k}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
      }
    }
    if (ok) this.eventsMatched += 1;
  }

  get ok() {
    return this.failures.length === 0;
  }

  summary() {
    return {
      fixture: this.label,
      checked: this.checked,
      maxDiff: this.maxDiff,
      maxField: this.maxField,
      events: `${this.eventsMatched}/${this.eventsExpected}`,
      failures: this.failures.length,
      firstFailures: this.failures,
    };
  }

  assert(assertFn) {
    assertFn(this.failures.length === 0,
             `${this.label}: ${this.failures.length} mismatches\n  ${this.failures.join('\n  ')}`);
  }
}

module.exports = { FIXTURES, loadFixture, listFixtures, listMonitorFixtures, decodeColumn, decodeFrames, isNullish, Cmp };
