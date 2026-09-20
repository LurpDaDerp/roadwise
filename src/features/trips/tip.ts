/**
 * The one tip a trip earns (§7.D D1 → D6), chosen from what the query layer already read.
 *
 * The scorer's shapes come from the data layer's bridges (`toScoredTrip`, `toScorableEvents`),
 * which carry the load-bearing rule that a locally `provisional` trip is `'final'` to the
 * picker. Only the outcome the query layer already decided (`tipOutcome`) chooses between
 * coaching, the clean-drive card and nothing at all.
 */
import { keepItUpTip, pickTopTip, type Tip } from '@/content/tips';
import {
  toScorableEvents,
  toScoredTrip,
  type TipOutcome,
  type TripDetail,
  type TripEventView,
} from '@/data/queries';

export interface TripTip {
  outcome: TipOutcome;
  /** Null only for `facts_only`, or when the catalogue has nothing for the costly category. */
  tip: Tip | null;
}

export function tipForTrip(detail: TripDetail, events: readonly TripEventView[]): TripTip {
  const { tipOutcome: outcome, trip, stage } = detail;
  if (outcome === 'facts_only') return { outcome, tip: null };
  if (outcome === 'keep_it_up') return { outcome, tip: keepItUpTip };
  return { outcome, tip: pickTopTip(toScoredTrip(trip, events), toScorableEvents(events), stage) };
}
