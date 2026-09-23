// Test instrumentation, NOT part of the port (the drive-sense pattern, M3 review M3). Every branch
// of the reference that compares a computed double with a threshold reports the pair here; the
// vector generator installs a probe and refuses any vector with a comparison closer than MARGIN_MIN
// to its threshold, where a different `sqrt`/`atan2` rounding in Swift or Kotlin could take the
// other branch and fail the self-test for no real reason. With no probe installed the cost is one
// null check. Ports do not port `probe(...)` calls.

/** Smallest |value − threshold| a golden vector may contain at any threshold comparison. */
export const MARGIN_MIN = 1e-6;

export type MarginProbe = (name: string, value: number, threshold: number) => void;

let current: MarginProbe | null = null;

export function setMarginProbe(p: MarginProbe | null): void {
  current = p;
}

export function probe(name: string, value: number, threshold: number): void {
  if (current !== null) current(name, value, threshold);
}
