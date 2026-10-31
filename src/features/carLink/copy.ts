// The car link's words (iPhone only): Settings › Your car, the pairing screen and Home's card.
import type { CarPortType } from '@drive-sense';

const KIND: Record<CarPortType, string> = {
  carAudio: 'CarPlay',
  bluetoothA2DP: 'Bluetooth',
  bluetoothHFP: 'Bluetooth',
  bluetoothLE: 'Bluetooth',
};

export const carCopy = {
  /** An output's kind as the screens say it. */
  kind: (type: CarPortType): string => KIND[type],
  /** An output with no name of its own. */
  unnamed: (type: CarPortType): string => (type === 'carAudio' ? 'CarPlay' : 'Bluetooth audio'),
  row: {
    title: 'Your car',
    none: 'Not paired',
  },
  screen: {
    title: 'Your car',
    intro: 'Turn on your car and connect this iPhone to its Bluetooth or CarPlay, then tap Use this car.',
    now: 'Connected now',
    nothing: 'Nothing connected',
    nothingBody: 'No Bluetooth or CarPlay audio is connected right now.',
    ask: (name: string) => `Connected to ${name}. Use this car?`,
    already: (name: string) => `${name} is paired.`,
    paired: 'Paired',
    use: 'Use this car',
    headphones: 'This looks like headphones, not a car.',
    full: 'You can pair up to 3 cars. Forget one to add another.',
    cars: 'Your cars',
    connected: 'Connected',
    forget: 'Forget car',
    forgetLabel: (name: string) => `Forget ${name}`,
    note:
      'Pairing starts drives sooner and ends a drive soon after the car disconnects. It can’t wake your iPhone by itself: RoadWise still notices a drive when you leave where you parked or open the app. RoadWise only reads which Bluetooth or CarPlay audio is connected; it never changes your audio or connections. A car that connects only for calls may not show here.',
    failed: 'That didn’t work. Try again.',
  },
  card: {
    title: 'Pair your car',
    body: 'Drives start sooner when RoadWise knows your car’s Bluetooth or CarPlay.',
    hint: 'Opens Your car',
    dismiss: 'Close',
    askTitle: (name: string) => `Is ${name} your car?`,
    askBody: 'It was connected on your recent drives. Pairing it starts drives sooner.',
    use: 'Use it',
    notMine: 'Not my car',
  },
} as const;
