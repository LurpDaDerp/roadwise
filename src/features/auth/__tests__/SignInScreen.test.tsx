import { Ionicons } from '@expo/vector-icons';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import type { Db } from '@/data/db/driver';
import { DataProvider } from '@/data/queries/context';
import { PENDING_TERMS_KEY } from '@/features/auth/pendingConsent';
import { SignInScreen, signInCopy } from '@/features/auth/SignInScreen';
import { ThemeProvider } from '@/ui/theme';

// Everything below is read from inside a mock factory, so each name is `mock`-prefixed and every
// reference sits in a function body that only runs once the module has finished evaluating.
const mockAppleSignIn = jest.fn(async () => {});
const mockGoogleSignIn = jest.fn(async () => {});
// `session`: what the session provider holds (a sign-in that worked makes one).
const mockWorld: { googleReady: boolean; session: unknown } = { googleReady: true, session: null };
const mockMarkTermsAccepted = jest.fn(async (..._args: unknown[]) => {});
const mockRegister = jest.fn(
  async (_email: string, _password: string) =>
    'ok' as 'ok' | 'confirm_email' | 'exists' | 'weak_password' | 'invalid_email' | 'rate_limited' | 'offline' | 'error'
);
const mockSignInPassword = jest.fn(
  async (_email: string, _password: string) =>
    'ok' as 'ok' | 'invalid' | 'unconfirmed' | 'rate_limited' | 'offline' | 'error'
);
type Verified = 'ok' | 'wrong_code' | 'rate_limited' | 'offline' | 'unfinished' | 'error';
// One address's confirmation (startEmailConfirmation): what it was started with, and its three calls.
const mockStartConfirmation = jest.fn((_email: string, _password: string | null, _kind?: string) => {});
const mockVerify = jest.fn(async (_code: string) => 'ok' as Verified);
const mockFinish = jest.fn(async () => 'ok' as Verified);
const mockAbandon = jest.fn(async () => {});
const mockResend = jest.fn(async (_email: string) => 'sent' as 'sent' | 'too_soon' | 'rate_limited' | 'offline' | 'error');
const mockRequestReset = jest.fn(async (_email: string) => 'sent' as 'sent' | 'too_soon' | 'rate_limited' | 'offline' | 'error');

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
  resendEmailCode: (email: string) => mockResend(email),
  requestPasswordReset: (email: string) => mockRequestReset(email),
  startEmailConfirmation: (email: string, password: string | null, kind?: string) => {
    mockStartConfirmation(email, password, kind);
    return { verify: mockVerify, finish: mockFinish, abandon: mockAbandon };
  },
}));
// The consent helpers import the app client; nothing here reaches the network.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: mockWorld.session }) }));
jest.mock('@/features/auth/asideAuth', () => ({ createAsideAuth: jest.fn() }));
jest.mock('@/features/auth/pendingConsent', () => ({
  ...jest.requireActual('@/features/auth/pendingConsent'),
  markTermsAccepted: (...args: unknown[]) => mockMarkTermsAccepted(...args),
}));

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
  mockWorld.session = null;
  mockAppleSignIn.mockReset().mockResolvedValue(undefined);
  mockGoogleSignIn.mockReset().mockResolvedValue(undefined);
  mockMarkTermsAccepted.mockReset().mockResolvedValue(undefined);
  mockRegister.mockReset().mockResolvedValue('ok');
  mockSignInPassword.mockReset().mockResolvedValue('ok');
  mockStartConfirmation.mockReset();
  mockVerify.mockReset().mockResolvedValue('ok');
  mockFinish.mockReset().mockResolvedValue('ok');
  mockAbandon.mockReset().mockResolvedValue(undefined);
  mockResend.mockReset().mockResolvedValue('sent');
  mockRequestReset.mockReset().mockResolvedValue('sent');
  executed.length = 0;
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
});

/** What the screen asked VoiceOver to read out (the tests run as an iPhone), in order. */
const spoken = () => jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([text]) => text);

const tree = () => (
  <ThemeProvider>
    <DataProvider db={fakeDb}>
      <SignInScreen />
    </DataProvider>
  </ThemeProvider>
);
const mount = () => render(tree());

/** Fills the Create account form (the default), with good values unless told otherwise. */
const fill = async (over: Partial<Record<'email' | 'password' | 'confirm', string>> = {}) => {
  const v = { email: 'ava@example.com', password: PASSWORD, confirm: PASSWORD, ...over };
  await fireEvent.changeText(screen.getByLabelText('Email'), v.email);
  await fireEvent.changeText(screen.getByLabelText('Password'), v.password);
  await fireEvent.changeText(screen.getByLabelText('Confirm password'), v.confirm);
};

const tick = async () => {
  await fireEvent.press(screen.getByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
};

const APPLE = { name: 'Continue with Apple' };
const GOOGLE = { name: 'Continue with Google' };
const REGISTER = { name: 'Create account' };
const SIGN_IN = { name: 'Sign in with email' };
const FORGOT = { name: 'Forgot password?' };
const PASSWORD = 'correct horse 1';

test('shows Apple, Google and email registration, in every build', async () => {
  await mount();
  expect(screen.getByRole('button', APPLE)).toBeTruthy();
  expect(screen.getByRole('button', GOOGLE)).toBeTruthy();
  expect(screen.getByLabelText('Email')).toBeTruthy();
  expect(screen.getByLabelText('Password')).toBeTruthy();
  expect(screen.getByRole('button', REGISTER)).toBeTruthy();
});

// Apple's HIG: a custom Sign in with Apple button shows the Apple logo (App Review 4.0).
test('the Apple button carries the Apple logo; Google has none', async () => {
  await mount();
  const logo = String.fromCodePoint(Number(Ionicons.glyphMap['logo-apple']));
  expect(within(screen.getByRole('button', APPLE)).getByText(logo)).toBeOnTheScreen();
  expect(within(screen.getByRole('button', GOOGLE)).queryByText(logo)).toBeNull();
});

test('nothing on the screen asks for an age or a birth date', async () => {
  await mount();
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/birth|date of birth|how old/i);
});

test('the 13+ checkbox: its words, a 44 pt target, and links to both documents', async () => {
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
  await fill();
  expect(screen.getByRole('button', REGISTER)).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', REGISTER));
  expect(mockRegister).not.toHaveBeenCalled();
  for (const name of [APPLE, GOOGLE]) {
    expect(screen.getByRole('button', name)).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', name));
  }
  expect(mockAppleSignIn).not.toHaveBeenCalled();
  expect(mockGoogleSignIn).not.toHaveBeenCalled();

  await tick();
  for (const name of [APPLE, GOOGLE, REGISTER]) expect(screen.getByRole('button', name)).toBeEnabled();
  expect(mockMarkTermsAccepted).toHaveBeenCalledTimes(1);
});

test('unticked, Forgot password is off too', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'Have an account? Sign in' }));
  expect(screen.getByRole('button', FORGOT)).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', FORGOT));
  expect(screen.queryByText('Reset your password')).toBeNull();
  await tick();
  expect(screen.getByRole('button', FORGOT)).toBeEnabled();
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

test('answers a rejected sign-in in place, and reads it out once, queued behind what VoiceOver is saying', async () => {
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
  expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledTimes(1);
  expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith("Couldn't sign in. Try again.", { queue: true });
  // Read out once on Android too: from the announcement, with no live region to say it again.
  expect(alert.props.accessibilityLiveRegion).toBeUndefined();
});

test('Android: a rejected sign-in is read out to TalkBack once', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'android');
  try {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGoogleSignIn.mockRejectedValueOnce(new Error('no id token'));
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', GOOGLE));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign in. Try again.");
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith("Couldn't sign in. Try again.");
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).not.toHaveBeenCalled();
  } finally {
    os.restore();
    jest.mocked(console.warn).mockRestore();
  }
});

describe('after a sign-in that made a session, until the screen leaves (the profile read, up to 10 s)', () => {
  const signedIn = { user: { id: 'u1' } };
  const busy = (name: { name: string }) => screen.getByRole('button', name).props.accessibilityState?.busy;

  test.each([
    ['Apple', APPLE, () => mockAppleSignIn],
    ['Google', GOOGLE, () => mockGoogleSignIn],
  ] as const)('%s: its spinner stays and every other way in stays off; a second tap starts nothing', async (_label, button, mock) => {
    mock().mockImplementation(async () => {
      mockWorld.session = signedIn;
    });
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', button));
    await waitFor(() => expect(mock()).toHaveBeenCalledTimes(1));
    expect(busy(button)).toBe(true);
    for (const name of [APPLE, GOOGLE, REGISTER]) expect(screen.getByRole('button', name)).toBeDisabled();
    expect(screen.getByLabelText('Email').props.editable).toBe(false);
    await fireEvent.press(screen.getByRole('button', APPLE));
    await fireEvent.press(screen.getByRole('button', GOOGLE));
    expect(mockAppleSignIn.mock.calls.length + mockGoogleSignIn.mock.calls.length).toBe(1);
  });

  test('an email sign-in that worked holds the same way', async () => {
    mockSignInPassword.mockImplementation(async () => {
      mockWorld.session = signedIn;
      return 'ok';
    });
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', { name: 'Have an account? Sign in' }));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'x');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
    await waitFor(() => expect(mockSignInPassword).toHaveBeenCalledTimes(1));
    expect(busy(SIGN_IN)).toBe(true);
    expect(screen.getByRole('button', APPLE)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New here? Create an account' })).toBeDisabled();
  });

  test('backing out of a sheet (no session) leaves the screen as it was: everything armed again', async () => {
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', APPLE));
    await waitFor(() => expect(mockAppleSignIn).toHaveBeenCalledTimes(1));
    expect(busy(APPLE)).toBe(false);
    for (const name of [APPLE, GOOGLE]) expect(screen.getByRole('button', name)).toBeEnabled();
  });

  test('a sign-in that fails re-arms the screen and says so, whatever session the app holds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGoogleSignIn.mockRejectedValueOnce(new Error('no identity token'));
    mockWorld.session = signedIn;
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', GOOGLE));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign in. Try again.");
    expect(busy(GOOGLE)).toBe(false);
    expect(screen.getByRole('button', APPLE)).toBeEnabled();
    warn.mockRestore();
  });
});

test('leaves Google unarmed until its client id is configured', async () => {
  mockWorld.googleReady = false;
  await mount();
  await tick();
  expect(screen.getByRole('button', GOOGLE)).toBeDisabled();
});

describe('creating an account with an email and password', () => {
  test('registration is the first thing shown: email, password and the password again, no username', async () => {
    await mount();
    for (const label of ['Email', 'Password', 'Confirm password']) expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
    expect(screen.getByLabelText('Confirm password').props.secureTextEntry).toBe(true);
    expect(screen.getByLabelText('Password').props.textContentType).toBe('newPassword');
    expect(screen.getByLabelText('Password').props.autoComplete).toBe('new-password');
    expect(screen.getByLabelText('Email').props.keyboardType).toBe('email-address');
    expect(screen.getByText('At least 8 characters, with a letter and a number.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', FORGOT)).toBeNull();
  });

  test('Create account stays off until the address looks right, the password meets the rules and the two match', async () => {
    await mount();
    await tick();
    expect(screen.getByRole('button', REGISTER)).toBeDisabled();
    await fill();
    expect(screen.getByRole('button', REGISTER)).toBeEnabled();

    for (const bad of [
      { email: 'ava@example' },
      { email: '' },
      { password: 'short1', confirm: 'short1' },
      { password: 'nodigitshere', confirm: 'nodigitshere' },
      { password: '123456789', confirm: '123456789' },
      { confirm: 'correct horse 2' },
      { confirm: '' },
    ]) {
      await fill(bad);
      expect(screen.getByRole('button', REGISTER)).toBeDisabled();
    }
  });

  test('a password too easy to guess, or holding the email\'s name, keeps Create account off and says why', async () => {
    await mount();
    await tick();
    await fill({ password: 'Password123', confirm: 'Password123' });
    expect(screen.getByRole('button', REGISTER)).toBeDisabled();
    expect(screen.getByText("That password is too easy to guess. Avoid common words, keyboard runs, and your email's name.")).toBeOnTheScreen();
    await fill({ email: 'zelda.quinn@example.com', password: 'zeldaquinn7', confirm: 'zeldaquinn7' });
    expect(screen.getByRole('button', REGISTER)).toBeDisabled();
  });

  test('says when the two passwords differ, and when the password breaks the rules', async () => {
    await mount();
    await fill({ confirm: 'correct horse 2' });
    expect(screen.getByText("The passwords don't match.")).toBeOnTheScreen();
    await fill({ password: 'abcdefgh', confirm: 'abcdefgh' });
    expect(screen.getByText('At least 8 characters, with a letter and a number.')).toBeOnTheScreen();
    await fill({ password: 'a1' + 'x'.repeat(71), confirm: 'a1' + 'x'.repeat(71) });
    expect(screen.getByText('That password is too long. Use 72 characters or fewer.')).toBeOnTheScreen();
  });

  test('registers with the address and password as typed, and an answer with a session needs nothing more', async () => {
    await mount();
    await tick();
    await fill({ email: ' Ava@Example.com ' });
    await fireEvent.press(screen.getByRole('button', REGISTER));
    await waitFor(() => expect(mockRegister).toHaveBeenCalledWith(' Ava@Example.com ', PASSWORD));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockStartConfirmation).not.toHaveBeenCalled();
  });

  test.each([
    ['exists', 'That email already has an account. Sign in instead, or use Apple or Google if you signed up with one.'],
    ['weak_password', 'That password is too weak. Use at least 8 characters, with a letter and a number.'],
    ['invalid_email', "That email doesn't look right. Check it and try again."],
    ['rate_limited', 'Too many tries. Try again later.'],
    ['offline', "You're offline. Connect to sign in."],
    ['error', "Couldn't sign in. Try again."],
  ] as const)('a refused registration (%s) says so in place', async (result, words) => {
    mockRegister.mockResolvedValueOnce(result);
    await mount();
    await tick();
    await fill();
    await fireEvent.press(screen.getByRole('button', REGISTER));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(mockStartConfirmation).not.toHaveBeenCalled();
  });

});

describe('signing in with an email and password', () => {
  const toSignIn = async () => {
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', { name: 'Have an account? Sign in' }));
  };

  test('shows only email and password, with Forgot password', async () => {
    await toSignIn();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByLabelText('Password').props.textContentType).toBe('password');
    expect(screen.getByLabelText('Password').props.autoComplete).toBe('current-password');
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
    expect(screen.getByRole('button', { name: 'New here? Create an account' })).toBeTruthy();
    expect(screen.getByRole('button', FORGOT)).toBeEnabled();
  });

  test('signs in with the address and password, any password the account has, and shows no error', async () => {
    await toSignIn();
    expect(screen.getByRole('button', SIGN_IN)).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'x');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
    await waitFor(() => expect(mockSignInPassword).toHaveBeenCalledWith('ava@example.com', 'x'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    ['invalid', "That email and password don't match. Check them and try again."],
    ['rate_limited', 'Too many tries. Try again later.'],
    ['offline', "You're offline. Connect to sign in."],
    ['error', "Couldn't sign in. Try again."],
  ] as const)('a refused sign-in (%s) says so in place', async (result, words) => {
    mockSignInPassword.mockResolvedValueOnce(result);
    await toSignIn();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
  });

  test('a wrong password is read out as its line appears, and again when a second try fails the same way', async () => {
    const words = "That email and password don't match. Check them and try again.";
    let answer: (result: 'invalid') => void = () => {};
    mockSignInPassword
      .mockResolvedValueOnce('invalid')
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await toSignIn();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(spoken()).toEqual([words]);
    // The second try clears the line while it runs, so the same words coming back are a new line.
    await act(async () => {
      void fireEvent.press(screen.getByRole('button', SIGN_IN));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => answer('invalid'));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(spoken()).toEqual([words, words]);
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

  test('Forgot password opens the reset screen with the email typed so far, and back returns here', async () => {
    await toSignIn();
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong');
    await fireEvent.press(screen.getByRole('button', FORGOT));
    expect(screen.getByRole('header')).toHaveTextContent('Reset your password');
    expect(screen.getByLabelText('Email').props.value).toBe('ava@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('button', SIGN_IN)).toBeTruthy();
    expect(screen.getByLabelText('Email').props.value).toBe('ava@example.com');
    expect(screen.getByLabelText('Password').props.value).toBe('');
  });
});

describe('confirming the address with the mailed code', () => {
  const register = async () => {
    mockRegister.mockResolvedValueOnce('confirm_email');
    await mount();
    await tick();
    await fill({ email: ' Ava@Example.com ' });
    await fireEvent.press(screen.getByRole('button', REGISTER));
    await screen.findByText('Check your email');
  };
  const typeCode = (code: string) => fireEvent.changeText(screen.getByLabelText('8-digit code'), code);

  test('a sign-up goes to the code screen, naming the address', async () => {
    await register();
    expect(screen.getByText('RoadWise sent an 8-digit code to Ava@Example.com.')).toBeOnTheScreen();
    expect(screen.getByLabelText('8-digit code').props.textContentType).toBe('oneTimeCode');
    expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(mockResend).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the confirmation carries the password chosen on the form; the right code is checked', async () => {
    await register();
    expect(mockStartConfirmation).toHaveBeenCalledWith(' Ava@Example.com ', PASSWORD, undefined);
    await typeCode('12345678');
    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('12345678'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a wrong code says so in place', async () => {
    mockVerify.mockResolvedValueOnce('wrong_code');
    await register();
    await typeCode('00000000');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code is wrong or has expired. Check it, or send a new one.'
    );
  });

  test('a right code whose account could not be finished: Try again finishes', async () => {
    mockVerify.mockResolvedValueOnce('unfinished');
    await register();
    await typeCode('12345678');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't finish signing you in. Check your connection and try again."
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockFinish).toHaveBeenCalledTimes(1));
  });

  test('leaving the code screen gives the confirmation up', async () => {
    await register();
    expect(mockAbandon).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Use a different email' }));
    expect(mockAbandon).toHaveBeenCalledTimes(1);
  });

  test('the screen going any other way (a route change) gives the confirmation up too', async () => {
    mockVerify.mockResolvedValueOnce('unfinished');
    await register();
    await typeCode('12345678');
    await screen.findByRole('button', { name: 'Try again' });
    expect(mockAbandon).not.toHaveBeenCalled();
    await screen.unmount();
    expect(mockAbandon).toHaveBeenCalledTimes(1);
  });

  test('"Use a different email" goes back to the form with everything typed there kept', async () => {
    await register();
    await fireEvent.press(screen.getByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText('Email').props.value).toBe(' Ava@Example.com ');
    expect(screen.getByLabelText('Password').props.value).toBe(PASSWORD);
    expect(screen.getByLabelText('Confirm password').props.value).toBe(PASSWORD);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', REGISTER)).toBeEnabled();
  });

  const signInUnconfirmed = async () => {
    mockSignInPassword.mockResolvedValueOnce('unconfirmed');
    await mount();
    await tick();
    await fireEvent.press(screen.getByRole('button', { name: 'Have an account? Sign in' }));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), PASSWORD);
    await fireEvent.press(screen.getByRole('button', SIGN_IN));
  };

  test('signing in to an address never confirmed sends a fresh code and goes to the code screen', async () => {
    await signInUnconfirmed();
    expect(await screen.findByText('Check your email')).toBeOnTheScreen();
    expect(mockResend).toHaveBeenCalledWith('ava@example.com');
    expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    // The server clears the password at confirmation, so the one just typed is set again.
    expect(mockStartConfirmation).toHaveBeenCalledWith('ava@example.com', PASSWORD, undefined);
  });

  test('a code sent within the minute still counts: the code screen waits out the rest', async () => {
    mockResend.mockResolvedValueOnce('too_soon');
    await signInUnconfirmed();
    expect(await screen.findByText('Check your email')).toBeOnTheScreen();
    expect(screen.getByText('RoadWise sent an 8-digit code to ava@example.com.')).toBeOnTheScreen();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('any other refusal for too many (the per-address cap) sent nothing: the screen says so and never "We sent"', async () => {
    mockResend.mockResolvedValueOnce('rate_limited');
    await signInUnconfirmed();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries. Try again later.');
    expect(screen.queryByText(/We sent/)).toBeNull();
    expect(screen.getByText('Confirm ava@example.com with an 8-digit code.')).toBeOnTheScreen();
  });

  test('back from the code screen reached by sign-in is the sign-in form', async () => {
    await signInUnconfirmed();
    await fireEvent.press(await screen.findByRole('button', { name: 'Use a different email' }));
    expect(screen.getByRole('button', SIGN_IN)).toBeTruthy();
    expect(screen.getByLabelText('Email').props.value).toBe('ava@example.com');
  });
});
