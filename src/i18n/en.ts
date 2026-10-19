export const en = {
  'app.name': 'RoadWise',
  'signIn.title': 'Sign in',
  'signIn.apple': 'Continue with Apple',
  'signIn.google': 'Continue with Google',
  'signIn.emailLabel': 'Email',
  'signIn.emailSend': 'Email me a code',
  'signIn.codeSent': 'We emailed a 6-digit code to {email}.',
  'signIn.codeResent': 'A new code is on its way.',
  'signIn.codeLabel': '6-digit code',
  'signIn.codeVerify': 'Sign in',
  'signIn.codeResend': 'Send a new code',
  'signIn.codeChange': 'Use a different email',
  'signIn.codeInvalid': "That code didn't work or has expired. Check it, or send a new one.",
  'signIn.errorGeneric': 'Sign-in did not work. Try again.',
  'signIn.offline': 'You are offline. Connect to sign in.',
  'tabs.home': 'Home',
  'tabs.leagues': 'Leagues',
  'tabs.clan': 'Clan',
  'tabs.profile': 'Profile',
  'home.signOut': 'Sign out',
  'summary.pointsEarned': '+{points} points',
  'format.distanceMi': '{value} mi',
  'format.minutes': '{m} min',
  'format.hoursMinutes': '{h} h {m} min',
  'common.retry': 'Try again',
  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.unknown': '—',
  // In-drive voice phrases (§8.8: audio first, ≤ 3 words — the break suggestion is the exception).
  'alert.easeOff': 'Ease off',
  'alert.slowDown': 'Slow down',
  'alert.phoneDown': 'Phone down',
  // The one in-drive phrase over 3 words: the break suggestion is an L1 nudge, never urgent.
  'alert.takeABreak': 'Take a break soon',
  // Spoken at drive start (product spec §8.4) and the dim label on the pocket screen (C4).
  'alert.recording': 'Recording',
  // The DashPal dashcam's alerts when the phone plays them (≤ 4 words; "Wake up" is spoken even
  // with voice off).
  'dashpal.eyesOnRoad': 'Eyes on the road',
  'dashpal.takeABreak': 'Take a break',
  'dashpal.wakeUp': 'Wake up',
  'dashpal.phoneDown': 'Phone down',
  'dashpal.driverNotVisible': 'Driver not visible',
} as const;

export type StringKey = keyof typeof en;
