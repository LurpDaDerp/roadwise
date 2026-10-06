import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';

import { CONFIG_DEFAULTS, type AppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { DataProvider } from '@/data/queries/context';
import { PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { SignInScreen, signInCopy } from '@/features/auth/SignInScreen';
import { ThemeProvider } from '@/ui/theme';

// Everything below is read from inside a mock factory, so each name is `mock`-prefixed and every
// reference sits in a function body that only runs once the module has finished evaluating.
const mockUseState = useState;
const mockAppleSignIn = jest.fn(async () => {});
const mockGoogleSignIn = jest.fn(async () => {});
const mockSend = jest.fn(async (_email: string) => 'sent' as 'sent' | 'rate_limited' | 'error');
const mockWorld = { googleReady: true };
const mockConfig: { config: AppConfig; ready: boolean } = {
  config: { ...CONFIG_DEFAULTS, fetchedAt: null },
  ready: true,
};
const mockMarkTermsAccepted = jest.fn(async (..._args: unknown[]) => {});

jest.mock('@/features/auth/useAppleSignIn', () => ({
  useAppleSignIn: () => ({ signIn: mockAppleSignIn, available: true }),
}));
jest.mock('@/features/auth/useGoogleSignIn', () => ({
  useGoogleSignIn: () => ({
    signIn: mockGoogleSignIn,
    ready: mockWorld.googleReady,
  }),
}));
// A real hook rather than a frozen value: the screen has to see `state` move the way it does in
// the app, or the confirmation line can never be asserted.
jest.mock('@/features/auth/useMagicLink', () => ({
  useMagicLink: () => {
    const [state, setState] = mockUseState<'idle' | 'sending' | 'sent' | 'rate_limited' | 'error'>(
      'idle'
    );
    return {
      state,
      send: async (email: string) => {
        setState('sending');
        const result = await mockSend(email);
        setState(result);
        return result;
      },
    };
  },
}));
// The consent helpers import the app client; nothing here reaches the network.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/config/appConfig', () => ({
  ...jest.requireActual('@/data/config/appConfig'),
  useAppConfig: () => mockConfig,
}));
jest.mock('@/features/auth/pendingConsent', () => ({
  ...jest.requireActual('@/features/auth/pendingConsent'),
  markTermsAccepted: (...args: unknown[]) => mockMarkTermsAccepted(...args),
}));

const TERMS = 'https://roadwise.app/terms';
const PRIVACY = 'https://roadwise.app/privacy';
const PUBLISHED: AppConfig = {
  ...CONFIG_DEFAULTS,
  fetchedAt: 1,
  legal_urls: { terms: TERMS, privacy: PRIVACY },
};

/** A settings table that only records what the screen removes; nothing else touches the db. */
const executed: { sql: string; params: unknown[] }[] = [];
const fakeDb = {
  execute: async (sql: string, params: unknown[] = []) => {
    executed.push({ sql, params });
    return { rows: [], changes: 1 };
  },
} as unknown as Db;

beforeEach(() => {
  mockWorld.googleReady = true;
  mockConfig.config = { ...CONFIG_DEFAULTS, fetchedAt: null };
  mockConfig.ready = true;
  mockAppleSignIn.mockReset().mockResolvedValue(undefined);
  mockGoogleSignIn.mockReset().mockResolvedValue(undefined);
  mockSend.mockReset().mockResolvedValue('sent');
  mockMarkTermsAccepted.mockReset().mockResolvedValue(undefined);
  executed.length = 0;
});

const tree = (showMagicLink = false) => (
  <ThemeProvider>
    <DataProvider db={fakeDb}>
      <SignInScreen showMagicLink={showMagicLink} />
    </DataProvider>
  </ThemeProvider>
);
const mount = (showMagicLink = false) => render(tree(showMagicLink));

const tick = async () => {
  await fireEvent.press(screen.getByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
};

const APPLE = { name: 'Continue with Apple' };
const GOOGLE = { name: 'Continue with Google' };
const EMAIL = { name: 'Email me a sign-in link' };

test('shows Apple and Google, and no email sign-in outside diagnostics builds', async () => {
  await mount();
  expect(screen.getByRole('button', APPLE)).toBeTruthy();
  expect(screen.getByRole('button', GOOGLE)).toBeTruthy();
  expect(screen.queryByRole('button', EMAIL)).toBeNull();
  expect(screen.queryByLabelText('Email')).toBeNull();
});

test('nothing on the screen asks for an age or a birth date', async () => {
  await mount(true);
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/birth|date of birth|how old/i);
});

test('the 13+ checkbox: its words, a 44 pt target, and links to both documents when published', async () => {
  mockConfig.config = PUBLISHED;
  await mount();
  const box = screen.getByRole('checkbox');
  expect(box.props.accessibilityLabel).toBe("I'm 13 or older and agree to the Terms and Privacy Policy");
  expect(signInCopy.attest).toBe("I'm 13 or older and agree to the Terms and Privacy Policy");
  const style = [box.props.style].flat(Infinity).reduce((a, b) => ({ ...a, ...b }), {});
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
  expect(screen.getByRole('link', { name: 'Terms' })).toBeOnTheScreen();
  expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeOnTheScreen();
});

test('starts unticked, and every way in is disabled until it is ticked', async () => {
  await mount(true);
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
  for (const name of [APPLE, GOOGLE, EMAIL]) {
    expect(screen.getByRole('button', name)).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', name));
  }
  expect(mockAppleSignIn).not.toHaveBeenCalled();
  expect(mockGoogleSignIn).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();

  await tick();
  for (const name of [APPLE, GOOGLE, EMAIL]) expect(screen.getByRole('button', name)).toBeEnabled();
  expect(mockMarkTermsAccepted).toHaveBeenCalledTimes(1);
});

test('ticked, Apple and Google sign in', async () => {
  await mount();
  await tick();
  await fireEvent.press(screen.getByRole('button', APPLE));
  await fireEvent.press(screen.getByRole('button', GOOGLE));
  expect(mockAppleSignIn).toHaveBeenCalledTimes(1);
  expect(mockGoogleSignIn).toHaveBeenCalledTimes(1);
});

test('unticking clears the tick and disables the buttons again', async () => {
  await mount();
  await tick();
  executed.length = 0;
  await fireEvent.press(screen.getByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  expect(screen.getByRole('button', APPLE)).toBeDisabled();
  const removed = executed.filter((e) => e.sql.startsWith('DELETE')).map((e) => e.params[0]);
  expect(removed).toEqual([PENDING_TERMS_KEY]);
});

test('a save that fails leaves it unticked and says so', async () => {
  mockMarkTermsAccepted.mockRejectedValueOnce(new Error('disk full'));
  await mount();
  await fireEvent.press(screen.getByRole('checkbox'));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("Couldn't save that. Try again.");
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.getByRole('button', APPLE)).toBeDisabled();
});

test('answers a rejected sign-in in place, in a live region', async () => {
  mockAppleSignIn.mockRejectedValueOnce(new Error('no identity token'));
  await mount();
  await tick();
  await fireEvent.press(screen.getByRole('button', APPLE));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Sign-in did not work. Try again.');
  expect(alert.props.accessibilityLiveRegion).toBe('polite');
});

test('leaves Google unarmed until its client id is configured', async () => {
  mockWorld.googleReady = false;
  await mount();
  await tick();
  expect(screen.getByRole('button', GOOGLE)).toBeDisabled();
});

describe('the magic link (diagnostics builds only)', () => {
  const sendEmail = async () => {
    await mount(true);
    await tick();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.press(screen.getByRole('button', EMAIL));
  };

  test('sends and confirms in place', async () => {
    await sendEmail();
    expect(mockSend).toHaveBeenCalledWith('ava@example.com');
    expect(await screen.findByText('Check your email for a sign-in link.')).toBeOnTheScreen();
  });

  test('a refused burst says to wait', async () => {
    mockSend.mockResolvedValueOnce('rate_limited');
    await sendEmail();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many sign-in emails. Try again in a minute.');
  });
});
