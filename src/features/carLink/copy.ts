// The car link's words: Settings › Your car, the pairing screen, Home's card and the "Are you
// driving?" note. The same on both phones but for the names: Android says "Android Auto" where
// iPhone says "CarPlay", and "this phone" where iPhone says "this iPhone" (read as each line is
// shown, so a test can switch phones).
import { Platform } from 'react-native';

import type { CarPortType } from '@drive-sense';

/** The car's own screen for the phone: CarPlay on iPhone, Android Auto on Android. */
const carScreen = (): string => (Platform.OS === 'android' ? 'Android Auto' : 'CarPlay');
const thisPhone = (): string => (Platform.OS === 'android' ? 'this phone' : 'this iPhone');

export const carCopy = {
  /** An output's kind as the screens say it. */
  kind: (type: CarPortType): string => (type === 'carAudio' ? carScreen() : 'Bluetooth'),
  /** An output with no name of its own. */
  unnamed: (type: CarPortType): string => (type === 'carAudio' ? carScreen() : 'Bluetooth audio'),
  /** Android only: Android Auto listed alone, when the car it shows on could not be told (`ANDROID_AUTO_UID`). */
  anyCar: 'Any car with Android Auto',
  row: {
    title: 'Your car',
    none: 'Not paired',
  },
  screen: {
    title: 'Your car',
    get intro(): string {
      return `Turn on your car and connect ${thisPhone()} to its Bluetooth or ${carScreen()}, and then select Use this car.`;
    },
    now: 'Connected now',
    nothing: 'Nothing connected',
    get nothingBody(): string {
      return `No Bluetooth or ${carScreen()} audio is connected right now.`;
    },
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
    note: 'With your car paired, RoadWise starts and ends drives on time, tells when you’re riding as a passenger, and remembers where you parked. It only checks what’s connected and never changes your audio.',
    failed: 'That didn’t work. Try again.',
  },
  /** "Are you driving?": the note on an automatic drive whose route never held the car (`src/drive/passengerCheck.ts`). */
  passenger: {
    title: 'Are you driving?',
    body: 'Your car isn’t connected. If you’re a passenger, select this to stop the drive.',
  },
  card: {
    dismiss: 'Close',
    askTitle: (name: string) => `Is ${name} your car?`,
    /** Android only: the suggestion is Android Auto listed alone (`ANDROID_AUTO_UID`). */
    askAnyCar: 'Do you drive with Android Auto?',
    askBody: 'It was connected during your recent drives. Pair it to start drives sooner.',
    use: 'Use it',
    notMine: 'Not my car',
  },
} as const;
