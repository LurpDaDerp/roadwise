// The car link's words (iPhone only): Settings › Your car, the pairing screen, Home's card and the
// "Are you driving?" note.
import type { CarPortType } from '@drive-sense';

const KIND: Record<CarPortType, string> = {
  carAudio: 'CarPlay',
  bluetoothA2DP: 'Bluetooth',
  bluetoothHFP: 'Bluetooth',
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
    headphones: 'This looks like headphones or a hearing aid, not a car, so RoadWise can’t use it.',
    full: 'You can pair up to 3 cars. Forget one to add another.',
    cars: 'Your cars',
    connected: 'Connected',
    forget: 'Forget car',
    forgetLabel: (name: string) => `Forget ${name}`,
    note: 'Pairing your car starts and ends drives on time, helps RoadWise tell when you’re riding as a passenger, and remembers where you parked. RoadWise only checks what’s connected and never changes your audio.',
    failed: 'That didn’t work. Try again.',
  },
  /** "Are you driving?": the note on an automatic drive whose route never held the car (`src/drive/passengerCheck.ts`). */
  passenger: {
    title: 'Are you driving?',
    body: 'Your car isn’t connected. If you’re a passenger, tap to stop this drive.',
  },
  card: {
    dismiss: 'Close',
    askTitle: (name: string) => `Is ${name} your car?`,
    askBody: 'It was connected during your recent drives. Pair it to start drives sooner.',
    use: 'Use it',
    notMine: 'Not my car',
  },
} as const;
