import { useEffect, useRef, useState } from 'react';

/** Ease-out cubic: fast start, gentle landing. */
const easeOut = (x: number) => 1 - (1 - x) ** 3;

/**
 * Counts a displayed integer from where it currently is to `target` over `duration` ms on the JS
 * thread (a text value cannot be animated on the UI thread without a TextInput hack). When
 * `enabled` is false (reduce motion, or no animation wanted) it returns `target` straight away.
 * `onDone` fires once the count lands, with the value it started from.
 */
export function useCountUp(
  target: number,
  {
    from,
    duration,
    enabled,
    onDone,
  }: { from: number; duration: number; enabled: boolean; onDone?: (start: number) => void }
): number {
  const [shown, setShown] = useState(enabled ? from : target);
  const shownRef = useRef(enabled ? from : target);
  const doneRef = useRef(onDone);

  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    const start = shownRef.current;
    let frame = 0;
    if (start === target) {
      // Re-sync the state after a stretch with animation off, where only the ref moved.
      frame = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(frame);
    }
    if (!enabled) {
      shownRef.current = target;
      doneRef.current?.(start);
      return;
    }
    const began = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - began) / duration);
      const v = Math.round(start + (target - start) * easeOut(p));
      shownRef.current = v;
      setShown(v);
      if (p < 1) frame = requestAnimationFrame(tick);
      else doneRef.current?.(start);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, enabled]);

  return enabled ? shown : target;
}
