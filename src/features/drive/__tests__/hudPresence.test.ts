import { isDriveScreenFocused, resetDriveScreenPresence, setDriveScreenFocused, subscribeDriveScreen } from '../hudPresence';

describe('hudPresence', () => {
  beforeEach(() => resetDriveScreenPresence());

  it('starts unfocused', () => {
    expect(isDriveScreenFocused()).toBe(false);
  });

  it('tracks focus', () => {
    setDriveScreenFocused(true);
    expect(isDriveScreenFocused()).toBe(true);
    setDriveScreenFocused(false);
    expect(isDriveScreenFocused()).toBe(false);
  });

  it('tells listeners only on a change, until they unsubscribe', () => {
    const seen: boolean[] = [];
    const off = subscribeDriveScreen((f) => seen.push(f));
    setDriveScreenFocused(true);
    setDriveScreenFocused(true);
    setDriveScreenFocused(false);
    off();
    setDriveScreenFocused(true);
    expect(seen).toEqual([true, false]);
  });
});
