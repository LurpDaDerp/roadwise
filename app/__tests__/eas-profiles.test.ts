/**
 * Diagnostics (the local-testing email sign-in and the /dev routes) must only ever ship in the
 * development client — never in a build testers or the store get against the hosted project.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { magicLinkEnabled } from '@/features/auth/SignInScreen';

type Profile = { env?: Record<string, string> };
const eas = JSON.parse(readFileSync(join(__dirname, '..', '..', 'eas.json'), 'utf8')) as {
  build: Record<string, Profile>;
};

it('only the development profile turns diagnostics on', () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    const on = profile.env?.EXPO_PUBLIC_DIAGNOSTICS === '1';
    expect({ name, on }).toEqual({ name, on: name === 'development' });
  }
});

it('the email sign-in is off when diagnostics are unset', () => {
  const before = process.env.EXPO_PUBLIC_DIAGNOSTICS;
  delete process.env.EXPO_PUBLIC_DIAGNOSTICS;
  try {
    expect(magicLinkEnabled()).toBe(false);
  } finally {
    if (before !== undefined) process.env.EXPO_PUBLIC_DIAGNOSTICS = before;
  }
});
