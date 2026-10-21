// A drive's merit: five tiers that combine its drive score AND its distance, so a short perfect
// drive can't outrank a long excellent one. Shown only by icon and colour (no names); not part of
// the Safety Rating. Pure.

/** 1 (lowest) to 5 (highest). */
export type MeritTier = 1 | 2 | 3 | 4 | 5;

/** The first rule a drive meets, highest tier first; tier 1 otherwise. Miles only (km are converted for display). */
export const MERIT_RULES: readonly { tier: MeritTier; minScore: number; minMiles: number }[] = [
  { tier: 5, minScore: 95, minMiles: 25 },
  { tier: 4, minScore: 90, minMiles: 10 },
  { tier: 3, minScore: 85, minMiles: 4 },
  { tier: 2, minScore: 75, minMiles: 1 },
];

/**
 * A drive's merit tier from its drive score (0–100) and miles: the first rule whose score AND miles
 * it reaches, else 1. Null for a null or non-finite score, or unreadable or negative miles (an
 * unscored drive has no tier).
 */
export function driveMerit(score: number | null, miles: number): MeritTier | null {
  if (score === null || !Number.isFinite(score) || !Number.isFinite(miles) || miles < 0) return null;
  for (const rule of MERIT_RULES) {
    if (score >= rule.minScore && miles >= rule.minMiles) return rule.tier;
  }
  return 1;
}
