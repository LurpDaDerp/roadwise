/**
 * Diagnostics (the local-testing email sign-in and the /dev routes) must only ever ship in the
 * development client — never in a build testers or the store get against the hosted project.
 */
import easJson from '../../eas.json';

type Profile = { env?: Record<string, string> };
const eas = easJson as { build: Record<string, Profile> };

it('only the development profile turns diagnostics on', () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    const on = profile.env?.EXPO_PUBLIC_DIAGNOSTICS === '1';
    expect({ name, on }).toEqual({ name, on: name === 'development' });
  }
});


// Android release builds: testers install the preview build directly (an APK), the store gets an
// app bundle, and `eas submit` puts it on Play's internal track as a draft. The Play service
// account key is read from the path in an environment variable, never from a file in the repo.
describe('Android profiles', () => {
  const a = easJson as unknown as {
    build: Record<string, { android?: { buildType?: string } }>;
    submit: { production: { android?: Record<string, string>; ios?: unknown } };
  };

  it('preview builds an APK, production an app bundle', () => {
    expect(a.build.preview?.android?.buildType).toBe('apk');
    expect(a.build.production?.android?.buildType).toBe('app-bundle');
  });

  it('submit: the internal track, as a draft, with the key path from the environment', () => {
    expect(a.submit.production.android).toEqual({
      track: 'internal',
      releaseStatus: 'draft',
      serviceAccountKeyPath: '$GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH',
    });
  });
});
