import { driveScreenEnteredFor, isDriveScreenFocused, resetDriveScreenPresence, setDriveScreenFocused, subscribeDriveScreen } from '../hudPresence';

describe('hudPresence', () => {
  beforeEach(() => resetDriveScreenPresence());

  it('starts unfocused, with no drive entered', () => {
    expect(isDriveScreenFocused()).toBe(false);
    expect(driveScreenEnteredFor('t1')).toBe(false);
    expect(driveScreenEnteredFor(null)).toBe(false);
  });

  it('tracks focus and remembers each drive the screen was shown for', () => {
    setDriveScreenFocused(true, 't1');
    expect(isDriveScreenFocused()).toBe(true);
    expect(driveScreenEnteredFor('t1')).toBe(true);
    setDriveScreenFocused(false, 't1');
    expect(isDriveScreenFocused()).toBe(false);
    expect(driveScreenEnteredFor('t1')).toBe(true);
    expect(driveScreenEnteredFor('t2')).toBe(false);
  });

  it('a focus without a drive enters none', () => {
    setDriveScreenFocused(true, null);
    expect(isDriveScreenFocused()).toBe(true);
    expect(driveScreenEnteredFor(null)).toBe(false);
  });

  it('tells listeners only on a change, until they unsubscribe', () => {
    const seen: boolean[] = [];
    const off = subscribeDriveScreen((f) => seen.push(f));
    setDriveScreenFocused(true, 't1');
    setDriveScreenFocused(true, 't1');
    setDriveScreenFocused(false, 't1');
    off();
    setDriveScreenFocused(true, 't1');
    expect(seen).toEqual([true, false]);
  });
});
