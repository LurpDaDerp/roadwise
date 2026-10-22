import {
  bindDriveScreenMemory,
  driveScreenEnteredFor,
  isDriveScreenFocused,
  markDriveScreenEntered,
  resetDriveScreenPresence,
  setDriveScreenFocused,
  subscribeDriveScreen,
} from '../hudPresence';

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

  it('writes each drive down once, the first time the screen is shown for it, while a writer is bound', () => {
    const written: string[] = [];
    setDriveScreenFocused(true, 't0');
    const unbind = bindDriveScreenMemory((id) => written.push(id));
    setDriveScreenFocused(true, 't1');
    setDriveScreenFocused(false, 't1');
    setDriveScreenFocused(true, 't1');
    setDriveScreenFocused(true, 't2');
    setDriveScreenFocused(true, null);
    unbind();
    setDriveScreenFocused(true, 't3');
    expect(written).toEqual(['t1', 't2']);
  });

  it('an unbind leaves a later binding in place', () => {
    const first: string[] = [];
    const second: string[] = [];
    const unbindFirst = bindDriveScreenMemory((id) => first.push(id));
    bindDriveScreenMemory((id) => second.push(id));
    unbindFirst();
    setDriveScreenFocused(true, 't1');
    expect(first).toEqual([]);
    expect(second).toEqual(['t1']);
  });

  it('a drive read back at a relaunch counts as entered, listeners re-read, and nothing is written again', () => {
    const written: string[] = [];
    bindDriveScreenMemory((id) => written.push(id));
    const heard: boolean[] = [];
    const off = subscribeDriveScreen((f) => heard.push(f));
    markDriveScreenEntered('t1');
    markDriveScreenEntered('t1');
    expect(driveScreenEnteredFor('t1')).toBe(true);
    expect(heard).toEqual([false]);
    setDriveScreenFocused(true, 't1');
    expect(written).toEqual([]);
    off();
  });
});
