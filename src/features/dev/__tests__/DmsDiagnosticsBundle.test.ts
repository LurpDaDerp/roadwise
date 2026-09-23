/** @jest-environment node */
// The bundle proof for the DMS diagnostics route (plan Task 16, R-2): the route file put through the same
// transforms a release build uses (babel-preset-expo in production, which inlines EXPO_PUBLIC_* values, then
// Metro's own inline and constant-folding plugins, which run before Metro collects a module's dependencies).
// Without the flag the panel's require is folded away, so Metro never adds it to the bundle; with the flag it
// stays. The route never references the native wrapper at all (the host binds it: security T14 m-1).

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { resolve: (...p: string[]) => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- build tooling, not app code
const babel = require('@babel/core') as { transformSync: (src: string, o: object) => { code: string } | null };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const metroPlugins = require('metro-transform-plugins') as { inlinePlugin: unknown; constantFoldingPlugin: unknown };

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ROUTE = path.resolve(ROOT, 'app', '(app)', 'dev', 'dms.tsx');
const SOURCE = fs.readFileSync(ROUTE, 'utf8');

/** The release transform for one platform, with EXPO_PUBLIC_DIAGNOSTICS as given (undefined = unset). */
function releaseTransform(platform: 'ios' | 'android', flag: string | undefined): string {
  const saved = process.env.EXPO_PUBLIC_DIAGNOSTICS;
  if (flag === undefined) delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
  else process.env.EXPO_PUBLIC_DIAGNOSTICS = flag;
  try {
    const caller = { name: 'metro', bundler: 'metro', platform, isDev: false, isServer: false, isReactServer: false };
    const first = babel.transformSync(SOURCE, {
      filename: ROUTE,
      cwd: ROOT,
      babelrc: false,
      configFile: false,
      caller,
      presets: [['babel-preset-expo', {}]],
    });
    if (first === null) throw new Error('no output');
    // Metro's worker, for a release build: inline (__DEV__ → false, Platform.OS) then constant folding.
    const second = babel.transformSync(first.code, {
      filename: ROUTE,
      babelrc: false,
      configFile: false,
      plugins: [[metroPlugins.inlinePlugin, { dev: false, inlinePlatform: true, platform, isWrapped: false }], [metroPlugins.constantFoldingPlugin, {}]],
    });
    if (second === null) throw new Error('no output');
    return second.code;
  } finally {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
    else process.env.EXPO_PUBLIC_DIAGNOSTICS = saved;
  }
}

const PANEL = /DmsDiagnosticsPanel/;
const WRAPPER = /modules\/dms-vision/;

describe.each(['ios', 'android'] as const)('%s release bundle', (platform) => {
  test('no flag: the panel is not required (so not bundled), nor the wrapper', () => {
    const code = releaseTransform(platform, undefined);
    expect(code).not.toMatch(PANEL);
    expect(code).not.toMatch(WRAPPER);
    // …and the route itself still exists, as a redirect home.
    expect(code).toMatch(/Redirect/);
  });

  test('a flag other than "1": the same', () => {
    const code = releaseTransform(platform, '0');
    expect(code).not.toMatch(PANEL);
    expect(code).not.toMatch(WRAPPER);
  });

  test('EXPO_PUBLIC_DIAGNOSTICS=1: the panel stays; the wrapper is still not referenced', () => {
    const code = releaseTransform(platform, '1');
    expect(code).toMatch(PANEL);
    expect(code).not.toMatch(WRAPPER);
  });
});

test('the route reaches the panel only through the guarded require, and never the wrapper', () => {
  // A static import would bundle it whatever the flag.
  expect(SOURCE).not.toMatch(/import[^;]*from\s+['"][^'"]*DmsDiagnosticsPanel['"]/);
  expect(SOURCE).not.toMatch(/modules\/dms-vision/);
  expect(SOURCE).not.toMatch(/import\(/);
});
