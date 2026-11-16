/** @jest-environment node */
// The Kotlin half of Sign in with Google on Android can't run in Jest, so this suite holds its
// sources to the contract the JS side (src/features/auth/googleCredential.ts) relies on by reading
// them as text: the module name, the cancel code, Android only (the iPhone build never links it),
// no permission of its own, pinned dependencies and the R8 keep rule Credential Manager needs.
import { GOOGLE_CREDENTIAL_CANCELLED } from '@/features/auth/googleCredential';

// Jest compiles this suite to CommonJS, so `__dirname` and `require` are real at run time (the root
// tsconfig's `types` is ["jest"], hence the local shapes).
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const { readFileSync } = require('node:fs') as { readFileSync: (file: string, encoding: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const ROOT = join(__dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const KT = join('android', 'src', 'main', 'java', 'expo', 'modules', 'googlecredential');
/** Kotlin with comments removed, so a rule can't be met by a comment. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('Android only: the iPhone build never links it', () => {
  const config = JSON.parse(read('expo-module.config.json')) as { platforms: string[]; android: { modules: string[] } };
  expect(config.platforms).toEqual(['android']);
  expect(config.android.modules).toEqual(['expo.modules.googlecredential.GoogleCredentialModule']);
});

test('the module name and the cancel code are the ones the JS side reads', () => {
  const mod = code(read(KT, 'GoogleCredentialModule.kt'));
  expect(mod).toMatch(/Name\("GoogleCredential"\)/);
  expect(mod).toMatch(/AsyncFunction\("signInAsync"\)\s*\{\s*serverClientId: String, nonce: String, promise: Promise ->/);
  // the sheet is shown from the main thread
  expect(mod).toMatch(/\.runOnQueue\(Queues\.MAIN\)/);
  // the hashed nonce goes into Google's option as given
  expect(mod).toMatch(/GetSignInWithGoogleOption\.Builder\(serverClientId\)\.setNonce\(nonce\)/);
  const errors = code(read(KT, 'GoogleCredentialErrors.kt'));
  expect(errors).toContain(`const val CANCELLED = "${GOOGLE_CREDENTIAL_CANCELLED}"`);
  expect(errors).toMatch(/is GetCredentialCancellationException -> CANCELLED/);
});

test('no permission of its own; dependencies pinned; the Play services provider kept through R8', () => {
  expect(code(read('android', 'src', 'main', 'AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, ''))).not.toMatch(/uses-permission/);
  const gradle = code(read('android', 'build.gradle'));
  const deps = [...gradle.matchAll(/implementation '([^']+)'/g)].map((m) => m[1]!);
  expect(deps).toEqual([
    'androidx.credentials:credentials:1.5.0',
    'androidx.credentials:credentials-play-services-auth:1.5.0',
    'com.google.android.libraries.identity.googleid:googleid:1.1.1',
    'androidx.core:core:1.17.0',
  ]);
  expect(gradle).toMatch(/consumerProguardFiles 'proguard-rules\.pro'/);
  expect(read('android', 'proguard-rules.pro')).toMatch(/-keep class androidx\.credentials\.playservices\.\*\*/);
});
