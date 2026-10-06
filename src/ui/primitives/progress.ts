import type { ColorSet, Signal } from '../tokens';

export type ProgressTone = 'primary' | 'accent' | Signal;

/** 0–1, with NaN and out-of-range values pinned. */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * The fill for a progress mark, chosen to clear 3:1 against its track (non-text contrast).
 * `primary` is gold in dark mode; in light mode gold cannot clear 3:1 on a pale track, so it is the
 * navy accent there. Signals use their `text` variant rather than `fill` for the same reason.
 */
export function progressColor(c: ColorSet, tone: ProgressTone): string {
  if (tone === 'primary' || tone === 'accent') return c.accent;
  return c.signal[tone].text;
}

/** The unfilled track behind a progress mark. */
export function progressTrack(c: ColorSet, scheme: 'light' | 'dark'): string {
  return scheme === 'dark' ? c.border : c.surfaceRaised;
}
