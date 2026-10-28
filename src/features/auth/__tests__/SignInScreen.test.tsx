import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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
const mockRegister = jest.fn(
  async (_email: string, _password: string) =>
    'ok' as 'ok' | 'confirm_email' | 'exists' | 'weak_password' | 'rate_limited' | 'error'
);
const mockSignInPassword = jest.fn(
  async (_email: string, _password: string) => 'ok' as 'ok' | 'invalid' | 'unconfirmed' | 'rate_limited' | 'error'
);
const mockVerify = jest.fn(
  async (_email: string, _code: string) => 'ok' as 'ok' | 'wrong_code' | 'rate_limited' | 'offline' | 'error'
);
const mockResend = jest.fn(async (_email: string) => 'sent' as 'sent' | 'rate_limited' | 'offline' | 'error');
const mockKeepPassword = jest.fn(async (_password: string) => {});
const mockClaim = jest.fn(async (_username: string) => true);
const mockRefreshProfile = jest.fn(async () => {});
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
jest.mock('@/features/auth/emailPassword', () => ({
  ...jest.requireActual('@/features/auth/emailPassword'),
  registerWithPassword: (email: string, password: string) => mockRegister(email, password),
  signInWithPassword: (email: string, password: string) => mockSignInPassword(email, password),
  claimChosenUsername: (username: string) => mockClaim(username),
  verifyEmailCode: (email: string, code: string) => mockVerify(email, code),
  resendEmailCode: (email: string) => mockResend(email),
  keepChosenPassword: (password: string) => mockKeepPassword(password),
}));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ refreshProfile: mockRefreshProfile }),
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
  mockRegister.mockReset().mockResolvedValue('ok');
  mockSignInPassword.mockReset().mockResolvedValue('ok');
  mockClaim.mockReset().mockResolvedValue(true);
  mockVerify.mockReset().mockResolvedValue('ok');
  mockResend.mockReset().mockResolvedValue('sent');
  mockKeepPassword.mockReset().mockResolvedValue(undefined);
  mockRefreshProfile.mockReset().mockResolvedValue(undefined);
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
const REGISTER = { name: 'Create account' };

test('shows Apple, Google and email registration, in every build', async () => {
  await mount();
  expect(screen.getByRole('button', APPLE)).toBeTruthy();
  expect(screen.getByRole('button', GOOGLE)).toBeTruthy();
  expect(screen.getByRole('button', REGISTER)).toBeTruthy();
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
  await fireEvent.changeText(screen.getByLabelText('Username'), 'ava_01');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse');
  await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'correct horse');
  for (const name of [APPLE, GOOGLE, REGISTER]) {
    expect(screen.getByRole('button', name)).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', name));
  }
  expect(mockAppleSignIn).not.toHaveBeenCalled();
  expect(mockGoogleSignIn).not.toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();

  await tick();
  for (const name of [APPLE, GOOGLE, REGISTER]) expect(screen.getByRole('button', name)).toBeEnabled();
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
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockAppleSignIn.mockRejectedValueOnce(new Error('no identity token'));
  await mount();
  await tick();
  await fireEvent.press(screen.getByRole('button', APPLE));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("Couldn't sign in. Try again.");
  // The reason goes to the Metro log, where whoever is setting the app up can read it.
  expect(warn).toHaveBeenCalledWith('[sign-in] apple:', expect.any(Error));
  warn.mockRestore();
  expect(alert.props.accessibilityLiveRegion).toBe('polite');
});

test('leaves Google unarmed until its client id is configured', async () => {
  mockWorld.googleReady = false;
  await mount();
  await tick();
  expect(screen.getByRole('button', GOOGLE)).toBeDisabled();
});

describe('creating an account with an email and password', () => {
  const REGISTER = { name: 'Create account' };
  const fill = async (over: Partial<Record<'email' | 'username' | 'password' | 'confirm', string>> = {}) => {
    const v = { email: 'ava@example.com', username: 'ava_01', password: 'correct horse', confirm: 'correct horse', ...over };
    await fireEvent.changeText(screen.getByLabelText('Email'), v.email);
    await fireEvent.changeText(screen.getByLabelText('Username'), v.username);
    await fireEvent.changeText(screen.getByLabelText('Password'), v.password);
    await fireEvent.changeText(screen.getByLabelText('Confirm password'), v.confirm);
  };

  test('registration is the first thing shown: email, username, password and the password again', async () => {
    await mount();
    for (const label of ['Email', 'Username', 'Password', 'Confirm password']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
    expect(screen.getByLabelText('Confirm password').props.secureTextEntry).toBe(true);
    expect(screen.getByRole('button', REGISTER)).toBeTruthy();
  });

  test('Create account stays off until every field is good and the two passwords match', async () => {
    await mount();
    await tick();
    expect(screen.getByRole('button', REGISTER)).toBeDisabled();
    await fill();
    expect(screen.getByRole('button', REGISTER)).toBeEnabled();

    for (const bad of [
      { email: 'ava@example' },
      { username: 'av' },
      { username: 'ava-01' },
      { password: 'short', confirm: 'short' },
      { confirm: 'correct horsE' },
      { confirm: '' },
    ]) {
      await fill(bad);
      expect(screen.getByRole('button', REGISTER)).toBeDisabled();
    }
  });

  test('says when the two passwords differ, and what a username may hold', async () => {
    await mount();
    await fill({ confirm: 'correct horsE', username: 'Av a!' });
    expect(screen.getByText("The passwords don't match.")).toBeOnTheScreen();
    expect(screen.getByLabelText('Username').props.value).toBe('ava!');
    expect(screen.getByText('Only letters, numbers and underscores.')).toBeOnTheScreen();
  });

  test('the username is typed as the server stores it: lower case, no spaces', async () => {
    await mount();
    await fireEvent.changeText(screen.getByLabelText('Username'), 'Ava 01');
    expect(screen.getByLabelText('Username').props.value).toBe('ava01');
  });

  test('registers, then claims the username and reads the profile again', async () => {
    await mount();
    await tick();
    await fill({ email: ' Ava@Example.com ' });
    await fireEvent.press(screen.getByRole('button', REGISTER));
    await waitFor(() => expect(mockRefreshProfile).toHaveBeenCalledTimes(1));
    expect(mockRegister).toHaveBeenCalledWith(' Ava@Example.com ', 'correct horse');
    expect(mockClaim).toHaveBeenCalledWith('ava_01');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a username that could not be claimed leaves it to setup, with no error here', async () => {
    mockClaim.mockResolvedValueOnce(false);
    await mount();
    await tick();
    await fill();
    await fireEvent.press(screen.getByRole('button', REGISTER));
    await waitFor(() => expect(mockClaim).toHaveBeenCalled());
    expect(mockRefreshProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    ['exists', 'That email already has an account. Sign in instead.'],
    ['weak_password', 'That password is too weak. Use at least 8 characters.'],
    ['rate_limited', 'Too many tries. Try again in a minute.'],
    ['error', "Couldn't sign in. Try again."],
  ] as const)('a refused registration (%s) says so in place and claims nothing', async (result, words) => {
    mockRegister.mockResolvedValueOnce(result);
    await mount();
    await tick();
    await fill();
    await fireEvent.press(screen.getByRole('button', REGISTER));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe('signing in with an email and password', () => {
  const SIGN_IN = { name: 'Sign in with email' };
  const toSignIn = async () => {
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', { name: 'Have an account? Sign in' }));
  };

  test('shows only email and password, and no username or second password', async () => {
    await toSignIn();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
    expect(screen.getByRole('button', { name: 'New here? Create an account' })).toBeTruthy();
  });

  test('signs in with the address and password, and shows no error', async () => {
    await toSignIn();
    expect(screen.getByRole('button', SIGN_IN)).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
    await waitFor(() => expect(mockSignInPassword).toHaveBeenCalledWith('ava@example.com', 'correct horse'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test.each([
    ['invalid', "That email and password don't match. Check them and try again."],
    ['rate_limited', 'Too many tries. Try again in a minute.'],
    ['error', "Couldn't sign in. Try again."],
  ] as const)('a refused sign-in (%s) says so in place', async (result, words) => {
    mockSignInPassword.mockResolvedValueOnce(result);
    await toSignIn();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
  });

  test('switching back and forth keeps the email and drops the passwords', async () => {
    await toSignIn();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'secret-pass');
    await fireEvent.press(screen.getByRole('button', { name: 'New here? Create an account' }));
    expect(screen.getByLabelText('Email').props.value).toBe('ava@example.com');
    expect(screen.getByLabelText('Password').props.value).toBe('');
    expect(screen.getByLabelText('Confirm password')).toBeTruthy();
  });
});

describe('confirming the address with the mailed code', () => {
  const REGISTER = { name: 'Create account' };
  const SIGN_IN = { name: 'Sign in with email' };
  const register = async () => {
    mockRegister.mockResolvedValueOnce('confirm_email');
    await mount();
    await tick();
    await fireEvent.changeText(screen.getByLabelText('Email'), ' Ava@Example.com ');
    await fireEvent.changeText(screen.getByLabelText('Username'), 'ava_01');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse');
    await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'correct horse');
    await fireEvent.press(screen.getByRole('button', REGISTER));
    await screen.findByText('Check your email');
  };
  const typeCode = (code: string) => fireEvent.changeText(screen.getByLabelText('6-digit code'), code);

  test('a sign-up goes to the code screen, naming the address, with nothing claimed yet', async () => {
    await register();
    expect(screen.getByText('We sent a 6-digit code to Ava@Example.com.')).toBeOnTheScreen();
    expect(screen.getByLabelText('6-digit code').props.textContentType).toBe('oneTimeCode');
    expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockResend).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the right code signs in, then the username from the form is claimed and the profile read again', async () => {
    await register();
    await typeCode('123456');
    await waitFor(() => expect(mockKeepPassword).toHaveBeenCalledTimes(1));
    expect(mockVerify).toHaveBeenCalledWith('Ava@Example.com', '123456');
    expect(mockClaim).toHaveBeenCalledWith('ava_01');
    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    // The password chosen on the form replaces any left by an earlier, never-confirmed sign-up.
    expect(mockKeepPassword).toHaveBeenCalledWith('correct horse');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a wrong code claims nothing and says so in place', async () => {
    mockVerify.mockResolvedValueOnce('wrong_code');
    await register();
    await typeCode('000000');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code is wrong or has expired. Check it, or send a new one.'
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockKeepPassword).not.toHaveBeenCalled();
  });

  test('Resend code sends a fresh code to the same address', async () => {
    jest.useFakeTimers();
    try {
      await register();
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      await fireEvent.press(screen.getByRole('button', { name: 'Resend code' }));
      expect(mockResend).toHaveBeenCalledWith('Ava@Example.com');
      expect(await screen.findByText('We sent a new code.')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  test('"Use a different email" goes back to the form with everything typed there kept', async () => {
    await register();
    await fireEvent.press(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText('Email').props.value).toBe(' Ava@Example.com ');
    expect(screen.getByLabelText('Username').props.value).toBe('ava_01');
    expect(screen.getByLabelText('Password').props.value).toBe('correct horse');
    expect(screen.getByLabelText('Confirm password').props.value).toBe('correct horse');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', REGISTER)).toBeEnabled();
  });

  const signInUnconfirmed = async () => {
    mockSignInPassword.mockResolvedValueOnce('unconfirmed');
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', { name: 'Have an account? Sign in' }));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'correct horse');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
  };

  test('signing in to an address never confirmed sends a fresh code and goes to the code screen', async () => {
    await signInUnconfirmed();
    expect(await screen.findByText('Check your email')).toBeOnTheScreen();
    expect(mockResend).toHaveBeenCalledWith('ava@example.com');
    expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();

    await typeCode('123456');
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('ava@example.com', '123456'));
    // Nothing was chosen on a form: no username to claim, no password to set.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockKeepPassword).not.toHaveBeenCalled();
  });

  test('a code sent within the minute still counts: the code screen waits out the rest', async () => {
    mockResend.mockResolvedValueOnce('rate_limited');
    await signInUnconfirmed();
    expect(await screen.findByText('Check your email')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a fresh code that could not be sent shows why, with Resend code ready', async () => {
    mockResend.mockResolvedValueOnce('offline');
    await signInUnconfirmed();
    expect(await screen.findByRole('alert')).toHaveTextContent("You're offline. Check your connection and try again.");
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  });

  test('back from the code screen reached by sign-in is the sign-in form', async () => {
    await signInUnconfirmed();
    await fireEvent.press(await screen.findByRole('button', { name: 'Use a different email' }));
    expect(screen.getByRole('button', SIGN_IN)).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.getByLabelText('Email').props.value).toBe('ava@example.com');
  });
});
