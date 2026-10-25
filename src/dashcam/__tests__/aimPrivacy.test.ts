/**
 * The aiming picture stays in memory on the phone: the files that touch it read no storage, file,
 * secure store or app store module, log nothing, and hand no record, image or AIM value to an error
 * report; the setup's speed reads the location only as it is already allowed.
 */
// Jest runs this suite as CommonJS: `__dirname` and `require` are real at run time.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node's own modules in a test
const { readFileSync } = require('fs') as { readFileSync(p: string, enc: string): string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node's own modules in a test
const { join } = require('path') as { join(...p: string[]): string };

const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

/** The files the picture and its AIM frames pass through. */
const PICTURE = ['view.ts', 'aim.ts', 'ui/wizard/AimView.tsx', 'ui/wizard/AimBorder.tsx', 'ui/wizard/StepAim.tsx'];

describe('the aiming picture stays in memory', () => {
  it.each(PICTURE)('%s imports no storage, file, secure store or app store module and logs nothing', (file) => {
    const text = src(...file.split('/'));
    const imports = [...text.matchAll(/from '([^']+)'|require\('([^']+)'\)/g)].map((m) => m[1] ?? m[2]);
    // view.ts imports nothing at all.
    if (file !== 'view.ts') expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).not.toMatch(/sqlite|file-system|secure-store|async-storage|\/store$|\/secure$|\/data\/|supabase|telemetry|sentry|media-library|sharing|view-shot/i);
    expect(text).not.toMatch(/console\./);
  });

  it('the setup flow hands the picture to the screen’s listeners only, and never a record, an image or an AIM value to a report', () => {
    const text = src('setup.ts');
    for (const call of text.match(/report\([^;]*\);/g) ?? []) expect(call).not.toMatch(/\brec\b|jpeg|image|\.score|\.hint|AimFrame|frame\b/i);
    expect(text).not.toMatch(/console\./);
    // An image reaches nothing but the frame listeners.
    expect(text.match(/r\.image\.jpeg/g)).toHaveLength(1);
    expect(text).toMatch(/for \(const fn of \[\.\.\.frameListeners\]\) \{\s*try \{\s*fn\(r\.image\.jpeg\);/);
  });

  it('the transport hands VIEW records to the setup listener and never to a report', () => {
    const text = src('transport.ts');
    const body = text.slice(text.indexOf('function onSetupView'), text.indexOf('/** iOS restored these'));
    expect(body).toContain('listener(r.frame)');
    expect(body).not.toMatch(/report\(/);
  });

  it('the setup speed reads the location only once it is allowed: getForegroundPermissionsAsync and watchPositionAsync, never a request', () => {
    const text = src('setupSpeed.ts');
    const calls = [...new Set([...text.matchAll(/Location\.(\w+Async)/g)].map((m) => m[1]))].sort();
    expect(calls).toEqual(['getForegroundPermissionsAsync', 'watchPositionAsync']);
    expect(text).not.toMatch(/request\w*PermissionsAsync/);
  });

  it('a change of theme never takes a picture of the app (the aiming picture with it)', () => {
    for (const f of [['theme.tsx'], ['sky', 'SkyFade.tsx'], ['sky', 'SkyBackdrop.tsx']]) {
      expect(readFileSync(join(__dirname, '..', '..', 'ui', ...f), 'utf8')).not.toMatch(/view-shot|captureRef/);
    }
  });
});
