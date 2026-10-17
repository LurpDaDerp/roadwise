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
      updateApp: 'Update RoadWise',
      unverified: 'Can’t verify DashPal',
    },
    fix: {
      notInRange: 'Your phone connects by itself when the DashPal is on and nearby.',
      bluetoothOff: 'Turn Bluetooth on to hear DashPal alerts on your phone. The DashPal beeps on its own meanwhile.',
      notAllowed: 'Allow Bluetooth for RoadWise in Settings to connect to your DashPal.',
      needsRepair: 'Your DashPal no longer knows this phone (after a firmware update, 10 presses of its button, or when it made room for a fifth phone). Set it up again.',
      downgrade: 'This DashPal’s firmware is older than its pairing. Update its firmware; your phone keeps checking.',
      updateApp: 'This DashPal’s firmware is newer than this version of RoadWise. Update RoadWise; your phone keeps checking.',
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
  },

  /** The setup sheet's words (screen 1 the DashPal and Pair, screen 2 how to aim it, screen 3 the picture). */
  wizard: {
    card: {
      new: { title: (n: string) => `Pair ${n}?`, subtitle: 'A new DashPal is nearby.' },
      again: { title: (n: string) => `Set up ${n} again?`, subtitle: 'It no longer knows this phone.' },
      hint: 'Opens setup',
      notNow: 'Not now',
    },
    cancel: 'Cancel',
    cancelLabel: 'Cancel setup',
    close: 'Close',
    step: (i: number, n: number) => `Step ${i} of ${n}`,
    search: {
      title: 'Looking for your DashPal…',
      body: 'Turn it on. A new DashPal is ready to pair for a few minutes after it starts; otherwise press its button 5 times.',
      chooseTitle: 'Which DashPal is yours?',
      chooseNew: 'New',
      chooseOpen: 'Has phones paired',
    },
    confirm: {
      title: (n: string) => `Pair ${n}?`,
      titleAgain: (n: string) => `Set up ${n} again`,
      body: 'Check that this is the DashPal in your car. Its light flashes quickly while it’s ready to pair.',
      note: 'Next, you’ll see your face from its camera, so you know it’s yours.',
      replaces: (from: string) => `This replaces ${from} on this phone.`,
      pair: 'Pair',
    },
    pressButton: 'Press the DashPal’s button 5 times.',
    waitingBusy: 'Another phone is setting up this DashPal. Waiting…',
    connecting: {
      title: (n: string) => `Connecting to ${n}…`,
      body: 'Other phones can’t pair with it while you set it up.',
      done: 'Connected',
      reconnecting: 'Reconnecting…',
    },
    holdLeft: (s: number) => `Finish setup within ${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`,
    instructions: {
      title: 'Aim DashPal at your face',
      steps: [
        'Put DashPal in front of you, low and near your line of sight, where it can see your whole face and doesn’t block your view of the road.',
        'Tap Start to see what DashPal sees. Turn and move DashPal until the frame around the picture turns blue and shows Good position. Your face doesn’t have to be in the middle.',
        'Then sit in your normal driving position, hands on the wheel and eyes on the road, to confirm the frame stays blue. Tap Next when it does.',
      ],
      privacy: 'The picture goes only to this phone, encrypted. It’s never saved, and it stops when you leave this step. DashPal’s light blinks dash-dot while it sends it.',
      start: 'Start',
      nextSkip: 'Next',
    },
    finishing: 'Finishing…',
    done: {
      title: 'DashPal is ready',
      body: (n: string) => `${n} connects by itself whenever it’s on and nearby.`,
      phones: (k: number) => `${k} phones are paired with this DashPal.`,
      notAllYours: 'Not all yours? Press its button 10 times within 6 seconds; it forgets every phone.',
      aimedElsewhere: 'Your other phone already aimed it.',
      button: 'Done',
    },
    cancelConfirm: {
      title: 'Stop setting up DashPal?',
      before: 'DashPal won’t be paired with this phone.',
      after: 'DashPal will be unpaired from this phone and ready to pair again.',
      stop: 'Stop setup',
      keep: 'Keep setting up',
    },
    failed: {
      not_found: (n: string | null) => `Couldn’t reach ${n ?? 'your DashPal'}. Make sure it’s on and nearby.`,
      none_nearby: 'Couldn’t find a DashPal ready to pair. Make sure it’s on and nearby, then press its button 5 times.',
      window_closed: (n: string | null) => `${n ?? 'Your DashPal'} isn’t ready to pair anymore. Press its button 5 times, then try again.`,
      setup_busy: 'Another phone is setting up this DashPal. Try again in a moment.',
      unverified: 'Couldn’t verify this DashPal.',
      update_firmware: 'Update this DashPal’s firmware, then set it up.',
      update_app: 'Update RoadWise, then set up this DashPal.',
      mtu: 'Your phone’s Bluetooth couldn’t make a secure connection. Turn Bluetooth off and on, then try again.',
      ios_forget_first:
        'Your phone still remembers an older pairing. In Settings › Bluetooth, tap ⓘ next to the DashPal and choose Forget This Device, then try again.',
      lost: (n: string | null) => `Lost the connection to ${n ?? 'your DashPal'}. Try again.`,
      expired: 'Setup took too long. Try again.',
      save_failed: 'DashPal couldn’t save the pairing. Try again.',
      error: 'That didn’t work. Try again.',
      busy: 'Finish your drive first.',
      tryAgain: 'Try again',
      close: 'Close',
    },
  },

  onboarding: {
    title: 'Got a DashPal dashcam?',
    body: 'If you have a DashPal, RoadWise can play its alerts and add its events to your drives. You can always set it up later in Settings.',
    /** What setting it up asks the phone for (Bluetooth scans use location on Android 11 and lower). */
    asks: (platform: 'ios' | 'android', androidApi: number | null): string =>
      platform === 'ios'
        ? 'Setting it up asks for Bluetooth.'
        : (androidApi ?? 31) >= 31
          ? 'Setting it up asks for Nearby devices (Bluetooth).'
          : 'Setting it up uses Location to find it.',
    find: 'Find my DashPal',
    notNow: 'Not now',
    continue: 'Continue',
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
