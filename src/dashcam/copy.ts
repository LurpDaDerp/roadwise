// DashPal's words (plan §7.9, §7.10). Plain, short, second person; only what the app and the
// dashcam actually do. The product name is DashPal; its Bluetooth name is `DashPal-XXXX`.
import { t } from '@/i18n';

export const dashpalCopy = {
  name: 'DashPal',

  settingsRow: { title: 'DashPal', subtitle: { unpaired: 'Set up your dashcam', paired: (state: string) => state } },

  screen: {
    title: 'DashPal',
    intro:
      'DashPal is a dashcam that watches for drowsiness and eyes off the road. Once paired, its alerts play on your phone and its events count in your drives, with a bonus for drives it watches.',
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
      bluetoothOff: 'Turn Bluetooth on to hear DashPal alerts on your phone. Until then, DashPal beeps on its own.',
      notAllowed: 'Allow Bluetooth for RoadWise in Settings to connect to your DashPal.',
      needsRepair: 'Your DashPal doesn’t know this phone anymore. Set it up again.',
      downgrade: 'This DashPal needs a firmware update. Your phone reconnects once it’s updated.',
      updateApp: 'This DashPal needs a newer RoadWise. Update the app and your phone reconnects.',
      unverified: 'Your phone can’t confirm this is your DashPal. It keeps trying. If this lasts, set it up again.',
      openSettings: 'Open Settings',
      setUpAgain: 'Set up again',
    },
    buzzerToo: { title: 'Also beep on DashPal', subtitle: 'DashPal beeps along with its alerts on your phone.' },
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
    newPhone: 'A new phone paired with your DashPal. Not yours? Press its button 10 times in 6 seconds to clear all phones.',
    newPhoneOk: 'OK',
    phonesPaired: (n: number) => `Phones paired: ${n}`,
    phonesPairedHelp: 'See a phone you don’t know? Press DashPal’s button 10 times in 6 seconds to clear all phones, then set yours up again.',
    forget: 'Forget DashPal',
    forgetConfirm: {
      title: 'Forget DashPal?',
      body: 'This phone won’t connect to it or get its alerts and events.',
      confirm: 'Forget',
      cancel: 'Cancel',
    },
    notConnected: 'Connect to your DashPal first.',
    commandFailed: "That didn't reach your DashPal. Try again.",
  },

  setup: {
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
      body: 'Turn it on. If it doesn’t show up, press its button 5 times.',
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
        'Put DashPal low in front of you, where it sees your whole face without blocking the road.',
        'Tap Start to see what DashPal sees. Move it until the frame turns blue and says Good position. Your face doesn’t need to be centered.',
        'Sit in your normal driving position, hands on the wheel and eyes on the road. If the frame stays blue, tap Next.',
      ],
      privacy: 'The picture is encrypted and goes only to this phone. It’s never saved and stops when you leave this step. DashPal’s light blinks dash-dot while it sends.',
      start: 'Start',
      nextSkip: 'Next',
      aimedElsewhere: 'Your other phone already aimed DashPal.',
    },
    aim: {
      title: 'Aim DashPal',
      starting: 'Starting the camera…',
      stalled: 'The picture stopped. Hold on…',
      waiting: 'Waiting for the picture…',
      good: 'Good position',
      /** By the hint DashPal sends; 2 and 3 are the picture's sides as the phone shows it (a mirror), see `aim.ts`. */
      hint: {
        0: 'Good position. Sit as you drive, look at the road, then tap Next.',
        1: 'Can’t see your face. Point DashPal at your face.',
        2: 'Your face is near the left edge. Turn DashPal to center it.',
        3: 'Your face is near the right edge. Turn DashPal to center it.',
        4: 'Your face is near the top. Tilt DashPal up a little.',
        5: 'Your chin is near the bottom. Tilt DashPal down a little.',
        6: 'DashPal is too close. Move it farther from your face.',
        7: 'DashPal is too far away. Move it closer to you.',
        8: 'DashPal is too far to your right. Move it more in front of you.',
        9: 'DashPal is too far to your left. Move it more in front of you.',
        10: 'DashPal is too high. Move it down near your eye level.',
        11: 'DashPal is too low. Move it a little higher.',
        12: 'DashPal is tilted. Straighten it.',
        13: 'It’s too dark to see your face well. Add some light.',
      } as Readonly<Record<number, string>>,
      hintUnknown: 'Adjust DashPal until the frame shows Good position.',
      refused: {
        moving: 'Stop the car to aim DashPal.',
        drive: 'Finish your drive first.',
        budget: 'Aiming time is used up for now. Press DashPal’s button 5 times to aim it again.',
        busy: 'DashPal’s camera is busy. Try again in a moment.',
        camera: 'DashPal’s camera isn’t ready. Try again in a moment.',
        memory: 'DashPal’s camera isn’t ready. Try again in a moment.',
        no_state: 'The picture stopped. Try again.',
        mtu: 'Your phone’s Bluetooth can’t show the picture. You can go on without it.',
        not_allowed: 'Your other phone already aimed DashPal.',
        hold_ended: 'Setup ended. Try again.',
        ok: 'The picture stopped. Try again.',
      },
      videoLabel: 'What DashPal’s camera sees',
      next: 'Next',
      tryAgain: 'Try again',
    },
    finishing: 'Finishing…',
    done: {
      title: 'DashPal is ready',
      body: (n: string) => `${n} connects by itself whenever it’s on and nearby.`,
      phones: (k: number) => `${k} phones are paired with this DashPal.`,
      notAllYours: 'Not all yours? Press its button 10 times in 6 seconds to clear all phones.',
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
      mtu: 'Couldn’t connect securely. Turn Bluetooth off and on, then try again.',
      ios_forget_first:
        'Your phone remembers an old pairing. In Settings › Bluetooth, tap ⓘ next to DashPal, choose Forget This Device, then try again.',
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
    body: 'Set it up now, or later in Settings.',
    /** What setting it up asks the phone for (Bluetooth scans use location on Android 11 and lower). */
    asks: (platform: 'ios' | 'android', androidApi: number | null): string =>
      platform === 'ios'
        ? 'Setting it up asks for Bluetooth.'
        : (androidApi ?? 31) >= 31
          ? 'Setting it up asks for Nearby devices (Bluetooth).'
          : 'Setting it up uses Location to find it.',
    find: 'Find my DashPal',
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
