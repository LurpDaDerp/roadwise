// The D-screen components and screens the trip routes mount, and what other features reuse.
export { tripCopy } from './copy';
export {
  canReport,
  confidenceLevel,
  confidenceReasons,
  EVENT_SEGMENT_RADIUS_M,
  eventClock,
  eventStanding,
  groupTripsByDay,
  historyItems,
  measuredLine,
  regionFor,
  routeFor,
  routeSegments,
  severityWord,
  timelineRows,
  TRIM_ENDPOINTS_M,
  trimRoute,
  whyItMatters,
  type ConfidenceLevel,
  type EventStanding,
  type HistoryItem,
  type RouteSegment,
  type SeverityWord,
  type TimelineRow,
  type TripDayGroup,
} from './detail';
export {
  DisputeSheet,
  MAX_STATED_LIMIT,
  MIN_STATED_LIMIT,
  parseStatedLimit,
} from './DisputeSheet';
export { EarnedField } from './EarnedField';
export { EditTripScreen } from './EditTripScreen';
export { EventDetailScreen } from './EventDetailScreen';
export { EventListScreen } from './EventListScreen';
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
  spokenRoute,
  unscoredCopy,
  type EarnedKind,
  type Highlight,
  type UnscoredCopy,
} from './format';
export { ICON, TIGHT, TOUCH, TOUCH_LG } from './layout';
export { QualityStamp } from './QualityStamp';
export { RoleChips } from './RoleChips';
export {
  roleStamp,
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
  HOW_SCORING_WORKS_HREF,
  TRIP_HISTORY_HREF,
  tripDetailHref,
  tripEditHref,
  tripEventHref,
  tripEventsHref,
  tripSummaryHref,
  tripTipHref,
} from './routes';
export { tipForTrip, type TripTip } from './tip';
export { firstSentence, TipCard } from './TipCard';
export { TipScreen, WEEKLY_FOCUS_KEY, type WeeklyFocus } from './TipScreen';
export { TripTopBar } from './TopBar';
export { TripDetailScreen } from './TripDetailScreen';
export { TripConditionsField, TripQualityField } from './TripFacts';
export {
  hasFilters,
  NO_FILTERS,
  toTripsFilter,
  TripFilterBar,
  type HistoryFilters,
} from './TripFilters';
export { TripHeader } from './TripHeader';
export { TripHighlights } from './TripHighlights';
export { PAGE_SIZE, TripHistoryScreen } from './TripHistoryScreen';
export { EventMiniMap, loadMaps, resetMapsCache, TripRouteField } from './TripMap';
export { TripScoreField } from './TripScoreField';
export { TripStatusChip, type TripStatusChipKind } from './TripStatusChip';
export { TripSummaryScreen } from './TripSummaryScreen';
export { spokenRow, STANDING_WHY, TripTimeline } from './TripTimeline';
export {
  DELETE_TRIP_KIND,
  deleteIdempotencyKey,
  deleteTrip,
  DISPUTE_KIND,
  disputeEvent,
  disputeIdempotencyKey,
  MAX_NOTE,
  MissingEventError,
  useDeleteTrip,
  useReportEvent,
  type DeleteTrip,
  type DeleteTripPayload,
  type DisputeInput,
  type DisputePayload,
  type ReportEvent,
} from './tripActions';
