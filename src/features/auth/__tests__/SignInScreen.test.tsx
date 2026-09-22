import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';

import { CONFIG_DEFAULTS, type AppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { DataProvider } from '@/data/queries/context';
import { SAFETY_DISCLAIMER } from '@/features/auth/legal';
import { PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { SignInScreen } from '@/features/auth/SignInScreen';
import { ThemeProvider } from '@/ui/theme';

// Everything below is read from inside a mock factory, so each name is `mock`-prefixed and every
// reference sits in a function body that only runs once the module has finished evaluating.
const mockUseState = useState;
const mockAppleSignIn = jest.fn(async () => {});
const mockGoogleSignIn = jest.fn(async () => {});
const mockSend = jest.fn(async (_email: string) => 'sent' as 'sent' | 'error');
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
    const [state, setState] = mockUseState<'idle' | 'sending' | 'sent' | 'error'>('idle');
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

const tree = () => (
  <ThemeProvider>
    <DataProvider db={fakeDb}>
      <SignInScreen />
    </DataProvider>
  </ThemeProvider>
);
const mount = () => render(tree());

const tick = async () => {
  await fireEvent.press(screen.getByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
};

const APPLE = { name: 'Continue with Apple' };
const GOOGLE = { name: 'Continue with Google' };
const EMAIL = { name: 'Email me a sign-in link' };

test('shows Apple, Google and email options and sends a magic link', async () => {
  await mount();
  expect(screen.getByRole('button', APPLE)).toBeTruthy();
  expect(screen.getByRole('button', GOOGLE)).toBeTruthy();
  await tick();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
  await fireEvent.press(screen.getByRole('button', EMAIL));
  expect(mockSend).toHaveBeenCalledWith('ava@example.com');
});

test('confirms in place once the link is on its way', async () => {
  await mount();
  await tick();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
  await fireEvent.press(screen.getByRole('button', EMAIL));
  expect(await screen.findByText('Check your email for a sign-in link.')).toBeOnTheScreen();
});

test('answers a rejected sign-in in place, in a live region', async () => {
  mockAppleSignIn.mockRejectedValueOnce(new Error('no identity token'));
  await mount();
  await tick();
  await fireEvent.press(screen.getByRole('button', APPLE));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Sign-in did not work. Try again.');
  // Announced without stealing focus: the driver is still in the middle of the form.
  expect(alert.props.accessibilityLiveRegion).toBe('polite');
});

test('leaves Google unarmed until its client id is configured', async () => {
  mockWorld.googleReady = false;
  await mount();
  await tick();
  expect(screen.getByRole('button', GOOGLE)).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', GOOGLE));
  expect(mockGoogleSignIn).not.toHaveBeenCalled();
});

describe('A3: the disclaimer and terms tick', () => {
  test('starts unticked, and every way in is disabled until it is ticked', async () => {
    await mount();
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    for (const name of [APPLE, GOOGLE, EMAIL]) {
      expect(screen.getByRole('button', name)).toBeDisabled();
      await fireEvent.press(screen.getByRole('button', name));
    }
    // The keyboard's Send is no way around it either.
    await fireEvent(screen.getByLabelText('Email'), 'submitEditing');
    expect(mockAppleSignIn).not.toHaveBeenCalled();
    expect(mockGoogleSignIn).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();

    await tick();
    for (const name of [APPLE, GOOGLE, EMAIL]) {
      expect(screen.getByRole('button', name)).toBeEnabled();
    }
  });

  test('the checkbox is a 44 pt target with the checkbox role', async () => {
    await mount();
    const box = screen.getByRole('checkbox');
    const style = [box.props.style].flat(Infinity).reduce((a, b) => ({ ...a, ...b }), {});
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  test('unpublished: acknowledges the disclaimer only, with no Terms or Privacy words anywhere', async () => {
    await mount();
    const box = screen.getByRole('checkbox');
    expect(box.props.accessibilityLabel).toBe(`I understand that ${SAFETY_DISCLAIMER}.`);
    expect(screen.getByText(`I understand that ${SAFETY_DISCLAIMER}.`)).toBeOnTheScreen();
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/terms|privacy/i);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  test('published: names the disclaimer, agrees to both documents, and links both', async () => {
    mockConfig.config = PUBLISHED;
    await mount();
    const box = screen.getByRole('checkbox');
    // The tick is recorded as acknowledging the disclaimer too, so the label names it.
    expect(box.props.accessibilityLabel).toBe(
      `I understand that ${SAFETY_DISCLAIMER}. I agree to the Terms and Privacy Policy.`
    );
    expect(screen.getByText('I agree to the Terms and Privacy Policy.')).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Terms' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeOnTheScreen();
  });

  test('ticking records the acceptance for exactly what was shown', async () => {
    mockConfig.config = PUBLISHED;
    await mount();
    await tick();
    expect(mockMarkTermsAccepted).toHaveBeenCalledTimes(1);
    expect(mockMarkTermsAccepted.mock.calls[0]?.[1]).toEqual({
      published: true,
      tos: { version: '2026-09-21', url: TERMS },
      privacy: { version: '2026-09-21', url: PRIVACY },
    });
  });

  test('unpublished ticking records the disclaimer state, not a Terms acceptance', async () => {
    await mount();
    await tick();
    expect(mockMarkTermsAccepted.mock.calls[0]?.[1]).toEqual({
      published: false,
      tos: null,
      privacy: null,
    });
  });

  test('unticking clears the Terms acceptance and disables the buttons again', async () => {
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    expect(screen.getByRole('button', APPLE)).toBeDisabled();
    // clearTermsAccepted: the Terms acceptance goes; the disclaimer acknowledgement is a device
    // preference and stays.
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

  test('cannot be ticked before the config has been read', async () => {
    mockConfig.ready = false;
    await mount();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox'));
    expect(mockMarkTermsAccepted).not.toHaveBeenCalled();
  });

  test('a tick given to the disclaimer alone does not carry over once documents are published', async () => {
    const view = await mount();
    await tick();
    mockConfig.config = PUBLISHED;
    await act(async () => view.rerender(tree()));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', APPLE)).toBeDisabled();
  });
});
