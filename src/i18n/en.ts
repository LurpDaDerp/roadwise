export const en = {
  'app.name': 'RoadWise',
  'signIn.title': 'Sign in',
  'signIn.apple': 'Continue with Apple',
  'signIn.google': 'Continue with Google',
  'signIn.emailLabel': 'Email',
  'signIn.magicLink': 'Email me a sign-in link',
  'signIn.magicLinkSent': 'Check your email for a sign-in link.',
  'signIn.errorGeneric': 'Sign-in did not work. Try again.',
  'signIn.offline': 'You are offline. Connect to sign in.',
  'auth.signingIn': 'Signing you in…',
  'auth.linkInvalid': 'That link has expired. Ask for a new one.',
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
} as const;

export type StringKey = keyof typeof en;
