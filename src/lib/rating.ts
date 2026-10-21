/** The words shown instead of a Safety Rating for a driver under 10 mi in 90 days (or one who doesn't share it). */
export const UNRANKED = 'No rating yet';

/**
 * The one Safety Rating display rule, used on every screen: a whole number (91.7 → "92"), and
 * "No rating yet" for a driver without a rating.
 */
export function formatRating(rating: number | null | undefined, ranked: boolean): string {
  if (!ranked || rating === null || rating === undefined || !Number.isFinite(rating)) return UNRANKED;
  return String(Math.round(rating));
}
