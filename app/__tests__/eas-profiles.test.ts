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

