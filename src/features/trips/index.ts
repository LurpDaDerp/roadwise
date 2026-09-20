// The D-screen components Task 7 composes its own screens from, and the two screens built here.
export { tripCopy } from './copy';
export { EarnedField } from './EarnedField';
export { Field, FieldText } from './Field';
export {
  categoryLabel,
  conditionsLabel,
  dateLine,
  describeEvent,
  earnedFor,
  formatClock,
  formatTimeSpan,
  formatTripDate,
  highlightsFor,
  isPerfect,
  LIMIT_KNOWN_PCT,
  MAX_HIGHLIGHTS,
  qualityCaption,
  routeLine,
  unscoredCopy,
  type EarnedKind,
  type Highlight,
  type UnscoredCopy,
} from './format';
export { RoleChips } from './RoleChips';
export {
  SET_ROLE_KIND,
  setRoleIdempotencyKey,
  setTripRole,
  useSetTripRole,
  type ChosenRole,
  type SetRolePayload,
  type SetTripRole,
} from './roleActions';
export {
  HOME_HREF,
  tripDetailHref,
  tripEventsHref,
  tripSummaryHref,
  tripTipHref,
} from './routes';
export { tipForTrip, type TripTip } from './tip';
export { firstSentence, TipCard } from './TipCard';
export { TipScreen, WEEKLY_FOCUS_KEY, type WeeklyFocus } from './TipScreen';
export { TripHeader } from './TripHeader';
export { TripHighlights } from './TripHighlights';
export { TripScoreField } from './TripScoreField';
export { TripStatusChip, type TripStatusChipKind } from './TripStatusChip';
export { TripSummaryScreen } from './TripSummaryScreen';
