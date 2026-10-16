// Which flash bursts the halo (drive-screen design §4.6). The phone's event flash and DashPal's flash
// run on different clocks, so they are ordered by the JS time each was first seen, never by their
// own `at`. A flash bursts at most once, whatever re-renders or flash orders follow; nothing seen
// while RoadWise is not in front bursts, then or later.
import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { BURST_PERIOD_MS, burstFor, type BurstSource, type HaloBurst } from '@/ui/drive';

type Candidate = NonNullable<ReturnType<typeof burstFor>>;

/** What the hook remembers between renders. */
export interface BurstMemory {
  /** JS time each present flash was first seen */
  firstSeen: Map<string, number>;
  /** the last flashes that burst or were passed over (16 at most) */
  played: string[];
  current: HaloBurst | null;
}

export const newBurstMemory = (): BurstMemory => ({ firstSeen: new Map(), played: [], current: null });

const PLAYED_MAX = 16;

/**
 * One render's burst. The unplayed flash first seen latest bursts (a tie: the stronger); every
 * unplayed flash is then played, so an older one never bursts after a newer one. A burst gets the
 * pulses that fit in what is left of its flash (400 ms each); under 400 ms left, none. The burst
 * ends with its flash. Idempotent for a repeated render.
 */
export function stepHaloBurst(mem: BurstMemory, candidates: readonly Candidate[], now: number, active: boolean): HaloBurst | null {
  const keys = new Set(candidates.map((c) => c.key));
  for (const c of candidates) if (!mem.firstSeen.has(c.key)) mem.firstSeen.set(c.key, now);
  for (const k of [...mem.firstSeen.keys()]) if (!keys.has(k)) mem.firstSeen.delete(k);
  const play = (key: string) => {
    if (mem.played.includes(key)) return;
    mem.played.push(key);
    if (mem.played.length > PLAYED_MAX) mem.played.shift();
  };
  if (mem.current !== null && (!keys.has(mem.current.key) || now >= mem.current.until)) mem.current = null;
  if (!active) {
    for (const c of candidates) play(c.key);
    mem.current = null;
    return null;
  }
  const fresh = candidates.filter((c) => !mem.played.includes(c.key));
  if (fresh.length > 0) {
    fresh.sort((a, b) => mem.firstSeen.get(b.key)! - mem.firstSeen.get(a.key)! || b.severity - a.severity);
    const pick = fresh[0]!;
    for (const c of fresh) play(c.key);
    const fits = Math.floor((pick.until - now) / BURST_PERIOD_MS);
    if (fits >= 1) mem.current = { key: pick.key, severity: pick.severity, pulses: Math.min(pick.pulses, fits) as 1 | 2 | 3, until: pick.until };
  }
  return mem.current;
}

/** In front; a state not (yet) known counts as in front, as the drive store reads it. */
const isActive = (s: AppStateStatus | null | undefined): boolean => typeof s !== 'string' || s === 'active' || s === 'unknown';

/** RoadWise is in front (AppState), live. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => isActive(AppState.currentState));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(isActive(next)));
    return () => sub.remove();
  }, []);
  return active;
}

/** The halo's burst this render, from the phone's and DashPal's flashes (null: none showing). */
export function useHaloBurst({ phone, dashpal, now }: { phone: BurstSource | null; dashpal: BurstSource | null; now: number }): HaloBurst | null {
  const active = useAppActive();
  // One mutable memory for the screen's life; each render's step is idempotent (a repeated render
  // returns the same burst), so re-rendering never replays one.
  const [mem] = useState(newBurstMemory);
  const candidates: Candidate[] = [];
  for (const src of [phone, dashpal]) {
    const c = src === null ? null : burstFor(src);
    if (c !== null) candidates.push(c);
  }
  return stepHaloBurst(mem, candidates, now, active);
}
