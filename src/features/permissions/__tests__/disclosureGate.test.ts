/** @jest-environment node */
/**
 * Google Play: on Android, every path that asks for background location shows the prominent
 * disclosure first. The adapter refuses the Android request without `disclosed` (adapters.test), so
 * this pins the other half: only the gated places call it, each one passing `disclosed` only after
 * the disclosure answered Continue.
 */
// The app's tsconfig carries no Node types: local shapes, as the repo's other Node reads do.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const fs = require('node:fs') as {
  readdirSync(dir: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  readFileSync(file: string, enc: 'utf8'): string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
const path = require('node:path') as { join(...parts: string[]): string; relative(a: string, b: string): string };

// Jest compiles this suite to CommonJS, so `__dirname` is real at run time.
declare const __dirname: string;
const SRC = path.join(__dirname, '..', '..', '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === '__fixtures__' ? [] : sources(full);
    return /[.]tsx?$/.test(e.name) ? [full] : [];
  });
}

const rel = (full: string) => path.relative(SRC, full).split('\\').join('/');
const text = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

test('only the adapter, the fix and the Location step ask for Always', () => {
  const callers = sources(SRC)
    .filter((full) => /requestLocationAlways[(]|[.]requestAlways[(]/.test(fs.readFileSync(full, 'utf8')))
    .map(rel)
    .sort();
  expect(callers).toEqual(['core/permissions/adapters.ts', 'features/onboarding/steps/LocationStep.tsx', 'features/permissions/actions.ts']);
});

test('the fix passes disclosed only after the disclosure said Continue', () => {
  const src = text('features/permissions/actions.ts');
  const gate = src.indexOf("if (!(await deps.discloseBackground(id === 'locationAlways' ? 'allTheTime' : 'allow'))) return { kind: 'declined' };");
  const ask = src.indexOf('await adapter.requestLocationAlways({ disclosed });');
  expect(gate).toBeGreaterThan(-1);
  expect(ask).toBeGreaterThan(-1);
  expect(src).toMatch(/disclosed = true;/);
  // The board hands the disclosure to every fix that needs it (`disclosesBackground`) and refuses one without it.
  const board = text('features/permissions/usePermissionBoard.ts');
  expect(board).toMatch(/const discloses = disclosesBackground[(]id, state, r[)];/);
  expect(board).toMatch(/if [(]discloses && !opts[.]disclose[)] throw/);
  expect(board).toMatch(/discloseBackground: discloses [?] opts[.]disclose : undefined/);
});

test("the Location step's Android request follows the disclosure", () => {
  const src = text('features/onboarding/steps/LocationStep.tsx');
  const ask = src.indexOf('if (!(await disclosure.ask())) return null;');
  const request = src.indexOf('await adapter.requestLocationAlways({ disclosed: true });');
  expect(ask).toBeGreaterThan(-1);
  expect(request).toBeGreaterThan(ask);
});

test("the Location step's Android 9-and-lower request follows the disclosure, and says so to the adapter", () => {
  const src = text('features/onboarding/steps/LocationStep.tsx');
  const ask = src.indexOf("if (disclosed && !(await disclosure.ask('allow'))) return;");
  const request = src.indexOf('await adapter.requestLocationForeground({ disclosed });');
  expect(src).toMatch(/const disclosed = oneAsk[(]snapshot[)];/);
  expect(ask).toBeGreaterThan(-1);
  expect(request).toBeGreaterThan(ask);
});

test('on Android 9 and lower the location fix passes disclosed (the adapter asks only then), and no other caller passes it', () => {
  expect(text('features/permissions/actions.ts')).toMatch(/await adapter[.]requestLocationForeground[(][{] disclosed [}][)];/);
  const passing = sources(SRC)
    .filter((full) => /requestLocationForeground[(][{]/.test(fs.readFileSync(full, 'utf8')))
    .map(rel)
    .sort();
  expect(passing).toEqual(['features/onboarding/steps/LocationStep.tsx', 'features/permissions/actions.ts', 'features/settings/PrivacyZonesScreen.tsx']);
});

test('"Use my location" (Places, Privacy zones) passes disclosed only after the disclosure said Continue', () => {
  const src = text('features/settings/PrivacyZonesScreen.tsx');
  const gate = src.indexOf("if (background && !(disclose !== undefined && (await disclose('allow')))) return { ok: false, reason: 'notAsked' };");
  const request = src.indexOf('await adapter.requestLocationForeground({ disclosed: background });');
  expect(gate).toBeGreaterThan(-1);
  expect(request).toBeGreaterThan(gate);
  for (const file of ['features/settings/PrivacyZonesScreen.tsx', 'features/places/PlaceSheet.tsx']) {
    const s = text(file);
    expect(s).toMatch(/useBackgroundDisclosure[(][)]/);
    expect(s).toMatch(/[{]disclosure[.]sheet[}]/);
    expect(s).toMatch(/await locate[(]disclosure[.]ask[)]/);
  }
});

test("the DashPal setup's location request (Android 11 and lower) passes disclosed only after the disclosure said Continue", () => {
  const passing = sources(SRC)
    .filter((full) => /requestBluetooth[(][{]/.test(fs.readFileSync(full, 'utf8')))
    .map(rel)
    .sort();
  expect(passing).toEqual(['dashcam/ui/wizard/useSetupFlow.ts']);
  const src = text('dashcam/ui/wizard/useSetupFlow.ts');
  const gate = src.indexOf("if (!ask || !(await ask('allow'))) return 'undetermined';");
  const request = src.indexOf('return adapter.requestBluetooth({ disclosed: true });');
  expect(gate).toBeGreaterThan(-1);
  expect(request).toBeGreaterThan(gate);
  const sheet = text('dashcam/ui/wizard/PairWizardSheet.tsx');
  expect(sheet).toMatch(/useBackgroundDisclosure[(][)]/);
  expect(sheet).toMatch(/[{]disclosure[.]sheet[}]/);
  expect(sheet).toMatch(/disclose: deps[?][.]disclose [?][?] disclosure[.]ask/);
});

test('every screen with a Location Always fix renders the disclosure and hands it to the fix', () => {
  for (const file of ['features/permissions/PermissionsScreen.tsx', 'features/permissions/PermissionCard.tsx']) {
    const src = text(file);
    expect(src).toMatch(/useBackgroundDisclosure[(][)]/);
    expect(src).toMatch(/[{]disclosure[.]sheet[}]/);
    expect(src).toMatch(/disclose: disclosure[.]ask/);
  }
});
