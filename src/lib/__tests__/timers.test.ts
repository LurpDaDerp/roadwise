// Pumped timers: a timer fires from its JS timer or from a pump once due, whichever is first, once.
import { createPumpedTimers } from '../timers';

/** A JS timer base that can be paused, as Android pauses them with the app in the background. */
function pausableBase() {
  let t = 0;
  let paused = false;
  const armed = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      id += 1;
      armed.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => {
      armed.delete(h as number);
    },
    pause(on: boolean) {
      paused = on;
    },
    advance(ms: number) {
      t += ms;
      if (paused) return;
      for (const [k, a] of [...armed]) {
        if (a.at <= t) {
          armed.delete(k);
          a.fn();
        }
      }
    },
    armed: () => armed.size,
  };
}

describe('pumped timers', () => {
  it('fire from the JS timer as usual when timers run, and a pump then finds nothing', () => {
    const base = pausableBase();
    const timers = createPumpedTimers(base);
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('a'), 1000);
    base.advance(999);
    timers.pump();
    expect(fired).toEqual([]);
    base.advance(1);
    expect(fired).toEqual(['a']);
    timers.pump();
    expect(fired).toEqual(['a']);
    expect(timers.pending()).toBe(0);
  });

  it('with JS timers paused, a pump fires what is due, in due order, once; the JS timer later fires nothing', () => {
    const base = pausableBase();
    base.pause(true);
    const timers = createPumpedTimers(base);
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('late'), 2000);
    timers.setTimeout(() => fired.push('early'), 500);
    timers.setTimeout(() => fired.push('future'), 9000);
    base.advance(2500);
    expect(fired).toEqual([]);
    timers.pump();
    expect(fired).toEqual(['early', 'late']);
    expect(base.armed()).toBe(1);
    base.pause(false);
    base.advance(10_000);
    expect(fired).toEqual(['early', 'late', 'future']);
  });

  it('a cleared timer never fires, by either path', () => {
    const base = pausableBase();
    base.pause(true);
    const timers = createPumpedTimers(base);
    const fn = jest.fn();
    const h = timers.setTimeout(fn, 100);
    timers.clearTimeout(h);
    base.advance(200);
    timers.pump();
    base.pause(false);
    base.advance(200);
    expect(fn).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it('sleep resolves on a pump while paused', async () => {
    const base = pausableBase();
    base.pause(true);
    const timers = createPumpedTimers(base);
    let done = false;
    const slept = timers.sleep(800).then(() => {
      done = true;
    });
    base.advance(900);
    await Promise.resolve();
    expect(done).toBe(false);
    timers.pump();
    await slept;
    expect(done).toBe(true);
  });

  it('a throwing callback does not stop the others; the pump rethrows the first error after', () => {
    const base = pausableBase();
    base.pause(true);
    const timers = createPumpedTimers(base);
    const after = jest.fn();
    timers.setTimeout(() => {
      throw new Error('boom');
    }, 10);
    timers.setTimeout(after, 20);
    base.advance(50);
    expect(() => timers.pump()).toThrow('boom');
    expect(after).toHaveBeenCalledTimes(1);
  });
});
