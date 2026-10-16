// The DashPal link's randomness: drawn from `globalThis.crypto` at each call (never captured at
// load), with the polyfill as `index.ts`'s first import, and noble's own random helpers never used.
import { RandomUnavailableError, randomBytes } from '../crypto';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time; the root
// tsconfig has no Node typings, hence the local shapes.
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node's modules in a text test
const fs = require('fs') as { readFileSync(p: string, enc: string): string; readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as { join(...p: string[]): string; resolve(...p: string[]): string };

const ROOT = path.resolve(__dirname, '../../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('randomBytes', () => {
  test('draws the asked number of bytes from crypto.getRandomValues', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).toHaveLength(32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  test('reads globalThis.crypto at call time: removed after import it throws the named error, restored it works', () => {
    const g = globalThis as { crypto?: unknown };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
      expect(() => randomBytes(16)).toThrow(RandomUnavailableError);
      Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (x: Uint8Array) => x.fill(7) }, configurable: true, writable: true });
      expect(Array.from(randomBytes(3))).toEqual([7, 7, 7]);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
      else delete g.crypto;
    }
    expect(randomBytes(4)).toHaveLength(4);
  });
});

describe('text pins', () => {
  test("index.ts's first import is the random-values polyfill", () => {
    const text = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf8');
    const first = text.split('\n').find((l) => /^\s*import\b/.test(l));
    expect(first?.trim()).toBe("import 'react-native-get-random-values';");
  });

  test('no file under src/dashcam imports randomBytes, randomPrivateKey or randomSecretKey from @noble', () => {
    const offenders: string[] = [];
    for (const f of sources(path.join(ROOT, 'src/dashcam'))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@noble\/[^']+'/g)) {
        if (/\brandom(Bytes|PrivateKey|SecretKey)\b/.test(m[1] ?? '')) offenders.push(f);
      }
      if (/\butils\.random(PrivateKey|SecretKey)\b/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
