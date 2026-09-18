#!/usr/bin/env node
/**
 * Static import checker for the app source (no bundler, no network).
 *
 * Parses every app JS file with @babel/parser and reports four classes of problem that a
 * bundle-and-run would only surface at runtime, on a device, inside an un-awaited async handler:
 *
 *   1. SHADOWED IMPORT  - a module declares a binding with the same name as one of its own
 *      imports, so every call to the import inside that scope hits the local value instead.
 *      This is the class of bug that silently killed the whole GPS path of a drive
 *      (`const distanceMeters = distance` shadowing the imported `distanceMeters`).
 *   2. UNRESOLVED RELATIVE IMPORT - `./x` with no matching file.
 *   3. UNDECLARED PACKAGE - a bare import that is not in package.json (or a node builtin).
 *   4. UNUSED DEPENDENCY - a package.json dependency nothing imports. Reported as information,
 *      because config plugins and Expo autolinking pull some packages in without an import;
 *      the KEEP list below records which ones and why.
 *
 * Usage:  node scripts/check-imports.js            (exit 1 on classes 1-3)
 *         node scripts/check-imports.js --unused   (also fail on class 4)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseModule = require('@babel/traverse');

const traverse = traverseModule.default || traverseModule;
const ROOT = path.resolve(__dirname, '..');

/** Directories that are not the app's own source. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.expo', 'dist', 'functions', 'ios', 'android', 'assets', 'docs',
  'scripts',   // build tooling, not shipped app source
]);

/** Packages nothing imports but that the build genuinely needs, and why. */
const KEEP_WITHOUT_IMPORT = {
  expo: 'the runtime itself (node_modules/expo/AppEntry.js is package.json#main)',
  'expo-dev-client': 'development builds; no JS import by design',
  'expo-updates': 'OTA updates are configured in app.json and run natively',
  'expo-asset': 'app.json plugin (asset bundling)',
  'expo-font': 'app.json plugin (font loading for @expo/vector-icons)',
  'expo-system-ui': 'app.json background colour / root view appearance',
  'expo-apple-authentication': 'app.json plugin; App Store review pairs Google sign-in with Sign in with Apple (owner decision)',
  'expo-audio': 'app.json plugin; imported through the audio hooks',
  'react-native-reanimated': 'peer dependency of @gorhom/bottom-sheet',
  react: 'the JSX runtime',
  'react-native': 'the platform',
  'react-native-screens': 'peer dependency of @react-navigation/native (enableScreens)',
  'react-native-gesture-handler': 'peer dependency of @gorhom/bottom-sheet and react-navigation',
  'react-native-safe-area-context': 'peer dependency of react-navigation',
};

const BUILTINS = new Set(require('module').builtinModules);
const EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.json', '/index.js', '/index.jsx', '/index.ts'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function parse(code, file) {
  return parser.parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx', 'classProperties', 'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'],
    sourceFilename: file,
  });
}

const problems = [];
const unusedInfo = [];

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function checkFile(file, imported) {
  const code = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(code, file);
  } catch (err) {
    problems.push(`${rel(file)}: parse error - ${err.message}`);
    return;
  }

  const localImports = new Map(); // local name -> source

  const record = (source, node) => {
    if (typeof source !== 'string' || source.length === 0) return;
    if (source.startsWith('.')) {
      const base = path.resolve(path.dirname(file), source);
      const found = EXTENSIONS.some((ext) => {
        try { return fs.statSync(base + ext).isFile(); } catch (e) { return false; }
      });
      if (!found) {
        problems.push(`${rel(file)}:${node.loc ? node.loc.start.line : '?'}: unresolved relative import '${source}'`);
      }
      return;
    }
    const pkg = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0];
    if (BUILTINS.has(pkg) || pkg.startsWith('node:')) return;
    imported.add(pkg);
  };

  traverse(ast, {
    ImportDeclaration(p) {
      record(p.node.source.value, p.node);
      for (const spec of p.node.specifiers) localImports.set(spec.local.name, p.node.source.value);
    },
    ExportNamedDeclaration(p) {
      if (p.node.source) record(p.node.source.value, p.node);
    },
    ExportAllDeclaration(p) {
      if (p.node.source) record(p.node.source.value, p.node);
    },
    CallExpression(p) {
      const callee = p.node.callee;
      const isRequire = callee.type === 'Identifier' && callee.name === 'require';
      const isImport = callee.type === 'Import';
      if (!isRequire && !isImport) return;
      const arg = p.node.arguments[0];
      if (arg && arg.type === 'StringLiteral') record(arg.value, p.node);
    },
  });

  if (localImports.size === 0) return;

  // Class 1: any declaration anywhere in the file that re-binds an imported name.
  traverse(ast, {
    Scopable(p) {
      if (p.scope.path.isProgram()) return;          // the imports' own scope
      for (const name of Object.keys(p.scope.bindings)) {
        if (!localImports.has(name)) continue;
        const binding = p.scope.bindings[name];
        if (binding.kind === 'module') continue;
        const line = binding.identifier.loc ? binding.identifier.loc.start.line : '?';
        problems.push(
          `${rel(file)}:${line}: '${name}' shadows the import of the same name from `
          + `'${localImports.get(name)}' - every use of the import inside this scope reads the local value`
        );
      }
    },
  });
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(pkg.dependencies || {}));
  const imported = new Set();
  const files = walk(ROOT);

  for (const file of files) checkFile(file, imported);

  for (const name of imported) {
    if (!declared.has(name)) {
      problems.push(`package.json: '${name}' is imported by the app but is not a dependency`);
    }
  }
  for (const name of declared) {
    if (imported.has(name)) continue;
    if (KEEP_WITHOUT_IMPORT[name]) continue;
    unusedInfo.push(`${name} (no import anywhere in the app source)`);
  }

  const failUnused = process.argv.includes('--unused');
  console.log(`check-imports: ${files.length} files, ${imported.size} packages imported, ${declared.size} declared.`);
  if (unusedInfo.length) {
    console.log('\nDependencies with no import:');
    for (const line of unusedInfo.sort()) console.log(`  - ${line}`);
  }
  const unique = Array.from(new Set(problems));
  if (unique.length) {
    console.log('\nProblems:');
    for (const line of unique) console.log(`  ! ${line}`);
  }
  const failed = unique.length > 0 || (failUnused && unusedInfo.length > 0);
  if (!failed) console.log('\nOK');
  process.exit(failed ? 1 : 0);
}

main();
