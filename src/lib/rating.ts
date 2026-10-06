/** The word shown instead of a Safety Rating for a driver under 25 mi in 30 days. */
export const UNRANKED = 'Unranked';

/**
 * The one Safety Rating display rule, used on every screen and the share card: a whole number
 * (91.7 → "92"), and "Unranked" for an unranked driver or no rating at all.
 */
export function formatRating(rating: number | null | undefined, ranked: boolean): string {
  if (!ranked || rating === null || rating === undefined || !Number.isFinite(rating)) return UNRANKED;
  return String(Math.round(rating));
}
