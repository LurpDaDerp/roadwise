import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { CONFIG_DEFAULTS, type AppConfig } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { DataProvider } from '@/data/queries/context';
import { PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { SignInScreen, signInCopy } from '@/features/auth/SignInScreen';
import { ThemeProvider } from '@/ui/theme';

// Everything below is read from inside a mock factory, so each name is `mock`-prefixed and every
// reference sits in a function body that only runs once the module has finished evaluating.
const mockAppleSignIn = jest.fn(async () => {});
const mockGoogleSignIn = jest.fn(async () => {});
const mockSend = jest.fn(async (_email: string) => 'sent' as 'sent' | 'rate_limited' | 'error');
const mockVerify = jest.fn(
  async (_email: string, _code: string) => 'ok' as 'ok' | 'invalid' | 'rate_limited' | 'error'
);
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
jest.mock('@/features/auth/emailCode', () => ({
  ...jest.requireActual('@/features/auth/emailCode'),
  sendEmailCode: (email: string) => mockSend(email),
  verifyEmailCode: (email: string, code: string) => mockVerify(email, code),
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
  mockVerify.mockReset().mockResolvedValue('ok');
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
const EMAIL = { name: 'Email me a code' };
const VERIFY = { name: 'Sign in' };
const RESEND = { name: 'Send a new code' };
const CHANGE = { name: 'Use a different email' };

test('shows Apple, Google and the email code, in every build', async () => {
  await mount();
  expect(screen.getByRole('button', APPLE)).toBeTruthy();
  expect(screen.getByRole('button', GOOGLE)).toBeTruthy();
  expect(screen.getByRole('button', EMAIL)).toBeTruthy();
  expect(screen.getByLabelText('Email')).toBeTruthy();
});

test('nothing on the screen asks for an age or a birth date', async () => {
  await mount();
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
  await mount();
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

describe('the emailed code', () => {
  const askForCode = async (email = 'ava@example.com') => {
    await mount();
    await tick();
    await fireEvent.changeText(screen.getByLabelText('Email'), email);
    await fireEvent.press(screen.getByRole('button', EMAIL));
  };
  const typeCode = (code: string) => fireEvent.changeText(screen.getByLabelText('6-digit code'), code);

  test('a malformed address cannot be sent', async () => {
    await mount();
    await tick();
    for (const bad of ['', 'ava', 'ava@', 'ava@example', 'a va@example.com']) {
      await fireEvent.changeText(screen.getByLabelText('Email'), bad);
      expect(screen.getByRole('button', EMAIL)).toBeDisabled();
    }
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    expect(screen.getByRole('button', EMAIL)).toBeEnabled();
  });

  test('step one asks for a code, then step two asks for the six digits', async () => {
    await askForCode(' ava@example.com ');
    expect(mockSend).toHaveBeenCalledWith(' ava@example.com ');
    expect(await screen.findByText('We emailed a 6-digit code to ava@example.com.')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByRole('button', VERIFY)).toBeDisabled();
  });

  test('the code field keeps digits only, at most six, and arms Sign in on the sixth', async () => {
    await askForCode();
    await screen.findByLabelText('6-digit code');
    await typeCode('12a-3 4');
    expect(screen.getByLabelText('6-digit code').props.value).toBe('1234');
    expect(screen.getByRole('button', VERIFY)).toBeDisabled();
    await typeCode('12345678');
    expect(screen.getByLabelText('6-digit code').props.value).toBe('123456');
    expect(screen.getByRole('button', VERIFY)).toBeEnabled();
  });

  test('a good code signs in with the address and the code, and shows no error', async () => {
    await askForCode();
    await screen.findByLabelText('6-digit code');
    await typeCode('123456');
    await fireEvent.press(screen.getByRole('button', VERIFY));
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('ava@example.com', '123456'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a wrong or expired code says so, in place, and can be retyped', async () => {
    mockVerify.mockResolvedValueOnce('invalid');
    await askForCode();
    await screen.findByLabelText('6-digit code');
    await typeCode('000000');
    await fireEvent.press(screen.getByRole('button', VERIFY));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That code didn't work or has expired. Check it, or send a new one.");
    expect(screen.getByLabelText('6-digit code').props.value).toBe('000000');
    expect(screen.getByRole('button', VERIFY)).toBeEnabled();
  });

  test('too many tries, and any other failure, each have their own line', async () => {
    mockVerify.mockResolvedValueOnce('rate_limited').mockResolvedValueOnce('error');
    await askForCode();
    await screen.findByLabelText('6-digit code');
    await typeCode('123456');
    await fireEvent.press(screen.getByRole('button', VERIFY));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries. Try again in a minute.');
    await fireEvent.press(screen.getByRole('button', VERIFY));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Sign-in did not work. Try again.'));
  });

  test('a new code can be asked for, and says it is on its way', async () => {
    await askForCode();
    await screen.findByLabelText('6-digit code');
    await typeCode('123456');
    await fireEvent.press(screen.getByRole('button', RESEND));
    expect(await screen.findByText('A new code is on its way.')).toBeOnTheScreen();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('6-digit code').props.value).toBe('');
  });

  test('a different email goes back to step one with the address kept for editing', async () => {
    await askForCode();
    await screen.findByLabelText('6-digit code');
    await fireEvent.press(screen.getByRole('button', CHANGE));
    expect((await screen.findByLabelText('Email')).props.value).toBe('ava@example.com');
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
  });

  test('a refused burst of emails says to wait, and stays on step one', async () => {
    mockSend.mockResolvedValueOnce('rate_limited');
    await askForCode();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many sign-in emails. Try again in a minute.');
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  test('an email that could not be sent says sign-in did not work', async () => {
    mockSend.mockResolvedValueOnce('error');
    await askForCode();
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in did not work. Try again.');
  });
});
