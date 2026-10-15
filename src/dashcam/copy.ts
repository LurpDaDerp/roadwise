// DashPal's words (plan §7.9, §7.10). Plain, short, second person; only what the app and the
// dashcam actually do. The product name is DashPal; its Bluetooth name is `DashPal-XXXX`.
import { t } from '@/i18n';

export const dashpalCopy = {
  name: 'DashPal',

  settingsRow: { title: 'DashPal', subtitle: { unpaired: 'Set up your dashcam', paired: (state: string) => state } },

  screen: {
    title: 'DashPal',
    intro:
      'DashPal is a dashcam that watches for drowsiness and eyes off the road. Paired with RoadWise, its alerts play on your phone, its events join your drives, and a drive it watched earns the DashPal bonus.',
    setUp: 'Set up DashPal',
    status: {
      connected: 'Connected',
      monitoring: 'Connected · Monitoring',
      calibrating: 'Connected · Calibrating',
      notInRange: 'Not in range',
      bluetoothOff: 'Bluetooth is off',
      notAllowed: 'Bluetooth not allowed',
      needsRepair: 'Needs pairing again',
    },
    fix: {
      notInRange: 'Your phone connects by itself when the DashPal is on and nearby.',
      bluetoothOff: 'Turn Bluetooth on to hear DashPal alerts on your phone. The DashPal beeps on its own meanwhile.',
      notAllowed: 'Allow Bluetooth for RoadWise in Settings to connect to your DashPal.',
      needsRepair: {
        ios: 'Your DashPal no longer knows this phone. In Settings › Bluetooth, tap ⓘ next to your DashPal and choose Forget This Device, then set it up again here.',
        android: 'Your DashPal no longer knows this phone. Set it up again: hold your phone near it and press its button 5 times.',
      },
      openSettings: 'Open Settings',
      setUpAgain: 'Set up again',
    },
    buzzerToo: { title: 'Also beep on DashPal', subtitle: 'The dashcam beeps too whenever your phone plays one of its alerts.' },
    test: 'Play test sound',
    recalibrate: 'Recalibrate',
    addPhone: 'Add another phone',
    addPhoneDone: 'Pairing is open for 2 minutes, for one phone: set up DashPal on the other phone now.',
    phonesPaired: (n: number) => `Phones paired: ${n}`,
    phonesPairedHelp: 'To remove a phone you don’t know, press the DashPal’s button 10 times within 6 seconds. It forgets every phone; then set up yours again.',
    forget: 'Forget DashPal',
    forgetConfirm: {
      title: 'Forget DashPal?',
      body: 'This phone stops connecting to it, and it stops sending you alerts and events.',
      confirm: 'Forget',
      cancel: 'Cancel',
    },
    forgetIos: 'To finish, in Settings › Bluetooth tap ⓘ next to your DashPal and choose Forget This Device.',
    notConnected: 'Connect to your DashPal first.',
    commandFailed: "That didn't reach your DashPal. Try again.",
  },

  setup: {
    title: 'Set up DashPal',
    busy: 'Finish your drive first.',
    permission: 'RoadWise needs Bluetooth to find your DashPal.',
    denied: 'Bluetooth isn’t allowed for RoadWise. Allow it in Settings, then try again.',
    off: 'Turn Bluetooth on, then try again.',
    unavailable: 'This phone has no Bluetooth LE.',
    scanning: 'Looking for your DashPal…',
    connecting: 'Connecting…',
    identify: 'Is your DashPal beeping and flashing?',
    yes: 'Yes, that’s it',
    no: 'No',
    bonding: { ios: 'Tap Pair when your phone asks.', android: 'Tap Pair when your phone asks to pair with DashPal.' },
    finishing: 'Finishing…',
    noneFound: 'No DashPal found. Hold your phone near the DashPal and press its button 5 times, then try again.',
    tryAgain: 'Try again',
    done: (name: string) => `Connected to ${name}.`,
    donePhones: (n: number) => `${n} phones are paired with this DashPal.`,
    doneUnexpected:
      'This DashPal has more phones paired than expected. If one isn’t yours, press its button 10 times within 6 seconds to forget every phone, then set it up again.',
    doneButton: 'Done',
    failed: 'That didn’t work. Hold your phone near the DashPal and try again.',
    busyElsewhere: 'Another phone is setting up this DashPal. Wait 3 minutes, or press its button 5 times, then try again.',
    iosForgetFirst:
      'Your phone still remembers an older pairing. In Settings › Bluetooth, tap ⓘ next to the DashPal and choose Forget This Device, then try again.',
    cancel: 'Cancel',
  },

  onboarding: {
    title: 'Got a DashPal dashcam?',
    body: 'If you have a DashPal, RoadWise can play its alerts and add its events to your drives. You can always set it up later in Settings.',
    find: 'Find my DashPal',
    notNow: 'Not now',
    continue: 'Continue',
  },

  prompt: {
    found: (name: string) => `${name} is nearby. Connect it to RoadWise?`,
    connect: 'Connect',
    notNow: 'Not now',
  },

  /** The in-app banner for a DashPal alert (HUD and other screens): the spoken words. */
  alert: {
    1: t('dashpal.eyesOnRoad'),
    2: t('dashpal.takeABreak'),
    3: t('dashpal.wakeUp'),
    4: t('dashpal.phoneDown'),
    5: 'DashPal',
  } as Readonly<Record<number, string>>,

  chip: 'DashPal',
} as const;
