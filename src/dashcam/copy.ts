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
      downgrade: 'Update DashPal',
      unverified: 'Can’t verify DashPal',
    },
    fix: {
      notInRange: 'Your phone connects by itself when the DashPal is on and nearby.',
      bluetoothOff: 'Turn Bluetooth on to hear DashPal alerts on your phone. The DashPal beeps on its own meanwhile.',
      notAllowed: 'Allow Bluetooth for RoadWise in Settings to connect to your DashPal.',
      needsRepair: 'Your DashPal no longer knows this phone (after a firmware update, 10 presses of its button, or when it made room for a fifth phone). Set it up again.',
      downgrade: 'This DashPal’s firmware is older than its pairing. Update its firmware; your phone keeps checking.',
      unverified: 'Something nearby answers as your DashPal but can’t prove it. Your phone keeps trying; if this lasts, set it up again.',
      openSettings: 'Open Settings',
      setUpAgain: 'Set up again',
    },
    buzzerToo: { title: 'Also beep on DashPal', subtitle: 'The dashcam beeps too whenever your phone plays one of its alerts.' },
    test: 'Play test sound',
    recalibrate: 'Recalibrate',
    addPhone: 'Add another phone',
    addPhoneSheet: {
      title: 'Add another phone',
      body: 'On the other phone, open RoadWise › Settings › DashPal › Set up DashPal.',
      left: (time: string) => `Pairing is open for ${time}`,
      ended: 'Pairing has closed. Open it again to add a phone.',
      done: 'Done',
    },
    addPhoneNeedsLink: 'Connect to your DashPal first.',
    newPhone: 'A new phone was paired with your DashPal. Not yours? Press its button 10 times within 6 seconds; it forgets every phone.',
    newPhoneOk: 'OK',
    phonesPaired: (n: number) => `Phones paired: ${n}`,
    phonesPairedHelp: 'To remove a phone you don’t know, press the DashPal’s button 10 times within 6 seconds. It forgets every phone; then set up yours again.',
    forget: 'Forget DashPal',
    forgetConfirm: {
      title: 'Forget DashPal?',
      body: 'This phone stops connecting to it, and it stops sending you alerts and events.',
      confirm: 'Forget',
      cancel: 'Cancel',
    },
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
    scan: 'Scan the code on your DashPal',
    scanHelp: 'The QR code is under the DashPal’s mount and on the card in its box.',
    typeInstead: 'Type the code instead',
    scanInstead: 'Scan the code instead',
    codeLabel: 'Pairing code',
    codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
    nameLabel: 'Name on the label (optional): DashPal-',
    submit: 'Pair',
    cameraDenied: 'Allow the camera in Settings to scan, or type the code.',
    allowCamera: 'Allow the camera',
    notACode: 'That’s not a DashPal code.',
    badCode: 'Check the code: it doesn’t look right.',
    pairTitle: (name: string) => `Set up ${name}`,
    pair: 'Pair',
    searching: (name: string | null) => (name ? `Looking for ${name}…` : 'Looking for your DashPal…'),
    connecting: (name: string) => `Connecting to ${name}…`,
    again: (name: string) => `Setting up ${name} again…`,
    pairing: 'Pairing…',
    pressButton: 'Press the DashPal’s button 5 times.',
    windowTimeout: 'Pairing mode didn’t open. Press the DashPal’s button 5 times, then try again.',
    waitingBusy: 'Another phone is setting up this DashPal. Waiting…',
    busyElsewhere: 'Another phone is setting up this DashPal. Try again in a moment.',
    notFound: (name: string | null) => `Couldn’t find ${name ?? 'your DashPal'}. Make sure it’s on and nearby.`,
    notFoundTwoPhones: 'If two phones are connected to it, turn Bluetooth off on one.',
    wrongCode: 'That code doesn’t match this DashPal. Check that the label is from this DashPal.',
    noMatch: 'That code doesn’t match any DashPal nearby.',
    unverified: 'Couldn’t verify this DashPal.',
    unverifiedNearby: 'Couldn’t verify a DashPal nearby.',
    replaceTitle: (from: string, to: string) => `Replace ${from} with ${to}?`,
    replaceBody: (from: string) => `Your phone stops connecting to ${from}.`,
    replace: 'Replace',
    notAllYours: 'Not all yours? Press its button 10 times within 6 seconds; it forgets every phone.',
    noStoredCode: 'Scan the label under your DashPal, or use Add another phone on a phone that’s paired.',
    noKey: 'This DashPal has no pairing code yet. Connect it to a computer and run its setup step (see Help).',
    updateFirmware: 'Update this DashPal’s firmware, then set it up.',
    mtu: 'Your phone’s Bluetooth couldn’t make a secure connection. Turn Bluetooth off and on, then try again.',
    lostPhone: 'Lost a phone? Press the DashPal’s button 10 times first; it forgets every phone.',
    tryAgain: 'Try again',
    done: (name: string) => `Connected to ${name}.`,
    donePhones: (n: number) => `${n} phones are paired with this DashPal.`,
    doneButton: 'Done',
    failed: 'That didn’t work. Try again.',
    iosForgetFirst:
      'Your phone still remembers an older pairing. In Settings › Bluetooth, tap ⓘ next to the DashPal and choose Forget This Device, then try again.',
    cancel: 'Cancel',
  },

  onboarding: {
    title: 'Got a DashPal dashcam?',
    body: 'If you have a DashPal, RoadWise can play its alerts and add its events to your drives. You can always set it up later in Settings.',
    /** What setting it up asks the phone for (the camera scans its code; Bluetooth scans use location on Android 11 and lower). */
    asks: (platform: 'ios' | 'android', androidApi: number | null): string =>
      platform === 'ios'
        ? 'Setting it up asks for the camera, to scan its code, and Bluetooth.'
        : (androidApi ?? 31) >= 31
          ? 'Setting it up asks for the camera, to scan its code, and Nearby devices (Bluetooth).'
          : 'Setting it up asks for the camera, to scan its code, and uses Location to find it.',
    find: 'Find my DashPal',
    /** A link's code is held (the driver opened the label link before signing in). */
    setUpHeld: (name: string) => `Set up ${name}`,
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
    6: t('dashpal.driverNotVisible'),
  } as Readonly<Record<number, string>>,

  chip: 'DashPal',
} as const;
