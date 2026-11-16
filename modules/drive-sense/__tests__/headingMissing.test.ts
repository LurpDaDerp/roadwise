// Where the `PhoneHeading` module does not exist (iOS, Expo Go, web, and Jest without a stub), the
// phone heading is simply unavailable: nothing throws at import, and a watch rejects.
import { PhoneHeading } from '../src/heading';

describe('PhoneHeading without its native module', () => {
  test('unavailable, and watch rejects', async () => {
    expect(PhoneHeading.available()).toBe(false);
    await expect(PhoneHeading.watch(() => {})).rejects.toThrow('not available');
  });
});
