#!/usr/bin/env node
'use strict';
/**
 * Checks package-lock.json the way EAS Build's `npm ci` (npm 10) does before it installs anything:
 * every dependency of every package in the lock must resolve, by Node's lookup through the
 * node_modules folders, to a locked package whose version satisfies the range asked for.
 *
 *   npm run lock:check
 *
 * npm 11 is more lenient with `overrides`: it accepts an edge to a hoisted package an override
 * touches whenever the override's own range holds, so a local `npm install` can write (and then
 * call "up to date") a lock that EAS refuses with "lock file's X@a does not satisfy X@b". This
 * applies an override only to the edges inside the folder of the package it names, as npm 10
 * does, so that drift fails here first. scripts/__tests__/check-lockfile.test.ts runs it with the
 * rest of the suite. A peer dependency is not checked: npm only warns about those.
 */

const fs = require('fs');
const path = require('path');
// npm's own range semantics (always installed: the Expo toolchain depends on it).
const semver = require('semver');

const ROOT = path.resolve(__dirname, '..');

/** The parent folder path of a lock key ("" for a top-level package). */
function parentOf(key) {
  const i = key.lastIndexOf('/node_modules/');
  return i < 0 ? '' : key.slice(0, i);
}

/** The lock key a dependency `name` of the package at `from` resolves to, or null. */
function resolve(packages, from, name) {
  let dir = from;
  for (;;) {
    const key = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[key]) return key;
    if (dir === '') return null;
    dir = parentOf(dir);
  }
}

/** `overrides` as [scope (a package name, or null for everywhere), dependency, range]. */
function overrideRules(overrides, scope = null, out = []) {
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'string') out.push([scope, name, value]);
    else if (value && typeof value === 'object') {
      if (typeof value['.'] === 'string') out.push([scope, name, value['.']]);
      overrideRules(value, name, out);
    }
  }
  return out;
}

/** The range an edge from the package at `from` to `name` is held to, after the overrides. */
function rangeFor(rules, packages, from, name, spec) {
  let range = spec;
  for (const [scope, dep, value] of rules) {
    if (dep !== name) continue;
    if (scope === null) range = value;
    else {
      // Inside the named package's own folder (or the package itself), as npm 10 applies it.
      const inScope = from.split('/node_modules/').some((part, i) => {
        const seg = i === 0 ? part.replace(/^node_modules\//, '') : part;
        return seg === scope;
      });
      if (inScope) range = value;
    }
  }
  return range;
}

/** The semver range a dependency spec asks for, or null when it isn't a registry range. */
function semverRange(name, spec) {
  if (spec.startsWith('npm:')) {
    const at = spec.lastIndexOf('@');
    return at > 4 ? { name: spec.slice(4, at), range: spec.slice(at + 1) } : { name: spec.slice(4), range: '*' };
  }
  if (/^(file|link|git|git\+[a-z]+|github|https?|workspace):/.test(spec) || spec.includes('/')) return null;
  return { name, range: spec === '' || spec === 'latest' ? '*' : spec };
}

/** Every edge of the lock that npm ci would refuse, as readable lines. */
function lockProblems(pkg, lock) {
  const packages = lock.packages ?? {};
  const rules = overrideRules(pkg.overrides);
  const problems = [];
  for (const [key, node] of Object.entries(packages)) {
    if (node.link) continue;
    const deps = { ...(node.dependencies ?? {}), ...(node.optionalDependencies ?? {}) };
    if (key === '') Object.assign(deps, pkg.devDependencies ?? {}, pkg.dependencies ?? {}, pkg.optionalDependencies ?? {});
    const optional = new Set(Object.keys(node.optionalDependencies ?? (key === '' ? pkg.optionalDependencies : null) ?? {}));
    for (const [name, spec] of Object.entries(deps)) {
      const target = resolve(packages, key, name);
      if (target === null) {
        if (!optional.has(name)) problems.push(`${key || '(root)'}: ${name}@${spec} is missing from the lock`);
        continue;
      }
      const wanted = semverRange(name, rangeFor(rules, packages, key, name, spec));
      if (wanted === null) continue;
      const got = packages[target];
      if (got.link) continue;
      if (got.name !== undefined && got.name !== wanted.name) {
        problems.push(`${key || '(root)'}: ${name}@${spec} resolves to ${target}, which is ${got.name}`);
        continue;
      }
      if (typeof got.version !== 'string' || !semver.satisfies(got.version, wanted.range, { loose: true, includePrerelease: true })) {
        problems.push(`${key || '(root)'}: ${name}@${wanted.range} is locked at ${target}@${got.version}`);
      }
    }
  }
  return problems;
}

module.exports = { lockProblems };

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const problems = lockProblems(pkg, lock);
  if (problems.length > 0) {
    console.error(`package-lock.json would fail \`npm ci\` on EAS (${problems.length}):\n  ${problems.join('\n  ')}`);
    console.error('Fix: npx -y npm@10.9.8 install --package-lock-only, then npm install.');
    process.exit(1);
  }
  console.log('package-lock.json: every dependency is locked at a version that satisfies it.');
}
